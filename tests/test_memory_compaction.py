"""长期记忆的压缩：每次只放最相关的一部分进上下文，超过阈值后台整理。"""
import unittest
from datetime import datetime, timedelta


class MemoryTestBase(unittest.TestCase):
    username = 'memcompact'

    @classmethod
    def setUpClass(cls):
        from _app import app
        from src.database import db
        from src.models import User
        cls.app = app
        with app.app_context():
            user = User(username=cls.username, email=f'{cls.username}@example.com', email_verified=True, password='x')
            db.session.add(user)
            db.session.commit()
            cls.user_id = user.id

    def setUp(self):
        self.ctx = self.app.app_context()
        self.ctx.push()
        self.addCleanup(self.ctx.pop)
        from src.database import db
        from src.models.meeting_assistant import MemoryEntry, MemoryEvent, MemoryConsolidation
        MemoryEvent.query.filter_by(user_id=self.user_id).delete()
        MemoryConsolidation.query.filter_by(user_id=self.user_id).delete()
        MemoryEntry.query.filter_by(user_id=self.user_id).delete()
        db.session.commit()

    def add(self, content, category='project', pinned=False, days_ago=0, by_user=False):
        from src.database import db
        from src.models.meeting_assistant import MemoryEntry, MemoryEvent
        moment = datetime.utcnow() - timedelta(days=days_ago)
        entry = MemoryEntry(user_id=self.user_id, category=category, content=content, pinned=pinned,
                            created_at=moment, updated_at=moment)
        db.session.add(entry)
        db.session.flush()
        if by_user:
            db.session.add(MemoryEvent(user_id=self.user_id, entry_id=entry.id, action='add', actor='user',
                                       after={'category': category, 'content': content}))
        db.session.commit()
        return entry


class SelectAndSearchTest(MemoryTestBase):
    username = 'memselect'

    def test_context_stays_within_budget_and_prefers_what_the_meeting_is_about(self):
        from src.services.meeting_assistant import memory
        for i in range(300):
            self.add(f'项目{i}号：一个和本次会议无关的旧项目，进展记录若干，负责人张三{i}。' * 2, days_ago=60)
        wang = self.add('王磊负责华东区回款，杭州客户拖款时由他当面催收。', category='person', days_ago=90)
        pinned = self.add('用户希望摘要先写结论。', category='preference', pinned=True, days_ago=200)
        entries = memory.active_entries(self.user_id)
        chosen, rels = memory.select(entries, '今天讨论杭州回款，王磊下周三去杭州催款。', budget=3000)
        self.assertLessEqual(sum(len(e.content) + 12 for e in chosen), 3000 + len(pinned.content) + 12)
        ids = {e.id for e in chosen}
        self.assertIn(wang.id, ids)          # 相关的旧条目也会被挑中
        self.assertIn(pinned.id, ids)        # 始终记住的一定在
        self.assertLess(len(chosen), 300)
        self.assertEqual(rels[wang.id], max(rels.values()))   # 和会议最相关的就是它

    def test_search_finds_two_character_names(self):
        from src.services.meeting_assistant import memory
        self.add('李娜（财务）审核超过 5 万元的报价。', category='person')
        self.add('王磊负责华东回款。', category='person')
        hits = memory.search(memory.active_entries(self.user_id), '李娜')
        self.assertEqual([h.content[:2] for h in hits], ['李娜'])
        self.assertEqual(memory.search(memory.active_entries(self.user_id), '   '), [])

    def test_prompt_lists_only_part_of_a_large_memory_and_points_to_search(self):
        from src.services.meeting_assistant import prompts
        rows = [{'id': 'm1', 'category': 'person', 'content': '王磊', 'pinned': True}]
        text = prompts.first_message([], rows, {'person': '人物'}, total=250)
        self.assertIn('共 250 条', text)
        self.assertIn('search_memory', text)
        self.assertIn('（始终记住）', text)


