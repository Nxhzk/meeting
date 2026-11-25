"""记忆整理：长期记忆多了以后，在后台合并重复、精简冗长、删掉过时的条目。

参考 Mem0 的「合并 / 更新 / 删除」判断和 Letta 的 sleep-time 后台整理：
会议助手和小助理平时只增量地记，难免越记越多、越记越碎；超过阈值时由这里
统一整理一遍，把总量压回目标大小。上下文大小本身由 memory.select 的预算控制，
整理解决的是「记忆库越来越乱、越来越大」。

安全规则（模型给出的操作都要过这一关，不合规的直接丢掉）：
- 「始终记住」的条目不删、不改、不并入别的条目；
- 用户自己写过或改过的条目不删，只允许和讲同一件事的条目合并；
- 一批里直接删除的条数不超过三分之一；
- 都是软删除，每一步写进变更记录（actor=consolidator，附理由），用户可以恢复。
"""
import json
import logging
import os
import re
import threading
from datetime import datetime, timedelta

from src.database import db
from src.models.meeting_assistant import (
    MEMORY_CATEGORIES, MEMORY_CATEGORY_LABELS, MEMORY_ENTRY_MAX_CHARS, MemoryConsolidation, MemoryEntry, MemoryEvent,
)
from src.services.meeting_assistant import memory as memory_store

logger = logging.getLogger(__name__)

THRESHOLD_CHARS = int(os.environ.get('MEMORY_CONSOLIDATE_CHARS', '12000'))
THRESHOLD_ENTRIES = int(os.environ.get('MEMORY_CONSOLIDATE_ENTRIES', '80'))
TARGET_RATIO = 0.6                     # 整理目标：压到阈值的 60% 左右
AUTO_INTERVAL = timedelta(hours=24)    # 自动整理每人每天最多一次
BATCH_ENTRIES = 120
BATCH_CHARS = 30000
MAX_DELETE_SHARE = 1 / 3
ACTOR = 'consolidator'

_lock = threading.Lock()
_running = set()


class ConsolidationFailed(RuntimeError):
    pass


# ---------------------------------------------------------------- 什么时候整理

def needs_it(user_id):
    count, chars = memory_store.totals(user_id)
    return count >= THRESHOLD_ENTRIES or chars >= THRESHOLD_CHARS


def running(user_id):
    with _lock:
        return user_id in _running


def due(user_id):
    """该自动整理了：超过阈值，且 24 小时内没有自动整理过。"""
    if running(user_id) or not needs_it(user_id):
        return False
    last = (MemoryConsolidation.query.filter_by(user_id=user_id, trigger='auto')
            .order_by(MemoryConsolidation.id.desc()).first())
    return last is None or datetime.utcnow() - last.started_at >= AUTO_INTERVAL


def nudge(user_id):
    """记忆有变动之后调用：该整理了就在后台开始。"""
    from flask import current_app
    if due(user_id):
        start(current_app._get_current_object(), user_id, 'auto')


def start(app, user_id, trigger='user'):
    """在后台整理。已经在整理时返回 False。"""
    with _lock:
        if user_id in _running:
            return False
        _running.add(user_id)
    threading.Thread(target=_run_in_thread, args=(app, user_id, trigger), name=f'memory-consolidate-{user_id}',
                     daemon=True).start()
    return True


def _run_in_thread(app, user_id, trigger):
    try:
        with app.app_context():
            run(user_id, trigger)
    except Exception:
        logger.exception('Memory consolidation crashed for user %s', user_id)
    finally:
        with _lock:
            _running.discard(user_id)


# ---------------------------------------------------------------- 整理一次

