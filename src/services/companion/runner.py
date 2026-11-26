"""小助理的一次运行：pi 的 RPC 模式，外面套 srt 沙箱。

和会议助手不同，小助理在回复期间要能接收「插话」（pi 的 steer）和「停止」
（abort），所以进程在一次回复期间保持打开，通过标准输入发送命令；回复结束
（agent_end）后关闭进程，不常驻。

正在运行的进程登记在本进程内存里（gunicorn 单进程多线程时成立）。
"""
import json
import logging
import os
import shutil
import signal
import subprocess
import tempfile
import threading
import time
import uuid
from pathlib import Path

from src.services.meeting_assistant import runner as base
from src.services import assistant_capacity as capacity
from src.services.companion import hub, tokens

logger = logging.getLogger(__name__)
TOOLS = ('read', 'meeting_api', 'web_search')

_lock = threading.Lock()
_runs = {}    # user_id -> CompanionRun


def active(user_id):
    with _lock:
        run = _runs.get(user_id)
    return run if run and not run.finished.is_set() else None


class NoCapacity(RuntimeError):
    """内存放不下再多一个回复：调用方让它排队。"""


def _register(run):
    with _lock:
        current = _runs.get(run.user_id)
        if current and not current.finished.is_set():
            return False
        _runs[run.user_id] = run
        return True


def _unregister(run):
    with _lock:
        if _runs.get(run.user_id) is run:
            _runs.pop(run.user_id, None)


class CompanionSettings(base.Settings):
    @property
    def extension(self):
        return self.assistant_dir / 'companion-tools.ts'

    @property
    def skills_dir(self):
        return self.assistant_dir / 'skills'

    def check(self):
        for path, what in ((self.pi_cli, 'pi'), (self.extension, '小助理扩展'),
                           (self.skills_dir / 'assistant-companion' / 'SKILL.md', '小助理 skill'),
                           (self.skills_dir / 'meeting-api' / 'SKILL.md', '接口用法 skill')):
            if not path.exists():
                raise base.AssistantUnavailable(f'找不到{what}：{path}')
        if self.sandbox == 'srt' and not self.srt_cli.exists():
            raise base.AssistantUnavailable(f'找不到沙箱 srt：{self.srt_cli}。')

    @property
    def internal_url(self):
        return os.environ.get('ASSISTANT_INTERNAL_URL', 'http://127.0.0.1:8899').rstrip('/')


