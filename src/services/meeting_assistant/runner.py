"""在临时目录和沙箱里跑一次 pi，收集它的工具调用。

每次生成：
1. 新建临时目录，写入会议资料（meeting/）、运行参数、pi 配置和会话文件；
2. 用 srt（Anthropic sandbox-runtime）包住 pi 子进程：只能读临时目录和 pi
   自身的程序文件，只能写会话目录，网络只能连模型接口；
3. 读 pi 的 JSON 事件流，报告进度，收集 save_summary 与记忆工具的结果；
4. 跑完把新的会话内容读回来，删除整个临时目录。

数据库不在这里读写。
"""
import json
import logging
import os
import queue
import shutil
import signal
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from urllib.parse import urlparse

logger = logging.getLogger(__name__)

REPO_ROOT = Path(__file__).resolve().parents[3]
OWN_TOOLS = ('save_summary', 'list_memory', 'search_memory', 'add_memory', 'update_memory', 'delete_memory')
ALLOWED_TOOLS = ('read', 'ls') + OWN_TOOLS
PROVIDER = 'meeting'
API_KEY_ENV = 'MEETING_ASSISTANT_API_KEY'


class AssistantUnavailable(RuntimeError):
    """会议助手的运行环境不完整（没装 pi、没配模型、沙箱不可用）。"""


class AssistantRunFailed(RuntimeError):
    """pi 进程异常退出、超时或模型调用出错。"""
    crashed = False   # pi 进程自己崩了（比如内存不够），重跑一次通常就好


class AssistantCanceled(RuntimeError):
    pass


def _env_bool(name, default=False):
    value = os.environ.get(name)
    return default if value is None else value.strip().lower() in ('1', 'true', 'yes', 'on')


@dataclass
class Settings:
    base_url: str
    api_key: str
    model: str
    thinking: str
    context_window: int
    max_tokens: int
    timeout: int
    sandbox: str          # srt | off
    node: str
    assistant_dir: Path
    work_root: str | None
    memory_mb: int
    systemd_run: bool

    @classmethod
    def from_env(cls):
        from src.services import llm
        base_url = (os.environ.get('ASSISTANT_MODEL_BASE_URL') or llm.TEXT_MODEL_BASE_URL or '').strip()
        model = (os.environ.get('ASSISTANT_MODEL_NAME') or llm.TEXT_MODEL_NAME or '').strip()
        if not base_url or not model:
            raise AssistantUnavailable('没有配置会议助手的模型（ASSISTANT_MODEL_BASE_URL / ASSISTANT_MODEL_NAME 或 TEXT_MODEL_*）。')
        sandbox = (os.environ.get('ASSISTANT_SANDBOX') or 'srt').strip().lower()
        if sandbox not in ('srt', 'off'):
            raise AssistantUnavailable('ASSISTANT_SANDBOX 只能是 srt 或 off。')
        return cls(
            base_url=base_url.rstrip('/'),
            api_key=(os.environ.get('ASSISTANT_MODEL_API_KEY') or llm.TEXT_MODEL_API_KEY or 'not-needed').strip(),
            model=model,
            thinking=(os.environ.get('ASSISTANT_THINKING') or 'xhigh').strip(),
            context_window=int(os.environ.get('ASSISTANT_CONTEXT_WINDOW') or 1_000_000),
            max_tokens=int(os.environ.get('ASSISTANT_MAX_TOKENS') or 131_072),
            timeout=int(os.environ.get('ASSISTANT_TIMEOUT_SECONDS') or 900),
            sandbox=sandbox,
            node=str(Path(os.environ.get('ASSISTANT_NODE') or shutil.which('node') or 'node').resolve()),
            assistant_dir=Path(os.environ.get('ASSISTANT_DIR') or REPO_ROOT / 'assistant').resolve(),
            work_root=os.environ.get('ASSISTANT_WORK_ROOT') or None,
            memory_mb=int(os.environ.get('ASSISTANT_MEMORY_MB') or 512),
            systemd_run=_env_bool('ASSISTANT_SYSTEMD_RUN'),
        )

    @property
    def pi_cli(self):
        return self.assistant_dir / 'node_modules' / '@mariozechner' / 'pi-coding-agent' / 'dist' / 'cli.js'

    @property
    def srt_cli(self):
        return self.assistant_dir / 'node_modules' / '@anthropic-ai' / 'sandbox-runtime' / 'dist' / 'cli.js'

    @property
    def extension(self):
        return self.assistant_dir / 'meeting-tools.ts'

    @property
    def skill(self):
        return self.assistant_dir / 'skills' / 'meeting-minutes'

    def check(self):
        for path, what in ((self.pi_cli, 'pi'), (self.extension, '会议助手扩展'), (self.skill / 'SKILL.md', '纪要规范')):
            if not path.exists():
                raise AssistantUnavailable(f'找不到{what}：{path}。请在 assistant/ 下执行 npm ci。')
        if self.sandbox == 'srt' and not self.srt_cli.exists():
            raise AssistantUnavailable(f'找不到沙箱 srt：{self.srt_cli}。')
        if shutil.which(self.node) is None and not Path(self.node).exists():
            raise AssistantUnavailable(f'找不到 Node.js：{self.node}。')


