"""会议助手的编排：准备资料、运行、校验、在一个事务里写库。

数据库是唯一正本：会议原文、会话、长期记忆都从库里导出给 pi，成功后
再写回。失败、超时或取消时什么都不写，这次的记忆改动全部作废。
"""
import hashlib
import logging
import time
from datetime import datetime

from flask import current_app

from src.database import db
from src.models import Recording, User
from src.models.meeting_assistant import (
    MEMORY_CATEGORIES, MEMORY_CATEGORY_LABELS, MEMORY_ENTRY_MAX_CHARS, MEMORY_MAX_ENTRIES,
    SESSION_ACTIVE, SESSION_RETIRED, AssistantSession, MemoryEntry,
    MemoryEvent, SummaryVersion,
)
from src.services.meeting_assistant import memory as memory_store
from src.services.meeting_assistant import prompts, render, runner
from src.services.meeting_assistant import trace as tracing

logger = logging.getLogger(__name__)

PART_MAX_LINES = 120
PART_MAX_CHARS = 9000
MAX_NUDGES = 2
LEGACY_SENTINELS = ('[Summary skipped', '[Summary generation failed', '[Summary not generated]')
LIMITS = {
    'entryChars': MEMORY_ENTRY_MAX_CHARS, 'maxEntries': MEMORY_MAX_ENTRIES,
    'textChars': 20000, 'listItems': 60,
}


class AssistantFailed(RuntimeError):
    """这次生成没有得到合格的会议摘要。message 是给用户看的中文。"""


# ---------------------------------------------------------------- 资料准备

def _clock(seconds):
    seconds = int(seconds)
    return f'{seconds // 3600:02d}:{seconds // 60 % 60:02d}:{seconds % 60:02d}'


def transcript_lines(recording):
    """会议原文的每一句：「[时:分:秒] 发言人：内容」。"""
    from src.api.meetings import transcript_rows
    lines = []
    for row in transcript_rows(recording.transcription):
        text = ' '.join(row['text'].split())
        if not text:
            continue
        stamp = f"[{_clock(row['start'])}] " if row.get('start') is not None else ''
        speaker = f"{row['speaker']}：" if row.get('speaker') else ''
        lines.append(f'{stamp}{speaker}{text}')
    return lines


def split_parts(lines):
    """按行数和字数把会议原文切成段，每段都远小于 pi read 的截断上限。"""
    parts, current, size = [], [], 0
    for line in lines:
        if current and (len(current) >= PART_MAX_LINES or size + len(line) > PART_MAX_CHARS):
            parts.append(current)
            current, size = [], 0
        current.append(line[:PART_MAX_CHARS])
        size += len(line) + 1
    if current:
        parts.append(current)
    files, meta, first = {}, [], 1
    width = max(2, len(str(len(parts))))
    for index, chunk in enumerate(parts, 1):
        path = f'transcript/part-{index:0{width}d}.md'
        files[path] = '\n'.join(chunk) + '\n'
        meta.append({'path': path, 'lines': len(chunk), 'first': first, 'last': first + len(chunk) - 1})
        first += len(chunk)
    return files, meta


def meeting_info(recording, owner):
    from src.utils.timezones import to_local, user_timezone
    zone = user_timezone(owner)
    when = recording.meeting_date or recording.created_at
    rows = ['# 会议信息', '']
    title = (recording.title or '').strip()
    if title:
        rows.append(f'- 标题：{title}')
    if when:
        rows.append(f"- 时间：{to_local(when, zone).strftime('%Y-%m-%d %H:%M')}")
    duration = recording.get_audio_duration(allow_probe_fallback=False)
    if duration:
        rows.append(f'- 时长：{_clock(duration)}')
    if recording.participants:
        rows.append(f'- 参会人：{recording.participants}')
    profile = [v for v in (owner.name, owner.job_title, owner.company) if v]
    if profile:
        rows.append(f"- 记录人：{'，'.join(profile)}")
    if owner.summary_include_notes:
        notes = (recording.get_user_notes(owner) or '').strip()
        if notes:
            rows += ['', '## 记录人的笔记', '', '（笔记是背景信息；会议内容以会议原文为准。）', '', notes[:8000]]
    return '\n'.join(rows) + '\n'


