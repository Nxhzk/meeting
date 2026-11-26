"""小助理专用的本机内部接口：/internal/assistant/*

- 只接受直接来自本机的请求（经过 nginx 转发的一律拒绝）；
- 每次运行发一个一次性凭证（X-Assistant-Token），数据范围只限这位用户；
- 不能删除会议、不能重新生成摘要、不能改会议内容。

接口用法写在 assistant/skills/meeting-api/SKILL.md，小助理需要时自己读。
"""
from datetime import datetime

from flask import Blueprint, g, jsonify, request
from sqlalchemy import or_

from src.database import db
from src.models import Recording
from src.models.companion import CompanionMessage, Reminder
from src.models.meeting_assistant import MEMORY_CATEGORIES, MEMORY_CATEGORY_LABELS, MemoryEntry, SummaryVersion
from src.services.companion import hub, schedule, tokens

companion_internal_bp = Blueprint('companion_internal', __name__, url_prefix='/internal/assistant')
PAGE = 20
TRANSCRIPT_PAGE = 200


def _error(message, status=400):
    return jsonify({'error': message}), status


@companion_internal_bp.before_request
def _authenticate():
    # 经过 nginx 的请求都会带 X-Forwarded-For：内部接口只给本机上的小助理用
    if request.headers.get('X-Forwarded-For') or request.remote_addr not in ('127.0.0.1', '::1'):
        return _error('not found', 404)
    user_id, context = tokens.resolve(request.headers.get('X-Assistant-Token'))
    if user_id is None:
        return _error('凭证无效或已过期', 401)
    g.companion_user_id = user_id
    g.companion_reminder_id = context.get('reminder_id')
    g.companion_is_brief = bool(context.get('is_brief'))


def _uid():
    return g.companion_user_id


def _body():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


def _meeting(recording_id):
    return Recording.query.filter_by(id=recording_id, user_id=_uid()).first()


def _latest_version(recording_id):
    return (SummaryVersion.query.filter_by(recording_id=recording_id)
            .order_by(SummaryVersion.version.desc()).first())


def _iso(value):
    return value.isoformat(timespec='minutes') + 'Z' if value else None


def _card(recording):
    from src.api.meetings import _card as card, _phase
    data = card(recording)
    return {'id': data['id'], 'title': data['title'], 'date': data['date'], 'status': _phase(recording),
            'duration_minutes': round((recording.get_audio_duration(allow_probe_fallback=False) or 0) / 60)}


# ---------------------------------------------------------------- 会议

@companion_internal_bp.get('/meetings')
def meetings():
    before = request.args.get('before', type=int)
    query = Recording.query.filter(Recording.user_id == _uid(), Recording.is_archived.is_not(True))
    if before:
        query = query.filter(Recording.id < before)
    rows = query.order_by(Recording.id.desc()).limit(PAGE + 1).all()
    return jsonify({'meetings': [_card(r) for r in rows[:PAGE]],
                    'next_before': rows[PAGE - 1].id if len(rows) > PAGE else None})


@companion_internal_bp.get('/meetings/<int:recording_id>')
def meeting(recording_id):
    recording = _meeting(recording_id)
    if recording is None:
        return _error('找不到这场会议', 404)
    version = _latest_version(recording_id)
    summary = version.markdown if version else None
    if summary is None:
        from src.services.meeting_assistant.service import legacy_summary
        summary = legacy_summary(recording)
    return jsonify({**_card(recording), 'summary': summary,
                    'summary_version': version.version if version else None,
                    'sections': version.sections if version and version.sections else None})


@companion_internal_bp.get('/meetings/<int:recording_id>/transcript')
def transcript(recording_id):
    from src.api.meetings import transcript_rows
    recording = _meeting(recording_id)
    if recording is None:
        return _error('找不到这场会议', 404)
    rows = transcript_rows(recording.transcription)
    offset = max(0, request.args.get('offset', 0, type=int))
    limit = min(TRANSCRIPT_PAGE, max(1, request.args.get('limit', TRANSCRIPT_PAGE, type=int)))
    page = rows[offset:offset + limit]
    return jsonify({'total': len(rows), 'offset': offset,
                    'lines': [{'n': offset + i + 1, 'time': r.get('start'), 'speaker': r.get('speaker'), 'text': r['text']}
                              for i, r in enumerate(page)]})


