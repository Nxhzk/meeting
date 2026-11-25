"""进程内的事件分发：把小助理的流式输出、主动消息、积分变化推给打开的页面（SSE）。

注意：登记在进程内存里。服务器上 gunicorn 是单进程多线程，所以没问题；
以后改成多进程时，需要换成 Redis 之类的共享通道。
"""
import os
import queue
import threading
import time

_lock = threading.Lock()
_subscribers = {}      # user_id -> set[Queue]
_order = []            # [(user_id, Queue)]，最早打开的在前

# 每条事件流在 gunicorn 里占一个线程（线上一共 16 个）。流太多时整个网站都会卡住，
# 所以限制总数和每人的条数；超出时关掉最早的那条（断线没发现的僵尸连接总是最早的）。
MAX_STREAMS = int(os.environ.get('COMPANION_MAX_STREAMS', '8'))
MAX_STREAMS_PER_USER = int(os.environ.get('COMPANION_MAX_STREAMS_PER_USER', '3'))
BYE = object()         # 放进队列：让那条事件流结束（页面收到 bye 后不再自动重连）
RESET = object()       # 放进队列：页面读得太慢，事件丢了。断开这条流，让页面自动重连、重新拿一份快照

# 每个用户一把锁：正在进行的回复「改状态 + 推事件」和「订阅 + 取快照」互斥，
# 这样新打开的页面拿到的快照和它之后收到的事件正好接上，不重复也不缺。
_guards = {}
_guards_lock = threading.Lock()


def guard(user_id):
    with _guards_lock:
        return _guards.setdefault(user_id, threading.RLock())


def _evict(user_id, q):
    _order.remove((user_id, q))
    subs = _subscribers.get(user_id)
    if subs:
        subs.discard(q)
        if not subs:
            _subscribers.pop(user_id, None)
    try:
        while True:
            q.get_nowait()
    except queue.Empty:
        pass
    q.put_nowait(BYE)


def subscribe(user_id):
    q = queue.Queue(maxsize=500)
    with _lock:
        mine = [item for item in _order if item[0] == user_id]
        while len(mine) >= MAX_STREAMS_PER_USER:
            _evict(*mine.pop(0))
        while len(_order) >= MAX_STREAMS:
            _evict(*_order[0])
        _subscribers.setdefault(user_id, set()).add(q)
        _order.append((user_id, q))
    return q


def unsubscribe(user_id, q):
    with _lock:
        if (user_id, q) in _order:
            _order.remove((user_id, q))
        subs = _subscribers.get(user_id)
        if subs:
            subs.discard(q)
            if not subs:
                _subscribers.pop(user_id, None)


def stream_count():
    with _lock:
        return len(_order)


def has_subscribers(user_id=None):
    with _lock:
        return bool(_subscribers.get(user_id)) if user_id is not None else bool(_subscribers)


def subscribed_users():
    with _lock:
        return list(_subscribers)


def publish(user_id, event, data):
    payload = {'event': event, 'data': data, 'at': time.time()}
    with _lock:
        targets = list(_subscribers.get(user_id, ()))
    for q in targets:
        try:
            q.put_nowait(payload)
        except queue.Full:
            # 页面太久没读：缺了事件，流式文字就会错乱。清空队列、让这条流断开重连，重连时拿新的快照
            try:
                while True:
                    q.get_nowait()
            except queue.Empty:
                pass
            try:
                q.put_nowait(RESET)
            except queue.Full:
                pass


def broadcast(event, data):
    for user_id in subscribed_users():
        publish(user_id, event, data)
