"""把 pi 的事件流整理成「工具调用流」，实时写库给页面展示。

每个条目有稳定的 key（工具调用 id / 思考段序号），状态从 running 变成 ok 或
error。高频的增量（思考、撰写摘要的参数流）节流后再写。
"""
import logging
import time
from datetime import datetime

logger = logging.getLogger(__name__)
THROTTLE = 1.2


def _meeting_path(path):
    path = str(path or '.')
    marker = '/meeting/'
    if marker in path:
        path = path.split(marker, 1)[1]
    elif path.endswith('/meeting'):
        path = '.'
    return path or '.'


def _first_text(result):
    for item in (result or {}).get('content') or []:
        if item.get('type') == 'text' and item.get('text'):
            return item['text']
    return ''


class Trace:
    def __init__(self, sink, parts):
        self.sink = sink
        self.parts = {part['path']: part for part in parts}
        self.thinking_count = 0
        self.compose_count = 0
        self.open = {}          # 进行中的思考 / 撰写: key -> [data, last_flush]
        self.started = {}       # 工具调用 id -> 开始时的参数摘要

    def _emit(self, key, kind, status, tool=None, data=None, ended=False):
        try:
            self.sink(key, kind, status, tool, data or {}, ended)
        except Exception:
            logger.warning('Could not store assistant trace event', exc_info=True)

    # ---------------------------------------------------------------- 工具
    def tool_start(self, call_id, name, args):
        args = args or {}
        data = {}
        if name in ('read', 'ls'):
            path = _meeting_path(args.get('path'))
            data['path'] = path
            part = self.parts.get(path)
            if part:
                data['range'] = [part['first'], part['last']]
                data['index'] = list(self.parts).index(path) + 1
                data['total'] = len(self.parts)
        elif name in ('add_memory', 'update_memory'):
            data.update({k: args.get(k) for k in ('id', 'category', 'content') if args.get(k)})
        elif name == 'delete_memory':
            data['id'] = args.get('id')
        elif name == 'search_memory':
            data['query'] = str(args.get('query') or '')[:40]
        if args.get('reason'):
            data['reason'] = str(args['reason'])[:160]
        self._emit(f'tool-{call_id}', 'tool', 'running', name, data)
        self.started[call_id] = data

    def tool_end(self, call_id, name, result, is_error):
        data = dict(self.started.pop(call_id, None) or {})
        if is_error:
            data['error'] = _first_text(result)[:200] or '失败'
        elif name in ('list_memory', 'search_memory'):
            text = _first_text(result)
            data['count'] = 0 if ('没有记忆' in text or '没有找到' in text) else len(
                [line for line in text.splitlines() if line.strip() and not line.startswith('（')])
        elif name == 'ls':
            data['count'] = len([line for line in _first_text(result).splitlines() if line.strip()])
        self._emit(f'tool-{call_id}', 'tool', 'error' if is_error else 'ok', name, data, ended=True)

    # ---------------------------------------------------------------- 思考与撰写
    def message_update(self, event):
        kind = event.get('type')
        partial = event.get('partial') or {}
        if kind == 'thinking_start':
            self.thinking_count += 1
            key = f'think-{self.thinking_count}'
            self.open[key] = [{'chars': 0}, 0.0]
            self._emit(key, 'thinking', 'running', None, {'chars': 0})
        elif kind == 'thinking_delta':
            self._grow(f'think-{self.thinking_count}', 'thinking', None, event.get('delta'))
        elif kind == 'thinking_end':
            self._close(f'think-{self.thinking_count}', 'thinking', None, len(event.get('content') or ''))
        elif kind == 'toolcall_start':
            content = partial.get('content') or []
            index = event.get('contentIndex', -1)
            name = content[index].get('name') if 0 <= index < len(content) and isinstance(content[index], dict) else None
            if name == 'save_summary':
                self.compose_count += 1
                key = f'compose-{self.compose_count}'
                self.open[key] = [{'chars': 0}, 0.0]
                self._emit(key, 'compose', 'running', 'save_summary', {'chars': 0})
        elif kind == 'toolcall_delta':
            key = f'compose-{self.compose_count}'
            if key in self.open:
                self._grow(key, 'compose', 'save_summary', event.get('delta'))
        elif kind == 'toolcall_end':
            key = f'compose-{self.compose_count}'
            if key in self.open:
                self._close(key, 'compose', 'save_summary', None)

    def _grow(self, key, kind, tool, delta):
        entry = self.open.get(key)
        if not entry:
            return
        entry[0]['chars'] += len(delta or '')
        now = time.monotonic()
        if now - entry[1] >= THROTTLE:
            entry[1] = now
            self._emit(key, kind, 'running', tool, dict(entry[0]))

    def _close(self, key, kind, tool, chars):
        entry = self.open.pop(key, None)
        data = dict(entry[0]) if entry else {}
        if chars is not None:
            data['chars'] = chars
        self._emit(key, kind, 'ok', tool, data, ended=True)

    def finish(self):
        """进程结束时还没收尾的条目（被中断）一律结束掉。"""
        for key in list(self.open):
            kind = 'thinking' if key.startswith('think') else 'compose'
            self._close(key, kind, None if kind == 'thinking' else 'save_summary', None)


def db_sink(recording_id):
    """写到 assistant_trace_event：独立连接，不碰调用方的事务。"""
    from sqlalchemy import func, insert, select, update
    from src.database import db
    from src.models.meeting_assistant import AssistantTraceEvent as T

    def sink(key, kind, status, tool, data, ended):
        now = datetime.utcnow()
        with db.engine.begin() as conn:
            row = conn.execute(select(T.id).where(T.recording_id == recording_id, T.key == key)).first()
            if row:
                values = {'status': status, 'data': data}
                if ended:
                    values['ended_at'] = now
                conn.execute(update(T).where(T.id == row[0]).values(**values))
            else:
                seq = (conn.execute(select(func.max(T.seq)).where(T.recording_id == recording_id)).scalar() or 0) + 1
                conn.execute(insert(T).values(recording_id=recording_id, key=key, seq=seq, kind=kind, tool=tool,
                                              status=status, data=data, started_at=now,
                                              ended_at=now if ended else None))
    return sink


def clear(recording_id):
    from sqlalchemy import delete
    from src.database import db
    from src.models.meeting_assistant import AssistantTraceEvent as T
    with db.engine.begin() as conn:
        conn.execute(delete(T).where(T.recording_id == recording_id))
