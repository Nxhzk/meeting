import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon, softSpring } from './ui.jsx';

/* 会议助手的实时工具调用流：pi 真实调用的每个工具、每段思考、撰写摘要的过程。 */

const CATEGORY = { person: '人物', project: '项目', recurring_issue: '问题', preference: '偏好' };

function describe(event) {
    const d = event.data || {};
    if (event.kind === 'thinking') {
        return { icon: 'sparkles', tool: 'think', title: event.status === 'running' ? '思考中' : '思考', meta: d.chars ? `${d.chars.toLocaleString()} 字` : '' };
    }
    if (event.kind === 'compose') {
        return { icon: 'pencil', tool: 'write', title: event.status === 'running' ? '正在撰写摘要' : '写完摘要', meta: d.chars ? `${d.chars.toLocaleString()} 字符` : '' };
    }
    switch (event.tool) {
        case 'ls': return { icon: 'folder', tool: 'ls', title: '查看会议资料', arg: d.path === '.' ? '' : d.path, meta: d.count ? `${d.count} 项` : '' };
        case 'read':
            if (d.range) return { icon: 'doc', tool: 'read', title: `阅读原文 ${d.index}/${d.total}`, arg: d.path, meta: `第 ${d.range[0]}–${d.range[1]} 句` };
            return { icon: 'doc', tool: 'read', title: '读取', arg: d.path };
        case 'list_memory': return { icon: 'brain', tool: 'list_memory', title: '查看长期记忆', meta: d.count != null ? `${d.count} 条` : '' };
        case 'search_memory': return { icon: 'brain', tool: 'search_memory', title: `搜索长期记忆${d.query ? `「${d.query}」` : ''}`, meta: d.count != null ? `找到 ${d.count} 条` : '' };
        case 'add_memory': return { icon: 'plus', tool: 'add_memory', title: `记住 · ${CATEGORY[d.category] || ''}`, quote: d.content };
        case 'update_memory': return { icon: 'pencil', tool: 'update_memory', title: `更新记忆 ${d.id || ''}`, quote: d.content };
        case 'delete_memory': return { icon: 'trash', tool: 'delete_memory', title: `删除记忆 ${d.id || ''}`, quote: d.reason };
        case 'save_summary': return { icon: 'checkCircle', tool: 'save_summary', title: '提交会议摘要' };
        default: return { icon: 'gear', tool: event.tool || 'tool', title: event.tool || '工具' };
    }
}

/** 会议助手此刻在做什么：取最新一条进行中的调用（没有就取最后一条）。 */
export function currentActivity(events = []) {
    const running = [...events].reverse().find(event => event.status === 'running');
    const last = events.at(-1);
    const event = running || last;
    if (!event) return '正在启动会议助手…';
    const d = event.data || {};
    if (!running) {
        if (last.status === 'error' && last.tool === 'save_summary') return '摘要被退回，正在修改';
        return '正在思考下一步';
    }
    if (event.kind === 'thinking') return '正在思考';
    if (event.kind === 'compose') return d.chars ? `正在撰写摘要 · ${d.chars.toLocaleString()} 字符` : '正在撰写摘要';
    switch (event.tool) {
        case 'read': return d.range ? `正在阅读原文 ${d.index}/${d.total}` : '正在阅读资料';
        case 'ls': return '正在查看会议资料';
        case 'list_memory': return '正在查看长期记忆';
        case 'search_memory': return '正在搜索长期记忆';
        case 'add_memory': return '正在记住新信息';
        case 'update_memory': return '正在更新记忆';
        case 'delete_memory': return '正在清理过时的记忆';
        case 'save_summary': return '正在提交摘要';
        default: return '正在工作';
    }
}

function duration(event, now) {
    const start = Date.parse(event.started_at);
    const end = event.ended_at ? Date.parse(event.ended_at) : now;
    if (Number.isNaN(start)) return '';
    const seconds = Math.max(0, (end - start) / 1000);
    return seconds < 1 ? '' : seconds < 60 ? `${seconds.toFixed(seconds < 10 ? 1 : 0)}s` : `${Math.floor(seconds / 60)}m${Math.round(seconds % 60)}s`;
}

export function AgentTrace({ events = [] }) {
    const list = useRef(null);
    const [now, setNow] = useState(Date.now);
    const [expanded, setExpanded] = useState(false);
    const running = events.some(event => event.status === 'running');
    useEffect(() => {
        if (!running) return;
        const timer = setInterval(() => setNow(Date.now()), 250);
        return () => clearInterval(timer);
    }, [running]);
    const [overflow, setOverflow] = useState(false);
    useEffect(() => {
        const node = list.current;
        if (!node) return;
        setOverflow(node.scrollHeight > node.clientHeight + 2);
        if (!expanded) node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
    }, [events.length, expanded]);
    const calls = events.filter(event => event.kind === 'tool').length;
    return <div className="trace" data-expanded={expanded}>
        <div className="trace-head">
            <span className="trace-title"><span className="trace-dot" data-live={running} />调用记录</span>
            <span className="trace-count">{calls} 次工具调用</span>
            {events.length > 6 && <button type="button" className="trace-toggle" onClick={() => setExpanded(!expanded)}>{expanded ? '收起' : '全部'}</button>}
        </div>
        <ol className="trace-list" ref={list} aria-live="polite" data-overflow={overflow}>
            {!events.length && <li className="trace-empty" data-status="running">
                <span className="trace-icon"><span className="trace-spin" /></span>
                <span className="trace-body"><span className="trace-line"><span className="trace-label">正在启动会议助手…</span></span></span>
            </li>}
            <AnimatePresence initial={false}>
                {events.map(event => {
                    const view = describe(event);
                    return <motion.li key={event.key} data-status={event.status} data-kind={event.kind}
                        initial={{ opacity: 0, y: 14, scale: .97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={softSpring}>
                        <span className="trace-icon">
                            {event.status === 'running' ? <span className="trace-spin" /> : <Icon name={event.status === 'error' ? 'warning' : view.icon} />}
                        </span>
                        <span className="trace-body">
                            <span className="trace-line">
                                <code className="trace-tool">{view.tool}</code>
                                <span className="trace-label">{view.title}</span>
                                {view.arg && <span className="trace-arg">{view.arg}</span>}
                                <span className="trace-time">{[view.meta, duration(event, now)].filter(Boolean).join(' · ')}</span>
                            </span>
                            {view.quote && <span className="trace-quote">{view.quote}</span>}
                            {event.status === 'error' && event.data?.error && <span className="trace-error">{event.data.error}</span>}
                            {event.kind === 'thinking' && event.status === 'running' && <span className="trace-wave" aria-hidden="true"><i /><i /><i /><i /><i /></span>}
                        </span>
                    </motion.li>;
                })}
            </AnimatePresence>
        </ol>
    </div>;
}