@companion_internal_bp.get('/search')
def search():
    """在会议标题、摘要和原文里找关键词，返回每场会议命中的片段。"""
    from src.api.meetings import transcript_rows
    from src.utils.search import contains_pattern, escape_like  # noqa: F401
    term = (request.args.get('q') or '').strip()
    if not term:
        return _error('缺少关键词 q')
    pattern = contains_pattern(term)
    candidates = (Recording.query.filter(Recording.user_id == _uid())
                  .filter(or_(Recording.title.ilike(pattern, escape='\\'), Recording.summary.ilike(pattern, escape='\\'),
                              Recording.transcription.ilike(pattern, escape='\\')))
                  .order_by(Recording.id.desc()).limit(30).all())
    hits = []
    for recording in candidates:
        snippets = []
        if term in (recording.title or ''):
            snippets.append({'where': 'title', 'text': recording.title})
        version = _latest_version(recording.id)
        summary = version.markdown if version else (recording.summary or '')
        for line in summary.splitlines():
            if term in line and len(snippets) < 6:
                snippets.append({'where': 'summary', 'text': line.strip()[:200]})
        for row in transcript_rows(recording.transcription):
            if term in row['text'] and len(snippets) < 10:
                snippets.append({'where': 'transcript', 'time': row.get('start'), 'speaker': row.get('speaker'),
                                 'text': row['text'][:200]})
        if snippets:
            hits.append({**_card(recording), 'snippets': snippets})
    return jsonify({'q': term, 'meetings': hits})


@companion_internal_bp.get('/todos')
def todos():
    """各场会议最新摘要里的待办（结构化的版本才有）。"""
    days = min(365, max(1, request.args.get('days', 60, type=int)))
    since = datetime.utcnow().timestamp() - days * 86400
    out = []
    recordings = (Recording.query.filter(Recording.user_id == _uid())
                  .order_by(Recording.id.desc()).limit(200).all())
    for recording in recordings:
        when = recording.meeting_date or recording.created_at
        if when and when.timestamp() < since:
            continue
        version = _latest_version(recording.id)
        sections = version.sections if version and isinstance(version.sections, dict) else {}
        items = sections.get('action_items') or sections.get('next_steps') or []
        for item in items:
            if isinstance(item, dict) and item.get('task'):
                out.append({'meeting_id': recording.id, 'meeting_title': recording.title, 'meeting_date': _iso(when),
                            'task': item['task'], 'owner': item.get('owner'), 'due': item.get('due')})
    return jsonify({'days': days, 'todos': out})


# ---------------------------------------------------------------- 长期记忆

def _entry_json(entry):
    return {'id': f'm{entry.id}', 'category': entry.category,
            'category_label': MEMORY_CATEGORY_LABELS.get(entry.category), 'content': entry.content,
            'pinned': bool(entry.pinned), 'source_meeting_id': entry.source_recording_id, 'updated_at': _iso(entry.updated_at)}


def _entry(ref):
    ref = str(ref)
    if ref.startswith('m'):
        ref = ref[1:]
    if not ref.isdigit():
        return None
    return MemoryEntry.query.filter_by(id=int(ref), user_id=_uid(), deleted_at=None).first()


