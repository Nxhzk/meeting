"""会议助手的接口：摘要版本、重新生成、长期记忆。

只服务当前登录用户自己的会议和记忆。
"""
from flask import Blueprint, jsonify, request
from flask_login import current_user, login_required

from src.database import db
from src.models import ProcessingJob, Recording
from src.models.meeting_assistant import (
    MEMORY_CATEGORIES, MEMORY_CATEGORY_LABELS, MemoryEntry, MemoryEvent, SummaryVersion,
)
from src.services.meeting_assistant import runner, service

assistant_bp = Blueprint('meeting_assistant', __name__)
FEEDBACK_MAX = 2000


def _json(data, status=200):
    response = jsonify(data)
    response.headers['Cache-Control'] = 'no-store'
    return response, status


def _own_recording(recording_id):
    return Recording.query.filter_by(id=recording_id, user_id=current_user.id).first()


def _body():
    data = request.get_json(silent=True)
    return data if isinstance(data, dict) else {}


# ---------------------------------------------------------------- 摘要

@assistant_bp.get('/api/meetings/<int:recording_id>/summary/versions/<int:version>')
@login_required
def summary_version(recording_id, version):
    from src.api.meetings import document_html
    if _own_recording(recording_id) is None:
        return _json({'error': '找不到这条会议记录。'}, 404)
    row = SummaryVersion.query.filter_by(recording_id=recording_id, version=version).first()
    if row is None:
        return _json({'error': '找不到这个版本。'}, 404)
    return _json(row.to_dict(html=document_html(row.markdown)))


@assistant_bp.post('/api/meetings/<int:recording_id>/summary/regenerate')
@login_required
def regenerate(recording_id):
    from src.services.job_cancel import snapshot_for_reprocess
    from src.services.job_queue import job_queue
    from src.utils.error_formatting import is_transcription_error

    recording = _own_recording(recording_id)
    if recording is None:
        return _json({'error': '找不到这条会议记录。'}, 404)
    feedback = _body().get('feedback')
    if feedback is not None and not isinstance(feedback, str):
        return _json({'error': '修改意见格式不正确。'}, 400)
    feedback = (feedback or '').strip()
    if len(feedback) > FEEDBACK_MAX:
        return _json({'error': f'修改意见最多 {FEEDBACK_MAX} 字。'}, 400)
    text = (recording.transcription or '').strip()
    if len(text) < 10 or is_transcription_error(text):
        return _json({'error': '这场会议还没有可用的会议原文。'}, 400)
    if recording.status in ('PENDING', 'QUEUED', 'PROCESSING', 'SUMMARIZING', 'STITCHING') or \
            ProcessingJob.query.filter(ProcessingJob.recording_id == recording_id,
                                       ProcessingJob.status.in_(('queued', 'processing'))).first():
        return _json({'error': '这场会议正在整理，请稍后再试。'}, 409)
    try:
        runner.Settings.from_env().check()
    except runner.AssistantUnavailable as exc:
        return _json({'error': str(exc)}, 503)

    # 不清空当前摘要：生成期间照常显示，失败也不受影响。
    service.ensure_legacy_version(recording)
    # 先提交：下面清调用记录用的是另一条数据库连接，SQLite 同时只允许一个写事务，
    # 不先提交就会自己等自己，30 秒后报「database is locked」
    db.session.commit()
    # 上一轮的调用记录立刻清掉：页面在新任务开始前不会再看到旧内容
    from src.services.meeting_assistant import trace as tracing
    tracing.clear(recording_id)
    restore_state = snapshot_for_reprocess(recording, 'summary')
    recording.status = 'SUMMARIZING'
    db.session.commit()
    job_queue.enqueue(user_id=current_user.id, recording_id=recording_id, job_type='reprocess_summary',
                      params={'user_id': current_user.id, 'feedback': feedback or None},
                      restore_state=restore_state)
    return _json({'success': True})


# ---------------------------------------------------------------- 长期记忆

def _titles(ids):
    ids = {i for i in ids if i}
    if not ids:
        return {}
    rows = Recording.query.filter(Recording.id.in_(ids), Recording.user_id == current_user.id) \
        .with_entities(Recording.id, Recording.title).all()
    return {rid: (title or '会议记录') for rid, title in rows}


def _own_entry(entry_id):
    return MemoryEntry.query.filter_by(id=entry_id, user_id=current_user.id).first()


def _entry_json(entry):
    return entry.to_dict(_titles([entry.source_recording_id]).get(entry.source_recording_id))