@dataclass
class RunInput:
    meeting_files: dict          # 资料目录内的相对路径 -> 文本
    parts: list                  # [{'path','lines','first','last'}]
    memory: list                 # [{'id','category','content'}]
    categories: dict
    limits: dict
    message: str
    session_jsonl: str | None = None


@dataclass
class RunResult:
    session_jsonl: str | None
    summary: dict | None = None
    memory_ops: list = field(default_factory=list)
    prompt_tokens: int = 0
    completion_tokens: int = 0
    error: str | None = None
    final_text: str = ''


class Progress:
    """把事件流翻译成给用户看的阶段文字。"""

    def __init__(self, parts, report):
        self.parts = {p['path'] for p in parts}
        self.total = len(parts)
        self.read = set()
        self.saved = False
        self.report = report or (lambda text: None)
        self.report('正在阅读原文')

    def on_tool(self, name, args):
        if name == 'read':
            path = str((args or {}).get('path') or '')
            for part in self.parts:
                if path.endswith(part):
                    self.read.add(part)
            if self.total:
                self.report(f'正在阅读原文 {min(len(self.read), self.total)}/{self.total} 段')
        elif name in ('list_memory', 'search_memory', 'add_memory', 'update_memory', 'delete_memory'):
            # 提交摘要之后的记忆改动属于收尾，进度不往回走
            self.report('正在更新长期记忆' if self.saved else '正在对照长期记忆')
        elif name == 'save_summary':
            self.saved = True
            self.report('正在校验')

    def on_text(self):
        if self.total and len(self.read) >= self.total and not self.saved:
            self.report('正在撰写')


def _models_json(settings):
    host_model = {
        'id': settings.model,
        'name': settings.model,
        'reasoning': settings.thinking != 'off',
        'thinkingLevelMap': {'minimal': None, 'low': None, 'medium': None, 'high': 'high', 'xhigh': 'max'},
        'input': ['text'],
        'contextWindow': settings.context_window,
        'maxTokens': settings.max_tokens,
        'cost': {'input': 0, 'output': 0, 'cacheRead': 0, 'cacheWrite': 0},
    }
    return {'providers': {PROVIDER: {
        'baseUrl': settings.base_url,
        'api': 'openai-completions',
        'apiKey': API_KEY_ENV,
        'compat': {
            'supportsDeveloperRole': False,
            'supportsStore': False,
            'thinkingFormat': 'deepseek',
            'requiresReasoningContentOnAssistantMessages': True,
            'maxTokensField': 'max_tokens',
        },
        'models': [host_model],
    }}}


def _network_target(base_url):
    parsed = urlparse(base_url)
    host = parsed.hostname or ''
    port = parsed.port or (443 if parsed.scheme == 'https' else 80)
    return f'[{host}]:{port}' if ':' in host else f'{host}:{port}'