def memory_snapshot(user_id):
    """这位用户全部有效的长期记忆（给会议助手的工具用：查找、更新、删除）。"""
    return [memory_store.as_row(entry) for entry in memory_store.active_entries(user_id)]


def legacy_summary(recording):
    text = (recording.summary or '').strip()
    return text if text and not text.startswith(LEGACY_SENTINELS) else None


def ensure_legacy_version(recording):
    """旧系统的摘要算作 v1（只在还没有任何版本时建）。"""
    if SummaryVersion.query.filter_by(recording_id=recording.id).first() is not None:
        return None
    text = legacy_summary(recording)
    if not text:
        return None
    version = SummaryVersion(recording_id=recording.id, version=1, markdown=text, source='legacy',
                             created_at=recording.completed_at or recording.created_at or datetime.utcnow())
    db.session.add(version)
    db.session.flush()
    return version


# ---------------------------------------------------------------- 主流程

def generate(recording_id, user_id=None, feedback=None, report=None, cancel_requested=None):
    """为一场会议生成（或重新生成）会议摘要。成功返回 SummaryVersion。"""
    recording = db.session.get(Recording, recording_id)
    if recording is None:
        raise AssistantFailed('会议记录不存在。')
    owner = db.session.get(User, recording.user_id)
    lines = transcript_lines(recording)
    if not lines:
        raise AssistantFailed('没有可用的会议原文。')
    feedback = (feedback or '').strip()[:2000] or None
    settings = runner.Settings.from_env()

    transcript_text = '\n'.join(lines)
    sha = hashlib.sha256(transcript_text.encode('utf-8')).hexdigest()
    files, parts = split_parts(lines)
    files['meeting.md'] = meeting_info(recording, owner)
    # 上下文里只放和这场会议最相关的一部分记忆（固定字数预算），其余让它用 search_memory 查
    entries = memory_store.active_entries(owner.id)
    memory = [memory_store.as_row(entry) for entry in entries]
    memory_snapshot_initial = list(memory)
    chosen, rels = memory_store.select(entries, f'{recording.title or ""}\n{transcript_text}')
    context_memory = [memory_store.as_row(entry) for entry in chosen]
    memory_store.mark_used(chosen, rels)

    session = (AssistantSession.query.filter_by(recording_id=recording.id, status=SESSION_ACTIVE)
               .order_by(AssistantSession.id.desc()).first())
    if session is not None and session.transcript_sha256 != sha:
        # 会议原文变了（重新转写、改了发言人）：旧会话里的引用对不上，换新会话。
        session.status = SESSION_RETIRED
        session = None
    continuing = session is not None and bool(session.session_jsonl)
    previous = None
    if not continuing:
        latest = (SummaryVersion.query.filter_by(recording_id=recording.id)
                  .order_by(SummaryVersion.version.desc()).first())
        previous = latest.markdown if latest is not None else legacy_summary(recording)
    db.session.commit()   # 不在模型调用期间占着事务

    if continuing:
        message = prompts.regenerate_message(parts, context_memory, MEMORY_CATEGORY_LABELS, feedback, total=len(memory))
    else:
        message = prompts.first_message(parts, context_memory, MEMORY_CATEGORY_LABELS, feedback, previous, total=len(memory))

    started = time.time()
    session_jsonl = session.session_jsonl if continuing else None
    tracing.clear(recording.id)
    trace = tracing.Trace(tracing.db_sink(recording.id), parts)
    total_prompt = total_completion = 0
    memory_ops = []
    summary = None
    problem = None
    for attempt in range(MAX_NUDGES + 1):
        result = runner.run(settings, runner.RunInput(
            meeting_files=files, parts=parts, memory=memory, categories=MEMORY_CATEGORY_LABELS,
            limits=LIMITS, message=message, session_jsonl=session_jsonl,
        ), prompts.SYSTEM_PROMPT, report=report, cancel_requested=cancel_requested, trace=trace)
        session_jsonl = result.session_jsonl or session_jsonl
        total_prompt += result.prompt_tokens
        total_completion += result.completion_tokens
        memory_ops += result.memory_ops
        if result.error and result.summary is None:
            raise AssistantFailed(result.error)
        if result.summary is not None:
            try:
                summary = render.normalize(result.summary)
                break
            except render.SummaryInvalid as exc:
                problem = f'提交的摘要不合格：{exc}'
        else:
            problem = '还没有调用 save_summary 提交会议摘要。'
        if attempt < MAX_NUDGES:
            # 同一会话里接着说，让它补上。下一轮的记忆快照要带上这一轮的改动。
            message = prompts.nudge_message(problem)
            memory = _apply_ops_preview(memory, result.memory_ops)
            if report:
                report('正在补充')
    if summary is None:
        raise AssistantFailed(f'会议助手没能完成摘要（{problem}）。')

    seen = {row['id']: (row['category'], row['content']) for row in memory_snapshot_initial}
    return _commit(recording_id, owner.id, user_id or owner.id, session, sha, session_jsonl, summary,
                   memory_ops, feedback, settings.model, total_prompt, total_completion,
                   int(time.time() - started), seen)