@assistant_bp.get('/api/memory')
@login_required
def list_memory():
    include_deleted = request.args.get('deleted') == '1'
    query = MemoryEntry.query.filter_by(user_id=current_user.id)
    if not include_deleted:
        query = query.filter(MemoryEntry.deleted_at.is_(None))
    entries = query.order_by(MemoryEntry.updated_at.desc()).all()
    titles = _titles(e.source_recording_id for e in entries)
    return _json({
        'categories': [{'key': key, 'label': MEMORY_CATEGORY_LABELS[key]} for key in MEMORY_CATEGORIES],
        'entries': [e.to_dict(titles.get(e.source_recording_id)) for e in entries],
        'consolidation': _consolidation_json(current_user.id),
    })


def _consolidation_json(user_id):
    from src.services.meeting_assistant import consolidate, memory as memory_store
    count, chars = memory_store.totals(user_id)
    last = consolidate.last(user_id)
    return {
        'running': consolidate.running(user_id),
        'count': count, 'chars': chars,
        'threshold_chars': consolidate.THRESHOLD_CHARS, 'threshold_entries': consolidate.THRESHOLD_ENTRIES,
        'context_chars': memory_store.CONTEXT_CHARS,
        'last': last.to_dict() if last else None,
    }


@assistant_bp.get('/api/memory/consolidation')
@login_required
def consolidation_status():
    return _json(_consolidation_json(current_user.id))


@assistant_bp.post('/api/memory/consolidate')
@login_required
def consolidate_now():
    """用户手动「立即整理」。"""
    from flask import current_app
    from src.services.meeting_assistant import consolidate
    from src.services.meeting_assistant import memory as memory_store
    count, _chars = memory_store.totals(current_user.id)
    if count < 2:
        return _json({'error': '记忆还很少，不需要整理。'}, 400)
    if not consolidate.start(current_app._get_current_object(), current_user.id, 'user'):
        return _json({'error': '正在整理中，请稍等。'}, 409)
    return _json(_consolidation_json(current_user.id), 202)


@assistant_bp.post('/api/memory')
@login_required
def add_memory():
    data = _body()
    try:
        entry = service.user_add_memory(current_user.id, data.get('category'), data.get('content'))
    except service.MemoryEditError as exc:
        return _json({'error': str(exc)}, 400)
    return _json(_entry_json(entry), 201)


@assistant_bp.patch('/api/memory/<int:entry_id>')
@login_required
def update_memory(entry_id):
    entry = _own_entry(entry_id)
    if entry is None or entry.deleted_at is not None:
        return _json({'error': '这条记忆不存在。'}, 404)
    data = _body()
    try:
        if 'content' in data or 'category' in data:
            service.user_update_memory(entry, data.get('category', entry.category), data.get('content', entry.content))
        if 'pinned' in data:
            service.set_pinned(entry, data.get('pinned') is True)
    except service.MemoryEditError as exc:
        return _json({'error': str(exc)}, 400)
    return _json(_entry_json(entry))


@assistant_bp.delete('/api/memory/<int:entry_id>')
@login_required
def delete_memory(entry_id):
    entry = _own_entry(entry_id)
    if entry is None:
        return _json({'error': '这条记忆不存在。'}, 404)
    service.user_delete_memory(entry)
    return _json(_entry_json(entry))


@assistant_bp.post('/api/memory/<int:entry_id>/restore')
@login_required
def restore_memory(entry_id):
    entry = _own_entry(entry_id)
    if entry is None:
        return _json({'error': '这条记忆不存在。'}, 404)
    try:
        service.user_restore_memory(entry)
    except service.MemoryEditError as exc:
        return _json({'error': str(exc)}, 400)
    return _json(_entry_json(entry))


@assistant_bp.get('/api/memory/events')
@login_required
def memory_events():
    entry_id = request.args.get('entry', type=int)
    before = request.args.get('before', type=int)
    query = MemoryEvent.query.filter_by(user_id=current_user.id)
    if entry_id:
        query = query.filter_by(entry_id=entry_id)
    if before:
        query = query.filter(MemoryEvent.id < before)
    rows = query.order_by(MemoryEvent.id.desc()).limit(51).all()
    titles = _titles(r.recording_id for r in rows[:50])
    return _json({
        'events': [r.to_dict(titles.get(r.recording_id)) for r in rows[:50]],
        'next_before': rows[49].id if len(rows) > 50 else None,
    })
