"""小助理的页面接口：/api/assistant/*"""
import json
import queue
import re
import time

from flask import Blueprint, Response, jsonify, request, stream_with_context
from flask_login import current_user, login_required

from src.models.companion import CompanionMessage
from src.services.companion import credits, hub, service

companion_bp = Blueprint('companion', __name__, url_prefix='/api/assistant')
PAGE = 40
HEARTBEAT = 10          # 心跳：页面断开后最多 10 秒就能发现，及时让出线程（nginx 180 秒没数据也会断开）
STREAM_LIFETIME = 600   # 事件流 10 分钟主动断开，让页面重连，避免僵死连接一直占着线程


_CONTROL = re.compile(r'[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\u200b-\u200f\u2028-\u202e\u2060-\u2064\ufeff]')


def _json(data, status=200):
    response = jsonify(data)
    response.headers['Cache-Control'] = 'no-store'
    return response, status


def _messages(before=None):
    query = CompanionMessage.query.filter_by(user_id=current_user.id)
    if before:
        query = query.filter(CompanionMessage.id < before)
    rows = query.order_by(CompanionMessage.id.desc()).limit(PAGE + 1).all()
    return [service.message_json(m) for m in reversed(rows[:PAGE])], (rows[PAGE - 1].id if len(rows) > PAGE else None)


@companion_bp.get('/state')
@login_required
def state():
    service.ensure_brief(current_user.id)
    # 先取快照再查消息：回复如果在这之间结束，消息里已经有它，页面按回复编号去重
    with hub.guard(current_user.id):
        live = service.live_snapshot(current_user.id)
    messages, more = _messages()
    return _json({'messages': messages, 'more': more, 'running': live is not None, 'live': live,
                  'unread': service.unread_count(current_user.id), 'credits': credits.get()})


@companion_bp.get('/messages')
@login_required
def messages():
    rows, more = _messages(request.args.get('before', type=int))
    return _json({'messages': rows, 'more': more})


@companion_bp.post('/messages')
@login_required
def send():
    data = request.get_json(silent=True) or {}
    text = data.get('text') if isinstance(data, dict) else None
    client_id = data.get('client_id') if isinstance(data, dict) else None
    if not isinstance(client_id, str) or not re.fullmatch(r'[A-Za-z0-9_-]{8,64}', client_id):
        client_id = None
    if isinstance(text, str):
        text = _CONTROL.sub('', text)   # 看不见的控制字符（\0 等）不算内容，也不送给模型
    if not isinstance(text, str) or not text.strip():
        return _json({'error': '说点什么吧。'}, 400)
    if len(text) > 4000:
        return _json({'error': '一条消息最多 4000 字。'}, 400)
    try:
        message = service.send(current_user.id, text, client_id)
    except service.Busy as exc:
        return _json({'error': str(exc)}, 409)
    except Exception as exc:
        from src.services.meeting_assistant.runner import AssistantUnavailable
        if isinstance(exc, AssistantUnavailable):
            return _json({'error': str(exc)}, 503)
        raise
    return _json({'message': service.message_json(message)}, 201)


@companion_bp.post('/stop')
@login_required
def stop():
    return _json({'stopped': bool(service.stop(current_user.id))})


@companion_bp.post('/clear')
@login_required
def clear():
    try:
        service.clear(current_user.id)
    except service.Busy as exc:
        return _json({'error': str(exc)}, 409)
    return _json({'cleared': True})


@companion_bp.post('/read')
@login_required
def read():
    service.mark_read(current_user.id)
    return _json({'unread': 0})


@companion_bp.get('/credits')
@login_required
def get_credits():
    return _json({'credits': credits.get(force=request.args.get('force') == '1')})


@companion_bp.get('/notifications')
@login_required
def notifications():
    """安卓 App 后台定时拉取：since 之后小助理主动发的消息。"""
    since = request.args.get('since', 0, type=int)
    rows = (CompanionMessage.query.filter(CompanionMessage.user_id == current_user.id,
                                          CompanionMessage.role == 'assistant', CompanionMessage.kind == 'proactive',
                                          CompanionMessage.id > since)
            .order_by(CompanionMessage.id).limit(10).all())
    latest = CompanionMessage.query.filter_by(user_id=current_user.id).order_by(CompanionMessage.id.desc()).first()
    return _json({'messages': [{'id': m.id, 'text': m.content[:300], 'read': m.read_at is not None} for m in rows],
                  'latest_id': latest.id if latest else 0})


@companion_bp.get('/events')
@login_required
def events():
    """SSE：流式回复、工具调用、主动消息、积分变化。每个页面一条。"""
    user_id = current_user.id
    # 订阅和取快照放在一起：快照之后的每个事件都会进这条流，不重复也不缺
    with hub.guard(user_id):
        q = hub.subscribe(user_id)
        live = service.live_snapshot(user_id)

    def stream():
        started = time.time()
        try:
            yield 'retry: 3000\n\n'
            yield _sse('hello', {'running': live is not None, 'live': live})
            while time.time() - started < STREAM_LIFETIME:
                try:
                    item = q.get(timeout=HEARTBEAT)
                except queue.Empty:
                    yield ': ping\n\n'
                    continue
                if item is hub.RESET:
                    return      # 页面读得太慢丢了事件：断开，页面会自动重连并拿到新的快照
                if item is hub.BYE:
                    # 同一个人开的页面太多或服务器上的事件流太多：让出位置，页面回到前台时再连
                    yield _sse('bye', {})
                    return
                yield _sse(item['event'], item['data'])
        finally:
            hub.unsubscribe(user_id, q)

    response = Response(stream_with_context(stream()), mimetype='text/event-stream')
    response.headers['Cache-Control'] = 'no-store'
    response.headers['X-Accel-Buffering'] = 'no'
    return response


def _sse(event, data):
    return f'event: {event}\ndata: {json.dumps(data, ensure_ascii=False)}\n\n'