class CompanionRun:
    """一次回复（或一次主动运行）。on_* 回调在读取线程里调用。"""

    def __init__(self, app, user_id, session_jsonl, system_prompt, *, proactive=False, on_finish=None, on_after=None, context=None):
        self.app = app
        self.id = uuid.uuid4().hex[:12]   # 页面靠它分辨「还是不是同一次回复」
        self.user_id = user_id
        self.proactive = proactive
        self.on_finish = on_finish
        self.on_after = on_after        # 进程退出、登记撤掉之后调用（这时可以开始下一次运行）
        self.settings = CompanionSettings.from_env()
        self.settings.check()
        self.system_prompt = system_prompt
        self.session_jsonl = session_jsonl
        self.finished = threading.Event()
        self.token = tokens.issue(user_id, ttl=self.settings.timeout + 300, context=context)
        self.segments = []          # [{'text', 'tools', 'thought', 'thought_ms'}] 每段回复（插话会切分段落）
        self.current = _segment()
        self.thinking_chars = 0
        self._thinking_since = None
        self._thought_buffer = ''   # 还没推给页面的思考文字（攒一小批再推，不一个字一推）
        self._thought_pushed_at = 0.0
        self.error = None
        self.aborted = False
        self.closing = False        # 已收到 agent_end：再插话 pi 也不会处理了
        self.ended = False          # 回复已保存成消息：不再出现在快照里
        self.thinking = False
        self.steers = []            # 发出去的插话
        self.user_messages = 0      # pi 收到的用户消息数（第一条是开头的消息，之后每条是一次插话）
        self._send_lock = threading.Lock()
        self.process = None
        self.work = Path(tempfile.mkdtemp(prefix='jst-companion-', dir=self.settings.work_root)).resolve()

    # ---------------------------------------------------------------- 启动
    def _prepare(self):
        s = self.settings
        for sub in ('session', 'agent', 'home', 'tmp', 'state'):
            (self.work / sub).mkdir(parents=True, exist_ok=True)
        self.session_file = self.work / 'session' / 'session.jsonl'
        if self.session_jsonl:
            base._write(self.session_file, base._session_with_cwd(self.session_jsonl, self.work / 'tmp'))
        base._write(self.work / 'agent' / 'models.json', json.dumps(base._models_json(s), ensure_ascii=False))
        base._write(self.work / 'agent' / 'settings.json', json.dumps({
            'compaction': {'enabled': True}, 'retry': {'enabled': True, 'maxRetries': 3}, 'quietStartup': True,
            'steeringMode': 'all',
        }))
        base._write(self.work / 'state' / 'run.json', json.dumps({
            'apiBase': s.internal_url, 'token': self.token, 'skillsDir': str(s.skills_dir),
            'maxOutputTokens': s.max_tokens,
        }))
        if s.sandbox == 'srt':
            srt = base._srt_settings(s, self.work)
            srt['network']['allowedDomains'].append(base._network_target(s.internal_url))
            base._write(self.work / 'state' / 'srt.json', json.dumps(srt, ensure_ascii=False))

    def _command(self):
        s = self.settings
        pi = [
            s.node, f'--max-old-space-size={max(128, s.memory_mb - 128)}', str(s.pi_cli),
            '--mode', 'rpc',
            '--provider', base.PROVIDER, '--model', s.model, '--thinking', s.thinking,
            '--session', str(self.session_file),
            '--no-builtin-tools', '--tools', ','.join(TOOLS),
            '--no-extensions', '-e', str(s.extension),
            # 两个 skill 都按需读：pi 会把名字、描述和位置列进系统提示词
            '--no-skills', '--skill', str(s.skills_dir / 'assistant-companion'), '--skill', str(s.skills_dir / 'meeting-api'),
            '--no-context-files', '--no-prompt-templates', '--no-themes',
            '--system-prompt', self.system_prompt,
        ]
        if s.sandbox == 'srt':
            pi = [s.node, str(s.srt_cli), '--settings', str(self.work / 'state' / 'srt.json'), '--',
                  '/usr/bin/env', 'NO_PROXY=', 'no_proxy='] + pi
        return pi

    def start(self, message, slot=None):
        """slot：排队轮到时带着已经占好的名额；不带时现场看内存放不放得下，放不下抛 NoCapacity。"""
        self.slot = slot or capacity.acquire(capacity.BACKGROUND if self.proactive else capacity.CHAT, f'companion:{self.user_id}')
        if self.slot is None:
            tokens.revoke(self.token)
            self._cleanup()
            raise NoCapacity()
        if not _register(self):
            capacity.release(self.slot)
            tokens.revoke(self.token)
            self._cleanup()
            raise RuntimeError('busy')
        try:
            self._prepare()
            env = {
                'PATH': os.environ.get('PATH', '/usr/bin:/bin'), 'HOME': str(self.work / 'home'),
                'TMPDIR': str(self.work / 'tmp'), 'LANG': 'C.UTF-8',
                'PI_CODING_AGENT_DIR': str(self.work / 'agent'), 'PI_OFFLINE': '1', 'PI_SKIP_VERSION_CHECK': '1',
                'PI_TELEMETRY': '0', 'MEETING_COMPANION_RUN': str(self.work / 'state' / 'run.json'),
                base.API_KEY_ENV: self.settings.api_key,
            }
            self.process = subprocess.Popen(self._command(), cwd=self.work / 'tmp', env=env, stdin=subprocess.PIPE,
                                            stdout=subprocess.PIPE, stderr=subprocess.PIPE, start_new_session=True)
        except Exception:
            # 没起来：撤掉登记、还回名额，不然这个用户会一直显示「正在回复」
            _unregister(self)
            capacity.release(self.slot)
            tokens.revoke(self.token)
            self._cleanup()
            raise
        self.started_at = time.time()
        threading.Thread(target=self._read, daemon=True).start()
        threading.Thread(target=self._drain_stderr, daemon=True).start()
        threading.Thread(target=self._watchdog, daemon=True).start()
        self._send({'type': 'prompt', 'message': message})
        if not self.proactive:
            with hub.guard(self.user_id):
                hub.publish(self.user_id, 'run', {'state': 'start', 'run': self.id})

    # ---------------------------------------------------------------- 命令
    def _send(self, command):
        with self._send_lock:
            if self.process is None or self.process.poll() is not None or self.process.stdin.closed:
                return False
            try:
                self.process.stdin.write((json.dumps(command, ensure_ascii=False) + '\n').encode('utf-8'))
                self.process.stdin.flush()
                return True
            except (BrokenPipeError, OSError, ValueError):
                return False

    def steer(self, text):
        """插话。回复已经结束或已被停止时返回 False，由调用方另起一次回复。"""
        with self._send_lock:
            if self.closing or self.aborted or self.finished.is_set():
                return False
            self.steers.append(text)
        if self._send({'type': 'steer', 'message': text}):
            return True
        with self._send_lock:
            self.steers.remove(text)
        return False

    def undelivered_steers(self):
        """pi 没来得及处理的插话（回复刚好在插话送达前结束）。"""
        delivered = max(0, self.user_messages - 1)
        return self.steers[delivered:]

    def abort(self):
        with hub.guard(self.user_id):
            first = not self.aborted
            self.aborted = True
            if first:
                self._publish('run', {'state': 'stopping', 'run': self.id})
        return self._send({'type': 'abort'})

    # ---------------------------------------------------------------- 快照（页面刷新、重新进入时用）
    def snapshot(self):
        """这次回复现在的样子：还没保存成消息的各段文字和工具调用。调用方须持有 hub.guard。"""
        if self.proactive or self.ended:
            return None
        segments = [dict(seg, tools=[dict(t) for t in seg['tools']], thought=seg['thought'][-THOUGHT_SNAPSHOT:])
                    for seg in self.segments]
        segments.append(dict(self.current, tools=[dict(t) for t in self.current['tools']],
                             thought=self.current['thought'][-THOUGHT_SNAPSHOT:]))
        return {'run': self.id, 'segments': segments, 'thinking': self.thinking, 'stopping': self.aborted}

    def take(self, *, keep_running=False):
        """取走还没保存的段落（由调用方存成消息）。调用方须持有 hub.guard。

        keep_running：用户插话时只取走已经写出的文字和做完的工具；还在跑的工具留在当前段，
        等它结束再更新状态。"""
        taken = list(self.segments)
        self.segments = []
        if keep_running:
            done = [t for t in self.current['tools'] if t['status'] != 'running']
            running = [t for t in self.current['tools'] if t['status'] == 'running']
            if self.current['text'].strip() or done:
                taken.append({**self.current, 'tools': done})
            self.current = _segment(tools=running)
        else:
            if self.current['text'].strip() or self.current['tools']:
                taken.append(self.current)
            self.current = _segment()
        return [seg for seg in taken if seg['text'].strip() or seg['tools']]

    # ---------------------------------------------------------------- 事件
    def _publish(self, event, data):
        if not self.proactive:
            hub.publish(self.user_id, event, {**data, 'run': self.id})

    def _flush_segment(self):
        if self.current['text'].strip() or self.current['tools']:
            self.segments.append(self.current)
        self.current = _segment()

    def _read(self):
        try:
            for raw in self.process.stdout:
                try:
                    event = json.loads(raw)
                except ValueError:
                    continue
                if event.get('type') == 'agent_end':
                    with self._send_lock:
                        self.closing = True
                    break
                with hub.guard(self.user_id):
                    self._handle(event)
        finally:
            self._finish()

    def _handle(self, event):
        kind = event.get('type')
        if kind == 'message_update':
            delta = event.get('assistantMessageEvent') or {}
            if delta.get('type') == 'text_delta':
                self.current['text'] += delta.get('delta') or ''
                self._publish('delta', {'text': delta.get('delta') or ''})
            elif delta.get('type') == 'thinking_start':
                self.thinking = True
                self._thinking_since = time.monotonic()
                if self.current['thought'] and not self.current['thought'].endswith('\n\n'):
                    self.current['thought'] += '\n\n'     # 同一段里第二次思考（查完资料再想）：空一行
                self._publish('thinking', {'state': 'start'})
            elif delta.get('type') == 'thinking_delta':
                text = delta.get('delta') or ''
                self.thinking_chars += len(text)
                self.current['thought'] = (self.current['thought'] + text)[-THOUGHT_KEEP:]
                self._thought_buffer += text
                now = time.monotonic()
                if len(self._thought_buffer) >= 80 or now - self._thought_pushed_at > .15:
                    self._push_thought(now)
            elif delta.get('type') == 'thinking_end':
                self._push_thought(time.monotonic())
                self.thinking = False
                if self._thinking_since is not None:
                    self.current['thought_ms'] += int((time.monotonic() - self._thinking_since) * 1000)
                    self._thinking_since = None
                self._publish('thinking', {'state': 'end', 'chars': self.thinking_chars, 'ms': self.current['thought_ms']})
        elif kind == 'message_start':
            message = event.get('message') or {}
            if message.get('role') == 'user':
                self.user_messages += 1
            if message.get('role') == 'user' and (self.current['text'] or self.current['tools']):
                # 插话被送达：之前的回复成为单独一段
                self._flush_segment()
                self._publish('segment', {})
        elif kind == 'message_end':
            message = event.get('message') or {}
            if message.get('role') == 'assistant' and message.get('stopReason') == 'error' and message.get('errorMessage'):
                self.error = message['errorMessage'][:300]
            if message.get('role') == 'assistant':
                # 一条助手消息内的文字后面可能还有工具调用，段落之间空一行
                if self.current['text'] and not self.current['text'].endswith('\n\n'):
                    self.current['text'] += '\n\n'
        elif kind == 'tool_execution_start':
            tool = {'id': event.get('toolCallId'), 'tool': event.get('toolName'), 'label': _label(event), 'status': 'running'}
            self.current['tools'].append(tool)
            self._publish('tool', tool)
        elif kind == 'tool_execution_end':
            for tool in self.current['tools']:
                if tool['id'] == event.get('toolCallId'):
                    tool['status'] = 'error' if event.get('isError') else 'ok'
                    self._publish('tool', tool)

    def _push_thought(self, now):
        if self._thought_buffer:
            self._publish('thinking', {'state': 'delta', 'text': self._thought_buffer})
            self._thought_buffer = ''
        self._thought_pushed_at = now

    def _drain_stderr(self):
        for raw in self.process.stderr:
            line = raw.decode('utf-8', 'replace').strip()
            if line:
                logger.debug('companion pi: %s', line[:300])

    def _watchdog(self):
        if not self.finished.wait(self.settings.timeout):
            logger.warning('Companion run for user %s timed out', self.user_id)
            self.error = '这次回复太久了，已经停止。'
            self.abort()
            if not self.finished.wait(10):
                self._kill()

    def _kill(self):
        if self.process and self.process.poll() is None:
            try:
                os.killpg(self.process.pid, signal.SIGTERM)
                self.process.wait(timeout=5)
            except Exception:
                try:
                    os.killpg(self.process.pid, signal.SIGKILL)
                except Exception:
                    pass

    def _finish(self):
        if self.finished.is_set():
            return
        with self._send_lock:
            self.closing = True
        with hub.guard(self.user_id):
            self._flush_segment()
        try:
            with self._send_lock:
                self.process.stdin.close()
        except Exception:
            pass
        try:
            self.process.wait(timeout=10)
        except Exception:
            self._kill()
        session = self.session_file.read_text(encoding='utf-8') if self.session_file.exists() else None
        try:
            if self.on_finish:
                with self.app.app_context():
                    self.on_finish(self, session)
        except Exception:
            logger.exception('Companion run finish failed for user %s', self.user_id)
        finally:
            tokens.revoke(self.token)
            self.finished.set()
            _unregister(self)
            self._cleanup()
            capacity.release(self.slot)   # 放行排队的下一位
        if self.on_after:
            try:
                with self.app.app_context():
                    self.on_after(self)
            except Exception:
                logger.exception('Companion follow-up failed for user %s', self.user_id)

    def _cleanup(self):
        shutil.rmtree(self.work, ignore_errors=True)