class ConsolidationTest(MemoryTestBase):
    username = 'memconsolidate'

    def run_with(self, ops_by_category):
        from src.services.meeting_assistant import consolidate

        def fake_model(prompt, _user_id):
            for label, ops in ops_by_category.items():
                if f'整理「{label}」' in prompt:
                    return ops
            return []
        return consolidate.run(self.user_id, 'user', call_model=fake_model)

    def test_merge_rewrite_delete_with_history(self):
        from src.models.meeting_assistant import MemoryEntry, MemoryEvent
        a = self.add('王磊负责华东区回款。', category='person')
        b = self.add('王磊，华东销售，常驻杭州。', category='person')
        c = self.add('张三是采购，' + '他非常非常非常认真地负责采购相关的大量各种工作。', category='person')
        d = self.add('上周五的临时会议改到了 3 点。', category='person')
        record = self.run_with({'人物': [
            {'op': 'merge', 'ids': [f'm{a.id}', f'm{b.id}'], 'content': '王磊：华东销售，常驻杭州，负责华东区回款。', 'reason': '同一个人'},
            {'op': 'rewrite', 'id': f'm{c.id}', 'content': '张三：采购负责人。', 'reason': '太啰嗦'},
            {'op': 'delete', 'id': f'm{d.id}', 'reason': '一次性细节'},
        ]})
        self.assertEqual(record.status, 'done')
        self.assertEqual((record.merged, record.rewritten, record.deleted), (1, 1, 1))
        alive = {e.id: e.content for e in MemoryEntry.query.filter_by(user_id=self.user_id, deleted_at=None)}
        self.assertEqual(alive, {a.id: '王磊：华东销售，常驻杭州，负责华东区回款。', c.id: '张三：采购负责人。'})
        actors = {e.actor for e in MemoryEvent.query.filter_by(user_id=self.user_id)}
        self.assertEqual(actors, {'consolidator'})
        self.assertLess(record.chars_after, record.chars_before)

    def test_safety_rules_drop_unsafe_operations(self):
        from src.models.meeting_assistant import MemoryEntry
        pinned = self.add('用户希望摘要先写结论。', category='preference', pinned=True)
        mine = self.add('我每周一上午不开会。', category='preference', by_user=True)
        other = self.add('用户喜欢表格。', category='preference')
        extra = [self.add(f'偏好{i}：可有可无的一条。', category='preference') for i in range(5)]
        record = self.run_with({'偏好': [
            {'op': 'delete', 'id': f'm{pinned.id}', 'reason': 'x'},                       # 锁定：不删
            {'op': 'rewrite', 'id': f'm{pinned.id}', 'content': '先结论', 'reason': 'x'},   # 锁定：不改
            {'op': 'merge', 'ids': [f'm{pinned.id}', f'm{other.id}'], 'content': 'x', 'reason': 'x'},  # 锁定：不并
            {'op': 'delete', 'id': f'm{mine.id}', 'reason': 'x'},                          # 用户写的：不删
            {'op': 'rewrite', 'id': f'm{other.id}', 'content': '用户喜欢用表格展示对比信息。', 'reason': '更长了'},  # 不许变长
            {'op': 'delete', 'id': 'm999999', 'reason': 'x'},                              # 不在这批里
            *[{'op': 'delete', 'id': f'm{e.id}', 'reason': '没用'} for e in extra],        # 最多删三分之一
            {'op': 'nonsense'}, 'not a dict',
        ]})
        alive = {e.id: e.content for e in MemoryEntry.query.filter_by(user_id=self.user_id, deleted_at=None)}
        self.assertEqual(alive[pinned.id], '用户希望摘要先写结论。')
        self.assertIn(mine.id, alive)
        self.assertEqual(alive[other.id], '用户喜欢表格。')
        self.assertEqual(record.deleted, 8 // 3)

    def test_user_written_entry_survives_a_merge(self):
        from src.models.meeting_assistant import MemoryEntry
        machine = self.add('杭州项目验收卡在客户签字。', category='project')
        mine = self.add('杭州项目：验收单周五前要签。', category='project', by_user=True)
        self.run_with({'项目': [{'op': 'merge', 'ids': [f'm{machine.id}', f'm{mine.id}'],
                                'content': '杭州项目：验收卡在客户签字，验收单周五前要签。', 'reason': '同一个项目'}]})
        alive = [e.id for e in MemoryEntry.query.filter_by(user_id=self.user_id, deleted_at=None)]
        self.assertEqual(alive, [mine.id])   # 留下的是用户写的那条

    def test_failed_model_call_is_recorded_and_nothing_changes(self):
        from src.models.meeting_assistant import MemoryEntry
        from src.services.meeting_assistant import consolidate
        self.add('甲。', category='person')
        self.add('乙。', category='person')

        def broken(_prompt, _user_id):
            raise RuntimeError('模型接口不通')
        record = consolidate.run(self.user_id, 'user', call_model=broken)
        self.assertEqual(record.status, 'failed')
        self.assertIn('模型接口不通', record.error)
        self.assertEqual(MemoryEntry.query.filter_by(user_id=self.user_id, deleted_at=None).count(), 2)

    def test_auto_consolidation_is_due_over_the_threshold_once_a_day(self):
        from src.database import db
        from src.models.meeting_assistant import MemoryConsolidation
        from src.services.meeting_assistant import consolidate
        self.add('短。', category='person')
        self.assertFalse(consolidate.due(self.user_id))
        for i in range(consolidate.THRESHOLD_ENTRIES):
            self.add(f'条目{i}', category='project')
        self.assertTrue(consolidate.due(self.user_id))
        db.session.add(MemoryConsolidation(user_id=self.user_id, trigger='auto', status='done'))
        db.session.commit()
        self.assertFalse(consolidate.due(self.user_id))   # 24 小时内不再自动整理

    def test_parse_ops_tolerates_code_fences(self):
        from src.services.meeting_assistant import consolidate
        self.assertEqual(consolidate.parse_ops('```json\n{"ops": [{"op": "delete", "id": "m1"}]}\n```'),
                         [{'op': 'delete', 'id': 'm1'}])
        self.assertEqual(consolidate.parse_ops('{"ops": "x"}'), [])


class CompanionMemoryApiTest(MemoryTestBase):
    username = 'memcompanion'

    def call(self, method, path, **kwargs):
        from src.services.companion import tokens
        headers = {'X-Assistant-Token': tokens.issue(self.user_id)}
        return getattr(self.app.test_client(), method)(f'/internal/assistant{path}', headers=headers, **kwargs)

    def test_large_memory_is_not_returned_whole_and_can_be_searched(self):
        from src.services.meeting_assistant import memory
        for i in range(400):
            self.add(f'旧项目{i}的一些零碎记录，内容和别的项目差不多，写得比较长一些。', days_ago=100)
        target = self.add('李娜（财务）审核超过 5 万元的报价。', category='person', days_ago=100)
        listing = self.call('get', '/memory').get_json()
        self.assertEqual(listing['total'], 401)
        self.assertLess(sum(len(e['content']) for e in listing['entries']), memory.CONTEXT_CHARS)
        self.assertIn('?q=', listing['note'])
        found = self.call('get', '/memory?q=李娜').get_json()['entries']
        self.assertEqual(found[0]['id'], f'm{target.id}')
        from src.database import db
        db.session.refresh(target)
        self.assertEqual(target.use_count, 1)            # 搜到了就算用过一次

    def test_companion_can_pin_and_it_is_logged(self):
        from src.models.meeting_assistant import MemoryEvent
        entry = self.add('用户希望摘要先写结论。', category='preference')
        response = self.call('patch', f'/memory/m{entry.id}', json={'pinned': True, 'reason': '用户说一定要记住'})
        self.assertTrue(response.get_json()['pinned'])
        event = MemoryEvent.query.filter_by(entry_id=entry.id).one()
        self.assertEqual((event.action, event.actor), ('pin', 'companion'))


if __name__ == '__main__':
    unittest.main()