def _apply_ops_preview(memory, ops):
    rows = {row['id']: dict(row) for row in memory}
    for op in ops:
        if op.get('op') == 'delete':
            rows.pop(op.get('id'), None)
        elif op.get('op') in ('add', 'update'):
            rows[op['id']] = {'id': op['id'], 'category': op['category'], 'content': op['content']}
    return list(rows.values())


def _commit(recording_id, owner_id, actor_user_id, session, sha, session_jsonl, summary, memory_ops,
            feedback, model, prompt_tokens, completion_tokens, duration, seen=None):
    recording = db.session.get(Recording, recording_id)
    if recording is None:
        raise AssistantFailed('会议记录在生成期间被删除了。')
    if session is not None:
        session = db.session.get(AssistantSession, session.id)
    if session is None or session.status != SESSION_ACTIVE:
        session = AssistantSession(recording_id=recording_id, user_id=owner_id, transcript_sha256=sha,
                                   status=SESSION_ACTIVE)
        db.session.add(session)
    session.session_jsonl = session_jsonl
    session.runs = (session.runs or 0) + 1
    session.updated_at = datetime.utcnow()

    ensure_legacy_version(recording)
    last = db.session.query(db.func.max(SummaryVersion.version)).filter_by(recording_id=recording_id).scalar() or 0
    markdown = render.to_markdown(summary)
    db.session.flush()
    version = SummaryVersion(
        recording_id=recording_id, version=last + 1, sections=summary, markdown=markdown,
        feedback=feedback, session_id=session.id, source='assistant', model_name=model,
        prompt_tokens=prompt_tokens, completion_tokens=completion_tokens, duration_seconds=duration,
        created_by=actor_user_id,
    )
    db.session.add(version)
    db.session.flush()
    apply_memory_ops(owner_id, recording_id, version.id, memory_ops, seen)
    recording.summary = markdown
    recording.summarization_duration_seconds = duration
    db.session.commit()
    _record_tokens(owner_id, model, prompt_tokens, completion_tokens)
    if memory_ops:
        maybe_consolidate_later(owner_id)
    return version