def _srt_settings(settings, work):
    home = str(Path.home())
    deny = [home, '/root', '/etc/jst-meeting', '/var/lib/jst-meeting', '/opt', '/srv', '/www',
            str(REPO_ROOT)]
    node_real = Path(shutil.which(settings.node) or settings.node).resolve()
    allow = [str(work), str(settings.assistant_dir), str(node_real.parent.parent)]
    return {
        'network': {'allowedDomains': [_network_target(settings.base_url)], 'deniedDomains': [], 'allowLocalBinding': False},
        'filesystem': {
            'denyRead': [p for p in deny if p],
            'allowRead': allow,
            'allowWrite': [str(work / 'session'), str(work / 'agent'), str(work / 'home'), str(work / 'tmp')],
            'denyWrite': [str(work / 'meeting'), str(work / 'state')],
        },
    }


def _write(path, text):
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(text, encoding='utf-8')


def _session_with_cwd(session_jsonl, cwd):
    """会话文件头里记着上次的工作目录，换成这次的临时目录。"""
    lines = session_jsonl.splitlines()
    if lines:
        try:
            header = json.loads(lines[0])
            if header.get('type') == 'session':
                header['cwd'] = str(cwd)
                lines[0] = json.dumps(header, ensure_ascii=False)
        except ValueError:
            pass
    return '\n'.join(lines) + '\n'


def _command(settings, work, session_file, message_file):
    # 沙箱里的 shell 不一定有同样的 PATH，一律用绝对路径。
    pi = [
        settings.node, f'--max-old-space-size={max(128, settings.memory_mb - 128)}', str(settings.pi_cli),
        '--mode', 'json', '-p',
        '--provider', PROVIDER, '--model', settings.model, '--thinking', settings.thinking,
        '--session', str(session_file),
        '--no-builtin-tools', '--tools', ','.join(ALLOWED_TOOLS),
        '--no-extensions', '-e', str(settings.extension),
        '--no-skills', '--skill', str(settings.skill),
        '--no-context-files', '--no-prompt-templates', '--no-themes',
        '--system-prompt', '@SYSTEM_PROMPT@',
        # 消息从标准输入传入：以 /skill:meeting-minutes 开头，pi 会把纪要规范全文展开进消息
        # （@文件 的方式会被包成 <file> 附件，不会展开 skill）。
    ]
    if settings.sandbox == 'srt':
        # srt 给子进程设的 NO_PROXY 含 localhost：模型接口在本机（服务器上是
        # 127.0.0.1:7864）时请求会绕过代理直连，而沙箱里直连是不通的。清空
        # NO_PROXY，让所有请求都经过 srt 的代理和白名单。
        pi = [settings.node, str(settings.srt_cli), '--settings', str(work / 'state' / 'srt.json'), '--',
              '/usr/bin/env', 'NO_PROXY=', 'no_proxy='] + pi
    if settings.systemd_run and sys.platform.startswith('linux') and shutil.which('systemd-run'):
        pi = ['systemd-run', '--user', '--scope', '--quiet', '--collect',
              '-p', f'MemoryMax={settings.memory_mb}M', '-p', 'CPUQuota=50%', '--'] + pi
    return pi


