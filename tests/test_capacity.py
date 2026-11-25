"""AI 运行按剩余内存放行：放得下才开始，放不下排队，轮到了自动开始。"""
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from src.services import assistant_capacity as capacity


class CapacityTest(unittest.TestCase):
    def setUp(self):
        capacity._reset_for_tests()
        self.addCleanup(capacity._reset_for_tests)
        self.free = 10_000
        patcher = mock.patch.object(capacity, 'headroom_mb', side_effect=lambda: self.free)
        patcher.start()
        self.addCleanup(patcher.stop)

    def test_admits_while_memory_allows_counting_runs_that_have_not_grown_yet(self):
        self.free = 700                       # 每个预估 300 MB
        first = capacity.acquire(capacity.CHAT)
        second = capacity.acquire(capacity.CHAT)
        third = capacity.acquire(capacity.CHAT)
        self.assertIsNotNone(first)
        self.assertIsNotNone(second)          # 700 − 300（第一个还在起步）≥ 300
        self.assertIsNone(third)              # 700 − 600 < 300

    def test_warmed_up_runs_are_already_in_the_measurement(self):
        self.free = 350
        old = capacity.acquire(capacity.CHAT)
        old.started -= capacity.WARMUP_SECONDS + 1   # 起步期过了：它的内存已经算在「已用」里
        self.assertIsNotNone(capacity.acquire(capacity.CHAT))

    def test_one_run_is_always_allowed_when_nothing_runs(self):
        self.free = 0
        self.assertIsNotNone(capacity.acquire(capacity.SUMMARY))
        self.assertIsNone(capacity.acquire(capacity.CHAT))

    def test_hard_cap(self):
        with mock.patch.object(capacity, 'MAX_RUNS', 2):
            slots = [capacity.acquire(capacity.CHAT) for _ in range(3)]
        self.assertEqual([s is not None for s in slots], [True, True, False])

    def test_unknown_memory_falls_back_to_a_fixed_number(self):
        self.free = None
        with mock.patch.object(capacity, 'FALLBACK_RUNS', 2):
            slots = [capacity.acquire(capacity.CHAT) for _ in range(3)]
        self.assertEqual([s is not None for s in slots], [True, True, False])

    def test_queue_is_served_by_priority_then_order_and_nobody_cuts_in(self):
        self.free = 0
        blocker = capacity.acquire(capacity.SUMMARY)
        order = []
        done = threading.Event()

        def admit(name):
            def on_admit(slot):
                order.append(name)
                capacity.release(slot)          # 用完马上还，下一个接着放行
                if len(order) == 3:
                    done.set()
            return on_admit

        capacity.enqueue(capacity.SUMMARY, 's1', admit('summary'))
        capacity.enqueue(capacity.CHAT, 'c1', admit('chat-1'))
        capacity.enqueue(capacity.CHAT, 'c2', admit('chat-2'))
        self.assertIsNone(capacity.acquire(capacity.CHAT))   # 有人在排队：不插队
        capacity.release(blocker)
        self.assertTrue(done.wait(5))
        self.assertEqual(order, ['chat-1', 'chat-2', 'summary'])

    def test_queue_moves_when_memory_frees_up_without_a_release(self):
        self.free = 0
        blocker = capacity.acquire(capacity.SUMMARY)
        admitted = threading.Event()
        capacity.enqueue(capacity.CHAT, 'c', lambda slot: admitted.set())
        self.assertFalse(admitted.wait(0.5))
        self.free = 5_000                      # 别的进程退出，内存降下来了
        self.assertTrue(admitted.wait(capacity.TICK_SECONDS + 3))
        capacity.release(blocker)

    def test_blocking_wait_reports_position_and_can_be_cancelled(self):
        self.free = 0
        blocker = capacity.acquire(capacity.CHAT)
        seen, stop = [], threading.Event()
        threading.Timer(0.6, stop.set).start()
        with self.assertRaises(capacity.Cancelled):
            capacity.wait(capacity.SUMMARY, 's', cancelled=stop.is_set, on_wait=seen.append, poll=0.1)
        self.assertEqual(seen, [0])
        self.assertEqual(capacity.status()['waiting'], 0)
        capacity.release(blocker)
        self.assertEqual(capacity.status()['running'], 0)

    def test_blocking_wait_returns_when_admitted(self):
        self.free = 0
        blocker = capacity.acquire(capacity.CHAT)
        threading.Timer(0.3, capacity.release, args=(blocker,)).start()
        slot = capacity.wait(capacity.SUMMARY, 's', poll=0.1)
        self.assertIsNotNone(slot)
        capacity.release(slot)
        self.assertEqual(capacity.status(), {**capacity.status(), 'running': 0, 'waiting': 0})


