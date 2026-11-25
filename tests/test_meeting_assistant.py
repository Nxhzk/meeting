"""会议助手：资料切分、摘要渲染、完整生成流程、重新生成、隔离和长期记忆接口。

模型由 tests/fixtures/mock_llm_server.py 代替（本机端口，按脚本发工具调用），
pi 是真的在跑；沙箱测试只在本机能用 srt 时运行。
"""
import json
import os
import subprocess
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

HERE = Path(__file__).resolve().parent
PASSWORD = 'Assistant-test-2026!'


def start_mock(**env):
    process = subprocess.Popen([sys.executable, str(HERE / 'fixtures' / 'mock_llm_server.py')],
                               stdout=subprocess.PIPE, text=True, env={**os.environ, **env})
    port = int(process.stdout.readline())
    process.stdout.close()
    return process, f'http://127.0.0.1:{port}/v1'


def stop(process):
    process.kill()
    process.wait()


def segments(n, tail='散会前的最后一句'):
    rows = [{'speaker': f'SPEAKER_0{i % 2}', 'start_time': i * 5, 'end_time': i * 5 + 4,
             'sentence': f'第{i:04d}句，讨论报价和交付安排。'} for i in range(n)]
    rows.append({'speaker': 'SPEAKER_01', 'start_time': n * 5, 'end_time': n * 5 + 3, 'sentence': tail})
    return json.dumps(rows, ensure_ascii=False)


class PartsAndRenderTest(unittest.TestCase):
    def test_long_transcript_is_split_into_small_complete_parts(self):
        from src.services.meeting_assistant.service import split_parts, PART_MAX_LINES, PART_MAX_CHARS
        lines = [f'[00:00:{i % 60:02d}] 发言人 1：' + '字' * 50 for i in range(1000)]
        files, parts = split_parts(lines)
        self.assertEqual(sum(p['lines'] for p in parts), 1000)
        self.assertEqual(parts[0]['first'], 1)
        self.assertEqual(parts[-1]['last'], 1000)
        for part in parts:
            body = files[part['path']]
            self.assertLessEqual(part['lines'], PART_MAX_LINES)
            self.assertLessEqual(len(body), PART_MAX_CHARS + 200)

    def test_summary_is_rendered_conclusions_first_without_cutting_anything(self):
        from src.services.meeting_assistant import render
        long_point = '要点' * 800
        sections = render.normalize({
            'summary': '讨论了报价。', 'decisions': [{'decision': '下周交付'}],
            'action_items': [{'task': '发报价|单', 'owner': ''}],
            'discussion': [{'topic': '报价', 'points': [long_point]}],
            'cautions': {'meeting_process': ['没有议程'], 'business_risks': [], 'recurring': []},
        })
        self.assertEqual(sections['action_items'][0]['owner'], '未明确')
        markdown = render.to_markdown(sections)
        self.assertTrue(markdown.startswith('讨论了报价。'))
        order = [markdown.index(title) for title in ('## 决定', '## 待办', '## 讨论要点', '## 本次注意事项')]
        self.assertEqual(order, sorted(order))
        self.assertIn('### 会议本身', markdown)
        self.assertNotIn('### 业务风险', markdown)      # 空的类别不出现
        self.assertIn(long_point, markdown)              # 程序不截断
        self.assertIn('发报价｜单', markdown)
        with self.assertRaises(render.SummaryInvalid):
            render.normalize({'summary': '  '})


class AssistantFlowTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from _app import app, bcrypt
        from src.database import db
        from src.models import Recording, User

        cls.app = app
        with app.app_context():
            cls.addClassCleanup(db.engine.dispose)
            cls.owner = User(username='assistantowner', email='assistant@example.com', email_verified=True,
                             password=bcrypt.generate_password_hash(PASSWORD).decode())
            cls.other = User(username='assistantother', email='assistant-other@example.com', email_verified=True,
                             password=bcrypt.generate_password_hash(PASSWORD).decode())
            db.session.add_all([cls.owner, cls.other])
            db.session.flush()
            cls.owner_id, cls.other_id = cls.owner.id, cls.other.id
            db.session.commit()

    def new_recording(self, n=300, summary=None, user_id=None):
        from src.database import db
        from src.models import Recording
        with self.app.app_context():
            recording = Recording(user_id=user_id or self.owner_id, title='报价会', status='COMPLETED',
                                  transcription=segments(n), summary=summary)
            db.session.add(recording)
            db.session.commit()
            return recording.id

    def run_generate(self, recording_id, base_url, **kwargs):
        from src.services.meeting_assistant import service
        with self.app.app_context(), patch.dict(os.environ, {'ASSISTANT_MODEL_BASE_URL': base_url}):
            return service.generate(recording_id, **kwargs).id

    def test_generate_then_regenerate_in_the_same_session(self):
        from src.database import db
        from src.models import Recording
        from src.models.meeting_assistant import AssistantSession, MemoryEntry, MemoryEvent, SummaryVersion

        log = Path(self.id().replace('.', '_') + '.log').absolute()
        self.addCleanup(lambda: log.unlink(missing_ok=True))
        server, url = start_mock(MOCK_LLM_LOG=str(log))
        self.addCleanup(stop, server)
        recording_id = self.new_recording(summary='## 旧摘要\n旧系统写的')
        progress = []
        from src.services.meeting_assistant import service
        with self.app.app_context(), patch.dict(os.environ, {'ASSISTANT_MODEL_BASE_URL': url}):
            service.generate(recording_id, report=progress.append)
            service.generate(recording_id, feedback='注意事项写具体一点')
        with self.app.app_context():
            versions = SummaryVersion.query.filter_by(recording_id=recording_id).order_by(SummaryVersion.version).all()
            self.assertEqual([v.version for v in versions], [1, 2, 3])
            self.assertEqual(versions[0].source, 'legacy')
            self.assertEqual(versions[2].feedback, '注意事项写具体一点')
            self.assertIn('## 本次注意事项', versions[2].markdown)
            self.assertTrue(versions[2].markdown.startswith('讨论报价与交付'))
            self.assertEqual(db.session.get(Recording, recording_id).summary, versions[2].markdown)
            session = AssistantSession.query.filter_by(recording_id=recording_id).one()
            self.assertEqual(session.runs, 2)
            # mock 每次都加一条同样的记忆：两次生成各写一条，都带来源和变更记录。
            entries = MemoryEntry.query.filter_by(user_id=self.owner_id, source_recording_id=recording_id).all()
            self.assertEqual(len(entries), 2)
            self.assertEqual(MemoryEvent.query.filter_by(recording_id=recording_id, actor='assistant').count(), 2)
        self.assertIn('正在校验', progress)
        with self.app.app_context():
            from src.models.meeting_assistant import AssistantTraceEvent
            trace = AssistantTraceEvent.query.filter_by(recording_id=recording_id).order_by(AssistantTraceEvent.seq).all()
            tools = [(e.tool, e.status) for e in trace if e.kind == 'tool']
            # 只留最近一次运行；每个工具调用都从 running 收尾成 ok
            self.assertIn(('read', 'ok'), tools)
            self.assertIn(('save_summary', 'ok'), tools)
            self.assertNotIn('running', [e.status for e in trace])
            self.assertEqual([e.seq for e in trace], sorted({e.seq for e in trace}))
            read = next(e for e in trace if e.tool == 'read' and e.data.get('range'))
            self.assertEqual(read.data['index'], 1)
        requests = [json.loads(line)['body'] for line in log.read_text().splitlines()]
        first_user = next(m for m in requests[0]['messages'] if m['role'] == 'user')['content']
        self.assertIn('旧系统生成', json.dumps(first_user, ensure_ascii=False))
        # 每一轮的用户消息都带着纪要规范全文
        for body in (requests[0], requests[-1]):
            users = [json.dumps(m['content'], ensure_ascii=False) for m in body['messages'] if m['role'] == 'user']
            self.assertIn('<skill name=\\"meeting-minutes\\"', users[-1])
            self.assertIn('纪要规范', users[-1])
        last = json.dumps(requests[-1]['messages'], ensure_ascii=False)
        # 重新生成带着上一轮的完整上下文和修改意见。
        self.assertIn('注意事项写具体一点', last)
        self.assertIn('请为这场会议生成会议摘要', last)
        self.assertEqual(requests[0]['reasoning_effort'], 'max')
        self.assertEqual(requests[0]['thinking'], {'type': 'enabled'})

    def test_regeneration_remembers_what_was_already_read(self):
        from src.models.meeting_assistant import SummaryVersion
        first, url = start_mock()
        self.addCleanup(stop, first)
        recording_id = self.new_recording(n=300)
        self.run_generate(recording_id, url)
        # 第二轮的模型不再读原文：上一轮在同一会话里读过，必须仍然算数
        lazy, lazy_url = start_mock(MOCK_SKIP_READ='1')
        self.addCleanup(stop, lazy)
        self.run_generate(recording_id, lazy_url, feedback='精简一些')
        with self.app.app_context():
            self.assertEqual(SummaryVersion.query.filter_by(recording_id=recording_id).count(), 2)

    def test_summary_is_refused_until_the_whole_transcript_is_read_and_nothing_is_written(self):
        from src.models.meeting_assistant import MemoryEntry, SummaryVersion
        from src.services.meeting_assistant import service
        server, url = start_mock(MOCK_SKIP_READ='1')
        self.addCleanup(stop, server)
        recording_id = self.new_recording()
        with self.app.app_context():
            before = MemoryEntry.query.count()
        with self.assertRaises(service.AssistantFailed):
            self.run_generate(recording_id, url)
        with self.app.app_context():
            self.assertEqual(SummaryVersion.query.filter_by(recording_id=recording_id).count(), 0)
            self.assertEqual(MemoryEntry.query.count(), before)

    def test_tools_cannot_leave_the_meeting_folder(self):
        log = Path(self.id().replace('.', '_') + '.log').absolute()
        self.addCleanup(lambda: log.unlink(missing_ok=True))
        secret = Path(__file__).resolve()
        server, url = start_mock(MOCK_LLM_LOG=str(log),
                                 MOCK_EVIL_PATHS=f'{secret}|../state/run.json|../../../../etc/hosts')
        self.addCleanup(stop, server)
        recording_id = self.new_recording(n=20)
        self.run_generate(recording_id, url)
        tool_results = [m for line in log.read_text().splitlines()
                        for m in json.loads(line)['body']['messages'] if m['role'] == 'tool']
        texts = [json.dumps(m['content'], ensure_ascii=False) for m in tool_results]
        refused = [t for t in texts if '只能访问本场会议的资料目录' in t or '找不到' in t]
        self.assertGreaterEqual(len(refused), 3)
        self.assertFalse(any('PASSWORD' in t or 'meetingDir' in t or 'localhost' in t for t in texts))

    def test_memory_of_another_user_is_never_touched(self):
        from src.database import db
        from src.models.meeting_assistant import MemoryEntry
        from src.services.meeting_assistant import service
        with self.app.app_context():
            theirs = MemoryEntry(user_id=self.other_id, category='person', content='别人的记忆')
            db.session.add(theirs)
            db.session.commit()
            service.apply_memory_ops(self.owner_id, None, None, [
                {'op': 'update', 'id': f'm{theirs.id}', 'category': 'person', 'content': '被改了'},
                {'op': 'delete', 'id': f'm{theirs.id}'},
            ])
            db.session.commit()
            db.session.refresh(theirs)
            self.assertEqual(theirs.content, '别人的记忆')
            self.assertIsNone(theirs.deleted_at)
            self.assertNotIn(f'm{theirs.id}', [m['id'] for m in service.memory_snapshot(self.owner_id)])

    def test_failed_regeneration_keeps_the_previous_summary(self):
        from src.database import db
        from src.models import Recording
        from src.models.meeting_assistant import SummaryVersion
        from src.services.meeting_assistant.service import last_failure
        from src.tasks import processing
        from src.services.error_classification import SummaryStepFailed
        recording_id = self.new_recording(n=20, summary='## 会议纪要\n\n上一版的摘要')
        # 模型接口不通（_app.py 默认指向 127.0.0.1:9）
        processing.generate_summary_only_task(self.app.app_context(), recording_id, feedback='再具体些')
        with self.app.app_context():
            recording = db.session.get(Recording, recording_id)
            self.assertEqual(recording.status, 'COMPLETED')
            self.assertEqual(recording.summary, '## 会议纪要\n\n上一版的摘要')
            self.assertEqual(SummaryVersion.query.filter_by(recording_id=recording_id).count(), 1)
            self.assertIsNotNone(last_failure(recording_id))
        # 没有任何摘要时失败：标记失败，等用户重试，不让队列自动重跑
        fresh = self.new_recording(n=20)
        with self.assertRaises(SummaryStepFailed) as caught:
            processing.generate_summary_only_task(self.app.app_context(), fresh)
        self.assertTrue(getattr(caught.exception, 'permanent', False))
        with self.app.app_context():
            self.assertEqual(db.session.get(Recording, fresh).status, 'FAILED')

    def test_memory_changed_meanwhile_is_not_overwritten(self):
        from src.database import db
        from src.models.meeting_assistant import MemoryEntry
        from src.services.meeting_assistant import service
        with self.app.app_context():
            entry = MemoryEntry(user_id=self.owner_id, category='recurring_issue', content='会议容易发散')
            db.session.add(entry)
            db.session.commit()
            ref = f'm{entry.id}'
            seen = {ref: ('recurring_issue', '会议容易发散')}
            # 另一场会议的生成先提交了更新
            entry.content = '会议容易发散（搬迁会也出现）'
            db.session.commit()
            service.apply_memory_ops(self.owner_id, None, None, [
                {'op': 'update', 'id': ref, 'category': 'recurring_issue', 'content': '会议容易发散（招聘会也出现）'}], seen)
            db.session.commit()
            db.session.refresh(entry)
            self.assertEqual(entry.content, '会议容易发散（搬迁会也出现）')
            # 同一次运行里连续改同一条：都生效
            seen = {ref: ('recurring_issue', entry.content)}
            service.apply_memory_ops(self.owner_id, None, None, [
                {'op': 'update', 'id': ref, 'category': 'recurring_issue', 'content': '第一次'},
                {'op': 'update', 'id': ref, 'category': 'recurring_issue', 'content': '第二次'}], seen)
            db.session.commit()
            db.session.refresh(entry)
            self.assertEqual(entry.content, '第二次')

    def test_memory_api_edit_delete_restore_with_change_log(self):
        client = self.app.test_client()
        with self.app.app_context():
            from src.database import db
            from src.models import User
            email = db.session.get(User, self.owner_id).email
        self.login(client, email)
        created = client.post('/api/memory', json={'category': 'project', 'content': '捷士通会议迁到腾讯云'})
        self.assertEqual(created.status_code, 201, created.get_data(as_text=True))
        entry_id = created.get_json()['id']
        self.assertEqual(client.patch(f'/api/memory/{entry_id}', json={'content': '会议系统已迁到腾讯云'}).status_code, 200)
        self.assertTrue(client.delete(f'/api/memory/{entry_id}').get_json()['deleted'])
        self.assertNotIn(entry_id, [e['id'] for e in client.get('/api/memory').get_json()['entries']])
        self.assertFalse(client.post(f'/api/memory/{entry_id}/restore').get_json()['deleted'])
        actions = [e['action'] for e in client.get(f'/api/memory/events?entry={entry_id}').get_json()['events']]
        self.assertEqual(actions, ['restore', 'delete', 'update', 'add'])
        self.assertEqual(client.post('/api/memory', json={'category': 'nope', 'content': 'x'}).status_code, 400)
        self.assertEqual(client.post('/api/memory', json={'category': 'project', 'content': '长' * 501}).status_code, 400)

    def login(self, client, email):
        page = client.get('/login')
        import re
        token = re.search(r'"csrfToken": ?"([^"]+)"', page.get_data(as_text=True)).group(1)
        response = client.post('/login', data={'email': email, 'password': PASSWORD, 'csrf_token': token})
        self.assertIn(response.status_code, (302, 303))
        client.environ_base['HTTP_X_CSRFTOKEN'] = token


