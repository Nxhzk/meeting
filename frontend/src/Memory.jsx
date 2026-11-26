import { useCallback, useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Banner, Icon, NavBar, NavButton, Segmented, Sheet, Toggle, relativeTime, softSpring, useToast } from './ui.jsx';
import { request } from './recording/api.js';
import { JstLoader } from './JstMark.jsx';

const categoryIcons = { person: 'person', project: 'folder', recurring_issue: 'warning', preference: 'heart' };
const actionText = { add: '新增', update: '修改', delete: '删除', restore: '恢复', pin: '设为始终记住', unpin: '取消始终记住' };
const actionIcons = { add: 'plus', update: 'pencil', delete: 'trash', restore: 'restore', pin: 'pin', unpin: 'pin' };
const actorText = { assistant: '会议助手', companion: '小助理', consolidator: '记忆整理' };
const MAX_CHARS = 500;

function useMemory() {
    const [state, setState] = useState({ loaded: false, entries: [], categories: [], error: null });
    const load = useCallback(async () => {
        try {
            const data = await request('/api/memory?deleted=1');
            setState({ loaded: true, entries: data.entries, categories: data.categories, consolidation: data.consolidation, error: null });
        } catch (error) {
            setState(current => ({ ...current, loaded: true, error: error.status === 401 ? 'login' : 'network' }));
        }
    }, []);
    useEffect(() => { load(); }, [load]);
    return [state, load, setState];
}

function EntrySheet({ entry, categories, onClose, onSaved, openMeeting }) {
    const toast = useToast();
    const creating = entry && !entry.id;
    const [category, setCategory] = useState(entry?.category || 'person');
    const [content, setContent] = useState(entry?.content || '');
    const [busy, setBusy] = useState('');   // 正在做的操作：save | delete | restore
    const [error, setError] = useState('');
    useEffect(() => {
        setCategory(entry?.category || 'person');
        setContent(entry?.content || '');
        setError('');
    }, [entry]);

    async function call(path, method, json, message, action = 'save') {
        setBusy(action);
        setError('');
        try {
            const saved = await request(path, { method, json });
            onSaved(saved);
            toast(message);
            onClose();
        } catch (err) {
            setError(err.data?.error || '没有保存成功，请稍后再试。');
        } finally { setBusy(''); }
    }
    const save = () => creating
        ? call('/api/memory', 'POST', { category, content }, '已记住')
        : call(`/api/memory/${entry.id}`, 'PATCH', { category, content }, '已保存');
    const deleted = entry?.deleted;
    const spin = action => busy === action ? <JstLoader size={18} tone="current" /> : null;
    return <Sheet open={Boolean(entry)} onClose={onClose} busy={Boolean(busy)} title={creating ? '新增记忆' : deleted ? '已删除的记忆' : '编辑记忆'}
        actions={deleted ? <button className="btn btn-primary btn-block" type="button" disabled={Boolean(busy)}
            onClick={() => call(`/api/memory/${entry.id}/restore`, 'POST', {}, '已恢复', 'restore')}>
            {spin('restore') || <Icon name="restore" />}{busy === 'restore' ? '正在恢复…' : '恢复这条记忆'}</button>
            : [<button key="s" className="btn btn-primary" type="button" disabled={Boolean(busy) || !content.trim()} onClick={save}>
                {spin('save')}{busy === 'save' ? '正在保存…' : '保存'}</button>,
                creating ? <button key="c" className="btn btn-gray" type="button" disabled={Boolean(busy)} onClick={onClose}>取消</button>
                    : <button key="d" className="btn btn-gray" type="button" style={{ color: 'var(--red)' }} disabled={Boolean(busy)}
                        onClick={() => call(`/api/memory/${entry.id}`, 'DELETE', undefined, '已删除，可在「显示已删除」里恢复', 'delete')}>
                        {spin('delete')}{busy === 'delete' ? '正在删除…' : '删除'}</button>]}>
        {!deleted && <div style={{ display: 'grid', gap: 14 }}>
            <div className="field">
                <span className="field-label">分类</span>
                <Segmented label="分类" value={category} onChange={setCategory}
                    options={categories.map(c => ({ value: c.key, label: c.label }))} />
            </div>
            <div className="field">
                <label htmlFor="memory-content">内容</label>
                <textarea id="memory-content" className="textarea" maxLength={MAX_CHARS} value={content}
                    placeholder="一句话写清楚，例如：李娜（财务）负责审核超过 5 万元的报价"
                    onChange={event => setContent(event.target.value.replace(/\n/g, ' '))} />
                <span className="counter">{content.length}/{MAX_CHARS}</span>
            </div>
        </div>}
        {deleted && <p style={{ color: 'var(--label)' }}>{entry.content}</p>}
        {!creating && !deleted && <div className="group"><div className="row">
            <span className="row-main"><span className="row-title">始终记住</span>
                <span className="row-sub"><span>每次都提供给助手，自动整理时不会改动</span></span></span>
            <Toggle checked={Boolean(entry?.pinned)} disabled={busy} label="始终记住"
                onChange={value => call(`/api/memory/${entry.id}`, 'PATCH', { pinned: value }, value ? '已设为始终记住' : '已取消始终记住')} />
        </div></div>}
        {entry?.source_recording_id && <p>来自会议：<button type="button" className="source-link" onClick={() => { onClose(); openMeeting(entry.source_recording_id); }}>
            {entry.source_title || '会议记录'}<Icon name="chevron" /></button></p>}
        {entry?.updated_at && <p>最后修改：{relativeTime(entry.updated_at)}</p>}
        {error && <Banner tone="bad">{error}</Banner>}
    </Sheet>;
}

