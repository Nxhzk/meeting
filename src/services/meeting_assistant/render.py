"""把 save_summary 的结构化结果整理并渲染成 Markdown。

结构（结论先行）：一句话总结 → 决定 → 待办 → 讨论要点 → 待定事项 → 本次注意事项 → 其他。
只整理格式，不截断任何内容：写多长由纪要规范要求，程序不替模型删字。
"""

SECTION_TITLES = {
    'decisions': '决定',
    'action_items': '待办',
    'discussion': '讨论要点',
    'open_questions': '待定事项',
    'cautions': '本次注意事项',
    'other': '其他',
}
CAUTION_TITLES = {
    'meeting_process': '会议本身',
    'business_risks': '业务风险',
    'recurring': '再次出现的问题',
}
UNCLEAR_OWNER = '未明确'


class SummaryInvalid(ValueError):
    """会议助手提交的摘要结构不合格。message 会原样反馈给它。"""


def _text(value):
    return ' '.join(value.split()) if isinstance(value, str) else ''


def _list(value):
    if not isinstance(value, list):
        return []
    return [text for text in (_text(v) for v in value) if text]


def normalize(raw):
    """整理成固定结构；缺少一句话总结时抛 SummaryInvalid。"""
    if not isinstance(raw, dict):
        raise SummaryInvalid('摘要必须是一个对象。')
    summary = _text(raw.get('summary'))
    if not summary:
        raise SummaryInvalid('一句话总结（summary）不能为空。')

    decisions = []
    for item in raw.get('decisions') or []:
        if isinstance(item, dict) and _text(item.get('decision')):
            decision = {'decision': _text(item.get('decision'))}
            if _text(item.get('reason')):
                decision['reason'] = _text(item.get('reason'))
            decisions.append(decision)

    actions = []
    for item in raw.get('action_items') or []:
        if not isinstance(item, dict) or not _text(item.get('task')):
            continue
        action = {'task': _text(item.get('task')), 'owner': _text(item.get('owner')) or UNCLEAR_OWNER}
        for key in ('due', 'done_when'):
            if _text(item.get(key)):
                action[key] = _text(item.get(key))
        actions.append(action)

    discussion = []
    for item in raw.get('discussion') or []:
        if isinstance(item, dict) and _text(item.get('topic')) and _list(item.get('points')):
            discussion.append({'topic': _text(item.get('topic')), 'points': _list(item.get('points'))})

    cautions_raw = raw.get('cautions') if isinstance(raw.get('cautions'), dict) else {}
    return {
        'summary': summary,
        'decisions': decisions,
        'action_items': actions,
        'discussion': discussion,
        'open_questions': _list(raw.get('open_questions')),
        'cautions': {key: _list(cautions_raw.get(key)) for key in CAUTION_TITLES},
        'other': _list(raw.get('other')),
    }


def _cell(value):
    return value.replace('|', '｜')


def _bullets(items):
    return '\n'.join(f'- {item}' for item in items)


def to_markdown(sections):
    # 一句话总结作为开头的引导段落
    out = [sections['summary']]
    if sections['decisions']:
        lines = [f"- **{item['decision']}**" + (f"　{item['reason']}" if item.get('reason') else '')
                 for item in sections['decisions']]
        out += [f"## {SECTION_TITLES['decisions']}", '\n'.join(lines)]
    out.append(f"## {SECTION_TITLES['action_items']}")
    if sections['action_items']:
        rows = ['| 事项 | 负责人 | 期限 |', '| --- | --- | --- |']
        for item in sections['action_items']:
            task = item['task'] + (f"（完成标准：{item['done_when']}）" if item.get('done_when') else '')
            rows.append(f"| {_cell(task)} | {_cell(item['owner'])} | {_cell(item.get('due') or '—')} |")
        out.append('\n'.join(rows))
    else:
        out.append('本次没有安排待办。')
    if sections['discussion']:
        out.append(f"## {SECTION_TITLES['discussion']}")
        for item in sections['discussion']:
            out += [f"### {item['topic']}", _bullets(item['points'])]
    if sections['open_questions']:
        out += [f"## {SECTION_TITLES['open_questions']}", _bullets(sections['open_questions'])]
    cautions = sections['cautions']
    out.append(f"## {SECTION_TITLES['cautions']}")
    if any(cautions.values()):
        for key, title in CAUTION_TITLES.items():
            if cautions[key]:
                out += [f'### {title}', _bullets(cautions[key])]
    else:
        out.append('本次没有需要特别注意的问题。')
    if sections['other']:
        out += [f"## {SECTION_TITLES['other']}", _bullets(sections['other'])]
    return '\n\n'.join(out).strip() + '\n'
