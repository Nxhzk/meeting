"""会议助手的数据：摘要版本、会议会话、长期记忆与其变更记录。

数据库是唯一正本。会议助手（pi 子进程）不连数据库：每次生成前由 Python
导出快照，生成成功后在一个事务里写回。
"""

from datetime import datetime

from src.database import db


# 长期记忆的分类，顺序即页面展示顺序。
MEMORY_CATEGORIES = ('person', 'project', 'recurring_issue', 'preference')
MEMORY_CATEGORY_LABELS = {
    'person': '人物', 'project': '项目', 'recurring_issue': '反复出现的问题', 'preference': '偏好',
}
MEMORY_ENTRY_MAX_CHARS = 500
# 只是防失控的安全上限。上下文大小不靠它控制：每次只把最相关的一部分放进上下文
# （见 services/meeting_assistant/memory.py），超过整理阈值时后台自动整理压缩。
MEMORY_MAX_ENTRIES = 2000

SESSION_ACTIVE = 'active'
SESSION_RETIRED = 'retired'  # 会议原文变了，会话不再续用


class SummaryVersion(db.Model):
    """一场会议的一次会议摘要结果（v1、v2…）。"""
    __tablename__ = 'summary_version'
    __table_args__ = (db.UniqueConstraint('recording_id', 'version', name='uq_summary_version'),)

    id = db.Column(db.Integer, primary_key=True)
    recording_id = db.Column(db.Integer, db.ForeignKey('recording.id', ondelete='CASCADE'), nullable=False, index=True)
    version = db.Column(db.Integer, nullable=False)
    # 结构化各节（JSON）；旧系统留下的 v1 没有结构，只有 markdown。
    sections = db.Column(db.JSON, nullable=True)
    markdown = db.Column(db.Text, nullable=False)
    feedback = db.Column(db.Text, nullable=True)
    session_id = db.Column(db.Integer, db.ForeignKey('assistant_session.id', ondelete='SET NULL'), nullable=True)
    source = db.Column(db.String(16), nullable=False, default='assistant')  # assistant | legacy
    model_name = db.Column(db.String(120), nullable=True)
    prompt_tokens = db.Column(db.Integer, nullable=True)
    completion_tokens = db.Column(db.Integer, nullable=True)
    duration_seconds = db.Column(db.Integer, nullable=True)
    created_by = db.Column(db.Integer, db.ForeignKey('user.id', ondelete='SET NULL'), nullable=True)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)

    def to_dict(self, html=None):
        return {
            'id': self.id,
            'version': self.version,
            'source': self.source,
            'feedback': self.feedback,
            'created_at': _iso(self.created_at),
            'duration_seconds': self.duration_seconds,
            **({'html': html} if html is not None else {}),
        }


class AssistantSession(db.Model):
    """会议助手针对一场会议的对话历史，每场会议各自独立。"""
    __tablename__ = 'assistant_session'

    id = db.Column(db.Integer, primary_key=True)
    recording_id = db.Column(db.Integer, db.ForeignKey('recording.id', ondelete='CASCADE'), nullable=False, index=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id', ondelete='CASCADE'), nullable=False, index=True)
    status = db.Column(db.String(16), nullable=False, default=SESSION_ACTIVE)
    # pi 的会话文件（JSONL）全文。生成时临时写成文件，跑完写回这里。
    session_jsonl = db.Column(db.Text, nullable=True)
    # 会话所依据的会议原文的指纹；原文变了就换一条新会话。
    transcript_sha256 = db.Column(db.String(64), nullable=False)
    runs = db.Column(db.Integer, nullable=False, default=0)
    # 最近一次重新生成失败的原因（已有摘要时失败不覆盖摘要，只记在这里）。
    last_error = db.Column(db.Text, nullable=True)
    last_error_at = db.Column(db.DateTime, nullable=True)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class MemoryEntry(db.Model):
    """长期记忆的一条，按用户共享。删除是软删除，可以恢复。"""
    __tablename__ = 'memory_entry'

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id', ondelete='CASCADE'), nullable=False, index=True)
    category = db.Column(db.String(32), nullable=False)
    content = db.Column(db.Text, nullable=False)
    source_recording_id = db.Column(db.Integer, db.ForeignKey('recording.id', ondelete='SET NULL'), nullable=True)
    # 用户标为「始终记住」：每次都放进上下文，整理时不动
    pinned = db.Column(db.Boolean, nullable=False, default=False)
    # 最近一次和会议/对话相关、被拿来用的时间与次数（挑选放进上下文的记忆时参考）
    last_used_at = db.Column(db.DateTime, nullable=True)
    use_count = db.Column(db.Integer, nullable=False, default=0)
    deleted_at = db.Column(db.DateTime, nullable=True)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    updated_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)

    def snapshot(self):
        return {'category': self.category, 'content': self.content}

    def to_dict(self, source_title=None):
        return {
            'id': self.id,
            'category': self.category,
            'category_label': MEMORY_CATEGORY_LABELS.get(self.category, self.category),
            'content': self.content,
            'source_recording_id': self.source_recording_id,
            'source_title': source_title,
            'pinned': bool(self.pinned),
            'use_count': self.use_count or 0,
            'last_used_at': _iso(self.last_used_at),
            'deleted': self.deleted_at is not None,
            'created_at': _iso(self.created_at),
            'updated_at': _iso(self.updated_at),
        }


