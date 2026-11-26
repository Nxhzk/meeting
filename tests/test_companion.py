"""小助理：一次性凭证、提醒时间计算、内部接口的隔离与权限、页面接口。

不启动 pi：小助理调用的内部接口和页面接口在这里直接测。
"""
import os
import re
import unittest
from datetime import datetime

PASSWORD = 'Companion-test-2026!'


class TokensAndScheduleTest(unittest.TestCase):
    def test_token_carries_user_and_context_and_can_be_revoked(self):
        from src.services.companion import tokens
        token = tokens.issue(7, ttl=60, context={'reminder_id': 3})
        self.assertEqual(tokens.resolve(token), (7, {'reminder_id': 3}))
        tokens.revoke(token)
        self.assertEqual(tokens.resolve(token), (None, {}))
        self.assertEqual(tokens.resolve('made-up'), (None, {}))
        expired = tokens.issue(7, ttl=-1)
        self.assertEqual(tokens.resolve(expired), (None, {}))

    def test_next_occurrence_follows_the_repeat_rule(self):
        from src.services.companion import schedule
        monday_10 = datetime(2026, 11, 23, 10, 0)            # 周一
        self.assertEqual(schedule.next_occurrence('daily', '08:30', None, 'Asia/Shanghai', monday_10),
                         datetime(2026, 11, 24, 8, 30))
        self.assertEqual(schedule.next_occurrence('daily', '11:00', None, 'Asia/Shanghai', monday_10),
                         datetime(2026, 11, 23, 11, 0))
        friday_10 = datetime(2026, 11, 27, 10, 0)
        self.assertEqual(schedule.next_occurrence('weekdays', '09:00', None, 'Asia/Shanghai', friday_10),
                         datetime(2026, 11, 30, 9, 0))           # 跳过周末
        self.assertEqual(schedule.next_occurrence('weekly', '09:00', 0, 'Asia/Shanghai', monday_10),
                         datetime(2026, 11, 30, 9, 0))           # 下周一
        self.assertEqual(schedule.to_utc(datetime(2026, 11, 24, 8, 30), 'Asia/Shanghai'), datetime(2026, 11, 24, 0, 30))
        with self.assertRaises(ValueError):
            schedule.parse_hhmm('25:00')


class CompanionApiTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from _app import app, bcrypt
        from src.database import db
        from src.models import Recording, User

        cls.app = app
        with app.app_context():
            cls.addClassCleanup(db.engine.dispose)
            owner = User(username='companionowner', email='companion@example.com', email_verified=True,
                         password=bcrypt.generate_password_hash(PASSWORD).decode())
            other = User(username='companionother', email='companion-other@example.com', email_verified=True,
                         password=bcrypt.generate_password_hash(PASSWORD).decode())
            db.session.add_all([owner, other])
            db.session.flush()
            mine = Recording(user_id=owner.id, title='我的周会', status='COMPLETED', summary='## 决定\n\n- 报价下周发')
            theirs = Recording(user_id=other.id, title='别人的会', status='COMPLETED', summary='## 决定\n\n- 机密')
            db.session.add_all([mine, theirs])
            db.session.commit()
            cls.owner_id, cls.other_id, cls.mine_id, cls.theirs_id = owner.id, other.id, mine.id, theirs.id

    def internal(self, user_id=None, **extra):
        from src.services.companion import tokens
        headers = {'X-Assistant-Token': tokens.issue(user_id or self.owner_id, context=extra or None)}
        return self.app.test_client(), headers

    def test_internal_api_needs_a_token_and_rejects_requests_through_nginx(self):
        client, headers = self.internal()
        self.assertEqual(client.get('/internal/assistant/meetings').status_code, 401)
        self.assertEqual(client.get('/internal/assistant/meetings', headers={'X-Assistant-Token': 'nope'}).status_code, 401)
        proxied = {**headers, 'X-Forwarded-For': '1.2.3.4'}
        self.assertEqual(client.get('/internal/assistant/meetings', headers=proxied).status_code, 404)
        self.assertEqual(client.get('/internal/assistant/meetings', headers=headers).status_code, 200)

    def test_web_search_goes_through_the_server_with_sources_and_a_daily_cap(self):
        # 联网搜索由服务器带密钥去搜：小助理拿到回答和来源，拿不到密钥；每人每天有次数上限
        from unittest import mock
        from src.services import web_search
        client, headers = self.internal()
        reply = mock.Mock(status_code=200)
        reply.json.return_value = {'output': {
            'choices': [{'message': {'content': [{'text': '深圳 2026 年最低工资 2520 元[1]。'}]}}],
            'search_info': {'search_results': [{'index': 1, 'title': '深圳市人社局', 'url': 'https://hrss.sz.gov.cn/x', 'site_name': '深圳人社'}]}}}
        web_search._used.clear()
        with mock.patch.dict('os.environ', {'ALIYUN_ASR_API_KEY': 'secret-key-123', 'WEB_SEARCH_DAILY_LIMIT': '2'}), \
                mock.patch('src.services.web_search.httpx.post', return_value=reply) as post:
            first = client.post('/internal/assistant/web-search', json={'query': '深圳最低工资'}, headers=headers)
            self.assertEqual(first.status_code, 200)
            data = first.get_json()
            self.assertIn('2520', data['answer'])
            self.assertEqual(data['sources'][0]['url'], 'https://hrss.sz.gov.cn/x')
            self.assertNotIn('secret-key-123', first.get_data(as_text=True))
            sent = post.call_args.kwargs['json']
            self.assertTrue(sent['parameters']['enable_search'])
            self.assertEqual(sent['model'], 'qwen3.8-flash')   # 百炼免费额度里的模型
            self.assertEqual(client.post('/internal/assistant/web-search', json={'query': '天气'}, headers=headers).status_code, 200)
            capped = client.post('/internal/assistant/web-search', json={'query': '第三次'}, headers=headers)
            self.assertEqual(capped.status_code, 400)
            self.assertIn('用完', capped.get_json()['error'])
            self.assertEqual(post.call_count, 2)
            empty = client.post('/internal/assistant/web-search', json={'query': '  '}, headers=headers)
            self.assertEqual(empty.status_code, 400)

    def test_voice_input_turns_speech_into_text_with_memory_names_as_hints(self):
        # 语音输入：服务器带密钥去识别，提示词里有公司名和这位用户记忆里的人物；格式、空录音会被拒绝
        import re as _re
        from unittest import mock
        from src.database import db
        from src.models.meeting_assistant import MemoryEntry
        from src.services import voice_input
        with self.app.app_context():
            db.session.add(MemoryEntry(user_id=self.owner_id, category='person', content='卢总是采购负责人，负责供应商谈判和每月对账'))
            db.session.commit()
        client = self.app.test_client()
        self.login(client)
        token = client.environ_base['HTTP_X_CSRFTOKEN']
        reply = mock.Mock(status_code=200)
        reply.json.return_value = {'choices': [{'message': {'content': '明天下午三点提醒我给卢总回电话。'}}]}
        voice_input._used.clear()
        with mock.patch.dict('os.environ', {'ALIYUN_ASR_API_KEY': 'secret-key-123'}), \
                mock.patch('src.services.voice_input.httpx.post', return_value=reply) as post:
            ok = client.post('/api/assistant/transcribe', data=b'fake-opus', content_type='audio/webm;codecs=opus',
                             headers={'X-CSRFToken': token})
            self.assertEqual(ok.status_code, 200, ok.get_data(as_text=True))
            self.assertEqual(ok.get_json()['text'], '明天下午三点提醒我给卢总回电话。')
            sent = post.call_args.kwargs['json']
            hint = sent['messages'][0]['content'][0]['text']
            self.assertIn('捷士通', hint)
            self.assertIn('卢总', hint)
            self.assertNotIn('供应商谈判', hint)   # 只发名字，不发记忆的整句内容
            self.assertTrue(sent['messages'][1]['content'][0]['input_audio']['data'].startswith('data:audio/webm;base64,'))
            self.assertNotIn('secret-key-123', ok.get_data(as_text=True))
            # 没听清时模型会把提示词吐出来：当作没识别出来
            reply.json.return_value = {'choices': [{'message': {'content': hint}}]}
            echo = client.post('/api/assistant/transcribe', data=b'fake-opus', content_type='audio/webm', headers={'X-CSRFToken': token})
            self.assertEqual(echo.get_json()['text'], '')
            bad = client.post('/api/assistant/transcribe', data=b'x', content_type='text/plain', headers={'X-CSRFToken': token})
            self.assertEqual(bad.status_code, 400)
            empty = client.post('/api/assistant/transcribe', data=b'', content_type='audio/webm', headers={'X-CSRFToken': token})
            self.assertEqual(empty.status_code, 400)

    def test_internal_api_only_sees_the_users_own_meetings(self):
        client, headers = self.internal()
        titles = [m['title'] for m in client.get('/internal/assistant/meetings', headers=headers).get_json()['meetings']]
        self.assertIn('我的周会', titles)
        self.assertNotIn('别人的会', titles)
        self.assertEqual(client.get(f'/internal/assistant/meetings/{self.theirs_id}', headers=headers).status_code, 404)
        found = client.get('/internal/assistant/search?q=机密', headers=headers).get_json()['meetings']
        self.assertEqual(found, [])

    def test_memory_written_by_the_companion_is_logged_as_companion(self):
        from src.models.meeting_assistant import MemoryEvent
        client, headers = self.internal()
        created = client.post('/internal/assistant/memory', headers=headers,
                              json={'category': 'preference', 'content': '喜欢先看结论', 'reason': '用户说的'})
        self.assertEqual(created.status_code, 201)
        ref = created.get_json()['id']
        self.assertEqual(client.patch(f'/internal/assistant/memory/{ref}', headers=headers,
                                      json={'content': '喜欢先看结论再看过程'}).status_code, 200)
        with self.app.app_context():
            actors = {e.actor for e in MemoryEvent.query.filter_by(entry_id=int(ref[1:])).all()}
        self.assertEqual(actors, {'companion'})
        # 别人的凭证碰不到这条记忆
        other_client, other_headers = self.internal(self.other_id)
        self.assertEqual(other_client.delete(f'/internal/assistant/memory/{ref}', headers=other_headers).status_code, 404)

    def test_reminders_validate_time_and_the_brief_cannot_be_deleted(self):
        from src.services.companion import service
        with self.app.app_context():
            service.ensure_brief(self.owner_id)
        client, headers = self.internal()
        past = client.post('/internal/assistant/reminders', headers=headers,
                           json={'title': '过去', 'repeat': 'once', 'at': '2020-01-01T09:00'})
        self.assertEqual(past.status_code, 400)
        weekly = client.post('/internal/assistant/reminders', headers=headers,
                             json={'title': '看周报', 'repeat': 'weekly', 'weekday': 0, 'time': '09:00'})
        self.assertEqual(weekly.status_code, 201, weekly.get_data(as_text=True))
        self.assertIsNotNone(weekly.get_json()['next_run_local'])
        reminders = client.get('/internal/assistant/reminders', headers=headers).get_json()['reminders']
        brief = next(r for r in reminders if r['is_brief'])
        self.assertEqual(client.delete(f"/internal/assistant/reminders/{brief['id']}", headers=headers).status_code, 400)
        off = client.patch(f"/internal/assistant/reminders/{brief['id']}", headers=headers, json={'enabled': False})
        self.assertFalse(off.get_json()['enabled'])

    def test_proactive_message_reaches_unread_and_the_app_poll(self):
        client, headers = self.internal(reminder_id=None, is_brief=True)
        sent = client.post('/internal/assistant/messages', headers=headers, json={'text': '今天有两件事到期'})
        self.assertEqual(sent.status_code, 201)
        page = self.app.test_client()
        self.login(page)
        notifications = page.get('/api/assistant/notifications?since=0').get_json()
        self.assertIn('今天有两件事到期', [m['text'] for m in notifications['messages']])
        state = page.get('/api/assistant/state').get_json()
        self.assertGreaterEqual(state['unread'], 1)
        brief = next(m for m in state['messages'] if m['content'] == '今天有两件事到期')
        self.assertTrue(brief['meta']['brief'])
        page.post('/api/assistant/read', json={})
        self.assertEqual(page.get('/api/assistant/state').get_json()['unread'], 0)
        self.assertEqual(page.post('/api/assistant/messages', json={'text': '  '}).status_code, 400)

    def login(self, client):
        token = re.search(r'"csrfToken": ?"([^"]+)"', client.get('/login').get_data(as_text=True)).group(1)
        response = client.post('/login', data={'email': 'companion@example.com', 'password': PASSWORD, 'csrf_token': token})
        self.assertIn(response.status_code, (302, 303))
        client.environ_base['HTTP_X_CSRFTOKEN'] = token