def run(user_id, trigger='user', call_model=None):
    """同步整理一次，返回 MemoryConsolidation 记录。call_model 可替换（测试用）。"""
    call_model = call_model or _call_model
    count, chars = memory_store.totals(user_id)
    record = MemoryConsolidation(user_id=user_id, trigger=trigger, entries_before=count, chars_before=chars)
    db.session.add(record)
    db.session.commit()
    try:
        authored = _user_authored(user_id)
        target_total = int(min(chars, THRESHOLD_CHARS) * TARGET_RATIO) if chars >= THRESHOLD_CHARS else chars
        for category in MEMORY_CATEGORIES:
            entries = [e for e in memory_store.active_entries(user_id) if e.category == category]
            if len(entries) < 2 and not any(len(e.content) > 200 for e in entries):
                continue
            category_chars = sum(len(e.content) for e in entries)
            # 各分类按自己的占比分摊目标字数
            category_target = int(category_chars * (target_total / chars)) if chars else category_chars
            for batch in _batches(entries):
                batch_chars = sum(len(e.content) for e in batch)
                target = int(category_target * batch_chars / category_chars) if category_chars else batch_chars
                ops = call_model(_prompt(category, batch, authored, target), user_id)
                stats = apply(user_id, batch, ops, authored)
                record.merged += stats['merged']
                record.rewritten += stats['rewritten']
                record.deleted += stats['deleted']
                db.session.commit()
        record.status = 'done'
    except Exception as exc:
        db.session.rollback()
        record = db.session.get(MemoryConsolidation, record.id)
        record.status = 'failed'
        record.error = str(exc)[:500]
        logger.warning('Memory consolidation failed for user %s: %s', user_id, exc)
    record.entries_after, record.chars_after = memory_store.totals(user_id)
    record.finished_at = datetime.utcnow()
    db.session.commit()
    return record


def _batches(entries):
    batch, size = [], 0
    for entry in entries:
        if batch and (len(batch) >= BATCH_ENTRIES or size + len(entry.content) > BATCH_CHARS):
            yield batch
            batch, size = [], 0
        batch.append(entry)
        size += len(entry.content)
    if batch:
        yield batch


def _user_authored(user_id):
    """用户自己写过或改过的条目编号。"""
    rows = (db.session.query(MemoryEvent.entry_id)
            .filter(MemoryEvent.user_id == user_id, MemoryEvent.actor == 'user',
                    MemoryEvent.action.in_(('add', 'update'))).distinct().all())
    return {row[0] for row in rows}


# ---------------------------------------------------------------- 模型

PROMPT = """你在整理一位用户的长期记忆。这些记忆由会议助手和个人助理在一场场会议、一次次对话里陆续记下，难免重复、零碎、过时。请整理「{label}」这一类，在不丢失仍然有用的信息的前提下把它压缩到大约 {target} 字以内（现在 {current} 字、{count} 条）。达不到目标也没关系，绝不能为了凑字数删掉有用的信息。

今天是 {today}。

可以做三种操作：
1. merge：几条讲的是同一个人、同一个项目、同一个问题，合成一条。合并后只保留具体、以后用得上的事实（谁、负责什么、定了什么、卡在哪、期限）；彼此冲突时以更新时间较新的为准。一条最多 {max_chars} 字，写成一行，脱离上下文也能看懂。
2. rewrite：啰嗦的条目改写得更精炼，意思不变，不能比原来长。
3. delete：明确过时的（项目已结束且以后用不上、已被更新的信息取代）、已经过去的一次性安排（某天去某地、某次会议改时间）、几乎没有价值的条目。

写合并或改写后的内容时：
- 空泛、没有具体信息的说法不是事实，直接去掉，例如「需要持续关注」「负责相关事项的跟进」「正在推进中」「还有若干事项待定」「经常被指派任务」。
- 不要把整理用的信息写进内容：条目编号、更新日期、「用过几次」、「第几次出现」、「曾记录」「较新记录称」之类的说法都不要出现。内容只写事实本身，就像第一次记下它一样。
- 已经过去的一次性安排不要并进去。

限制：
- 标了【锁定】的条目：不能删除、不能改写、不能并入别的条目。
- 标了【用户写的】的条目：不能删除；可以和讲同一件事的条目合并，合并后要保留它的意思。
- 不要编造任何事实；拿不准的条目不要动。
- 每个操作都写一句 reason（为什么这样做），给用户看。

条目（编号 | 最近更新 | 用过几次 | 标记 | 内容）：
{lines}

只输出 JSON，格式：
{{"ops": [
  {{"op": "merge", "ids": ["m3", "m7"], "content": "合并后的一条", "reason": "……"}},
  {{"op": "rewrite", "id": "m4", "content": "精简后的内容", "reason": "……"}},
  {{"op": "delete", "id": "m5", "reason": "……"}}
]}}
没有需要整理的就输出 {{"ops": []}}。"""


