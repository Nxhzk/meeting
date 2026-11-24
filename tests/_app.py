"""One Flask app for the whole test run.

src.app reads its settings once, when it is first imported, and keeps its
database for the life of the process. Every test file therefore shares this
app, with a database in a temporary directory that is removed at exit.
"""
import atexit
import os
import tempfile

_state = tempfile.TemporaryDirectory()
atexit.register(_state.cleanup)

os.environ.update({
    'SQLALCHEMY_DATABASE_URI': f'sqlite:///{_state.name}/test.db',
    'UPLOAD_FOLDER': f'{_state.name}/uploads',
    'SECRET_KEY': '',
    'SECRET_KEY_FILE': f'{_state.name}/session.key',
    'TRANSCRIPTION_CONNECTOR': 'aliyun_asr',
    'ALIYUN_ASR_ALLOW_UNCONFIGURED': 'true',
    'ALIYUN_ASR_API_KEY': '',
    'SPEAKR_SKIP_BACKGROUND_TASKS': 'true',
    'ALLOW_REGISTRATION': 'false',
    'REQUIRE_EMAIL_VERIFICATION': 'false',
    'SESSION_COOKIE_SECURE': 'false',
})

from src.app import app, bcrypt  # noqa: E402  (after the environment is set)

__all__ = ['app', 'bcrypt']