class HubLimitsTest(unittest.TestCase):
    """事件流每条占一个线程：总数和每人的条数有上限，超出时关掉最早的。"""

    def setUp(self):
        from src.services.companion import hub
        self.hub = hub
        self.saved = (hub.MAX_STREAMS, hub.MAX_STREAMS_PER_USER)
        hub.MAX_STREAMS, hub.MAX_STREAMS_PER_USER = 4, 2
        self.opened = []

    def tearDown(self):
        for user_id, q in self.opened:
            self.hub.unsubscribe(user_id, q)
        self.hub.MAX_STREAMS, self.hub.MAX_STREAMS_PER_USER = self.saved

    def open(self, user_id):
        q = self.hub.subscribe(user_id)
        self.opened.append((user_id, q))
        return q

    def test_oldest_stream_of_the_same_user_is_closed(self):
        first, second, third = self.open(901), self.open(901), self.open(901)
        self.assertIs(first.get_nowait(), self.hub.BYE)
        self.assertTrue(second.empty() and third.empty())
        self.hub.publish(901, 'message', {'id': 1})
        self.assertTrue(first.empty())          # 关掉的那条不再收到事件
        self.assertEqual(third.get_nowait()['event'], 'message')

    def test_total_streams_are_capped(self):
        queues = [self.open(user_id) for user_id in (911, 912, 913, 914, 915)]
        self.assertIs(queues[0].get_nowait(), self.hub.BYE)
        self.assertEqual(self.hub.stream_count(), 4)


