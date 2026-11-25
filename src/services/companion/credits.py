"""WorkBuddy 积分：通过 nginx 的只读通道读取面板 overview（管理密钥只在 nginx 里），
只取积分数字，不返回账号昵称等信息。"""
import json
import logging
import os
import threading
import time
import urllib.request

from src.services.companion import hub

logger = logging.getLogger(__name__)
_lock = threading.Lock()
_cache = {'at': 0.0, 'data': None}
TTL = 30


def _url():
    return os.environ.get('ASSISTANT_CREDITS_URL', '').strip()


def _fetch():
    url = _url()
    if not url:
        return None
    key = (os.environ.get('ASSISTANT_MODEL_API_KEY') or os.environ.get('TEXT_MODEL_API_KEY') or '').strip()
    request = urllib.request.Request(url, headers={'Authorization': f'Bearer {key}', 'Accept': 'application/json'})
    with urllib.request.urlopen(request, timeout=8) as response:
        raw = json.loads(response.read().decode('utf-8'))
    accounts = [a for a in raw.get('accounts') or [] if isinstance(a, dict) and not a.get('disabled')]
    if not accounts:
        return None
    expiring = None
    for account in accounts:
        when, amount = account.get('credits_earliest_expiry'), account.get('credits_earliest_remaining')
        if when and amount and (expiring is None or when < expiring['at']):
            expiring = {'at': when, 'amount': amount}
    return {
        'credits': round(sum(float(a.get('credits') or 0) for a in accounts), 2),
        'total': round(sum(float(a.get('credits_total') or 0) for a in accounts), 2),
        'expiring': expiring,
        'checked_at': int(time.time()),
    }


def get(force=False):
    with _lock:
        if not force and _cache['data'] and time.time() - _cache['at'] < TTL:
            return _cache['data']
    try:
        data = _fetch()
    except Exception as exc:
        logger.info('Credits fetch failed: %s', type(exc).__name__)
        data = None
    with _lock:
        previous = _cache['data']
        if data is not None:
            _cache.update(at=time.time(), data=data)
        changed = data is not None and (previous is None or previous['credits'] != data['credits']
                                        or previous.get('expiring') != data.get('expiring'))
    if changed:
        hub.broadcast('credits', data)
    return data or previous


def refresh_soon(delay=3):
    """模型调用刚结束：过几秒再查一次（面板记账有一点延迟）。"""
    def later():
        time.sleep(delay)
        get(force=True)
    threading.Thread(target=later, daemon=True).start()
