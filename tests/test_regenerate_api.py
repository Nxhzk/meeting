"""重新生成摘要的接口：从旧系统迁移来的会议（有摘要、还没有任何版本）第一次点重新生成。

曾经的问题：先在请求的事务里补写 v1（未提交），再用另一条连接清调用记录，
SQLite 同时只允许一个写事务 → 自己等自己，30 秒后 500「database is locked」。
"""
import json
import re
import time
import unittest
from unittest import mock

PASSWORD = 'Regenerate-test-2026!'


class RegenerateLegacyMeetingTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from _app import app, bcrypt
        from src.database import db
        from src.models import Recording, User
        cls.app = app
        with app.app_context():
            user = User(username='regenlegacy', email='regenlegacy@example.com', email_verified=True,
                        password=bcrypt.generate_password_hash(PASSWORD).decode())
            db.session.add(user)
            db.session.flush()
            lines = [{'speaker': 'SPEAKER_00', 'sentence': f'第{i}句：讨论报价和交付时间。', 'start_time': i, 'end_time': i + 1} for i in range(30)]
            recording = Recording(user_id=user.id, title='迁移来的会议', status='COMPLETED',
                                  transcription=json.dumps(lines, ensure_ascii=False), summary='## 旧系统的摘要\n\n- 报价下周发')
            db.session.add(recording)
            db.session.commit()
            cls.recording_id = recording.id

    def test_first_regenerate_of_a_migrated_meeting_does_not_lock_the_database(self):
        from src.database import db
        from src.models.meeting_assistant import SummaryVersion
        from src.services import job_queue
        from src.services.meeting_assistant import runner
        client = self.app.test_client()
        token = re.search(r'"csrfToken": ?"([^"]+)"', client.get('/login').get_data(as_text=True)).group(1)
        client.post('/login', data={'email': 'regenlegacy@example.com', 'password': PASSWORD, 'csrf_token': token})
        client.environ_base['HTTP_X_CSRFTOKEN'] = token
        with mock.patch.object(runner.Settings, 'check', return_value=None), \
                mock.patch.object(job_queue.job_queue, 'enqueue', return_value=None):
            started = time.time()
            response = client.post(f'/api/meetings/{self.recording_id}/summary/regenerate', json={})
        self.assertEqual(response.status_code, 200, response.get_data(as_text=True)[:300])
        self.assertLess(time.time() - started, 5)
        with self.app.app_context():
            legacy = SummaryVersion.query.filter_by(recording_id=self.recording_id).all()
            self.assertEqual([(v.version, v.source) for v in legacy], [(1, 'legacy')])


    def test_a_crashed_assistant_is_retried_once(self):
        # 会议助手进程偶尔崩溃（内存瞬间不够）：自动再跑一次，不需要用户点「重新生成」
        from types import SimpleNamespace
        from src.services.meeting_assistant import runner, service
        from src.tasks import processing
        crash = runner.AssistantRunFailed('会议助手异常退出（134）。')
        crash.crashed = True
        done = SimpleNamespace(version=2, duration_seconds=1, markdown='## 摘要')
        with mock.patch.object(service, 'generate', side_effect=[crash, done]) as generate, \
                mock.patch.object(processing, 'finish_processing', return_value=None), \
                mock.patch('src.services.webhook_dispatch.emit_summary_result', return_value=None):
            processing.generate_summary_only_task(self.app.app_context(), self.recording_id)
        self.assertEqual(generate.call_count, 2)

    def test_a_model_error_is_not_retried(self):
        from src.services.meeting_assistant import runner, service
        from src.tasks import processing
        failure = runner.AssistantRunFailed('模型调用失败：400')
        with mock.patch.object(service, 'generate', side_effect=[failure]) as generate, \
                mock.patch('src.services.webhook_dispatch.emit_summary_result', return_value=None):
            try:
                processing.generate_summary_only_task(self.app.app_context(), self.recording_id)
            except Exception:
                pass
        self.assertEqual(generate.call_count, 1)


if __name__ == '__main__':
    unittest.main()
