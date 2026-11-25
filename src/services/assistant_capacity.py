"""AI 运行的准入：按此刻剩下的内存决定能不能再起一个 pi，放不下就排队。

小助理的每次回复、会议助手的每次摘要都会起一个 pi 进程（沙箱里，约 250 MB），
和网站服务算在同一个内存上限里。同时跑得太多，服务会被系统限速，整个网页卡住
（2026-11-25 出过一次）。所以开始之前先看还剩多少：

    可用 = min(服务上限 − 服务现在用的, 系统可用内存 − 留给别的服务的)
    还要扣掉刚开始、内存还没涨上来的运行各自的预估用量

够一个预估用量才放行，不够就排队；有运行结束或内存降下来时按优先级、先来后到放行。
一个都没在跑时总是放行一个，保证不会全卡住。

优先级：用户在等的聊天 > 会议摘要 > 后台提醒。后台提醒不排队，放不下就下一分钟再试。
"""
import logging
import os
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path

logger = logging.getLogger(__name__)

CHAT, SUMMARY, BACKGROUND = 0, 1, 2   # 数字越小越优先


def _env_int(name, default):
    try:
        return int(os.environ.get(name) or default)
    except ValueError:
        return default


RUN_MB = _env_int('ASSISTANT_RUN_MB', 300)              # 一次运行的预估峰值（pi + 沙箱，实测 220～280 MB）
WARMUP_SECONDS = _env_int('ASSISTANT_RUN_WARMUP', 45)  # 刚开始的运行内存还没涨上来：这段时间按预估值预留
SYSTEM_RESERVE_MB = _env_int('ASSISTANT_SYSTEM_RESERVE_MB', 200)   # 整台机器留给别的服务
MAX_RUNS = _env_int('ASSISTANT_MAX_RUNS', 8)            # 内存再多也不超过这个数（模型接口的并发也有限）
FALLBACK_RUNS = _env_int('ASSISTANT_FALLBACK_RUNS', 3)  # 读不到内存信息时（非 Linux）的固定上限
TICK_SECONDS = 2


@dataclass(eq=False)
class Slot:
    kind: int
    label: str
    started: float = field(default_factory=time.monotonic)
    released: bool = False


@dataclass(eq=False)
class Ticket:
    kind: int
    label: str
    on_admit: object                       # on_admit(slot)：在后台线程里调用
    seq: int = 0
    cancelled: bool = False


_lock = threading.Lock()
_active = []        # [Slot]
_waiting = []       # [Ticket]，按 (kind, seq) 排
_seq = 0
_ticker = None
_listeners = []     # 排队情况变化时调用（小助理用来更新页面上的「前面还有几位」）


# ---------------------------------------------------------------- 内存读数

def _cgroup_dir():
    try:
        for line in Path('/proc/self/cgroup').read_text().splitlines():
            if line.startswith('0::'):
                path = Path('/sys/fs/cgroup') / line[3:].lstrip('/')
                return path if (path / 'memory.current').exists() else None
    except OSError:
        return None
    return None


def _read_mb(path):
    try:
        value = path.read_text().strip()
    except OSError:
        return None
    return None if value == 'max' else int(value) // 1048576


def _mem_available_mb():
    try:
        for line in Path('/proc/meminfo').read_text().splitlines():
            if line.startswith('MemAvailable:'):
                return int(line.split()[1]) // 1024
    except (OSError, ValueError, IndexError):
        return None
    return None


def headroom_mb():
    """此刻还能给新运行用的内存（MB）；读不到时返回 None。"""
    candidates = []
    group = _cgroup_dir()
    if group is not None:
        current = _read_mb(group / 'memory.current')
        # MemoryHigh 是开始被限速的线，比 MemoryMax 更该守住
        limit = _read_mb(group / 'memory.high') or _read_mb(group / 'memory.max')
        if current is not None and limit:
            candidates.append(limit - current)
    available = _mem_available_mb()
    if available is not None:
        candidates.append(available - SYSTEM_RESERVE_MB)
    return min(candidates) if candidates else None


# ---------------------------------------------------------------- 判断

def _fits_locked(now=None):
    now = now or time.monotonic()
    running = [s for s in _active if not s.released]
    if not running:
        return True
    if len(running) >= MAX_RUNS:
        return False
    free = headroom_mb()
    if free is None:
        return len(running) < FALLBACK_RUNS
    warming = sum(RUN_MB for s in running if now - s.started < WARMUP_SECONDS)
    return free - warming >= RUN_MB


