"""后台每分钟检查一次：到点的提醒和今日简报；有人打开页面时刷新积分。"""
import logging
import threading
import time
from datetime import datetime

logger = logging.getLogger(__name__)
_started = False
_lock = threading.Lock()
INTERVAL = 60


def start(app):
    global _started
    with _lock:
        if _started:
            return
        _started = True
    threading.Thread(target=_loop, args=(app,), name='companion-scheduler', daemon=True).start()


def _loop(app):
    from src.services.companion import credits, hub, service
    from src.models.companion import Reminder
    while True:
        try:
            with app.app_context():
                due = [r.id for r in Reminder.query.filter(Reminder.enabled.is_(True),
                                                           Reminder.next_run_at.isnot(None),
                                                           Reminder.next_run_at <= datetime.utcnow())
                       .order_by(Reminder.next_run_at).limit(20).all()]
            for reminder_id in due:
                try:
                    service.run_reminder(app, reminder_id)
                except Exception:
                    logger.exception('Reminder %s failed to start', reminder_id)
            if hub.has_subscribers():
                credits.get()
        except Exception:
            logger.exception('Companion scheduler tick failed')
        time.sleep(INTERVAL)
