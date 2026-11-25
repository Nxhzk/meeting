"""小助理主动消息的推送。

- 浏览器：网页推送（用户在浏览器里授权过才有订阅）。
- 安卓 App：WebView 不支持网页推送，App 后台定时调用 /api/assistant/notifications 拉取，自己弹通知。
"""
import json
import logging
import threading

logger = logging.getLogger(__name__)


def notify_async(user_id, message_id):
    from flask import current_app
    app = current_app._get_current_object()
    threading.Thread(target=_send, args=(app, user_id, message_id), daemon=True).start()


def _send(app, user_id, message_id):
    with app.app_context():
        try:
            from pywebpush import WebPushException, webpush
            from src.models import PushSubscription
            from src.models.companion import CompanionMessage
            from src.utils.vapid_keys import VAPID_ENABLED, VAPID_PRIVATE_KEY
            from src.database import db
        except Exception:
            return
        if not VAPID_ENABLED:
            return
        message = db.session.get(CompanionMessage, message_id)
        if message is None:
            return
        payload = json.dumps({'title': '小助理', 'body': message.content[:140], 'url': '#assistant',
                              'tag': f'companion-{message.id}'}, ensure_ascii=False)
        for sub in PushSubscription.query.filter_by(user_id=user_id).all():
            try:
                webpush(subscription_info={'endpoint': sub.endpoint, 'keys': {'p256dh': sub.p256dh_key, 'auth': sub.auth_key}},
                        data=payload, vapid_private_key=VAPID_PRIVATE_KEY, vapid_claims={'sub': 'mailto:noreply@localhost'})
            except WebPushException as exc:
                if getattr(exc, 'response', None) is not None and exc.response.status_code in (404, 410):
                    db.session.delete(sub)
                    db.session.commit()
                logger.info('Web push failed for a subscription: %s', type(exc).__name__)
            except Exception:
                logger.warning('Web push failed', exc_info=True)
