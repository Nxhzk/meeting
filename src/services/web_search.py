"""小助理的联网搜索：用阿里云百炼（和会议转写同一个密钥）的通义千问联网搜索。

在服务器上调用，密钥不进小助理的沙箱。返回一段带引用编号的回答和来源网页列表。
每位用户每天有次数上限（WEB_SEARCH_DAILY_LIMIT，默认 100），防止费用失控。
"""
import logging
import os
import threading
from datetime import date

import httpx

logger = logging.getLogger(__name__)

# qwen3.x 系列走多模态接口（文本接口会报 url error）；模型选百炼免费额度里有的
ENDPOINT = 'https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation'
MAX_QUERY = 200
MAX_ANSWER = 4000
MAX_SOURCES = 8

_lock = threading.Lock()
_used = {}   # (user_id, 日期) -> 次数；单进程服务，内存计数即可（重启归零无妨）


class WebSearchError(RuntimeError):
    pass


def _api_key():
    return (os.environ.get('WEB_SEARCH_API_KEY') or os.environ.get('ALIYUN_ASR_API_KEY') or '').strip()


def available():
    return bool(_api_key())


def _daily_limit():
    try:
        return max(0, int(os.environ.get('WEB_SEARCH_DAILY_LIMIT') or 100))
    except ValueError:
        return 100


def _take_quota(user_id):
    key = (user_id, date.today())
    with _lock:
        for old in [k for k in _used if k[1] != key[1]]:
            del _used[old]
        if _used.get(key, 0) >= _daily_limit():
            return False
        _used[key] = _used.get(key, 0) + 1
        return True


def search(user_id, query, now_text=None):
    """搜索并返回 {'answer', 'sources': [{'n', 'title', 'url', 'site'}]}。"""
    query = ' '.join(str(query or '').split())[:MAX_QUERY]
    if not query:
        raise WebSearchError('搜索内容不能为空。')
    if not available():
        raise WebSearchError('联网搜索还没有配置。')
    if not _take_quota(user_id):
        raise WebSearchError(f'今天的联网搜索次数（{_daily_limit()} 次）已经用完，明天再试。')
    prompt = (f'当前时间：{now_text}。\n' if now_text else '') + (
        f'请联网搜索并回答：{query}\n'
        '要求：只根据搜索到的内容回答，简洁，给出关键事实、数字和日期；搜不到或说法不一致就直说。')
    body = {
        'model': os.environ.get('WEB_SEARCH_MODEL') or 'qwen3.8-flash',
        'input': {'messages': [{'role': 'user', 'content': [{'text': prompt}]}]},
        'parameters': {
            'result_format': 'message',
            'enable_thinking': False,   # 只需要整理搜索结果，不需要思考，省 token
            'enable_search': True,
            'search_options': {'forced_search': True, 'enable_source': True, 'enable_citation': True,
                               'search_strategy': os.environ.get('WEB_SEARCH_STRATEGY') or 'turbo'},
        },
    }
    try:
        response = httpx.post(ENDPOINT, json=body, timeout=60,
                              headers={'Authorization': f'Bearer {_api_key()}', 'Content-Type': 'application/json'})
        data = response.json()
    except (httpx.HTTPError, ValueError) as error:
        logger.warning('Web search failed: %s', error)
        raise WebSearchError('联网搜索暂时不可用，请稍后再试。') from error
    if response.status_code != 200 or not data.get('output'):
        logger.warning('Web search rejected (%s): %s', response.status_code, str(data.get('code') or data.get('message'))[:200])
        raise WebSearchError('联网搜索暂时不可用，请稍后再试。')
    output = data['output']
    choices = output.get('choices') or [{}]
    content = (choices[0].get('message') or {}).get('content') or ''
    if isinstance(content, list):
        content = ''.join(part.get('text', '') for part in content if isinstance(part, dict))
    answer = str(content).strip()[:MAX_ANSWER]
    sources = []
    for item in ((output.get('search_info') or {}).get('search_results') or [])[:MAX_SOURCES]:
        if item.get('url'):
            sources.append({'n': item.get('index'), 'title': item.get('title'), 'url': item.get('url'),
                            'site': item.get('site_name')})
    return {'query': query, 'answer': answer, 'sources': sources}
