"""小助理的数据：和用户的对话、pi 会话、提醒。

小助理是应用级别的个人助理，每个用户只有一条对话（可以清空）。长期记忆
和会议助手共用 memory_entry。
"""
from datetime import datetime

from src.database import db


def _iso(value):
    return value.isoformat(timespec='seconds') + 'Z' if value else None


class CompanionMessage(db.Model):
    """对话里的一条消息。"""
    __tablename__ = 'companion_message'
    # 编号永不复用：清空对话会删掉最新的几条，复用编号的话，页面会把新消息当成已有的、
    # 安卓按「上次看到的编号」拉通知也会漏掉
    __table_args__ = {'sqlite_autoincrement': True}

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id', ondelete='CASCADE'), nullable=False, index=True)
    role = db.Column(db.String(16), nullable=False)        # user | assistant
    # chat：一问一答；steer：回复途中的插话；proactive：小助理主动发的（提醒、今日简报）
    kind = db.Column(db.String(16), nullable=False, default='chat')
    content = db.Column(db.Text, nullable=False)
    # 这条回复里的工具调用摘要 [{tool, label, status}]、来自哪条提醒等
    meta = db.Column(db.JSON, nullable=True)
    read_at = db.Column(db.DateTime, nullable=True)        # 主动消息被看到的时间（小红点、推送）
    notified_at = db.Column(db.DateTime, nullable=True)    # 已推送到手机的时间
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow, index=True)

    def to_dict(self, html=None):
        return {
            'id': self.id, 'role': self.role, 'kind': self.kind, 'content': self.content,
            **({'html': html} if html is not None else {}),
            'meta': self.meta or {}, 'read': self.read_at is not None, 'created_at': _iso(self.created_at),
        }


class CompanionSession(db.Model):
    """小助理的 pi 会话（JSONL 全文），每个用户一条。清空对话时一起清掉。"""
    __tablename__ = 'companion_session'

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id', ondelete='CASCADE'), nullable=False, unique=True)
    session_jsonl = db.Column(db.Text, nullable=True)
    updated_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow, onupdate=datetime.utcnow)


class Reminder(db.Model):
    """提醒：一次性或周期性。到点后后台运行一次小助理，由它组织语言发出。

    今日简报也是一条周期提醒（is_brief），到点时由小助理判断发不发。
    时间都按用户所在时区理解：time_of_day 是本地「HH:MM」，next_run_at 存 UTC。
    """
    __tablename__ = 'reminder'

    id = db.Column(db.Integer, primary_key=True)
    user_id = db.Column(db.Integer, db.ForeignKey('user.id', ondelete='CASCADE'), nullable=False, index=True)
    title = db.Column(db.String(200), nullable=False)
    note = db.Column(db.Text, nullable=True)            # 到点时要做什么、要提醒的上下文
    repeat = db.Column(db.String(16), nullable=False, default='once')   # once | daily | weekdays | weekly
    weekday = db.Column(db.Integer, nullable=True)     # weekly：0=周一 … 6=周日
    time_of_day = db.Column(db.String(5), nullable=True)  # 周期提醒的本地时间 HH:MM
    next_run_at = db.Column(db.DateTime, nullable=True, index=True)
    last_run_at = db.Column(db.DateTime, nullable=True)
    enabled = db.Column(db.Boolean, nullable=False, default=True)
    is_brief = db.Column(db.Boolean, nullable=False, default=False)
    created_at = db.Column(db.DateTime, nullable=False, default=datetime.utcnow)

    def to_dict(self):
        return {
            'id': self.id, 'title': self.title, 'note': self.note, 'repeat': self.repeat,
            'weekday': self.weekday, 'time_of_day': self.time_of_day, 'enabled': self.enabled,
            'is_brief': self.is_brief, 'next_run_at': _iso(self.next_run_at), 'last_run_at': _iso(self.last_run_at),
        }
