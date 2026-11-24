"""Aliyun ASR connector and the summary request sent to the model gateway.

Both talk to services that are not reachable from a test run, so the HTTP
layer is replaced: DashScope by an httpx mock transport, the model by a stub.
"""
import base64
import io
import json
import os
import unittest
from unittest.mock import MagicMock, patch

import httpx

from src.services.transcription.connectors import aliyun_asr
from src.services.transcription.base import TranscriptionRequest
from src.services.transcription.exceptions import ConfigurationError, ProviderError, TranscriptionError

THINKING_MAX = {'thinking': {'type': 'enabled'}, 'reasoning_effort': 'max'}
MODEL_MAX_OUTPUT = 393216
PASSWORD = 'Summary-test-2026!'


class AliyunConnectorTest(unittest.TestCase):
    CONFIG = {'api_key': 'sk-test', 'timeout': '5', 'poll_interval': '0.01'}
    RESULT_URL = 'https://result.example/r.json'

    def connector(self, **extra):
        return aliyun_asr.AliyunASRConnector({**self.CONFIG, **extra})

    def run_with_aliyun(self, connector, request, handler, staged=True):
        """transcribe() with every DashScope call answered by handler(method, url, body)."""
        calls = []

        def transport(http_request):
            body = json.loads(http_request.content) if http_request.content else None
            calls.append((http_request.method, str(http_request.url), body, dict(http_request.headers)))
            return handler(http_request.method, str(http_request.url), body)

        real_client = httpx.Client
        s3 = MagicMock()
        s3.build_locator.return_value = 's3://bucket/aliyun-asr/x.mp3'
        s3.presign_get_url.return_value = 'https://bucket.example/aliyun-asr/x.mp3?sig=1'
        storage = MagicMock(s3=s3 if staged else None)
        with patch.object(aliyun_asr.httpx, 'Client',
                          lambda **kwargs: real_client(transport=httpx.MockTransport(transport), **kwargs)), \
                patch('src.services.storage.get_storage_service', return_value=storage), \
                patch('src.services.storage.parse_locator', side_effect=lambda value: MagicMock(raw=value)):
            return connector.transcribe(request), calls, s3

    def test_without_key_the_app_refuses_to_start_unless_told_otherwise(self):
        with self.assertRaises(ConfigurationError):
            aliyun_asr.AliyunASRConnector({})
        pending = aliyun_asr.AliyunASRConnector({'allow_unconfigured': True})
        self.assertFalse(pending.is_configured)
        request = TranscriptionRequest(audio_file=io.BytesIO(b'x'), filename='a.mp3')
        with self.assertRaises(aliyun_asr.AliyunSetupPending) as caught:
            pending.transcribe(request)
        self.assertTrue(caught.exception.permanent)
        self.assertTrue(str(caught.exception).startswith(aliyun_asr.PENDING_SETUP))

    def test_meeting_audio_is_staged_submitted_with_diarization_and_parsed(self):
        saved = []
        polls = []

        def handler(method, url, body):
            if method == 'POST':
                return httpx.Response(200, json={'output': {'task_id': 'task-42', 'task_status': 'PENDING'}})
            if url.endswith('/tasks/task-42'):
                polls.append(url)
                if len(polls) == 1:
                    return httpx.Response(200, json={'output': {'task_status': 'RUNNING'}})
                return httpx.Response(200, json={'output': {'task_status': 'SUCCEEDED', 'results': [
                    {'subtask_status': 'SUCCEEDED', 'transcription_url': self.RESULT_URL}]}})
            self.assertEqual(url, self.RESULT_URL)
            return httpx.Response(200, json={
                'properties': {'original_duration_in_milliseconds': 12500},
                'transcripts': [{'sentences': [
                    {'begin_time': 0, 'end_time': 2100, 'text': '大家好，开始开会。', 'speaker_id': 0},
                    {'begin_time': 2100, 'end_time': 2200, 'text': ' ', 'speaker_id': 0},
                    {'begin_time': 2300, 'end_time': 4000, 'text': '先看上周的进度。', 'speaker_id': 1}]}]})

        request = TranscriptionRequest(audio_file=io.BytesIO(b'audio' * 100), filename='meeting.mp3',
                                       mime_type='audio/mpeg', diarize=True, max_speakers=3,
                                       save_provider_task=saved.append)
        response, calls, s3 = self.run_with_aliyun(self.connector(), request, handler)

        submit = next(call for call in calls if call[0] == 'POST')
        self.assertTrue(submit[1].endswith('/services/audio/asr/transcription'))
        self.assertEqual(submit[3]['authorization'], 'Bearer sk-test')
        self.assertEqual(submit[3]['x-dashscope-async'], 'enable')
        self.assertEqual(submit[2]['model'], 'fun-asr')
        self.assertEqual(submit[2]['input'], {'file_urls': ['https://bucket.example/aliyun-asr/x.mp3?sig=1']})
        self.assertEqual(submit[2]['parameters'], {'language_hints': ['zh', 'en'],
                                                   'diarization_enabled': True, 'speaker_count': 3})
        # The result link is signed already: the API key must not be sent to it.
        result_call = next(call for call in calls if call[1] == self.RESULT_URL)
        self.assertNotIn('authorization', result_call[3])

        self.assertEqual([s.text for s in response.segments], ['大家好，开始开会。', '先看上周的进度。'])
        self.assertEqual([s.speaker for s in response.segments], ['SPEAKER_00', 'SPEAKER_01'])
        self.assertEqual(response.segments[1].start_time, 2.3)
        self.assertEqual(response.duration, 12.5)
        stored = json.loads(response.to_storage_format())
        self.assertEqual(stored[1]['sentence'], '先看上周的进度。')
        # Saved before the submit and again once DashScope answered, so a retry
        # polls task-42 instead of paying for a second run.
        self.assertEqual(saved[0]['submitting'], True)
        self.assertEqual(saved[1]['task_id'], 'task-42')
        s3.upload_local_file.assert_called_once()
        s3.delete.assert_called_once()  # the staged audio is removed after recognition

    def test_a_saved_task_is_polled_not_submitted_again(self):
        def handler(method, url, body):
            self.assertEqual(method, 'GET')
            if url.endswith('/tasks/task-7'):
                # The nested shape DashScope returns today.
                return httpx.Response(200, json={'output': {'task_status': 'SUCCEEDED', 'results': [
                    {'output': {'subtask_status': 'SUCCEEDED', 'transcription_url': self.RESULT_URL}}]}})
            return httpx.Response(200, json={'transcripts': [{'sentences': [
                {'begin_time': 0, 'end_time': 500, 'text': '继续', 'speaker_id': 0}]}]})

        import time
        request = TranscriptionRequest(audio_file=io.BytesIO(b'x'), filename='a.mp3',
                                       provider_task={'task_id': 'task-7', 'submitted_at': time.time()})
        response, calls, s3 = self.run_with_aliyun(self.connector(), request, handler)
        self.assertEqual([call[0] for call in calls], ['GET', 'GET'])
        self.assertEqual(response.segments[0].text, '继续')
        s3.upload_local_file.assert_not_called()

    def test_failed_task_and_rejected_key_are_reported(self):
        def failing(method, url, body):
            if method == 'POST':
                return httpx.Response(200, json={'output': {'task_id': 'task-1'}})
            return httpx.Response(200, json={'output': {'task_status': 'FAILED', 'code': 'InvalidFile'}})
        with self.assertRaisesRegex(TranscriptionError, 'failed'):
            self.run_with_aliyun(self.connector(), TranscriptionRequest(audio_file=io.BytesIO(b'x'),
                                                                        filename='a.mp3'), failing)

        saved = []

        def rejected(method, url, body):
            return httpx.Response(401, json={'code': 'InvalidApiKey', 'message': 'secret details'})
        with self.assertRaisesRegex(ProviderError, 'ALIYUN_ASR_API_KEY') as caught:
            self.run_with_aliyun(self.connector(), TranscriptionRequest(
                audio_file=io.BytesIO(b'x'), filename='a.mp3', save_provider_task=saved.append), rejected)
        self.assertNotIn('secret details', str(caught.exception))
        self.assertIsNone(saved[-1])  # a definite rejection leaves no saved task

    def test_audio_needs_object_storage(self):
        request = TranscriptionRequest(audio_file=io.BytesIO(b'0'), filename='long.mp3')
        with self.assertRaisesRegex(ConfigurationError, 'S3 storage'):
            self.run_with_aliyun(self.connector(), request,
                                 lambda *args: self.fail('must not call DashScope'), staged=False)


class SummaryRequestTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from _app import app, bcrypt
        from src.database import db
        from src.models import Recording, User

        cls.app = app
        with app.app_context():
            cls.addClassCleanup(db.engine.dispose)
            owner = User(username='summarytest', email='summary@example.com', email_verified=True,
                         password=bcrypt.generate_password_hash(PASSWORD).decode())
            db.session.add(owner)
            db.session.flush()
            # A long meeting: far beyond the old 30,000-character cut.
            segments = [{'speaker': 'SPEAKER_00', 'start_time': i, 'end_time': i + 1,
                         'sentence': f'第{i:05d}条发言，' + '议' * 30} for i in range(2500)]
            segments.append({'speaker': 'SPEAKER_01', 'start_time': 2500, 'end_time': 2501,
                             'sentence': '尾部标记-散会前的最后一句'})
            recording = Recording(user_id=owner.id, title='长会', status='PROCESSING',
                                  transcription=json.dumps(segments, ensure_ascii=False))
            db.session.add(recording)
            db.session.commit()
            cls.recording_id = recording.id

    def completion(self, text):
        choice = MagicMock(finish_reason='stop')
        choice.message.content = text
        return MagicMock(choices=[choice], usage=None)

    def test_summary_gets_the_whole_transcript_and_the_model_maximum_output(self):
        from src.tasks import processing
        from src.models import Recording
        from src.database import db

        stub = MagicMock(return_value=self.completion('## 会议纪要\n\n- 已讨论完毕'))
        with patch.object(processing, 'client', object()), patch.object(processing, 'call_llm_completion', stub):
            processing.generate_summary_only_task(self.app.app_context(), self.recording_id)

        stub.assert_called_once()
        kwargs = stub.call_args.kwargs
        self.assertEqual(kwargs['max_tokens'], MODEL_MAX_OUTPUT)
        self.assertEqual(kwargs['operation_type'], 'summarization')
        sent = json.dumps(kwargs['messages'], ensure_ascii=False)
        self.assertGreater(len(sent), 100_000)
        self.assertIn('尾部标记-散会前的最后一句', sent)
        with self.app.app_context():
            self.assertEqual(db.session.get(Recording, self.recording_id).summary, '## 会议纪要\n\n- 已讨论完毕')

    def test_model_call_carries_max_thinking_and_the_output_budget(self):
        from src.services import llm

        gateway = MagicMock()
        gateway.chat.completions.create.return_value = self.completion('ok')
        with patch.object(llm, 'client', gateway), \
                patch.object(llm, 'TEXT_MODEL_NAME', 'cn:deepseek-v4.1-flash'), \
                patch.object(llm, 'TEXT_MODEL_EXTRA_BODY', THINKING_MAX), \
                patch.object(llm, 'TEXT_MODEL_EXTRA_BODY_ERROR', None):
            llm.call_llm_completion([{'role': 'user', 'content': 'hi'}],
                                    max_tokens=llm.max_output_tokens('SUMMARY_MAX_TOKENS'))
        sent = gateway.chat.completions.create.call_args.kwargs
        self.assertEqual(sent['model'], 'cn:deepseek-v4.1-flash')
        self.assertEqual(sent['max_tokens'], MODEL_MAX_OUTPUT)
        self.assertEqual(sent['extra_body'], THINKING_MAX)

    def test_output_budget_can_still_be_lowered_by_env(self):
        from src.services.llm import max_output_tokens
        self.assertEqual(max_output_tokens('SUMMARY_MAX_TOKENS'), MODEL_MAX_OUTPUT)
        with patch.dict(os.environ, {'SUMMARY_MAX_TOKENS': '8000'}):
            self.assertEqual(max_output_tokens('SUMMARY_MAX_TOKENS'), 8000)


if __name__ == '__main__':
    unittest.main()