class FakeRun:
    def __init__(self, proactive=False, accepts=True, text=''):
        import threading
        self.proactive, self.accepts, self.steered = proactive, accepts, []
        self.finished = threading.Event()
        self.id = 'fake-run'
        self.text = text

    def steer(self, text):
        self.steered.append(text)
        return self.accepts

    def take(self, keep_running=False):
        taken = [{'text': self.text, 'tools': []}] if self.text else []
        self.text = ''
        return taken

    def snapshot(self):
        return {'run': self.id, 'segments': [{'text': self.text, 'tools': []}], 'thinking': False, 'stopping': False}


class SendOrderingTest(unittest.TestCase):
    """发消息时小助理正在忙的几种情况：不能出现收下了却没人回复的消息。"""

    @classmethod
    def setUpClass(cls):
        from _app import app
        from src.database import db
        from src.models import User
        cls.app = app
        with app.app_context():
            user = User(username='sendorder', email='sendorder@example.com', email_verified=True, password='x')
            db.session.add(user)
            db.session.commit()
            cls.user_id = user.id

    def setUp(self):
        from unittest import mock
        from src.services.companion import service
        self.service = service
        self.started = []
        patcher = mock.patch.object(service, '_start_chat', side_effect=lambda uid, prompt, slot=None: self.started.append(prompt))
        patcher.start()
        self.addCleanup(patcher.stop)
        service._queued.pop(self.user_id, None)

    def active(self, run):
        from unittest import mock
        from src.services.companion import runner
        patcher = mock.patch.object(runner, 'active', return_value=run)
        patcher.start()
        self.addCleanup(patcher.stop)

    def kinds(self):
        from src.models.companion import CompanionMessage
        return [m.kind for m in CompanionMessage.query.filter_by(user_id=self.user_id).order_by(CompanionMessage.id)]

    def test_message_during_a_reply_is_a_steer(self):
        run = FakeRun()
        self.active(run)
        with self.app.app_context():
            self.service.send(self.user_id, '顺便看看周报')
            self.assertEqual(self.kinds()[-1], 'steer')
        self.assertEqual(len(run.steered), 1)
        self.assertEqual(self.started, [])

    def test_steer_that_cannot_be_delivered_starts_a_new_reply(self):
        run = FakeRun(accepts=False)
        run.finished.set()              # 回复刚好结束
        self.active(run)
        with self.app.app_context():
            self.service.send(self.user_id, '还有一件事')
            self.assertEqual(self.kinds()[-1], 'chat')
        self.assertEqual(len(self.started), 1)

    def test_message_during_a_reminder_is_queued_and_answered_after_it(self):
        reminder = FakeRun(proactive=True)
        self.active(reminder)
        with self.app.app_context():
            self.service.send(self.user_id, '在吗')
            self.assertEqual(self.kinds()[-1], 'chat')
        self.assertEqual(self.started, [])
        self.assertTrue(self.service.has_queued(self.user_id))
        reminder.user_id = self.user_id
        self.active(None)
        with self.app.app_context():
            self.service._after_proactive(reminder)
        self.assertEqual(len(self.started), 1)
        self.assertIn('在吗', self.started[0])
        self.assertFalse(self.service.has_queued(self.user_id))


