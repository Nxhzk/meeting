"""小助理的语音输入：一段短语音（按住说话录下的）转成文字。

用阿里云百炼的 qwen3-asr-flash（和会议转写同一个密钥），一次 HTTP 请求，一句话约 0.5 秒。
把公司名和这位用户长期记忆里的人名、项目名作为上下文一起发过去，专有名词识别得更准。
每位用户每天有次数上限（VOICE_INPUT_DAILY_LIMIT，默认 300），防止费用失控。
"""
import base64
import logging
import os
import re
import threading
from datetime import date

import httpx

logger = logging.getLogger(__name__)

ENDPOINT = 'https://dashscope.aliyuncs.com/compatible-mode/v1/chat/completions'
MAX_BYTES = 3 * 1024 * 1024        # 一分钟的语音压缩后远小于这个数
CONTEXT_CHARS = 300
MIME_TYPES = {'audio/webm', 'audio/ogg', 'audio/mp4', 'audio/aac', 'audio/mpeg', 'audio/wav', 'audio/x-m4a'}

_lock = threading.Lock()
_used = {}


class VoiceInputError(RuntimeError):
    pass


def _api_key():
    return (os.environ.get('VOICE_INPUT_API_KEY') or os.environ.get('ALIYUN_ASR_API_KEY') or '').strip()


def available():
    return bool(_api_key())


def _daily_limit():
    try:
        return max(0, int(os.environ.get('VOICE_INPUT_DAILY_LIMIT') or 300))
    except ValueError:
        return 300


def _take_quota(user_id):
    key = (user_id, date.today())
    with _lock:
        for old in [k for k in _used if k[1] != key[1]]:
            del _used[old]
        if _used.get(key, 0) >= _daily_limit():
            return False
        _used[key] = _used.get(key, 0) + 1
        return True


_NAME_END = re.compile(r'[：:，,。；;（(\s是为在的]')


def _names(user_id):
    """长期记忆里的人名、项目名：只取每条开头的名字（几个字），不把整句内容发出去。"""
    try:
        from src.models.meeting_assistant import MemoryEntry
        rows = (MemoryEntry.query.filter_by(user_id=user_id, deleted_at=None)
                .filter(MemoryEntry.category.in_(('person', 'project')))
                .order_by(MemoryEntry.pinned.desc(), MemoryEntry.id.desc()).limit(60).all())
    except Exception:
        logger.exception('Could not load memory for voice input context')
        return []
    names = []
    for row in rows:
        name = _NAME_END.split(row.content.strip(), 1)[0][:12]
        if 2 <= len(name) and name not in names:
            names.append(name)
    return names


def _context(user_id):
    """识别时的提示词：只是一串可能出现的词，帮模型认准专有名词。"""
    words = ['捷士通', '会议纪要', '待办', '提醒', '长期记忆', '摘要'] + _names(user_id)
    return ('可能出现的词：' + '、'.join(words))[:CONTEXT_CHARS]


def _echoes(text, context):
    """模型没听清时会把提示词当成结果吐出来：结果里有提示词的一大段原文，就当作没识别出来。"""
    plain = re.sub(r'\s', '', text)
    hint = re.sub(r'\s', '', context)
    return any(hint[i:i + 12] in plain for i in range(0, max(0, len(hint) - 11), 4))


def transcribe(user_id, audio, mime_type):
    mime = (mime_type or '').split(';')[0].strip().lower()
    if not audio:
        raise VoiceInputError('没有录到声音。')
    if len(audio) > MAX_BYTES:
        raise VoiceInputError('这段语音太长了，请分几次说。')
    if mime not in MIME_TYPES:
        raise VoiceInputError('不支持这种录音格式。')
    if not available():
        raise VoiceInputError('语音输入还没有配置。')
    if not _take_quota(user_id):
        raise VoiceInputError(f'今天的语音输入次数（{_daily_limit()} 次）已经用完，明天再试。')
    context = _context(user_id)
    body = {
        'model': os.environ.get('VOICE_INPUT_MODEL') or 'qwen3-asr-flash',
        'messages': [
            {'role': 'system', 'content': [{'text': context}]},
            {'role': 'user', 'content': [{'type': 'input_audio', 'input_audio': {
                'data': f'data:{mime};base64,{base64.b64encode(audio).decode()}'}}]},
        ],
        'asr_options': {'language': 'zh', 'enable_itn': True},
    }
    try:
        response = httpx.post(ENDPOINT, json=body, timeout=30,
                              headers={'Authorization': f'Bearer {_api_key()}', 'Content-Type': 'application/json'})
        data = response.json()
    except (httpx.HTTPError, ValueError) as error:
        logger.warning('Voice input failed: %s', error)
        raise VoiceInputError('语音识别暂时不可用，请稍后再试。') from error
    if response.status_code != 200 or not data.get('choices'):
        logger.warning('Voice input rejected (%s): %s', response.status_code, str(data.get('error') or data)[:200])
        raise VoiceInputError('语音识别暂时不可用，请稍后再试。')
    text = str(data['choices'][0].get('message', {}).get('content') or '').strip()
    if text and _echoes(text, context):
        logger.warning('Voice input returned the hint words instead of speech; treated as unheard')
        return ''
    return text