def apply_memory_ops(user_id, recording_id, version_id, ops, seen=None):
    """把会议助手这次的记忆改动写进库。只认这位用户自己的条目。

    seen 是会议助手开始时读到的快照 {"m12": (分类, 内容)}。修改或删除一条
    已有记忆前，先确认它在这期间没被别人改过（用户在页面上改了，或另一场
    会议的生成先提交了）；改过就跳过，不覆盖别人的改动，下次生成时会议助手
    会看到最新内容再判断。
    """
    created = {}
    for op in ops:
        kind = op.get('op')
        ref = str(op.get('id') or '')
        reason = (op.get('reason') or '')[:300] or None
        if kind == 'add':
            category, content = op.get('category'), _clean(op.get('content'))
            if category not in MEMORY_CATEGORIES or not content:
                continue
            entry = MemoryEntry(user_id=user_id, category=category, content=content,
                                source_recording_id=recording_id)
            db.session.add(entry)
            db.session.flush()
            created[ref] = entry
            _event(entry, 'add', recording_id, version_id, None, entry.snapshot(), reason)
            continue
        entry = created.get(ref) or _own_entry(user_id, ref)
        if entry is None or entry.deleted_at is not None:
            logger.info('Skipping memory %s on %s: entry gone', kind, ref)
            continue
        if seen is not None and ref not in created and ref in seen and seen[ref] != (entry.category, entry.content):
            logger.info('Skipping memory %s on %s: changed since the assistant read it', kind, ref)
            continue
        before = entry.snapshot()
        if kind == 'update':
            category, content = op.get('category'), _clean(op.get('content'))
            if category not in MEMORY_CATEGORIES or not content:
                continue
            entry.category, entry.content = category, content
            entry.updated_at = datetime.utcnow()
            if seen is not None and ref in seen:
                seen[ref] = (category, content)   # 同一次运行里接着改同一条，不算冲突
            _event(entry, 'update', recording_id, version_id, before, entry.snapshot(), reason)
        elif kind == 'delete':
            entry.deleted_at = entry.updated_at = datetime.utcnow()
            _event(entry, 'delete', recording_id, version_id, before, None, reason)


def _own_entry(user_id, ref):
    if not (ref.startswith('m') and ref[1:].isdigit()):
        return None
    return MemoryEntry.query.filter_by(id=int(ref[1:]), user_id=user_id).first()


def _clean(content):
    return ' '.join(str(content or '').split())[:MEMORY_ENTRY_MAX_CHARS]


def _event(entry, action, recording_id, version_id, before, after, reason, actor='assistant'):
    db.session.add(MemoryEvent(user_id=entry.user_id, entry_id=entry.id, action=action, actor=actor,
                               recording_id=recording_id, summary_version_id=version_id,
                               before=before, after=after, reason=reason))


def _record_tokens(user_id, model, prompt_tokens, completion_tokens):
    try:
        from src.services.token_tracking import token_tracker
        token_tracker.record_usage(user_id=user_id, operation_type='summarization', prompt_tokens=prompt_tokens,
                                   completion_tokens=completion_tokens,
                                   total_tokens=prompt_tokens + completion_tokens, model_name=model)
    except Exception:
        current_app.logger.warning('Could not record assistant token usage', exc_info=True)


# ---------------------------------------------------------------- 用户编辑记忆

class MemoryEditError(ValueError):
    pass


def _validate(category, content):
    if category not in MEMORY_CATEGORIES:
        raise MemoryEditError('分类不正确。')
    if not isinstance(content, str):
        raise MemoryEditError('内容格式不正确。')
    if len(' '.join(content.split())) > MEMORY_ENTRY_MAX_CHARS:
        raise MemoryEditError(f'一条记忆最多 {MEMORY_ENTRY_MAX_CHARS} 字。')
    content = _clean(content)
    if not content:
        raise MemoryEditError('内容不能为空。')
    return content


def _reason(reason):
    return (str(reason).strip()[:300] or None) if reason else None


