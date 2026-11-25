"""安卓 App 原生录音的服务器一侧：AAC 分段上传、拼接、封装成可播放的 m4a。

原生录音器把麦克风的 AAC（ADTS 封装，每帧自带帧头）按完整帧切成 5 秒一段上传；
服务器把它们字节拼接（前提：段与段之间在帧边界上），再用 ffmpeg 无损封装。
"""
import json
import os
import re
import shutil
import subprocess
import tempfile
import unittest

PASSWORD = 'Native-rec-test-2026!'


def adts_frames(data):
    """按 ADTS 帧头切开，返回每一帧的字节（和 NativeRecorder.adtsBoundary 同一套规则）。"""
    frames, pos = [], 0
    while pos + 7 <= len(data):
        if data[pos] != 0xFF or (data[pos + 1] & 0xF0) != 0xF0:
            break
        length = ((data[pos + 3] & 0x03) << 11) | (data[pos + 4] << 3) | ((data[pos + 5] & 0xE0) >> 5)
        if length < 7 or pos + length > len(data):
            break
        frames.append(data[pos:pos + length])
        pos += length
    return frames


@unittest.skipUnless(shutil.which('ffmpeg') and shutil.which('ffprobe'), '需要 ffmpeg')
class NativeRecordingStitchTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from _app import app, bcrypt
        from src.database import db
        from src.models import User
        cls.app = app
        cls.tmp = tempfile.TemporaryDirectory()
        cls.addClassCleanup(cls.tmp.cleanup)
        source = os.path.join(cls.tmp.name, 'tone.aac')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=440:duration=12:sample_rate=32000',
                        '-ac', '1', '-c:a', 'aac', '-b:a', '48k', '-f', 'adts', source], check=True)
        cls.frames = adts_frames(open(source, 'rb').read())
        with app.app_context():
            user = User(username='nativerec', email='nativerec@example.com', email_verified=True,
                        password=bcrypt.generate_password_hash(PASSWORD).decode())
            db.session.add(user)
            db.session.commit()

    def client(self):
        client = self.app.test_client()
        token = re.search(r'"csrfToken": ?"([^"]+)"', client.get('/login').get_data(as_text=True)).group(1)
        response = client.post('/login', data={'email': 'nativerec@example.com', 'password': PASSWORD, 'csrf_token': token})
        self.assertIn(response.status_code, (302, 303))
        client.environ_base['HTTP_X_CSRFTOKEN'] = token
        return client

    def chunks(self, count):
        """把帧分成 count 段，段与段在帧边界上（和原生录音器一样）。"""
        size = -(-len(self.frames) // count)
        return [b''.join(self.frames[i:i + size]) for i in range(0, len(self.frames), size)]

    def record(self, client, parts):
        created = client.post('/upload/session', json={'mime_type': 'audio/aac', 'meeting_mode': True})
        self.assertIn(created.status_code, (200, 201), created.get_data(as_text=True))
        session_id = created.get_json()['session_id']
        for index, data in enumerate(parts, start=1):
            response = client.post(f'/upload/session/{session_id}/chunks/{index}', data=data,
                                   content_type='application/octet-stream')
            self.assertEqual(response.status_code, 204, response.get_data(as_text=True))
        return session_id

    def stitch(self, client, session_id):
        from src.services import recording_stitch
        finalized = client.post(f'/upload/session/{session_id}/finalize', json={'meeting_mode': True})
        self.assertIn(finalized.status_code, (200, 202), finalized.get_data(as_text=True))
        with self.app.app_context():
            _recording_id, path, _meta = recording_stitch.stitch_recording_session(session_id)
        self.addCleanup(lambda: os.path.exists(path) and os.remove(path))
        return path

    def probe(self, path):
        out = subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration,format_name:stream=codec_name,channels',
                              '-of', 'json', path], capture_output=True, text=True, check=True).stdout
        return json.loads(out)

    def test_aac_chunks_become_one_playable_m4a(self):
        client = self.client()
        path = self.stitch(client, self.record(client, self.chunks(3)))
        self.assertTrue(path.endswith('.m4a'))
        info = self.probe(path)
        self.assertEqual(info['streams'][0]['codec_name'], 'aac')
        self.assertAlmostEqual(float(info['format']['duration']), 12.0, delta=0.5)

    def test_a_chunk_that_misses_the_next_index_can_be_renumbered(self):
        # 原生录音器遇到 409 expected_chunk_index 时，把待传的段往前挪：这里验证服务器给出的信息够用
        client = self.client()
        created = client.post('/upload/session', json={'mime_type': 'audio/aac', 'meeting_mode': True}).get_json()
        parts = self.chunks(3)
        ok = client.post(f"/upload/session/{created['session_id']}/chunks/1", data=parts[0], content_type='application/octet-stream')
        self.assertEqual(ok.status_code, 204)
        gap = client.post(f"/upload/session/{created['session_id']}/chunks/3", data=parts[2], content_type='application/octet-stream')
        self.assertEqual(gap.status_code, 409)
        self.assertEqual(gap.get_json()['expected_chunk_index'], 2)
        # 重复上传已收到的段：服务器说期望的编号比它大，原生就当这段已经传完
        again = client.post(f"/upload/session/{created['session_id']}/chunks/1", data=parts[0], content_type='application/octet-stream')
        self.assertEqual(again.status_code, 409)
        self.assertGreater(again.get_json()['expected_chunk_index'], 1)

    def test_resumed_recording_joins_into_one_file(self):
        # 通话打断后原生录音器重开麦克风：新的一段是另一次独立编码的 AAC，直接接在后面，
        # 服务器拼出来仍是一个合法的文件，时长是两段之和
        other = os.path.join(self.tmp.name, 'tone2.aac')
        subprocess.run(['ffmpeg', '-v', 'error', '-y', '-f', 'lavfi', '-i', 'sine=frequency=880:duration=6:sample_rate=32000',
                        '-ac', '1', '-c:a', 'aac', '-b:a', '48k', '-f', 'adts', other], check=True)
        second = adts_frames(open(other, 'rb').read())
        parts = self.chunks(2) + [b''.join(second)]
        client = self.client()
        path = self.stitch(client, self.record(client, parts))
        self.assertAlmostEqual(float(self.probe(path)['format']['duration']), 18.0, delta=0.6)

if __name__ == '__main__':
    unittest.main()