THOUGHT_KEEP = 8000       # 每段回复最多留多少字的思考内容（存进消息，可以点开看）
THOUGHT_SNAPSHOT = 2000   # 页面刷新时接上的思考内容（只要够填满思考窗口）


def _segment(tools=None):
    return {'text': '', 'tools': tools or [], 'thought': '', 'thought_ms': 0}


def _label(event):
    """工具调用给用户看的一句话。"""
    args = event.get('args') or {}
    if event.get('toolName') == 'web_search':
        query = ' '.join(str(args.get('query') or '').split())
        return f'联网搜索：{query[:30]}' if query else '联网搜索'
    if event.get('toolName') == 'read':
        path = str(args.get('path') or '')
        return '查看用法说明' if 'meeting-api' in path else '查看自己的角色说明' if 'assistant-companion' in path else '读取说明'
    method = str(args.get('method') or 'GET').upper()
    path = str(args.get('path') or '')
    head = path.split('?')[0]
    if head.startswith('/meetings') and head.endswith('/transcript'):
        return '阅读会议原文'
    if head.startswith('/meetings/'):
        return '查看会议摘要'
    if head.startswith('/meetings'):
        return '查看会议列表'
    if head.startswith('/search'):
        return '搜索会议'
    if head.startswith('/todos'):
        return '整理待办'
    if head.startswith('/memory'):
        return {'GET': '查看长期记忆', 'POST': '记住新信息', 'PATCH': '更新记忆', 'DELETE': '删除记忆'}.get(method, '长期记忆')
    if head.startswith('/reminders'):
        return {'GET': '查看提醒', 'POST': '设置提醒', 'PATCH': '修改提醒', 'DELETE': '删除提醒'}.get(method, '提醒')
    if head.startswith('/messages'):
        return '发送消息'
    return f'{method} {head}'