@companion_internal_bp.get('/memory')
def memory_list():
    """不带 q：最该常记在心的一部分（始终记住、偏好、最近常用的，有字数预算）；带 q：按关键词搜。
    长期记忆可能很多，不整份返回。"""
    from src.services.meeting_assistant import memory as memory_store
    entries = memory_store.active_entries(_uid())
    query = (request.args.get('q') or '').strip()[:200]
    category = request.args.get('category')
    if category:
        entries = [e for e in entries if e.category == category]
    if query:
        rows = memory_store.search(entries, query)
        memory_store.mark_used(rows)
        db.session.commit()
        return jsonify({'query': query, 'total': len(entries), 'entries': [_entry_json(e) for e in rows]})
    rows, _rels = memory_store.select(entries, '')
    return jsonify({'categories': list(MEMORY_CATEGORIES), 'total': len(entries), 'shown': len(rows),
                    'note': (f'共 {len(entries)} 条，这里列出 {len(rows)} 条；找具体的人、项目、事情用 GET /memory?q=关键词。'
                             if len(rows) < len(entries) else None),
                    'entries': [_entry_json(e) for e in rows]})


@companion_internal_bp.post('/memory')
def memory_add():
    from src.services.meeting_assistant import service
    data = _body()
    try:
        entry = service.user_add_memory(_uid(), data.get('category'), data.get('content'), actor='companion',
                                        reason=data.get('reason'))
    except service.MemoryEditError as exc:
        return _error(str(exc))
    return jsonify(_entry_json(entry)), 201


@companion_internal_bp.patch('/memory/<ref>')
def memory_update(ref):
    from src.services.meeting_assistant import service
    entry = _entry(ref)
    if entry is None:
        return _error('这条记忆不存在', 404)
    data = _body()
    try:
        if 'content' in data or 'category' in data:
            service.user_update_memory(entry, data.get('category', entry.category), data.get('content', entry.content),
                                       actor='companion', reason=data.get('reason'))
        if 'pinned' in data:
            service.set_pinned(entry, data.get('pinned') is True, actor='companion', reason=data.get('reason'))
    except service.MemoryEditError as exc:
        return _error(str(exc))
    return jsonify(_entry_json(entry))


@companion_internal_bp.delete('/memory/<ref>')
def memory_delete(ref):
    from src.services.meeting_assistant import service
    entry = _entry(ref)
    if entry is None:
        return _error('这条记忆不存在', 404)
    service.user_delete_memory(entry, actor='companion', reason=_body().get('reason'))
    return jsonify({'deleted': f'm{entry.id}'})


# ---------------------------------------------------------------- 提醒

def _zone():
    from src.models import User
    return schedule.user_zone(db.session.get(User, _uid()))


def _reminder(reminder_id):
    return Reminder.query.filter_by(id=reminder_id, user_id=_uid()).first()


def _apply_reminder(reminder, data, zone):
    if 'title' in data:
        title = ' '.join(str(data.get('title') or '').split())
        if not title:
            raise ValueError('提醒标题不能为空')
        reminder.title = title[:200]
    if 'note' in data:
        reminder.note = (str(data.get('note') or '').strip() or None)
    if 'enabled' in data:
        reminder.enabled = bool(data.get('enabled'))
    repeat = data.get('repeat', reminder.repeat or 'once')
    if repeat not in schedule.REPEATS:
        raise ValueError('repeat 只能是 once / daily / weekdays / weekly')
    reminder.repeat = repeat
    if repeat == 'once':
        at = data.get('at')
        if at is not None:
            try:
                local = datetime.fromisoformat(str(at)).replace(tzinfo=None, second=0, microsecond=0)
            except ValueError:
                raise ValueError('at 的格式应为 YYYY-MM-DDTHH:MM（本地时间）')
            if local <= schedule.local_now(zone):
                raise ValueError('提醒时间已经过去了')
            reminder.next_run_at = schedule.to_utc(local, zone)
        if reminder.next_run_at is None:
            raise ValueError('一次性提醒需要 at（本地时间 YYYY-MM-DDTHH:MM）')
        reminder.time_of_day = reminder.weekday = None
    else:
        reminder.time_of_day = data.get('time', reminder.time_of_day)
        if repeat == 'weekly':
            weekday = data.get('weekday', reminder.weekday)
            if not isinstance(weekday, int) or not 0 <= weekday <= 6:
                raise ValueError('weekly 需要 weekday（0=周一 … 6=周日）')
            reminder.weekday = weekday
        else:
            reminder.weekday = None
        schedule.parse_hhmm(reminder.time_of_day)
        reminder.next_run_at = schedule.to_utc(
            schedule.next_occurrence(repeat, reminder.time_of_day, reminder.weekday, zone), zone)
    if not reminder.enabled:
        reminder.next_run_at = reminder.next_run_at  # 保留时间，但不会触发