def _prompt(category, entries, authored, target):
    lines = []
    for entry in entries:
        marks = ''.join(mark for mark, on in (('【锁定】', entry.pinned), ('【用户写的】', entry.id in authored)) if on)
        moment = entry.updated_at or entry.created_at
        lines.append(f'm{entry.id} | {moment:%Y-%m-%d} | {entry.use_count or 0} | {marks or "-"} | {entry.content}')
    return PROMPT.format(label=MEMORY_CATEGORY_LABELS.get(category, category), target=max(target, 1),
                         current=sum(len(e.content) for e in entries), count=len(entries),
                         today=datetime.utcnow().strftime('%Y-%m-%d'), max_chars=MEMORY_ENTRY_MAX_CHARS,
                         lines='\n'.join(lines))


def _call_model(prompt, user_id):
    from src.services.llm import call_llm_completion
    response = call_llm_completion([{'role': 'user', 'content': prompt}], temperature=0.2,
                                   response_format={'type': 'json_object'}, user_id=user_id,
                                   operation_type='memory_consolidation')
    return parse_ops(response.choices[0].message.content or '')


def parse_ops(text):
    text = re.sub(r'^```(?:json)?\s*|\s*```$', '', text.strip())
    try:
        data = json.loads(text)
    except ValueError:
        match = re.search(r'\{.*\}', text, re.S)
        if not match:
            raise ConsolidationFailed('模型没有返回整理结果。')
        data = json.loads(match.group(0))
    ops = data.get('ops') if isinstance(data, dict) else None
    return ops if isinstance(ops, list) else []


# ---------------------------------------------------------------- 应用（每一步都过安全规则）

def _ref(value):
    value = str(value or '').strip()
    return int(value[1:]) if value[:1] == 'm' and value[1:].isdigit() else None


def _content(value, limit=MEMORY_ENTRY_MAX_CHARS):
    text = ' '.join(str(value or '').split())
    return text if 0 < len(text) <= limit else None


def apply(user_id, batch, ops, authored):
    from src.services.meeting_assistant.service import _event
    by_id = {entry.id: entry for entry in batch}
    alive = set(by_id)
    stats = {'merged': 0, 'rewritten': 0, 'deleted': 0}
    delete_budget = int(len(batch) * MAX_DELETE_SHARE)
    now = datetime.utcnow()

    def reason_of(op):
        return ' '.join(str(op.get('reason') or '').split())[:200] or '整理'

    def update(entry, content, reason):
        if content == entry.content:
            return
        before = entry.snapshot()
        entry.content, entry.updated_at = content, now
        _event(entry, 'update', None, None, before, entry.snapshot(), reason, actor=ACTOR)

    def delete(entry, reason):
        entry.deleted_at = entry.updated_at = now
        alive.discard(entry.id)
        _event(entry, 'delete', None, None, entry.snapshot(), None, reason, actor=ACTOR)

    for op in ops if isinstance(ops, list) else []:
        if not isinstance(op, dict):
            continue
        kind = op.get('op')
        reason = reason_of(op)
        if kind == 'merge':
            ids = [_ref(x) for x in (op.get('ids') or []) if _ref(x) is not None]
            ids = list(dict.fromkeys(i for i in ids if i in alive))
            content = _content(op.get('content'))
            if len(ids) < 2 or content is None or any(by_id[i].pinned for i in ids):
                continue
            # 留下用户写的那条（没有就留最早的），其余并进来
            keep = next((i for i in ids if i in authored), ids[0])
            update(by_id[keep], content, reason)
            for i in ids:
                if i != keep:
                    delete(by_id[i], f'{reason}（已并入 m{keep}）')
            stats['merged'] += len(ids) - 1
        elif kind == 'rewrite':
            entry = by_id.get(_ref(op.get('id')))
            content = _content(op.get('content'))
            if entry is None or entry.id not in alive or entry.pinned or content is None:
                continue
            if len(content) >= len(entry.content) or content == entry.content:
                continue
            update(entry, content, reason)
            stats['rewritten'] += 1
        elif kind == 'delete':
            entry = by_id.get(_ref(op.get('id')))
            if entry is None or entry.id not in alive or entry.pinned or entry.id in authored:
                continue
            if stats['deleted'] >= delete_budget:
                continue
            delete(entry, reason)
            stats['deleted'] += 1
    return stats


def last(user_id):
    return (MemoryConsolidation.query.filter_by(user_id=user_id)
            .order_by(MemoryConsolidation.id.desc()).first())