@unittest.skipUnless(sys.platform == 'darwin' or os.path.exists('/usr/bin/bwrap'), 'srt needs sandbox-exec or bubblewrap')
class SandboxTest(unittest.TestCase):
    def test_sandbox_blocks_reading_the_app_and_home(self):
        import tempfile
        from src.services.meeting_assistant import runner
        settings = runner.Settings(
            base_url='http://127.0.0.1:9/v1', api_key='x', model='m', thinking='off', context_window=1000,
            max_tokens=1000, timeout=30, sandbox='srt', node=str(Path(__import__('shutil').which('node')).resolve()),
            assistant_dir=runner.REPO_ROOT / 'assistant', work_root=None, memory_mb=256, systemd_run=False)
        if not settings.srt_cli.exists():
            self.skipTest('assistant/ 未安装')
        work = Path(tempfile.mkdtemp()).resolve()
        self.addCleanup(__import__('shutil').rmtree, work, True)
        (work / 'meeting').mkdir()
        (work / 'meeting' / 'ok.md').write_text('可以读')
        (work / 'state').mkdir()
        config = work / 'state' / 'srt.json'
        config.write_text(json.dumps(runner._srt_settings(settings, work)))
        def sandboxed(*cmd):
            return subprocess.run([settings.node, str(settings.srt_cli), '--settings', str(config), '--', *cmd],
                                  capture_output=True, text=True, timeout=60)
        self.assertEqual(sandboxed('/bin/cat', str(work / 'meeting' / 'ok.md')).stdout, '可以读')
        self.assertNotEqual(sandboxed('/bin/cat', str(runner.REPO_ROOT / 'README.md')).returncode, 0)
        self.assertNotEqual(sandboxed('/bin/sh', '-c', f'echo x > {work}/meeting/ok.md').returncode, 0)
        self.assertNotEqual(sandboxed('/usr/bin/curl', '-sS', '--max-time', '5', 'https://example.com').returncode, 0)


if __name__ == '__main__':
    unittest.main()
