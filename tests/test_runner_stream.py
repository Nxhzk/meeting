"""会议助手读 pi 输出：处理完的行不留在内存里；输出不停时超时照样生效。

2026-11-25 一场 97 分钟的会议生成摘要时，服务把 pi 的全部输出都留在内存里，
涨到 800 多 MB，撞上内存上限后整个网页卡死。
"""
import json
import sys
import time
import tracemalloc
import unittest

from src.services.meeting_assistant import runner

BIG = 300            # 行数
LINE = 1024 * 1024   # 每行约 1 MB（像流式事件里带着的整条半成品消息）

EMIT_BIG = f"""
import json, sys
pad = 'x' * {LINE}
for i in range({BIG}):
    sys.stdout.write(json.dumps({{'type': 'message_update', 'assistantMessageEvent': {{'type': 'text_delta', 'delta': 'a'}},
                                  'message': {{'content': [{{'type': 'text', 'text': pad}}]}}}}) + '\\n')
sys.stdout.write(json.dumps({{'type': 'tool_execution_end', 'toolName': 'save_summary', 'isError': False,
                              'result': {{'details': {{'summary': {{'markdown': 'ok'}}}}}}}}) + '\\n')
"""

EMIT_FOREVER = """
import json, sys
while True:
    sys.stdout.write(json.dumps({'type': 'message_update', 'assistantMessageEvent': {'type': 'thinking_delta', 'delta': 'a'}}) + '\\n')
    sys.stdout.flush()
"""


def run(code, timeout):
    return runner._execute([sys.executable, '-c', code], None, None, timeout, [], None, None)


class RunnerStreamTest(unittest.TestCase):
    def test_big_output_is_not_kept(self):
        tracemalloc.start()
        try:
            result = run(EMIT_BIG, 120)
            _, peak = tracemalloc.get_traced_memory()
        finally:
            tracemalloc.stop()
        self.assertEqual(result.summary, {'markdown': 'ok'})
        # 全部留着要 300 MB 以上；逐行处理时只有几行在内存里
        self.assertLess(peak, 60 * 1024 * 1024, f'峰值 {peak // 1048576} MB')

    def test_timeout_fires_while_output_never_stops(self):
        started = time.monotonic()
        with self.assertRaises(runner.AssistantRunFailed):
            run(EMIT_FOREVER, 1)
        self.assertLess(time.monotonic() - started, 15)

    def test_last_successful_save_wins(self):
        code = "import json\n" + "\n".join(
            f"print(json.dumps({{'type': 'tool_execution_end', 'toolName': 'save_summary', 'isError': False, "
            f"'result': {{'details': {{'summary': {{'markdown': '{n}'}}}}}}}}))" for n in ('v1', 'v2'))
        self.assertEqual(run(code, 30).summary, {'markdown': 'v2'})


if __name__ == '__main__':
    unittest.main()