class MemoryEvent(db.Model):
    """长期记忆的每一次增加、修改、删除、恢复。"""
    __tablename__ = 'memory_event'

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id', ondelete='CASCADE'), nullable=False, index=True)
    entry_id = db.Column(db.Integer, db.ForeignKey('memory_entry.id', ondelete='CASCADE'), nullable=False, index=True)
    action = db.Column(db.String(16), nullable=False)  # add | update | delete | restore
    actor = db.Column(db.String(16), nullable=False)   # assistant（会议助手）| companion（小助理）| consolidator（记忆整理）| user
    recording_id = db.Column(db.Integer, db.ForeignKey('recording.id', ondelete='SET NULL'), nullable=True)
    summary_version_id = db.Column(db.Integer, db.ForeignKey('summary_version.id', ondelete='SET NULL'), nullable=True)
    before = db.Column(db.JSON, nullable=True)
    after = db.Column(db.JSON, nullable=True)
    reason = db.Column(db.Text, nullable=True)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)

    def to_dict(self, recording_title=None):
        return {
            'id': self.id,
            'entry_id': self.entry_id,
            'action': self.action,
            'actor': self.actor,
            'recording_id': self.recording_id,
            'recording_title': recording_title,
            'before': self.before,
            'after': self.after,
            'reason': self.reason,
            'created_at': _iso(self.created_at),
        }


class AssistantTraceEvent(db.Model):
    """会议助手一次运行里的工具调用和思考过程，给页面实时展示。

    每场会议只保留最近一次运行的记录：新的运行开始时清掉旧的。
    key 在一次运行内唯一（工具调用 id、思考段落序号），同一个 key 更新状态。
    """
    __tablename__ = 'assistant_trace_event'
    __table_args__ = (db.UniqueConstraint('recording_id', 'key', name='uq_trace_key'),)

    id = db.Column(db.Integer, primary_key=True)
    recording_id = db.Column(db.Integer, db.ForeignKey('recording.id', ondelete='CASCADE'), nullable=False, index=True)
    key = db.Column(db.String(80), nullable=False)
    seq = db.Column(db.Integer, nullable=False)
    kind = db.Column(db.String(16), nullable=False)      # tool | thinking | note
    tool = db.Column(db.String(32), nullable=True)
    status = db.Column(db.String(16), nullable=False)    # running | ok | error
    data = db.Column(db.JSON, nullable=True)
    started_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    ended_at = db.Column(db.DateTime, nullable=True)

    def to_dict(self):
        return {'key': self.key, 'seq': self.seq, 'kind': self.kind, 'tool': self.tool, 'status': self.status,
                'data': self.data or {}, 'started_at': _iso(self.started_at), 'ended_at': _iso(self.ended_at)}


def _iso(value):
    return value.isoformat(timespec='seconds') + 'Z' if value else None


class MemoryConsolidation(db.Model):
    """一次记忆整理：合并重复、精简冗长、删掉过时的，把长期记忆压回目标大小。"""
    __tablename__ = 'memory_consolidation'

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id', ondelete='CASCADE'), nullable=False, index=True)
    trigger = db.Column(db.String(16), nullable=False)          # auto | user
    status = db.Column(db.String(16), nullable=False, default='running')   # running | done | failed
    entries_before = db.Column(db.Integer, nullable=False, default=0)
    chars_before = db.Column(db.Integer, nullable=False, default=0)
    entries_after = db.Column(db.Integer, nullable=True)
    chars_after = db.Column(db.Integer, nullable=True)
    merged = db.Column(db.Integer, nullable=False, default=0)
    rewritten = db.Column(db.Integer, nullable=False, default=0)
    deleted = db.Column(db.Integer, nullable=False, default=0)
    error = db.Column(db.Text, nullable=True)
    started_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)
    finished_at = db.Column(db.DateTime, nullable=True)

    def to_dict(self):
        return {
            'id': self.id, 'trigger': self.trigger, 'status': self.status,
            'entries_before': self.entries_before, 'chars_before': self.chars_before,
            'entries_after': self.entries_after, 'chars_after': self.chars_after,
            'merged': self.merged, 'rewritten': self.rewritten, 'deleted': self.deleted, 'error': self.error,
            'started_at': _iso(self.started_at), 'finished_at': _iso(self.finished_at),
        }