class LiveStateTest(unittest.TestCase):
    """刷新页面、重新进入、事件流重连：进行中的回复都能原样接上。"""

    @classmethod
    def setUpClass(cls):
        from _app import app
        from src.database import db
        from src.models import User
        cls.app = app
        with app.app_context():
            user = User(username='livestate', email='livestate@example.com', email_verified=True, password='x')
            db.session.add(user)
            db.session.commit()
            cls.user_id = user.id

    def run_obj(self):
        from src.services.companion.runner import CompanionRun
        run = CompanionRun.__new__(CompanionRun)
        run.id, run.user_id, run.proactive, run.ended, run.aborted, run.thinking = 'r1', self.user_id, False, False, False, False
        from src.services.companion.runner import _segment
        run.segments, run.current, run.thinking_chars, run.error, run.user_messages = [], _segment(), 0, None, 0
        run._thinking_since, run._thought_buffer, run._thought_pushed_at = None, '', 0.0
        return run

    def feed(self, run, *events):
        for event in events:
            run._handle(event)

    def test_thinking_streams_to_the_page_and_is_kept_with_the_reply(self):
        # 思考内容分批推给页面；刷新时快照里有；保存消息时存成「已思考 N 秒」
        from unittest import mock
        from src.services.companion import hub, service
        run = self.run_obj()
        pushed = []
        with mock.patch.object(hub, 'publish', side_effect=lambda uid, event, data: pushed.append((event, data))):
            self.feed(run,
                      {'type': 'message_update', 'assistantMessageEvent': {'type': 'thinking_start'}},
                      *[{'type': 'message_update', 'assistantMessageEvent': {'type': 'thinking_delta', 'delta': '想一想'}} for _ in range(40)],
                      {'type': 'message_update', 'assistantMessageEvent': {'type': 'thinking_end'}},
                      {'type': 'message_update', 'assistantMessageEvent': {'type': 'text_delta', 'delta': '定了。'}})
        deltas = ''.join(d['text'] for e, d in pushed if e == 'thinking' and d.get('state') == 'delta')
        self.assertEqual(deltas, '想一想' * 40)                       # 一个字都不少
        self.assertLess(sum(1 for e, d in pushed if d.get('state') == 'delta'), 40)   # 攒成批推，不是一字一推
        self.assertIn('想一想', run.snapshot()['segments'][-1]['thought'])
        with self.app.app_context():
            saved = service._segment_messages(run, run.take())
            self.assertEqual(saved[0].meta['thought']['text'], '想一想' * 40)
            self.assertGreaterEqual(saved[0].meta['thought']['seconds'], 1)
            from src.database import db
            db.session.rollback()

    def test_snapshot_has_everything_written_so_far(self):
        run = self.run_obj()
        self.feed(run,
                  {'type': 'message_start', 'message': {'role': 'user'}},
                  {'type': 'tool_execution_start', 'toolCallId': 't1', 'toolName': 'meeting_api', 'args': {'path': '/meetings'}},
                  {'type': 'tool_execution_end', 'toolCallId': 't1'},
                  {'type': 'message_update', 'assistantMessageEvent': {'type': 'text_delta', 'delta': '上周的会定了'}},
                  {'type': 'message_update', 'assistantMessageEvent': {'type': 'text_delta', 'delta': '报价。'}})
        snap = run.snapshot()
        self.assertEqual(snap['run'], 'r1')
        self.assertEqual(snap['segments'][-1]['text'], '上周的会定了报价。')
        self.assertEqual(snap['segments'][-1]['tools'][0]['status'], 'ok')
        run.ended = True
        self.assertIsNone(run.snapshot())       # 存成消息之后不再算「进行中」，避免和消息重复

    def test_steer_keeps_running_tools_in_the_live_part(self):
        run = self.run_obj()
        self.feed(run,
                  {'type': 'message_update', 'assistantMessageEvent': {'type': 'text_delta', 'delta': '我先查一下。'}},
                  {'type': 'tool_execution_start', 'toolCallId': 't2', 'toolName': 'meeting_api', 'args': {'path': '/search'}})
        taken = run.take(keep_running=True)
        self.assertEqual([seg['text'] for seg in taken], ['我先查一下。'])
        self.assertEqual(run.current['tools'][0]['status'], 'running')
        self.feed(run, {'type': 'tool_execution_end', 'toolCallId': 't2'})
        self.assertEqual(run.current['tools'][0]['status'], 'ok')

    def test_state_and_event_stream_carry_the_snapshot(self):
        from unittest import mock
        from src.services.companion import runner, service
        run = FakeRun(text='正在写的回复')
        with mock.patch.object(runner, 'active', return_value=run):
            snap = service.live_snapshot(self.user_id)
        self.assertEqual(snap['segments'][0]['text'], '正在写的回复')
        with mock.patch.object(runner, 'active', return_value=None):
            self.assertIsNone(service.live_snapshot(self.user_id))
            service._queued[self.user_id] = ['x']
            try:
                self.assertTrue(service.live_snapshot(self.user_id)['waiting'])   # 提醒期间收下的消息在等回复
            finally:
                service._queued.pop(self.user_id, None)

    def test_steer_saves_what_was_written_before_it(self):
        """插话之前写出的部分先存，插话排在它后面：刷新前后的顺序都和用户看到的一样。"""
        from unittest import mock
        from src.models.companion import CompanionMessage
        from src.services.companion import hub, runner, service
        run = FakeRun(text='上周的会定了报价。')
        run.user_id = self.user_id
        q = hub.subscribe(self.user_id)
        self.addCleanup(hub.unsubscribe, self.user_id, q)
        with mock.patch.object(runner, 'active', return_value=run), self.app.app_context():
            service.send(self.user_id, '顺便看看周报', 'cid-steer-0001')
            rows = CompanionMessage.query.filter_by(user_id=self.user_id).order_by(CompanionMessage.id).all()[-2:]
            self.assertEqual([(m.role, m.kind) for m in rows], [('assistant', 'chat'), ('user', 'steer')])
            self.assertEqual(rows[0].content, '上周的会定了报价。')
            self.assertEqual(rows[0].meta['run'], 'fake-run')
        events = []
        while not q.empty():
            events.append(q.get_nowait()['event'])
        self.assertEqual(events, ['message', 'message', 'cut'])

    def test_same_client_id_is_saved_once(self):
        from unittest import mock
        from src.models.companion import CompanionMessage
        from src.services.companion import runner, service
        started = []
        with mock.patch.object(runner, 'active', return_value=None), \
                mock.patch.object(service, '_start_chat', side_effect=lambda uid, prompt: started.append(prompt)), \
                self.app.app_context():
            first = service.send(self.user_id, '在吗', 'cid-dup-00001')
            again = service.send(self.user_id, '在吗', 'cid-dup-00001')
            self.assertEqual(first.id, again.id)
            self.assertEqual(CompanionMessage.query.filter_by(user_id=self.user_id, content='在吗').count(), 1)
        self.assertEqual(len(started), 1)

    def test_message_is_withdrawn_when_the_reply_cannot_start(self):
        from unittest import mock
        from src.models.companion import CompanionMessage
        from src.services.companion import runner, service
        from src.services.meeting_assistant.runner import AssistantUnavailable
        with mock.patch.object(runner, 'active', return_value=None), \
                mock.patch.object(service, '_start_chat', side_effect=AssistantUnavailable('没装 pi')), \
                self.app.app_context():
            with self.assertRaises(AssistantUnavailable):
                service.send(self.user_id, '没人回的消息', 'cid-fail-0001')
            self.assertEqual(CompanionMessage.query.filter_by(user_id=self.user_id, content='没人回的消息').count(), 0)

    def test_slow_page_is_reset_instead_of_missing_events(self):
        from src.services.companion import hub
        q = hub.subscribe(self.user_id)
        self.addCleanup(hub.unsubscribe, self.user_id, q)
        for i in range(q.maxsize + 1):
            hub.publish(self.user_id, 'delta', {'text': str(i)})
        self.assertIs(q.get_nowait(), hub.RESET)