def _admit_locked(kind, label):
    slot = Slot(kind, label)
    _active.append(slot)
    return slot


def acquire(kind, label=''):
    """不等待：放得下就返回 Slot，否则 None。前面有同等或更优先的在排队时也返回 None（不插队）。"""
    with _lock:
        if any(t.kind <= kind for t in _waiting):
            return None
        if not _fits_locked():
            return None
        return _admit_locked(kind, label)


def release(slot):
    if slot is None:
        return
    with _lock:
        if slot.released:
            return
        slot.released = True
        try:
            _active.remove(slot)
        except ValueError:
            pass
    pump()


def enqueue(kind, label, on_admit):
    """排队；轮到时在后台线程里调用 on_admit(slot)。返回 Ticket，可 cancel。"""
    global _seq
    with _lock:
        _seq += 1
        ticket = Ticket(kind, label, on_admit, _seq)
        _waiting.append(ticket)
        _waiting.sort(key=lambda t: (t.kind, t.seq))
        _ensure_ticker_locked()
    _notify()
    pump()
    return ticket


def cancel(ticket):
    with _lock:
        if ticket in _waiting:
            _waiting.remove(ticket)
        ticket.cancelled = True
    _notify()


def position(ticket):
    """前面还有几个（0 表示下一个就是它）；已不在队里时返回 None。"""
    with _lock:
        try:
            return _waiting.index(ticket)
        except ValueError:
            return None


def wait(kind, label='', cancelled=None, on_wait=None, poll=1.0):
    """阻塞等到轮到（后台任务用，例如会议摘要）。cancelled() 为真时放弃并抛 Cancelled。"""
    slot = acquire(kind, label)
    if slot is not None:
        return slot
    admitted = threading.Event()
    box = {}
    settle = threading.Lock()   # 轮到和取消同时发生时，二者只算一个

    def on_admit(s):
        with settle:
            if box.get('gave_up'):
                release(s)
                return
            box['slot'] = s
            admitted.set()

    ticket = enqueue(kind, label, on_admit)
    last = None
    while not admitted.wait(poll):
        if cancelled and cancelled():
            with settle:
                if not admitted.is_set():
                    box['gave_up'] = True
            if box.get('gave_up'):
                cancel(ticket)
                raise Cancelled()
            break                       # 取消的同时刚好轮到：照常返回名额，由调用方处理取消
        pos = position(ticket)
        if on_wait and pos is not None and pos != last:
            last = pos
            try:
                on_wait(pos)
            except Exception:
                logger.exception('capacity on_wait failed')
    return box['slot']


class Cancelled(Exception):
    pass


# ---------------------------------------------------------------- 放行

def pump():
    """按优先级放行排队的，直到放不下。"""
    admitted = []
    with _lock:
        while _waiting and _fits_locked():
            ticket = _waiting.pop(0)
            if ticket.cancelled:
                continue
            admitted.append((ticket, _admit_locked(ticket.kind, ticket.label)))
    for ticket, slot in admitted:
        threading.Thread(target=_run_admit, args=(ticket, slot), daemon=True).start()
    if admitted:
        _notify()


def _run_admit(ticket, slot):
    try:
        ticket.on_admit(slot)
    except Exception:
        logger.exception('Queued assistant run %s could not start', ticket.label)
        release(slot)


def _ensure_ticker_locked():
    # 内存是慢慢降下来的（进程退出、回收）：有人排队时每隔几秒再看一次
    global _ticker
    if _ticker is not None and _ticker.is_alive():
        return
    _ticker = threading.Thread(target=_tick, daemon=True, name='assistant-capacity')
    _ticker.start()


def _tick():
    while True:
        time.sleep(TICK_SECONDS)
        with _lock:
            if not _waiting:
                return
        pump()


def on_change(listener):
    _listeners.append(listener)


def _notify():
    for listener in list(_listeners):
        try:
            listener()
        except Exception:
            logger.exception('capacity listener failed')


def status():
    """给日志和管理页看：在跑几个、排队几个、还剩多少内存。"""
    with _lock:
        return {'running': len([s for s in _active if not s.released]), 'waiting': len(_waiting),
                'headroom_mb': headroom_mb(), 'run_mb': RUN_MB}


def _reset_for_tests():
    global _seq
    with _lock:
        _active.clear()
        _waiting.clear()
        _seq = 0