class HeadroomTest(unittest.TestCase):
    def test_reads_the_service_limit_and_the_machine(self):
        with tempfile.TemporaryDirectory() as tmp:
            group = Path(tmp)
            (group / 'memory.current').write_text(str(600 * 1048576))
            (group / 'memory.high').write_text(str(900 * 1048576))
            (group / 'memory.max').write_text(str(1100 * 1048576))
            with mock.patch.object(capacity, '_cgroup_dir', return_value=group), \
                    mock.patch.object(capacity, '_mem_available_mb', return_value=2000):
                self.assertEqual(capacity.headroom_mb(), 300)          # 服务上限更紧
            with mock.patch.object(capacity, '_cgroup_dir', return_value=group), \
                    mock.patch.object(capacity, '_mem_available_mb', return_value=350):
                self.assertEqual(capacity.headroom_mb(), 350 - capacity.SYSTEM_RESERVE_MB)   # 整台机器更紧
            (group / 'memory.high').write_text('max')
            with mock.patch.object(capacity, '_cgroup_dir', return_value=group), \
                    mock.patch.object(capacity, '_mem_available_mb', return_value=None):
                self.assertEqual(capacity.headroom_mb(), 500)          # 没设 MemoryHigh 时看 MemoryMax

    def test_nothing_to_read(self):
        with mock.patch.object(capacity, '_cgroup_dir', return_value=None), \
                mock.patch.object(capacity, '_mem_available_mb', return_value=None):
            self.assertIsNone(capacity.headroom_mb())


class CompanionQueueTest(unittest.TestCase):
    """小助理：内存放不下时消息收下排队，轮到了自动回复；排队时能取消。"""

    @classmethod
    def setUpClass(cls):
        from _app import app
        from src.database import db
        from src.models import User
        cls.app = app
        with app.app_context():
            user = User(username='queuetest', email='queuetest@example.com', email_verified=True, password='x')
            db.session.add(user)
            db.session.commit()
            cls.user_id = user.id

    def setUp(self):
        from src.services.companion import runner, service
        self.service, self.runner = service, runner
        capacity._reset_for_tests()
        self.addCleanup(capacity._reset_for_tests)
        self.free = 0
        for target, attr, kwargs in ((capacity, 'headroom_mb', {'side_effect': lambda: self.free}),
                                     (runner, 'active', {'return_value': None})):
            patcher = mock.patch.object(target, attr, **kwargs)
            patcher.start()
            self.addCleanup(patcher.stop)
        self.started = []
        self.started_event = threading.Event()

        def fake_start(uid, prompt, slot=None):
            slot = slot or capacity.acquire(capacity.CHAT)
            if slot is None:
                raise runner.NoCapacity()
            self.started.append((uid, prompt))
            self.started_event.set()
            capacity.release(slot)

        patcher = mock.patch.object(service, '_start_chat', side_effect=fake_start)
        patcher.start()
        self.addCleanup(patcher.stop)
        service._queued.pop(self.user_id, None)
        service._tickets.pop(self.user_id, None)

    def test_message_waits_for_memory_then_is_answered(self):
        blocker = capacity.acquire(capacity.SUMMARY)       # 有个摘要在跑，内存已满
        with self.app.app_context():
            self.service.send(self.user_id, '帮我看看本周待办')
            self.service.send(self.user_id, '顺便看看周报')    # 排队期间再发：并进同一次回复
            from src.services.companion import hub
            with hub.guard(self.user_id):
                live = self.service.live_snapshot(self.user_id)
        self.assertEqual(self.started, [])
        self.assertEqual(live['queue'], 0)
        self.assertTrue(live['waiting'])
        capacity.release(blocker)
        self.assertTrue(self.started_event.wait(5))
        self.assertEqual(len(self.started), 1)
        self.assertIn('本周待办', self.started[0][1])
        self.assertIn('周报', self.started[0][1])
        self.assertFalse(self.service.has_queued(self.user_id))

    def test_stop_while_queued_cancels(self):
        blocker = capacity.acquire(capacity.SUMMARY)
        with self.app.app_context():
            self.service.send(self.user_id, '在吗')
            self.assertTrue(self.service.stop(self.user_id))
        self.assertFalse(self.service.has_queued(self.user_id))
        capacity.release(blocker)
        time.sleep(0.5)
        self.assertEqual(self.started, [])
        self.assertEqual(capacity.status()['running'], 0)


if __name__ == '__main__':
    unittest.main()
