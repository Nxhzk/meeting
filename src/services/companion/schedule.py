"""提醒的时间计算。存 UTC，按用户本地时间理解。"""
import os
from datetime import datetime, timedelta, timezone
from zoneinfo import ZoneInfo

from src.utils.timezones import is_valid_timezone

REPEATS = ('once', 'daily', 'weekdays', 'weekly')
BRIEF_TIME = '08:30'


def user_zone(user):
    """用户时区；没设置且部署默认是 UTC 时，按 COMPANION_DEFAULT_TZ（默认北京时间）。"""
    from src.utils.timezones import user_timezone
    name = user_timezone(user)
    if name == 'UTC' and not is_valid_timezone(getattr(user, 'timezone', None)):
        fallback = os.environ.get('COMPANION_DEFAULT_TZ', 'Asia/Shanghai')
        return fallback if is_valid_timezone(fallback) else 'UTC'
    return name


def local_now(zone):
    return datetime.now(ZoneInfo(zone)).replace(tzinfo=None)


def to_utc(local, zone):
    return local.replace(tzinfo=ZoneInfo(zone)).astimezone(timezone.utc).replace(tzinfo=None)


def parse_hhmm(value):
    try:
        hh, mm = str(value).strip().split(':')
        hh, mm = int(hh), int(mm)
        if 0 <= hh < 24 and 0 <= mm < 60:
            return hh, mm
    except (ValueError, AttributeError):
        pass
    raise ValueError('时间格式应为 HH:MM')


def next_occurrence(repeat, time_of_day, weekday, zone, after_local=None):
    """下一次触发的本地时间（严格晚于 after_local）。"""
    hh, mm = parse_hhmm(time_of_day)
    base = after_local or local_now(zone)
    candidate = base.replace(hour=hh, minute=mm, second=0, microsecond=0)
    for _ in range(9):
        if candidate > base:
            if repeat == 'daily':
                return candidate
            if repeat == 'weekdays' and candidate.weekday() < 5:
                return candidate
            if repeat == 'weekly' and candidate.weekday() == (weekday or 0):
                return candidate
        candidate += timedelta(days=1)
    raise ValueError('无法计算下一次时间')


def schedule_next(reminder, zone):
    """到点之后算下一次；一次性提醒用完就停。"""
    if reminder.repeat == 'once':
        reminder.enabled = False
        reminder.next_run_at = None
        return
    local = next_occurrence(reminder.repeat, reminder.time_of_day, reminder.weekday, zone)
    reminder.next_run_at = to_utc(local, zone)
