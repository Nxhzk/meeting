"""一个最小的 OpenAI 兼容流式接口，用脚本化的工具调用驱动会议助手，供测试使用。

按请求里已有的 tool 结果数量决定下一步：ls → 逐段 read → list_memory →
add_memory → save_summary → 结束语。请求体写入 MOCK_LLM_LOG（JSONL）。
"""
import json
import os
import sys
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

LOG = os.environ.get('MOCK_LLM_LOG')
SKIP_READ = os.environ.get('MOCK_SKIP_READ') == '1'
DELAY = float(os.environ.get('MOCK_DELAY') or 0)
EVIL_PATHS = [p for p in os.environ.get('MOCK_EVIL_PATHS', '').split('|') if p]


def plan(messages):
    tool_msgs = [m for m in messages if m.get('role') == 'tool']
    users = [m for m in messages if m.get('role') == 'user']
    last_user = users[-1]['content'] if users else ''
    if isinstance(last_user, list):
        last_user = ''.join(p.get('text', '') for p in last_user if isinstance(p, dict))
    parts = []
    for line in last_user.splitlines():
        line = line.strip()
        if line.startswith('- transcript/'):
            parts.append(line[2:].split(' ')[0])
    # 只看最后一条 user 之后的工具结果
    idx = max((i for i, m in enumerate(messages) if m.get('role') == 'user'), default=-1)
    after = [m for m in messages[idx + 1:] if m.get('role') == 'tool']
    steps = [('ls', {'path': '.'})]
    steps += [('read', {'path': p}) for p in EVIL_PATHS]
    if not SKIP_READ:
        steps += [('read', {'path': p}) for p in parts]
    steps += [('list_memory', {}),
              ('add_memory', {'category': 'person', 'content': '张三负责报价审核', 'reason': '多次会议都会用到'}),
              ('save_summary', {
                  'summary': '讨论报价与交付，定下周交付。',
                  'decisions': [{'decision': '下周交付', 'reason': '客户要求'}],
                  'action_items': [{'task': '整理报价单', 'owner': '张三', 'due': '周五'}],
                  'discussion': [{'topic': '报价', 'points': ['总价 48 万，超预算 8 万']}],
                  'open_questions': ['二期功能是否保留'],
                  'cautions': {'meeting_process': ['没有提前发议程'], 'business_risks': ['客户对价格敏感'], 'recurring': []}})]
    n = len(after)
    if n < len(steps):
        return steps[n]
    return None


class Handler(BaseHTTPRequestHandler):
    def log_message(self, *args):
        pass

    def do_POST(self):
        body = json.loads(self.rfile.read(int(self.headers.get('Content-Length', 0))) or b'{}')
        if LOG:
            with open(LOG, 'a') as f:
                f.write(json.dumps({'path': self.path, 'auth': self.headers.get('Authorization'), 'body': body}, ensure_ascii=False) + '\n')
        step = plan(body.get('messages', []))
        time.sleep(DELAY)
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.end_headers()

        def send(obj):
            self.wfile.write(f'data: {json.dumps(obj, ensure_ascii=False)}\n\n'.encode())
            self.wfile.flush()
        base = {'id': 'c1', 'object': 'chat.completion.chunk', 'model': body.get('model')}
        if step:
            name, args = step
            n = sum(1 for m in body.get('messages', []) if m.get('role') == 'tool')
            send({**base, 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'tool_calls': [
                {'index': 0, 'id': f'call_{n}', 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(args, ensure_ascii=False)}}]}}]})
            send({**base, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'tool_calls'}]})
        else:
            send({**base, 'choices': [{'index': 0, 'delta': {'role': 'assistant', 'content': '已完成。'}}]})
            send({**base, 'choices': [{'index': 0, 'delta': {}, 'finish_reason': 'stop'}]})
        send({**base, 'choices': [], 'usage': {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120}})
        self.wfile.write(b'data: [DONE]\n\n')


if __name__ == '__main__':
    server = ThreadingHTTPServer(('127.0.0.1', int(sys.argv[1]) if len(sys.argv) > 1 else 0), Handler)
    print(server.server_address[1], flush=True)
    server.serve_forever()