def user_add_memory(user_id, category, content, actor='user', reason=None):
    content = _validate(category, content)
    if MemoryEntry.query.filter_by(user_id=user_id, deleted_at=None).count() >= MEMORY_MAX_ENTRIES:
        raise MemoryEditError(f'长期记忆最多 {MEMORY_MAX_ENTRIES} 条。')
    entry = MemoryEntry(user_id=user_id, category=category, content=content)
    db.session.add(entry)
    db.session.flush()
    _event(entry, 'add', None, None, None, entry.snapshot(), _reason(reason), actor=actor)
    db.session.commit()
    maybe_consolidate_later(user_id)
    return entry


def user_update_memory(entry, category, content, actor='user', reason=None):
    content = _validate(category, content)
    before = entry.snapshot()
    if before == {'category': category, 'content': content}:
        return entry
    entry.category, entry.content, entry.updated_at = category, content, datetime.utcnow()
    _event(entry, 'update', None, None, before, entry.snapshot(), _reason(reason), actor=actor)
    db.session.commit()
    return entry


def user_delete_memory(entry, actor='user', reason=None):
    if entry.deleted_at is None:
        entry.deleted_at = entry.updated_at = datetime.utcnow()
        _event(entry, 'delete', None, None, entry.snapshot(), None, _reason(reason), actor=actor)
        db.session.commit()
    return entry


def set_pinned(entry, pinned, actor='user', reason=None):
    """「始终记住」：每次都放进上下文，记忆整理时不动。"""
    pinned = bool(pinned)
    if entry.deleted_at is None and bool(entry.pinned) != pinned:
        entry.pinned = pinned
        _event(entry, 'pin' if pinned else 'unpin', None, None, None, entry.snapshot(), _reason(reason), actor=actor)
        db.session.commit()
        maybe_consolidate_later(entry.user_id)
    return entry


def maybe_consolidate_later(user_id):
    """记忆变多后提醒后台整理（真正的判断和节流在 consolidate.due 里）。"""
    try:
        from src.services.meeting_assistant import consolidate
        consolidate.nudge(user_id)
    except Exception:
        logger.exception('Could not schedule memory consolidation for user %s', user_id)


def user_restore_memory(entry):
    if entry.deleted_at is not None:
        if MemoryEntry.query.filter_by(user_id=entry.user_id, deleted_at=None).count() >= MEMORY_MAX_ENTRIES:
            raise MemoryEditError(f'长期记忆最多 {MEMORY_MAX_ENTRIES} 条，请先删除一些。')
        entry.deleted_at = None
        entry.updated_at = datetime.utcnow()
        _event(entry, 'restore', None, None, None, entry.snapshot(), None, actor='user')
        db.session.commit()
    return entry


def record_failure(recording, reason):
    """已有摘要时重新生成失败：记在会话上，不动摘要。"""
    ensure_legacy_version(recording)
    session = (AssistantSession.query.filter_by(recording_id=recording.id, status=SESSION_ACTIVE)
               .order_by(AssistantSession.id.desc()).first())
    if session is None:
        lines = transcript_lines(recording)
        session = AssistantSession(recording_id=recording.id, user_id=recording.user_id, status=SESSION_ACTIVE,
                                   transcript_sha256=hashlib.sha256('\n'.join(lines).encode('utf-8')).hexdigest())
        db.session.add(session)
    session.last_error = (reason or '')[:1000]
    session.last_error_at = datetime.utcnow()


def last_failure(recording_id):
    """最近一次重新生成失败、且之后没有成功过时，返回 (原因, 时间)。"""
    session = (AssistantSession.query.filter_by(recording_id=recording_id)
               .filter(AssistantSession.last_error_at.isnot(None))
               .order_by(AssistantSession.last_error_at.desc()).first())
    if session is None:
        return None
    latest = (SummaryVersion.query.filter_by(recording_id=recording_id)
              .order_by(SummaryVersion.created_at.desc()).first())
    if latest is not None and latest.created_at >= session.last_error_at:
        return None
    return session.last_error, session.last_error_at