def run(settings, run_input, system_prompt, report=None, cancel_requested=None, trace=None):
    """跑一次 pi。返回 RunResult；超时或被取消时抛异常。"""
    settings.check()
    from src.services import assistant_capacity as capacity
    # 先看内存放不放得下：放不下就排队，页面上显示「排队中」
    try:
        slot = capacity.wait(capacity.SUMMARY, 'summary', cancelled=cancel_requested,
                             on_wait=lambda pos: report and report(f'排队中，前面还有 {pos} 个任务' if pos else '排队中，下一个就是'))
    except capacity.Cancelled:
        raise AssistantCanceled()
    work = None
    try:
        work = Path(tempfile.mkdtemp(prefix='jst-assistant-', dir=settings.work_root)).resolve()
        meeting_dir = work / 'meeting'
        for rel, text in run_input.meeting_files.items():
            _write(meeting_dir / rel, text)
        for sub in ('session', 'agent', 'home', 'tmp'):
            (work / sub).mkdir(parents=True, exist_ok=True)
        session_file = work / 'session' / 'session.jsonl'
        if run_input.session_jsonl:
            _write(session_file, _session_with_cwd(run_input.session_jsonl, meeting_dir))
        _write(work / 'agent' / 'models.json', json.dumps(_models_json(settings), ensure_ascii=False, indent=2))
        _write(work / 'agent' / 'settings.json', json.dumps({
            'compaction': {'enabled': True}, 'retry': {'enabled': True, 'maxRetries': 3},
            'quietStartup': True,
        }))
        _write(work / 'state' / 'run.json', json.dumps({
            'meetingDir': str(meeting_dir),
            'parts': [{'path': p['path'], 'lines': p['lines']} for p in run_input.parts],
            'memory': run_input.memory,
            'categories': run_input.categories,
            'limits': run_input.limits,
            'maxOutputTokens': settings.max_tokens,
        }, ensure_ascii=False))
        message_file = work / 'state' / 'message.md'
        _write(message_file, run_input.message)
        if settings.sandbox == 'srt':
            _write(work / 'state' / 'srt.json', json.dumps(_srt_settings(settings, work), ensure_ascii=False))

        command = [system_prompt if arg == '@SYSTEM_PROMPT@' else arg
                   for arg in _command(settings, work, session_file, message_file)]
        env = {
            'PATH': os.environ.get('PATH', '/usr/bin:/bin'),
            'HOME': str(work / 'home'),
            'TMPDIR': str(work / 'tmp'),
            'LANG': 'C.UTF-8',
            'PI_CODING_AGENT_DIR': str(work / 'agent'),
            'PI_OFFLINE': '1',
            'PI_SKIP_VERSION_CHECK': '1',
            'PI_TELEMETRY': '0',
            'MEETING_ASSISTANT_RUN': str(work / 'state' / 'run.json'),
            API_KEY_ENV: settings.api_key,
        }
        result = _execute(command, env, meeting_dir, settings.timeout, run_input.parts, report, cancel_requested, trace,
                          stdin_text=run_input.message)
        result.session_jsonl = session_file.read_text(encoding='utf-8') if session_file.exists() else None
        return result
    finally:
        if work is not None:
            shutil.rmtree(work, ignore_errors=True)
        capacity.release(slot)


def _kill(process):
    try:
        os.killpg(process.pid, signal.SIGTERM)
        process.wait(timeout=5)
    except Exception:
        try:
            os.killpg(process.pid, signal.SIGKILL)
        except Exception:
            pass


# 会议纪要不限时长：只要还在输出（思考、读原文、调用工具）就一直等。
# 连续 IDLE 秒没有任何输出才算卡死；总时长的上限只用来拦住死循环（正常的会碰不到）。
MAX_RUN_SECONDS = int(os.environ.get('ASSISTANT_MAX_RUN_SECONDS') or 4 * 3600)