def _reminder_json(reminder, zone):
    from src.utils.timezones import to_local
    data = reminder.to_dict()
    data['next_run_local'] = to_local(reminder.next_run_at, zone).strftime('%Y-%m-%d %H:%M') if reminder.next_run_at else None
    return data


@companion_internal_bp.get('/reminders')
def reminders():
    zone = _zone()
    rows = Reminder.query.filter_by(user_id=_uid()).order_by(Reminder.enabled.desc(), Reminder.next_run_at).all()
    return jsonify({'timezone': zone, 'now_local': schedule.local_now(zone).strftime('%Y-%m-%d %H:%M'),
                    'reminders': [_reminder_json(r, zone) for r in rows]})


@companion_internal_bp.post('/reminders')
def reminder_add():
    zone = _zone()
    data = _body()
    reminder = Reminder(user_id=_uid(), title='', repeat='once', enabled=True)
    data.setdefault('title', data.get('title'))
    try:
        _apply_reminder(reminder, {'title': data.get('title'), **data}, zone)
    except ValueError as exc:
        return _error(str(exc))
    if Reminder.query.filter_by(user_id=_uid(), enabled=True).count() >= 50:
        return _error('提醒最多 50 条，先删掉一些')
    db.session.add(reminder)
    db.session.commit()
    return jsonify(_reminder_json(reminder, zone)), 201


@companion_internal_bp.patch('/reminders/<int:reminder_id>')
def reminder_update(reminder_id):
    zone = _zone()
    reminder = _reminder(reminder_id)
    if reminder is None:
        return _error('这条提醒不存在', 404)
    try:
        _apply_reminder(reminder, _body(), zone)
    except ValueError as exc:
        db.session.rollback()
        return _error(str(exc))
    db.session.commit()
    return jsonify(_reminder_json(reminder, zone))


@companion_internal_bp.delete('/reminders/<int:reminder_id>')
def reminder_delete(reminder_id):
    reminder = _reminder(reminder_id)
    if reminder is None:
        return _error('这条提醒不存在', 404)
    if reminder.is_brief:
        return _error('今日简报不能删除，可以用 PATCH 设 enabled=false 关掉')
    db.session.delete(reminder)
    db.session.commit()
    return jsonify({'deleted': reminder_id})


# ---------------------------------------------------------------- 主动发消息

@companion_internal_bp.post('/messages')
def send_message():
    """主动给用户发一条消息（提醒到点、今日简报）。普通聊天的回复不用调这个。"""
    text = str(_body().get('text') or '').strip()
    if not text:
        return _error('text 不能为空')
    message = CompanionMessage(user_id=_uid(), role='assistant', kind='proactive', content=text,
                               meta={'reminder_id': g.get('companion_reminder_id'), 'brief': g.get('companion_is_brief')})
    db.session.add(message)
    db.session.commit()
    from src.services.companion.service import message_json
    hub.publish(_uid(), 'message', message_json(message))
    from src.services.companion.service import unread_count
    hub.publish(_uid(), 'unread', {'count': unread_count(_uid())})
    from src.services.companion.push import notify_async
    notify_async(_uid(), message.id)
    return jsonify({'sent': message.id}), 201


# ---------------------------------------------------------------- 联网搜索

@companion_internal_bp.post('/web-search')
def web_search():
    from src.services import web_search as searcher
    query = str(_body().get('query') or '')
    now_text = schedule.local_now(_zone()).strftime('%Y年%m月%d日 %H:%M')
    try:
        return jsonify(searcher.search(_uid(), query, now_text=now_text))
    except searcher.WebSearchError as error:
        return _error(str(error), 400)
