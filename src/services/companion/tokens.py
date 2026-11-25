"""小助理每次运行的一次性凭证：只在这次运行期间有效，只能访问这位用户的数据。"""
import secrets
import threading
import time

_lock = threading.Lock()
_tokens = {}   # token -> (user_id, expires_at, context)


def issue(user_id, ttl=3600, context=None):
    token = secrets.token_urlsafe(32)
    with _lock:
        _tokens[token] = (user_id, time.time() + ttl, dict(context or {}))
        for key, entry in list(_tokens.items()):
            if entry[1] < time.time():
                _tokens.pop(key, None)
    return token


def resolve(token):
    """(user_id, context)；无效或过期时 (None, {})。"""
    if not token:
        return None, {}
    with _lock:
        entry = _tokens.get(token)
    if not entry or entry[1] < time.time():
        return None, {}
    return entry[0], entry[2]


def revoke(token):
    with _lock:
        _tokens.pop(token, None)