def _execute(command, env, cwd, timeout, parts, report, cancel_requested, trace=None, stdin_text='', max_run=None):
    """timeout：连续多少秒没有输出就停（卡死）；max_run：总时长上限（防死循环）。"""
    progress = Progress(parts, report)
    result = RunResult(session_jsonl=None)
    stderr_tail = []
    process = subprocess.Popen(command, cwd=cwd, env=env, stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                               stderr=subprocess.PIPE, start_new_session=True)
    try:
        process.stdin.write((stdin_text or '').encode('utf-8'))
    finally:
        process.stdin.close()

    def drain_stderr():
        for raw in process.stderr:
            line = raw.decode('utf-8', 'replace').rstrip()
            if line:
                stderr_tail.append(line)
                del stderr_tail[:-40]

    threading.Thread(target=drain_stderr, daemon=True).start()
    # 逐行取走、处理完就丢：pi 的每个流式事件都带着到当前为止的整条消息，读原文的工具结果也很大，
    # 长会议的输出全部留在内存里会到几百 MB（2026-11-25 一场 97 分钟的会把服务撑到内存上限、网页卡死）。
    lines = queue.SimpleQueue()
    reader_done = threading.Event()

    def drain_stdout():
        try:
            for raw in process.stdout:
                lines.put(raw)
        finally:
            reader_done.set()

    threading.Thread(target=drain_stdout, daemon=True).start()
    started = time.monotonic()
    last_output = started
    max_run = max_run or MAX_RUN_SECONDS
    last_cancel_check = 0.0
    try:
        while True:
            try:
                raw = lines.get(timeout=0.1)
            except queue.Empty:
                raw = None
            if raw is not None:
                last_output = time.monotonic()
                _handle_event(raw, result, progress, trace)
                raw = None
            elif reader_done.is_set() and process.poll() is not None and lines.empty():
                break
            now = time.monotonic()
            if now - last_output > timeout:
                _kill(process)
                raise AssistantRunFailed(f'会议助手连续 {max(1, timeout // 60)} 分钟没有任何进展，可能卡住了，已停止。可以点「重新生成」再试。')
            if now - started > max_run:
                _kill(process)
                raise AssistantRunFailed(f'会议助手运行超过 {max_run // 3600} 小时仍未完成，已停止。可以点「重新生成」再试。')
            if cancel_requested and now - last_cancel_check > 2:
                last_cancel_check = now
                if cancel_requested():
                    _kill(process)
                    raise AssistantCanceled()
    finally:
        if process.poll() is None:
            _kill(process)
        if trace is not None:
            trace.finish()
        reader_done.wait(timeout=5)
        for stream in (process.stdout, process.stderr):
            try:
                stream.close()
            except Exception:
                pass
    if process.returncode != 0 and result.summary is None:
        tail = '\n'.join(stderr_tail[-8:])
        logger.warning('pi exited with %s: %s', process.returncode, tail)
        failure = AssistantRunFailed(result.error or f'会议助手异常退出（{process.returncode}）。{_short(tail)}')
        failure.crashed = result.error is None
        raise failure
    return result


def _short(text, limit=300):
    text = (text or '').strip().replace('\n', ' ')
    return text[:limit]


def _handle_event(raw, result, progress, trace=None):
    try:
        event = json.loads(raw)
    except ValueError:
        return
    kind = event.get('type')
    if kind == 'tool_execution_start':
        progress.on_tool(event.get('toolName'), event.get('args'))
        if trace is not None:
            trace.tool_start(event.get('toolCallId'), event.get('toolName'), event.get('args'))
    elif kind == 'tool_execution_end':
        name = event.get('toolName')
        if trace is not None:
            trace.tool_end(event.get('toolCallId'), name, event.get('result'), event.get('isError'))
        if event.get('isError') or name not in OWN_TOOLS:
            return
        details = (event.get('result') or {}).get('details') or {}
        if name == 'save_summary' and isinstance(details.get('summary'), dict):
            result.summary = details['summary']   # 以最后一次成功提交为准
        elif isinstance(details.get('memory'), dict):
            result.memory_ops.append(details['memory'])
    elif kind == 'message_update':
        delta = event.get('assistantMessageEvent') or {}
        if delta.get('type') == 'text_delta':
            progress.on_text()
        if trace is not None:
            trace.message_update(delta)
    elif kind == 'message_end':
        message = event.get('message') or {}
        if message.get('role') != 'assistant':
            return
        usage = message.get('usage') or {}
        result.prompt_tokens += int(usage.get('input') or 0) + int(usage.get('cacheRead') or 0)
        result.completion_tokens += int(usage.get('output') or 0)
        if message.get('stopReason') == 'error' and message.get('errorMessage'):
            result.error = f"模型调用失败：{_short(message['errorMessage'])}"
        texts = [c.get('text', '') for c in message.get('content') or [] if c.get('type') == 'text']
        if texts:
            result.final_text = ''.join(texts)[-2000:]
