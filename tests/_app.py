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
    # 所有测试共用一个 IP 登录：关掉限流，限流本身另有测试时再单独打开
    'RATELIMIT_ENABLED': 'false',
    # 会议助手在测试里绝不连外部模型：默认指向一个不存在的本机端口。
    'ASSISTANT_MODEL_BASE_URL': 'http://127.0.0.1:9/v1',
    'ASSISTANT_MODEL_NAME': 'test-model',
    'ASSISTANT_SANDBOX': 'off',
})

from src.app import app, bcrypt  # noqa: E402  (after the environment is set)

__all__ = ['app', 'bcrypt']