function History({ close, openMeeting }) {
    const [events, setEvents] = useState(null);
    const [more, setMore] = useState(null);
    const [error, setError] = useState(false);
    const load = useCallback(async before => {
        try {
            const data = await request(`/api/memory/events${before ? `?before=${before}` : ''}`);
            setEvents(current => before ? [...(current || []), ...data.events] : data.events);
            setMore(data.next_before);
        } catch { setError(true); }
    }, []);
    useEffect(() => { load(); }, [load]);
    return <div className="page">
        <NavBar title="变更记录" subtitle="会议助手、小助理、记忆整理和你对长期记忆的每一次改动" left={<NavButton icon="back" label="返回记忆" onClick={close}>记忆</NavButton>} />
        <div className="content">
            {error && <Banner tone="warn">暂时无法加载变更记录。</Banner>}
            {!events && !error && <div className="center"><JstLoader size={40} label="正在加载" /></div>}
            {events && !events.length && <div className="empty"><Icon name="history" /><strong>还没有改动</strong></div>}
            {events?.length > 0 && <section className="section"><ul className="group timeline">
                {events.map(event => <motion.li key={event.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                    <span className="event-icon" data-action={event.action}><Icon name={actionIcons[event.action]} /></span>
                    <div className="event-body">
                        <strong>{actorText[event.actor] || '我'}{actionText[event.action]}了一条记忆</strong>
                        <div className="diff">
                            {event.action === 'update' && event.before?.content !== event.after?.content && <><del>{event.before?.content}</del><br /></>}
                            {(event.after || event.before)?.content}
                        </div>
                        {event.reason && <div className="diff">理由：{event.reason}</div>}
                        <div className="event-meta">
                            <span>{relativeTime(event.created_at)}</span>
                            {event.recording_id && <button type="button" className="source-link" onClick={() => openMeeting(event.recording_id)}>
                                {event.recording_title || '会议记录'}<Icon name="chevron" /></button>}
                        </div>
                    </div>
                </motion.li>)}
            </ul></section>}
            {more && <div className="section" style={{ display: 'grid' }}><button className="btn btn-gray" type="button" onClick={() => load(more)}>更早的记录</button></div>}
        </div>
    </div>;
}

function Consolidation({ info, reload }) {
    const toast = useToast();
    const [starting, setStarting] = useState(false);
    const running = info.running || starting;
    // 整理在后台进行：每 3 秒刷新一次，直到结束
    useEffect(() => {
        if (!info.running) return;
        const timer = setInterval(reload, 3000);
        return () => clearInterval(timer);
    }, [info.running, reload]);
    useEffect(() => { if (info.running) setStarting(false); }, [info.running]);
    async function start() {
        setStarting(true);
        try {
            await request('/api/memory/consolidate', { method: 'POST', json: {} });
            reload();
        } catch (error) {
            setStarting(false);
            toast(error.data?.error || '没能开始整理', 'bad');
        }
    }
    const last = info.last;
    const pct = Math.min(100, Math.round(info.chars / info.threshold_chars * 100));
    const lastLine = last && (last.status === 'failed' ? `上次整理没有完成：${last.error || '模型调用失败'}`
        : last.status === 'done' ? `上次整理 ${relativeTime(last.finished_at || last.started_at)}：`
            + ([last.merged && `合并 ${last.merged} 条`, last.rewritten && `精简 ${last.rewritten} 条`, last.deleted && `删除 ${last.deleted} 条`].filter(Boolean).join('、') || '没有需要整理的')
            + (last.chars_after != null && last.chars_after < last.chars_before ? `，${last.chars_before.toLocaleString()} → ${last.chars_after.toLocaleString()} 字` : '')
        : null);
    return <section className="section">
        <div className="group consolidation">
            <div className="row">
                <span className="memory-badge" data-cat="compress" aria-hidden="true"><Icon name="compress" /></span>
                <span className="row-main">
                    <span className="row-title">{info.count} 条 · {info.chars.toLocaleString()} 字</span>
                    <span className="row-sub"><span>每次只提供最相关的约 {info.context_chars.toLocaleString()} 字，其余按需查</span></span>
                    <span className="consolidation-bar" aria-label={`距离自动整理 ${pct}%`}><i style={{ width: `${pct}%` }} /></span>
                    <span className="row-sub"><span>{running ? '正在整理：合并重复、精简冗长、删掉过时的…'
                        : lastLine || `超过 ${info.threshold_chars.toLocaleString()} 字或 ${info.threshold_entries} 条时自动整理`}</span></span>
                </span>
                <button type="button" className="btn btn-gray btn-small" disabled={running || info.count < 2} onClick={start}>
                    {running ? <JstLoader size={20} tone="current" /> : '立即整理'}</button>
            </div>
        </div>
        <p className="section-foot">整理的每一步都在「变更记录」里，删掉的可以恢复；「始终记住」的条目不会被改动。</p>
    </section>;
}

export function MemoryPage({ config, sub, openMeeting, openHistory, closeHistory }) {
    const [state, load, setState] = useMemory();
    const [filter, setFilter] = useState('all');
    const [showDeleted, setShowDeleted] = useState(false);
    const [editing, setEditing] = useState(null);
    const visible = useMemo(() => state.entries.filter(entry =>
        (filter === 'all' || entry.category === filter) && (showDeleted || !entry.deleted)), [state.entries, filter, showDeleted]);
    // 列表行只在条目增删、改动时挪位；左右滑动切页面时整页位置变化不触发
    const visibleIds = visible.map(entry => `${entry.id}:${entry.deleted ? 1 : 0}:${entry.content?.length}`).join();
    const count = state.entries.filter(entry => !entry.deleted).length;
    const onSaved = saved => setState(current => ({
        ...current,
        entries: [saved, ...current.entries.filter(entry => entry.id !== saved.id)],
    }));

    if (sub === 'history') return <History close={closeHistory} openMeeting={openMeeting} />;
    return <div className="page">
        <NavBar title="长期记忆" subtitle={state.loaded ? `会议助手和小助理记住的 ${count} 条信息` : ' '}
            right={<>
                <NavButton icon="history" label="变更记录" onClick={openHistory} />
                <NavButton icon="plus" label="新增记忆" onClick={() => setEditing({ category: filter === 'all' ? 'person' : filter, content: '' })} />
            </>} />
        <div className="memory-filter content">
            <Segmented label="按分类筛选" value={filter} onChange={setFilter}
                options={[{ value: 'all', label: '全部' }, ...state.categories.map(c => ({ value: c.key, label: c.label }))]} />
        </div>
        <div className="content">
            {state.error === 'login' && <Banner tone="bad" title="登录已失效"><a href={config.loginUrl}>重新登录</a>后查看。</Banner>}
            {state.error === 'network' && <Banner tone="warn">网络不稳定，<button type="button" className="source-link" onClick={load}>重试</button></Banner>}
            {!state.loaded && <div className="center"><JstLoader size={40} label="正在加载" /></div>}
            {state.loaded && !visible.length && !state.error && <div className="empty">
                <Icon name="brain" />
                <strong>{filter === 'all' ? '还没有长期记忆' : '这个分类还没有记忆'}</strong>
                <p>每次生成会议摘要时，会议助手会自己判断哪些人物、项目、反复出现的问题值得记住，以后的会议都能用上。</p>
            </div>}
            {state.consolidation && count > 0 && filter === 'all' && <Consolidation info={state.consolidation} reload={load} />}
            {visible.length > 0 && <section className="section">
                <ul className="group list" role="list">
                    <AnimatePresence initial={false}>
                        {visible.map(entry => <motion.li key={entry.id} layout layoutDependency={visibleIds} initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }}
                            exit={{ opacity: 0, height: 0 }} transition={softSpring}>
                            <button type="button" className="row memory-row" data-deleted={entry.deleted} onClick={() => setEditing(entry)}>
                                <span className="memory-badge" data-cat={entry.category} aria-hidden="true"><Icon name={categoryIcons[entry.category] || 'lightbulb'} /></span>
                                <span className="row-main">
                                    <span className="memory-text">{entry.pinned && <Icon name="pin" className="memory-pin" />}{entry.content}</span>
                                    <span className="row-sub">
                                        <span>{[entry.category_label, entry.source_title, relativeTime(entry.updated_at)].filter(Boolean).join(' · ')}</span>
                                        {entry.deleted && <span className="chip" data-tone="bad">已删除</span>}
                                    </span>
                                </span>
                                <Icon name="chevron" className="chevron" />
                            </button>
                        </motion.li>)}
                    </AnimatePresence>
                </ul>
            </section>}
            {state.loaded && state.entries.some(entry => entry.deleted) && <section className="section">
                <div className="group"><div className="row">
                    <span className="row-main"><span className="row-title">显示已删除</span></span>
                    <Toggle checked={showDeleted} onChange={setShowDeleted} label="显示已删除的记忆" />
                </div></div>
                <p className="section-foot">删除的记忆不会再提供给会议助手，可以随时恢复。</p>
            </section>}
        </div>
        <EntrySheet entry={editing} categories={state.categories} onClose={() => setEditing(null)} onSaved={onSaved} openMeeting={openMeeting} />
    </div>;
}
