"""页面版本：服务器告诉页面「现在最新的是哪一版」，页面据此提醒用户刷新。"""
import json
import re
import unittest
from pathlib import Path


class BuildVersionTest(unittest.TestCase):
    def test_endpoint_reports_the_built_entry_and_the_page_carries_the_same_value(self):
        from _app import app
        manifest = Path(app.static_folder) / 'meeting' / 'manifest.json'
        if not manifest.exists():
            self.skipTest('前端没有构建')
        built = json.loads(manifest.read_text(encoding='utf-8'))['src/main.jsx']['file']
        client = app.test_client()
        response = client.get('/api/meeting-build')
        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.get_json()['build'], built)
        self.assertIn('no-store', response.headers['Cache-Control'])
        page = client.get('/login').get_data(as_text=True)
        self.assertEqual(re.search(r'"build": ?"([^"]+)"', page).group(1), built)


if __name__ == '__main__':
    unittest.main()


class SilentMeetingTest(unittest.TestCase):
    """阿里云对「没有语音」的两种回复都应显示成「没有说话内容」，而不是红色的「整理失败」。"""

    def phase(self, error, transcription=''):
        from types import SimpleNamespace
        from _app import app
        from src.api import meetings
        recording = SimpleNamespace(status='FAILED', error_message=error, transcription=transcription, summary='')
        with app.app_context():
            return meetings._phase(recording)

    def test_both_aliyun_no_speech_codes_are_no_speech(self):
        self.assertEqual(self.phase('Aliyun task x failed (code: ASR_RESPONSE_HAVE_NO_WORDS)'), 'no_speech')
        self.assertEqual(self.phase('Aliyun task x failed (code: SUCCESS_WITH_NO_VALID_FRAGMENT)'), 'no_speech')
        self.assertEqual(self.phase('', 'ERROR_JSON:{"m": "code: SUCCESS_WITH_NO_VALID_FRAGMENT"}'), 'no_speech')

    def test_real_failures_stay_failures(self):
        self.assertEqual(self.phase('Aliyun task x failed (code: InvalidFile.DownloadFailed)'), 'failed')
        self.assertEqual(self.phase('polling timed out'), 'failed')

    def test_error_formatting_also_knows_the_new_code(self):
        from src.utils.error_formatting import format_error_for_user
        result = format_error_for_user('Aliyun task x failed (code: SUCCESS_WITH_NO_VALID_FRAGMENT)')
        self.assertEqual(result.get('type'), 'no_speech')
