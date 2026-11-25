"""长期记忆放进上下文的方式：只放最该看的一部分，其余按需搜索。

长期记忆会越积越多，不能每次都整份塞进上下文。做法参考 Letta/MemGPT 的
「常驻 + 档案」分层，和 Generative Agents 的检索打分（相关 + 新近 + 常用）：

- 每次运行有固定的字数预算（MEMORY_CONTEXT_CHARS），按分数挑条目放进去；
  「始终记住」的条目和偏好优先。上下文大小因此和记忆总量无关。
- 没放进去的，会议助手用 search_memory、小助理用 GET /memory?q= 按关键词查。
- 和这次会议/查询相关、被放进去的条目记一次「使用」，以后更容易被选中。

总量超过整理阈值时，后台的记忆整理（consolidate.py）负责合并和精简。

相关度用「字的二元组」重合度：中文不分词也能匹配两个字的人名（王磊、李娜）。
"""
import math
import os
import re
from datetime import datetime

from src.database import db
from src.models.meeting_assistant import MemoryEntry

CONTEXT_CHARS = int(os.environ.get('MEMORY_CONTEXT_CHARS', '6000'))
SEARCH_LIMIT = 30
RECENCY_HALF_LIFE_DAYS = 30
USED_AT = 0.25          # 相关度达到这个值才算「这次用上了」

_WORD = re.compile(r'[A-Za-z0-9]+|[㐀-鿿]+')
_STOP = set('的了是在和与及就也都而但这那有个们我你他她它会到说要把被让给对为')


def _grams(text):
    """二元组（中文按字，英文数字按词）。单字的停用词不参与。"""
    grams = set()
    for token in _WORD.findall(str(text or '').lower()):
        if token.isascii():
            if len(token) >= 2:
                grams.add(token)
            continue
        chars = [c for c in token]
        if len(chars) == 1:
            if chars[0] not in _STOP:
                grams.add(chars[0])
            continue
        grams.update(a + b for a, b in zip(chars, chars[1:]))
    return grams


def idf_table(entries):
    """二元组在全部记忆里的稀有度：人名、项目名这种只在少数条目出现的词权重高，
    「负责」「客户」这种到处都有的词权重低。"""
    df = {}
    for entry in entries:
        for gram in _grams(entry.content):
            df[gram] = df.get(gram, 0) + 1
    total = max(1, len(entries))
    return {gram: math.log(1 + total / count) for gram, count in df.items()}


def relevance(entry_text, context_grams, idf=None):
    """条目的（按稀有度加权的）二元组有多大比例出现在上下文里（0~1）。"""
    if not context_grams:
        return 0.0
    grams = _grams(entry_text)
    if not grams:
        return 0.0
    weight = (lambda g: idf.get(g, 1.0)) if idf else (lambda g: 1.0)
    total = sum(weight(g) for g in grams)
    return sum(weight(g) for g in grams & context_grams) / total if total else 0.0


def _recency(entry, now):
    moment = max(filter(None, (entry.updated_at, entry.last_used_at, entry.created_at)), default=now)
    days = max(0.0, (now - moment).total_seconds() / 86400)
    return 0.5 ** (days / RECENCY_HALF_LIFE_DAYS)


def score(entry, context_grams, now, idf=None):
    rel = relevance(entry.content, context_grams, idf)
    value = 2.0 * rel + _recency(entry, now) + 0.3 * math.log1p(entry.use_count or 0)
    if entry.category == 'preference':
        value += 0.6            # 习惯和偏好在哪场会议都用得上
    return value, rel


def active_entries(user_id):
    return (MemoryEntry.query.filter_by(user_id=user_id, deleted_at=None)
            .order_by(MemoryEntry.category, MemoryEntry.id).all())


def as_row(entry):
    return {'id': f'm{entry.id}', 'category': entry.category, 'content': entry.content, 'pinned': bool(entry.pinned)}


def select(entries, context_text='', budget=None, now=None):
    """挑出放进上下文的条目。返回 (挑中的条目, 相关度 {id: rel})，挑中的按分类和编号排好。"""
    budget = CONTEXT_CHARS if budget is None else budget
    now = now or datetime.utcnow()
    context_grams = _grams(context_text)
    idf = idf_table(entries) if context_grams else None
    scored = []
    for entry in entries:
        value, rel = score(entry, context_grams, now, idf)
        scored.append((not entry.pinned, -value, entry.id, entry, rel))
    scored.sort(key=lambda item: item[:3])
    chosen, used, rels = [], 0, {}
    for _unpinned, _neg, _id, entry, rel in scored:
        size = len(entry.content) + 12
        if not entry.pinned and used + size > budget:
            continue            # 放不下就看下一条（短的也许还放得下）
        chosen.append(entry)
        used += size
        rels[entry.id] = rel
    chosen.sort(key=lambda e: (e.category, e.id))
    return chosen, rels


def search(entries, query, limit=SEARCH_LIMIT):
    """按关键词找记忆：相关度高的在前，同样相关的新的在前。"""
    query_grams = _grams(query)
    if not query_grams:
        return []
    now = datetime.utcnow()
    idf = idf_table(entries)
    wanted = sum(idf.get(g, 1.0) for g in query_grams)
    hits = []
    for entry in entries:
        grams = _grams(entry.content)
        if not grams:
            continue
        common = grams & query_grams
        if not common:
            continue
        # 查询词被覆盖得越多越靠前（按稀有度加权，「王磊」比「负责」重要）
        value = sum(idf.get(g, 1.0) for g in common) / wanted + 0.2 * len(common) / len(grams) + 0.1 * _recency(entry, now)
        hits.append((-value, entry.id, entry))
    hits.sort(key=lambda item: item[:2])
    return [entry for _v, _id, entry in hits[:limit]]


def mark_used(entries, rels=None, threshold=USED_AT):
    """和这次会议/查询相关的条目记一次使用。调用方负责提交事务。"""
    now = datetime.utcnow()
    count = 0
    for entry in entries:
        if rels is not None and rels.get(entry.id, 0) < threshold:
            continue
        entry.last_used_at = now
        entry.use_count = (entry.use_count or 0) + 1
        count += 1
    return count


def totals(user_id):
    """有效记忆的条数和总字数。"""
    row = db.session.query(db.func.count(MemoryEntry.id), db.func.coalesce(db.func.sum(db.func.length(MemoryEntry.content)), 0)) \
        .filter(MemoryEntry.user_id == user_id, MemoryEntry.deleted_at.is_(None)).one()
    return int(row[0]), int(row[1])
