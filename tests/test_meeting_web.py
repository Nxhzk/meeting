"""HTTP contracts for the only meeting UI, under the deployed /meeting mount.

Build the frontend before running: python -m unittest discover -s tests
"""
import json
import os
import re
import unittest
from pathlib import Path
from unittest.mock import patch

MOUNT = {'SCRIPT_NAME': '/meeting'}
PASSWORD = 'Meeting-test-2026!'


def bootstrap(response):
    match = re.search(r'<script id="meeting-bootstrap" type="application/json">(.*?)</script>', response.get_data(as_text=True), re.S)
    if not match:
        raise AssertionError(f'Missing React bootstrap (HTTP {response.status_code})')
    return json.loads(match.group(1))


class MeetingWebTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        from _app import app, bcrypt
        from src.database import db
        from src.models import Recording, User
        from src.services import audit

        cls.app = app
        cls.enterClassContext(patch.dict(app.config, {'TESTING': True, 'RATELIMIT_ENABLED': False}))
        with app.app_context():
            cls.addClassCleanup(db.engine.dispose)
            password = bcrypt.generate_password_hash(PASSWORD).decode()
            owner = User(username='meetingtest', email='meeting@example.com', password=password, email_verified=True)
            other = User(username='other', email='other@example.com', password=password, email_verified=True)
            db.session.add_all([owner, other])
            db.session.flush()
            ready = Recording(user_id=owner.id, title='验证会议', status='COMPLETED',
                              summary='## 结论\n\n[外部链接](https://example.com)\n\n![远程图片](https://example.com/image.png)',
                              transcription='[{"speaker":"Speaker 7","start_time":0,"sentence":"验证发言"}]')
            removable = Recording(user_id=owner.id, title='可删除会议', status='COMPLETED')
            private = Recording(user_id=other.id, title='别人的会议', status='COMPLETED')
            db.session.add_all([ready, removable, private])
            db.session.flush()
            cls.meeting_id, cls.removable_id, cls.private_id = ready.id, removable.id, private.id
            db.session.commit()
        cls.addClassCleanup(audit.flush)

    def setUp(self):
        self.client = self.app.test_client()

    def get(self, path):
        return self.client.get(path, environ_overrides=MOUNT)

    def login(self, password=PASSWORD):
        page = bootstrap(self.get('/login'))
        return self.client.post('/login', data={'email': 'meetingtest', 'password': password, 'csrf_token': page['csrfToken']},
                                environ_overrides=MOUNT)

    def test_login_uses_versioned_assets_and_no_private_cache(self):
        self.assertTrue(self.get('/').location.startswith('/meeting/login?'))
        page = self.get('/login')
        self.assertEqual(page.status_code, 200)
        self.assertEqual(page.headers['Cache-Control'], 'no-store')
        self.assertEqual(bootstrap(page)['formUrl'], '/meeting/login')
        static = Path(self.app.static_folder)
        entry = json.loads((static / 'meeting/manifest.json').read_text())['src/main.jsx']
        for resource in [entry['file'], *entry['css']]:
            self.assertIn(f'/meeting/static/meeting/{resource}', page.get_data(as_text=True))
            with self.get(f'/static/meeting/{resource}') as asset:
                self.assertEqual(asset.status_code, 200)
                self.assertIn('immutable', asset.headers['Cache-Control'])
        self.assertEqual(self.get('/static/js/app.modular.js').status_code, 404)

    def test_password_login_and_old_urls(self):
        invalid = self.login('not the password')
        self.assertEqual(invalid.status_code, 200)
        self.assertTrue(any(msg['tone'] == 'error' for msg in bootstrap(invalid)['messages']))
        self.assertEqual(self.login().location, '/meeting/')
        for path in ['/', '/?view=full', '/label/old']:
            self.assertEqual(bootstrap(self.get(path))['page'], 'meetings')
        detail = bootstrap(self.get(f'/recordings/{self.meeting_id}'))
        self.assertEqual(detail['recordingId'], self.meeting_id)
        self.assertEqual(bootstrap(self.get('/account'))['page'], 'account')
        response = self.client.post('/logout', data={'csrf_token': detail['csrfToken']}, environ_overrides=MOUNT)
        self.assertEqual(response.location, '/meeting/login')
        self.assertEqual(self.get('/api/meetings').status_code, 401)

    def test_data_ownership_summary_and_csrf(self):
        self.assertEqual(self.get('/api/meetings').status_code, 401)
        self.login()
        listing = self.get('/api/meetings').get_json()['meetings']
        self.assertNotIn(self.private_id, [row['id'] for row in listing])
        self.assertEqual(self.get(f'/api/meetings/{self.private_id}').status_code, 404)
        view = self.get(f'/api/meetings/{self.meeting_id}')
        self.assertEqual(view.headers['Cache-Control'], 'no-store')
        record = view.get_json()
        self.assertEqual(record['transcript'][0]['speaker'], '发言人 1')
        self.assertIn('<h2>结论</h2>', record['summary_html'])
        self.assertNotRegex(record['summary_html'], r'<(?:a|img)\b|https://example.com')
        card = next(row for row in listing if row['id'] == self.removable_id)
        path = f'/api/meetings/{card["id"]}'
        payload = {'identity': card['deletion_identity']}
        rejected = self.client.delete(path, json=payload, environ_overrides=MOUNT)
        self.assertEqual(rejected.status_code, 400)
        token = bootstrap(self.get('/'))['csrfToken']
        headers = {'X-CSRFToken': token}
        stale = self.client.delete(path, json={'identity': 'stale'}, headers=headers, environ_overrides=MOUNT)
        self.assertEqual(stale.status_code, 409)
        deleted = self.client.delete(path, json=payload, headers=headers, environ_overrides=MOUNT)
        self.assertEqual(deleted.status_code, 200)
        self.assertEqual(self.get(path).status_code, 404)