class RunnerSteerBookkeepingTest(unittest.TestCase):
    def test_steers_pi_never_saw_are_reported(self):
        from src.services.companion.runner import CompanionRun
        run = CompanionRun.__new__(CompanionRun)
        run.steers, run.user_messages = ['a', 'b', 'c'], 2     # 开头一条 + 插话 a
        self.assertEqual(run.undelivered_steers(), ['b', 'c'])


class InputHardeningTest(unittest.TestCase):
    """页面接口：控制字符不算内容；超大的数字参数是 400 而不是 500；清空后编号不复用。"""

    @classmethod
    def setUpClass(cls):
        from _app import app, bcrypt
        from src.database import db
        from src.models import User
        cls.app = app
        with app.app_context():
            user = User(username='hardening', email='hardening@example.com', email_verified=True,
                        password=bcrypt.generate_password_hash(PASSWORD).decode())
            db.session.add(user)
            db.session.commit()
            cls.owner_id = user.id

    def login(self, client):
        token = re.search(r'"csrfToken": ?"([^"]+)"', client.get('/login').get_data(as_text=True)).group(1)
        response = client.post('/login', data={'email': 'hardening@example.com', 'password': PASSWORD, 'csrf_token': token})
        self.assertIn(response.status_code, (302, 303))
        client.environ_base['HTTP_X_CSRFTOKEN'] = token

    def test_control_characters_are_not_a_message(self):
        page = self.app.test_client()
        self.login(page)
        for text in ['\x00', '\u200b\u200b', ' \x00 \ufeff ']:
            self.assertEqual(page.post('/api/assistant/messages', json={'text': text}).status_code, 400)

    def test_huge_numbers_are_a_bad_request(self):
        page = self.app.test_client()
        self.login(page)
        self.assertEqual(page.get('/api/assistant/messages?before=99999999999999999999999').status_code, 400)
        self.assertEqual(page.get('/api/assistant/notifications?since=99999999999999999999999').status_code, 400)
        self.assertEqual(page.get('/api/meetings/99999999999999999999999').status_code, 404)

    def test_message_ids_are_not_reused_after_clearing(self):
        from src.database import db
        from src.models.companion import CompanionMessage
        from src.services.companion import service
        with self.app.app_context():
            message = CompanionMessage(user_id=self.owner_id, role='user', kind='chat', content='旧消息')
            db.session.add(message)
            db.session.commit()
            old = message.id
            service.clear(self.owner_id)
            fresh = CompanionMessage(user_id=self.owner_id, role='user', kind='chat', content='新消息')
            db.session.add(fresh)
            db.session.commit()
            self.assertGreater(fresh.id, old)


if __name__ == '__main__':
    unittest.main()
