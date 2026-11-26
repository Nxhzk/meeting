import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { AnimatePresence, animate, motion, useMotionValue, useTransform } from 'motion/react';
import { Icon, Menu, MenuItem, NavButton, Sheet, dayLabel, softSpring, spring, timeFormat, useToast } from './ui.jsx';
import { chunkHtml, completedChunks, splitReply, typingDelay } from './chat-format.js';
import { LiquidMark } from './LiquidOrb.jsx';
import { JstLoader } from './JstMark.jsx';
import { HoldToTalk } from './VoiceInput.jsx';
import { apiUrl, request } from './recording/api.js';

/* 小助理：和用户的一条连续对话。
   一条 SSE 事件流（整个应用共用）推送流式回复、工具调用、主动消息、未读数和积分。 */

const SUGGESTIONS = ['最近有哪些待办快到期了？', '上次华东回款的会定了什么？', '明天上午 9 点提醒我看周报', '你记得我哪些习惯？'];

// ------------------------------------------------------------ 全局连接（在 Workspace 里调用一次）
const EMPTY_SEGMENT = () => ({ text: '', tools: [], thought: '', thought_ms: 0 });

/** 服务器快照 → 页面上的进行中回复。快照里是还没存成消息的各段。 */
function fromSnapshot(snap, previous) {
    if (!snap) return null;
    const segments = snap.segments?.length ? snap.segments.map(seg => ({ ...EMPTY_SEGMENT(), ...seg })) : [EMPTY_SEGMENT()];
    return { run: snap.run, segments, thinking: Boolean(snap.thinking), stopping: Boolean(snap.stopping), waiting: Boolean(snap.waiting),
        queue: snap.queue ?? null, cut: previous && previous.run === snap.run ? previous.cut : 0 };
}

/** 按编号插入（去重、保持顺序）。 */
function upsert(messages, message) {
    if (messages.some(m => m.id === message.id)) return messages;
    const next = [...messages, message];
    return next.at(-2)?.id > message.id ? next.sort((a, b) => a.id - b.id) : next;
}

/** 重新拉到的最新一页并进现有列表：页面上已经加载的更早消息尽量保留，之后推送来的新消息也保留。 */
function mergePage(current, page, more) {
    if (!page.length) return { messages: current.filter(m => m.id > (more ?? Infinity)), more };
    const first = page[0].id;
    const last = page.at(-1).id;
    const newer = current.filter(m => m.id > last);
    const contiguous = more == null || current.some(m => m.id === first);
    const older = contiguous && more != null ? current.filter(m => m.id < first) : [];
    return { messages: [...older, ...page, ...newer], more: older.length ? undefined : more };
}

function newClientId() {
    const bytes = new Uint8Array(12);
    crypto.getRandomValues(bytes);
    return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

function readStore(key, fallback) {
    try { const raw = localStorage.getItem(key); return raw ? JSON.parse(raw) : fallback; } catch { return fallback; }
}

function writeStore(key, value) {
    try {
        if (value == null || (Array.isArray(value) && !value.length) || value === '') localStorage.removeItem(key);
        else localStorage.setItem(key, JSON.stringify(value));
    } catch { /* 隐私模式等存不了：只是刷新后不保留 */ }
}

export function useCompanion(enabled = true, owner = 'me') {
    const [state, setState] = useState({ loaded: false, messages: [], more: null, unread: 0, credits: null });
    // 正在进行的回复：{ run, segments: [{text, tools}], thinking, stopping, waiting, cut }。
    // 唯一可靠的来源是事件流：连上时先给一份快照（hello），之后的事件正好接在快照后面。
    const [live, setLive] = useState(null);
    // 还没被服务器确认的消息（发送中、排队、没发出去）。存在本机，刷新后还在。
    const outboxKey = `jst.companion.outbox.${owner}`;
    const draftKey = `jst.companion.draft.${owner}`;
    const [outbox, setOutbox] = useState(() => readStore(outboxKey, []).map(item => ({ ...item, status: item.status === 'failed' ? 'failed' : 'queued' })));
    const listeners = useRef(new Set());
    const epoch = useRef(0);   // 每次清空 +1：清空之前发出的状态请求晚回来时作废
    const streaming = useRef(false);   // 事件流已连上并收到了快照：进行中的回复以事件流为准
    const resync = useRef(() => {});

    useEffect(() => { writeStore(outboxKey, outbox.map(({ client_id, content, status, error }) => ({ client_id, content, status, error }))); }, [outbox, outboxKey]);

    const reload = useCallback(async () => {
        const asked = epoch.current;
        try {
            const data = await request('/api/assistant/state');
            if (asked !== epoch.current) return;
            setState(s => {
                const merged = s.loaded ? mergePage(s.messages, data.messages, data.more) : { messages: data.messages, more: data.more };
                return { loaded: true, messages: merged.messages, more: merged.more === undefined ? s.more : merged.more, unread: data.unread, credits: data.credits };
            });
            // 事件流还没连上（或被服务器请走了）时，先用接口里的快照顶上
            if (!streaming.current) setLive(l => fromSnapshot(data.live, l));
            // 服务器已经收下的消息不再留在待发送里
            const known = new Set(data.messages.map(m => m.meta?.client_id).filter(Boolean));
            setOutbox(items => items.some(item => known.has(item.client_id)) ? items.filter(item => !known.has(item.client_id)) : items);
        } catch { /* 下次重连再拉 */ }
    }, []);

    // 事件流每条都占服务器一个线程：页面在后台 30 秒就断开，回到前台再连；
    // 服务器让出位置（bye）时也不自动重连，等页面回到前台、获得焦点或用户发消息时再连。
    const wake = useRef(() => {});
    useEffect(() => {
        if (!enabled) return;
        reload();
        let source = null;
        let closed = false;
        let retry = null;
        let idle = null;
        let lastResync = 0;
        const disconnect = () => { source?.close(); source = null; streaming.current = false; clearTimeout(retry); };
        // 收到对不上的事件（中间漏了）：重连一次，用新的快照接上
        resync.current = () => {
            if (performance.now() - lastResync < 2000) return;
            lastResync = performance.now();
            disconnect();
            connect();
        };
        const sameRun = (l, data) => l && l.run === data.run;
        const connect = () => {
            if (closed || source) return;
            clearTimeout(retry);
            source = new EventSource(apiUrl('/api/assistant/events'), { withCredentials: true });
            const on = (name, handler) => source.addEventListener(name, event => {
                let data = {};
                try { data = JSON.parse(event.data); } catch { /* ignore */ }
                handler(data);
                for (const listener of listeners.current) listener(name, data);
            });
            on('hello', data => { streaming.current = true; setLive(l => fromSnapshot(data.live, l)); });
            on('bye', () => disconnect());
            on('run', data => {
                if (data.state === 'start') setLive({ run: data.run, segments: [EMPTY_SEGMENT()], thinking: false, stopping: false, waiting: Boolean(data.waiting), queue: data.queue ?? null, cut: 0 });
                // 服务器忙、在排队：更新「前面还有几位」
                if (data.state === 'queue') setLive(l => (l && l.run === data.run ? { ...l, queue: data.queue ?? null } : l));
                if (data.state === 'stopping') setLive(l => (sameRun(l, data) ? { ...l, stopping: true } : l));
                if (data.state === 'end') setLive(l => (!l || !data.run || l.run === data.run ? null : l));
            });
            // 流式事件只认当前这次回复；对不上说明漏了事件，重新同步
            const patch = (data, change) => setLive(l => {
                if (!sameRun(l, data)) { queueMicrotask(() => resync.current()); return l; }
                return change(l);
            });
            const editLast = (l, edit) => {
                const segments = l.segments.slice();
                segments[segments.length - 1] = edit({ ...segments.at(-1) });
                return { ...l, segments };
            };
            on('delta', data => patch(data, l => ({ ...editLast(l, last => ({ ...last, text: last.text + data.text })), thinking: false })));
            // 思考：start 开始、delta 一小批思考文字、end 结束（带这一段累计的思考时长）
            on('thinking', data => patch(data, l => {
                if (data.state === 'delta') return editLast(l, last => ({ ...last, thought: (last.thought + data.text).slice(-8000) }));
                if (data.state === 'end') return { ...editLast(l, last => ({ ...last, thought_ms: data.ms ?? last.thought_ms })), thinking: false };
                return { ...editLast(l, last => ({ ...last, thought: last.thought && !last.thought.endsWith('\n\n') ? `${last.thought}\n\n` : last.thought })), thinking: true };
            }));
            on('tool', data => patch(data, l => editLast(l, last => {
                const index = last.tools.findIndex(t => t.id === data.id);
                const tool = { id: data.id, tool: data.tool, label: data.label, status: data.status };
                return { ...last, tools: index >= 0 ? last.tools.map((t, i) => (i === index ? tool : t)) : [...last.tools, tool] };
            })));
            on('segment', data => patch(data, l => ({ ...l, segments: [...l.segments, EMPTY_SEGMENT()] })));
            // 插话：之前写出的部分已经存成消息（随后的 message 事件），进行中的回复从插话之后重新开始
            on('cut', data => patch(data, l => ({ ...l, segments: fromSnapshot(data.current)?.segments || [EMPTY_SEGMENT()], cut: l.cut + 1 })));
            on('message', data => {
                setState(s => ({ ...s, messages: upsert(s.messages, data) }));
                if (data.meta?.client_id) setOutbox(items => items.filter(item => item.client_id !== data.meta.client_id));
            });
            on('removed', data => setState(s => ({ ...s, messages: s.messages.filter(m => m.id !== data.id) })));
            on('unread', data => setState(s => ({ ...s, unread: data.count })));
            on('credits', data => setState(s => ({ ...s, credits: data })));
            on('cleared', () => { epoch.current += 1; setState(s => ({ ...s, messages: [], more: null })); setLive(null); });
            const current = source;
            source.onerror = () => {
                if (source !== current) return;
                // 断开期间的事件收不到：重连后以新的快照为准
                streaming.current = false;
                // 服务端每 10 分钟主动断一次；EventSource 自己会重连，彻底关闭时 3 秒后再连
                if (current.readyState === EventSource.CLOSED) {
                    source = null;
                    if (!document.hidden) retry = setTimeout(connect, 3000);
                }
            };
            source.onopen = () => reload();
        };
        const awake = () => {
            clearTimeout(idle);
            if (source) return;
            reload();
            connect();
        };
        const visibility = () => {
            if (document.hidden) idle = setTimeout(disconnect, 30000);
            else awake();
        };
        wake.current = awake;
        connect();
        document.addEventListener('visibilitychange', visibility);
        window.addEventListener('focus', awake);
        window.addEventListener('online', awake);
        return () => {
            closed = true;
            disconnect();
            clearTimeout(idle);
            document.removeEventListener('visibilitychange', visibility);
            window.removeEventListener('focus', awake);
            window.removeEventListener('online', awake);
        };
    }, [enabled, reload]);

    const loadingOlder = useRef(false);
    const loadOlder = useCallback(async () => {
        if (state.more == null || loadingOlder.current) return;
        loadingOlder.current = true;
        const asked = epoch.current;
        try {
            const data = await request(`/api/assistant/messages?before=${state.more}`);
            if (asked !== epoch.current) return;
            setState(s => ({ ...s, messages: data.messages.reduce(upsert, s.messages), more: data.more }));
        } finally { loadingOlder.current = false; }
    }, [state.more]);

    // ---- 发送：一条条按顺序发（同时发出去的话，后打的字可能先到）。
    // 每条带一个本机生成的编号：网络慢、超时后重发、刷新前已经发出，服务器都只收一次。
    const sendingNow = useRef(false);
    const outboxRef = useRef(outbox);
    outboxRef.current = outbox;
    const pump = useCallback(async () => {
        const items = outboxRef.current;
        if (sendingNow.current || items.some(item => item.status === 'failed')) return;   // 前面有没发出去的：先等它，保证顺序
        const next = items.find(item => item.status === 'queued');
        if (!next) return;
        sendingNow.current = true;
        setOutbox(list => list.map(item => (item.client_id === next.client_id ? { ...item, status: 'sending' } : item)));
        let failure = null;
        try {
            const data = await request('/api/assistant/messages', { method: 'POST', json: { text: next.content, client_id: next.client_id }, timeout: 45000 });
            const sent = data?.message;
            if (sent?.id) setState(s => ({ ...s, messages: upsert(s.messages, sent) }));
        } catch (error) {
            failure = error.data?.error || (error.status ? '没有发出去' : '网络不太好，没有发出去');
        } finally {
            sendingNow.current = false;
        }
        setOutbox(list => (failure
            ? list.map(item => (item.client_id === next.client_id ? { ...item, status: 'failed', error: failure } : item))
            : list.filter(item => item.client_id !== next.client_id)));
    }, []);
    useEffect(() => {
        // 刷新前没确认的消息：等第一次拉到消息列表、认出已经收下的之后，再接着发
        if (state.loaded && outbox.some(item => item.status === 'queued')) pump();
    }, [state.loaded, outbox, pump]);

    const send = useCallback(text => {
        const content = text.trim();
        if (!content) return;
        wake.current();
        setOutbox(items => [...items, { client_id: newClientId(), content, status: 'queued' }]);
    }, []);
    const retry = useCallback(clientId => {
        wake.current();
        setOutbox(items => items.map(item => (item.client_id === clientId ? { ...item, status: 'queued', error: null } : item)));
    }, []);
    const discard = useCallback(clientId => setOutbox(items => items.filter(item => item.client_id !== clientId)), []);

    const [draft, setDraftState] = useState(() => readStore(draftKey, ''));
    const setDraft = useCallback(value => { setDraftState(value); writeStore(draftKey, value); }, [draftKey]);

    return { ...state, running: Boolean(live), live, outbox, send, retry, discard, draft, setDraft, reload, loadOlder, setState, listeners,
        wake: () => wake.current() };
}

// ------------------------------------------------------------ 积分
function RollingNumber({ value }) {
    const motionValue = useMotionValue(value ?? 0);
    const text = useTransform(motionValue, v => Math.round(v).toLocaleString());
    useEffect(() => {
        if (value == null) return;
        const controls = animate(motionValue, value, { duration: .9, ease: [.3, .7, .4, 1] });
        return () => controls.stop();
    }, [value, motionValue]);
    return <motion.span>{text}</motion.span>;
}

function CreditsPill({ credits, open }) {
    if (!credits) return null;
    return <motion.button type="button" className="credits-pill glass" onClick={open} whileTap={{ scale: .94 }} transition={spring}
        aria-label={`AI 积分 ${credits.credits}`}>
        <Icon name="sparkles" /><RollingNumber value={credits.credits} />
    </motion.button>;
}

function CreditsSheet({ credits, open, onClose }) {
    if (!credits) return null;
    const expiry = credits.expiring && new Date(credits.expiring.at);
    const days = expiry ? Math.max(0, Math.ceil((expiry - Date.now()) / 86400000)) : null;
    return <Sheet open={open} onClose={onClose} title="AI 积分">
        <div className="credits-hero">
            <span className="credits-big"><RollingNumber value={credits.credits} /></span>
            <span className="credits-sub">累计获得 {Math.round(credits.total).toLocaleString()}</span>
        </div>
        {credits.expiring && <div className="banner" data-tone={days <= 3 ? 'warn' : 'info'}>
            <Icon name="clock" />
            <div><strong>{credits.expiring.amount} 分将在 {expiry.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })}到期</strong>
                <p>{days === 0 ? '今天到期' : `还有 ${days} 天`}，到期前会优先消耗这部分。</p></div>
        </div>}
        <p style={{ marginTop: 14 }}>会议助手生成摘要和小助理聊天都会消耗积分。数字会在每次使用后自动更新。</p>
    </Sheet>;
}

// ------------------------------------------------------------ 消息
function ToolLine({ tools }) {
    const [open, setOpen] = useState(false);
    if (!tools?.length) return null;
    const counts = {};
    for (const tool of tools) counts[tool.label] = (counts[tool.label] || 0) + 1;
    const summary = Object.entries(counts).slice(0, 3).map(([label, n]) => (n > 1 ? `${label} ×${n}` : label)).join(' · ');
    const running = tools.some(t => t.status === 'running');
    return <div className="tool-summary">
        <button type="button" onClick={() => setOpen(!open)} aria-expanded={open}>
            {running ? <JstLoader size={16} /> : <Icon name="checkCircle" />}
            <span>{summary}{Object.keys(counts).length > 3 ? ' …' : ''}</span>
            <Icon name="chevron" className="tool-chevron" />
        </button>
        <AnimatePresence initial={false}>
            {open && <motion.ol initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={softSpring}>
                {tools.map((tool, i) => <li key={tool.id || i} data-status={tool.status}>
                    {tool.status === 'running' ? <JstLoader size={16} /> : <Icon name={tool.status === 'error' ? 'warning' : 'check'} />}
                    {tool.label}
                </li>)}
            </motion.ol>}
        </AnimatePresence>
    </div>;
}

/* 思考流：思考时是一个上下雾化的小窗口，文字从下往上缓缓推过去；想完收成「已思考 N 秒」，点开看全文。 */
function ThoughtStream({ text, ms = 0, active = false }) {
    const [open, setOpen] = useState(false);
    const since = useRef(Date.now());
    const [now, setNow] = useState(Date.now());
    const window_ = useRef(null);
    useEffect(() => {
        if (!active) return;
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, [active]);
    useLayoutEffect(() => {
        const node = window_.current;
        if (active && node) node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
    }, [text, active]);
    if (!active && !text?.trim()) return null;
    const seconds = Math.max(1, Math.round(active ? Math.max(ms, now - since.current) / 1000 : ms / 1000));
    return <div className={`thought${active ? ' active' : ''}${open ? ' open' : ''}`}>
        <button type="button" className="thought-head" disabled={active} aria-expanded={active ? undefined : open} onClick={() => setOpen(!open)}>
            {active ? <LiquidMark size={18} energy={1} /> : <Icon name="lightbulb" />}
            <span className="thought-label">{active ? `正在思考 · ${seconds} 秒` : `已思考 ${seconds} 秒`}</span>
            {!active && <Icon name="chevron" className="thought-chevron" />}
        </button>
        <AnimatePresence initial={false}>
            {active && <motion.div key="stream" className="thought-window" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }} transition={softSpring}>
                <div ref={window_} className="thought-scroll" aria-live="off">{(text || '…').replace(/\n{2,}/g, '\n')}</div>
            </motion.div>}
            {!active && open && <motion.div key="full" className="thought-full" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }} transition={softSpring}>
                <div className="thought-full-text">{text}</div>
            </motion.div>}
        </AnimatePresence>
    </div>;
}

function Typing({ label }) {
    return <motion.div className="msg" data-mine="false" initial={{ opacity: 0, y: 10, scale: .96 }} animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, scale: .96 }} transition={softSpring}>
        <div className="bubble live"><span className="thinking"><LiquidMark size={26} energy={.9} /><span>{label}</span></span></div>
    </motion.div>;
}

/** 一条消息拆成的几个气泡：时间只写在最后一个下面。 */
function Bubbles({ chunks, mine, time, kind, label, meta, done = true, animate: fresh, onMeeting }) {
    return chunks.map((chunk, i) => {
        const last = i === chunks.length - 1;
        return <motion.div key={i} className="msg" data-mine={mine} data-kind={kind}
            initial={fresh ? { opacity: 0, y: 12, scale: .98 } : false} animate={{ opacity: 1, y: 0, scale: 1 }} transition={softSpring}>
            <div className={`bubble${kind === 'proactive' ? ' proactive' : ''}`}
                onClick={event => { const ref = event.target.closest('[data-meeting]'); if (ref) onMeeting(Number(ref.dataset.meeting)); }}>
                {label && i === 0 && <span className="bubble-tag">{label}</span>}
                {mine ? <p>{chunk}</p> : <div className="minutes chat-md" dangerouslySetInnerHTML={{ __html: chunkHtml(chunk) }} />}
            </div>
            {last && done && <span className="msg-meta">{meta}{time}</span>}
        </motion.div>;
    });
}

function proactiveLabel(message) {
    if (message.kind !== 'proactive') return null;
    return <><Icon name={message.meta?.brief ? 'sparkles' : 'clock'} />{message.meta?.brief ? '今日简报' : message.meta?.reminder_id ? '提醒' : '小助理'}</>;
}

// ------------------------------------------------------------ 页面
export function CompanionPage({ companion, openMeeting, onBack, onGrab, meetingBusy }) {
    const toast = useToast();
    const scroller = useRef(null);
    const field = useRef(null);
    const composerRef = useRef(null);
    const menuButton = useRef(null);
    const [text, setTextState] = useState(companion.draft || '');
    const setText = value => { setTextState(value); companion.setDraft(value); };   // 草稿存在本机：刷新、切走再回来都还在
    const [stopAsked, setStopAsked] = useState(null);   // 已经按过停止的那次回复：不重复发停止
    const [menu, setMenu] = useState(false);
    const [confirmClear, setConfirmClear] = useState(false);
    const [clearing, setClearing] = useState(false);
    // 输入方式：voice 按住说话（默认）| text 打字。和豆包一样点按钮切换，记住上次用的
    const [inputMode, setInputModeState] = useState(() => { try { return localStorage.getItem('jst-assistant-input') === 'text' ? 'text' : 'voice'; } catch { return 'voice'; } });
    const setInputMode = mode => {
        setInputModeState(mode);
        try { localStorage.setItem('jst-assistant-input', mode); } catch { /* 记不住也能用 */ }
        if (mode === 'text') requestAnimationFrame(() => field.current?.focus());
    };
    const voiceMode = inputMode === 'voice';
    const [creditsOpen, setCreditsOpen] = useState(false);
    const { messages, running, live, credits, unread, loaded, outbox } = companion;

    // ---- 拟人的发送节奏：由程序控制，不由模型控制
    // 回复期间：写完的段落/整句一条条发出来，每条之前「正在输入」一会儿；
    // 回复结束：保存下来的消息接着把剩下的发完；历史消息直接显示。
    const seen = useRef(null);              // 页面打开时已有的消息，不做动画
    const [revealed, setRevealed] = useState({});   // messageId -> 已显示的气泡数
    const [liveShown, setLiveShown] = useState([]); // 进行中回复：每段已显示的气泡数
    const liveShownRef = useRef([]);
    liveShownRef.current = liveShown;
    if (loaded && seen.current === null) seen.current = new Set(messages.map(m => m.id));

    useEffect(() => {
        if (!seen.current) return;
        const fresh = messages.filter(m => m.role === 'assistant' && !seen.current.has(m.id) && revealed[m.id] === undefined);
        if (!fresh.length) return;
        const carried = [...liveShownRef.current];
        setRevealed(r => {
            const next = { ...r };
            for (const m of fresh) next[m.id] = m.kind === 'chat' ? (carried.shift() ?? 0) : 0;
            return next;
        });
        for (const m of messages) if (m.role === 'user') seen.current.add(m.id);
    }, [messages, revealed]);

    // 进行中回复换了一次（新的回复、刷新后接上、进入页面时已经在回复）：已经写完的部分直接显示，不重新「打字」；
    // 同一次回复里插了话：之前的部分已经存成消息（上面接手了显示进度），从头计数。
    const liveKey = live ? `${live.run}:${live.cut}` : '';
    const liveKeyRef = useRef(null);
    useEffect(() => {
        if (liveKey === liveKeyRef.current) return;
        const previous = liveKeyRef.current;
        liveKeyRef.current = liveKey;
        if (!live) setLiveShown([]);
        else if (previous && previous.startsWith(`${live.run}:`)) setLiveShown([]);
        else setLiveShown(live.segments.map(segment => completedChunks(segment.text).length));
    }, [liveKey]); // eslint-disable-line react-hooks/exhaustive-deps
    useEffect(() => {
        const listener = name => { if (name === 'cleared') { seen.current = new Set(); setRevealed({}); setLiveShown([]); } };
        companion.listeners.current.add(listener);
        return () => companion.listeners.current.delete(listener);
    }, [companion.listeners]);

    // 推进一步：按页面上的先后，先发已保存消息里剩下的（插话前写出的部分），再发进行中回复里写完的
    const pending = (() => {
        for (const m of messages) {
            const count = revealed[m.id];
            if (count === undefined) continue;
            const chunks = splitReply(m.content);
            if (count < chunks.length) return { kind: 'msg', id: m.id, chunk: chunks[count] };
        }
        if (live) {
            for (let i = 0; i < live.segments.length; i++) {
                const done = completedChunks(live.segments[i].text);
                if ((liveShown[i] || 0) < done.length) return { kind: 'live', index: i, chunk: done[liveShown[i] || 0] };
            }
        }
        return null;
    })();
    const typing = Boolean(pending) || Boolean(live);
    const pendingKey = pending && (pending.kind === 'live' ? `l${pending.index}-${liveShown[pending.index] || 0}` : `m${pending.id}-${revealed[pending.id]}`);
    useEffect(() => {
        if (!pending) return;
        const timer = setTimeout(() => {
            if (pending.kind === 'live') setLiveShown(s => { const n = [...s]; n[pending.index] = (n[pending.index] || 0) + 1; return n; });
            else setRevealed(r => ({ ...r, [pending.id]: (r[pending.id] || 0) + 1 }));
        }, typingDelay(pending.chunk));
        return () => clearTimeout(timer);
    }, [pendingKey]); // eslint-disable-line react-hooks/exhaustive-deps

    // 打开页面即算已读
    useEffect(() => {
        if (unread > 0 && !document.hidden) request('/api/assistant/read', { method: 'POST', json: {} }).catch(() => {});
    }, [unread]);

    // 贴底：用户自己往上翻就不再自动滚动，回到底部附近又恢复。
    // 判断放在 scroll 事件里（手指拖动、惯性滑动、滚轮、键盘都会触发）；
    // 只看触摸开始的位置不行：手指一抬起，惯性滑出去很远，却还以为自己在底部，之后任何刷新都会被拽回底部。
    // 我们自己发起的滚动（平滑滚到底）期间的 scroll 事件不算用户操作。
    const stick = useRef(true);
    const autoUntil = useRef(0);
    const placed = useRef(false);
    const instantUntil = useRef(0);     // 刚发出消息的这段时间：自己的气泡和「正在输入」立刻到位，不做平滑滚动
    const toBottom = useCallback(smooth => {
        const node = scroller.current;
        if (!node) return;
        const distance = node.scrollHeight - node.scrollTop - node.clientHeight;
        if (distance <= 0) return;
        // 太远的直接到位：平滑滚动要几百毫秒，期间的滚动事件会被误当成用户在往上翻。
        // 自己刚发出去的消息也直接到位：平滑滚动追上之前，新气泡会先被输入框盖住一会儿
        const animate = smooth && distance <= 900 && performance.now() > instantUntil.current;
        autoUntil.current = performance.now() + (animate ? 900 : 150);
        if (animate) node.scrollTo({ top: node.scrollHeight, behavior: 'smooth' });
        else node.scrollTop = node.scrollHeight;
    }, []);
    useEffect(() => {
        const node = scroller.current;
        const near = () => node.scrollHeight - node.scrollTop - node.clientHeight < 80;
        const onScroll = () => { if (performance.now() >= autoUntil.current) stick.current = near(); };
        const onUser = () => { autoUntil.current = 0; };   // 手指碰到屏幕、滚轮：马上交还给用户
        node.addEventListener('scroll', onScroll, { passive: true });
        node.addEventListener('touchstart', onUser, { passive: true });
        node.addEventListener('wheel', onUser, { passive: true });
        return () => {
            node.removeEventListener('scroll', onScroll);
            node.removeEventListener('touchstart', onUser);
            node.removeEventListener('wheel', onUser);
        };
    }, []);

    // 输入框占多高（多行输入会变高，手机键盘弹出会整体上移）：列表底部留出同样的空间，
    // 滚到底时最后一个气泡不会被输入框盖住。
    useLayoutEffect(() => {
        const node = scroller.current;
        const form = composerRef.current;
        if (!node || !form) return undefined;
        const measure = () => {
            const space = node.getBoundingClientRect().bottom - form.getBoundingClientRect().top;
            node.style.setProperty('--composer-space', `${Math.max(0, Math.ceil(space))}px`);
            // 输入框变高/变矮：同一帧里马上调整滚动位置，最后一个气泡不会有一帧被盖住
            if (placed.current && stick.current) toBottom(false);
        };
        measure();
        if (typeof ResizeObserver === 'undefined') return undefined;
        const observer = new ResizeObserver(measure);
        observer.observe(form);
        observer.observe(node);
        window.visualViewport?.addEventListener('resize', measure);
        return () => { observer.disconnect(); window.visualViewport?.removeEventListener('resize', measure); };
    }, [toBottom]);

    // 内容变高（来了新气泡、出现「正在输入」、输入框变高）或可视区变化（键盘弹出）时，
    // 只要用户停在底部，就跟着滚到底。这是兜底：不管是什么让它变高的，都不会再被盖住。
    useEffect(() => {
        const node = scroller.current;
        const content = node?.firstElementChild;
        if (!node || !content || typeof ResizeObserver === 'undefined') return undefined;
        let contentHeight = content.offsetHeight;
        let viewHeight = node.clientHeight;
        const observer = new ResizeObserver(() => {
            const nextContent = content.offsetHeight;
            const nextView = node.clientHeight;
            const viewChanged = nextView !== viewHeight;
            const grew = nextContent > contentHeight;
            contentHeight = nextContent;
            viewHeight = nextView;
            if (!placed.current || !stick.current) return;
            if (viewChanged) toBottom(false);        // 键盘弹出/收起：马上到位，跟着键盘一起动
            else if (grew) toBottom(true);           // 新气泡：平滑滚过去
        });
        // 观察 border-box：输入框变高时只有列表的内边距在变，默认观察的内容盒子尺寸不变，就不会触发
        observer.observe(content, { box: 'border-box' });
        observer.observe(node);
        return () => observer.disconnect();
    }, [toBottom]);

    // 进入页面：直接停在最底部（没有从顶部滚下来的动画）；之后来了新消息再平滑滚动
    useLayoutEffect(() => {
        if (!scroller.current || !stick.current) return;
        if (!placed.current) {
            if (!loaded) return;
            toBottom(false);
            // 字体、排版在下一帧可能还会把内容撑高一点：再对齐一次
            requestAnimationFrame(() => { if (stick.current) toBottom(false); placed.current = true; });
            return;
        }
        toBottom(true);
    }, [messages.length, revealed, liveShown, loaded, typing, outbox.length, toBottom]);

    const resize = () => {
        const node = field.current;
        if (!node) return;
        node.style.height = 'auto';
        node.style.height = `${Math.min(node.scrollHeight, 132)}px`;
    };

    // 发送：马上显示在列表里并清空输入框，由 useCompanion 按顺序发出；连点、狂按回车也只会一条条发
    function send(value = text) {
        const content = value.trim();
        if (!content) return;
        if (content.length > 4000) { toast('一条消息最多 4000 字', 'bad'); return; }
        stick.current = true;        // 发出去就跟着最新的消息走（哪怕之前在往上翻）
        instantUntil.current = performance.now() + 1500;
        companion.send(content);
        if (value === text) { setText(''); requestAnimationFrame(resize); }
    }

    // 没发出去的消息「编辑」：从列表里撤下，文字放回输入框
    function edit(item) {
        companion.discard(item.client_id);
        setInputMode('text');   // 文字放回输入框：语音模式下输入框是藏起来的
        setText(text.trim() ? `${text}\n${item.content}` : item.content);
        requestAnimationFrame(() => { resize(); field.current?.focus(); });
    }

    // 回复结束就忘掉「按过停止」：排队状态每次都叫 queued，不清掉下次排队时停止按钮会一直是灰的
    useEffect(() => { if (!live) setStopAsked(null); }, [live]);
    const stopping = Boolean(live?.stopping) || Boolean(live && stopAsked === live.run);
    async function stop() {
        if (!live || stopping) return;
        setStopAsked(live.run);
        try { await request('/api/assistant/stop', { method: 'POST', json: {} }); } catch { setStopAsked(null); toast('没能停止', 'bad'); }
    }

    async function clear() {
        if (clearing) return;
        setClearing(true);
        try {
            await request('/api/assistant/clear', { method: 'POST', json: {} });
            setConfirmClear(false);
            setRevealed({});
            toast('对话已清空，长期记忆还在');
        } catch (error) { toast(error.data?.error || '没能清空', 'bad'); }
        finally { setClearing(false); }
    }

    // ---- 组装时间线
    const items = [];
    let lastDay = null;
    for (const message of messages) {
        const day = dayLabel(message.created_at);
        if (day !== lastDay) { items.push(<div className="day-sep" key={`d-${message.id}`}><span>{day}</span></div>); lastDay = day; }
        const time = timeFormat.format(new Date(message.created_at));
        if (message.role === 'user') {
            items.push(<Bubbles key={message.meta?.client_id || message.id} chunks={[message.content]} mine time={time} kind={message.kind}
                meta={message.kind === 'steer' ? '插话 · ' : ''} animate={!seen.current?.has(message.id)} onMeeting={openMeeting} />);
            continue;
        }
        const chunks = splitReply(message.content);
        const shown = revealed[message.id] ?? chunks.length;
        if (shown === 0) continue;
        items.push(<div className="msg-group" key={message.id}>
            <ThoughtStream text={message.meta?.thought?.text} ms={(message.meta?.thought?.seconds || 0) * 1000} />
            <ToolLine tools={message.meta?.tools} />
            <Bubbles chunks={chunks.slice(0, shown)} mine={false} time={time} kind={message.kind} label={proactiveLabel(message)}
                meta={message.meta?.stopped ? '已停止 · ' : ''} done={shown >= chunks.length}
                animate={revealed[message.id] !== undefined} onMeeting={openMeeting} />
        </div>);
    }
    if (live) {
        live.segments.forEach((segment, i) => {
            const done = completedChunks(segment.text);
            const count = Math.min(liveShown[i] || 0, done.length);
            const thinkingNow = live.thinking && i === live.segments.length - 1;
            if (!count && !segment.tools.length && !segment.thought && !thinkingNow) return;
            items.push(<div className="msg-group" key={`live-${i}`}>
                <ThoughtStream text={segment.thought} ms={segment.thought_ms} active={thinkingNow} />
                <ToolLine tools={segment.tools} />
                {count > 0 && <Bubbles chunks={done.slice(0, count)} mine={false} done={false} animate onMeeting={openMeeting} />}
            </div>);
        });
    }
    // 还没被服务器确认的消息：排在最后（发送中、等待发送；没发出去的可以重发或改了再发）
    for (const item of outbox) {
        const failed = item.status === 'failed';
        items.push(<div className="msg-group outbox" key={item.client_id} data-status={item.status}>
            <Bubbles chunks={[item.content]} mine animate onMeeting={openMeeting} done={!failed}
                meta={item.status === 'queued' ? '等待发送' : item.status === 'sending' ? '发送中…' : ''} time="" />
            {failed && <div className="outbox-failed">
                <span><Icon name="warning" />{item.error || '没有发出去'}</span>
                <button type="button" onClick={() => companion.retry(item.client_id)}>重发</button>
                <button type="button" onClick={() => edit(item)}>编辑</button>
            </div>}
        </div>);
    }
    const toolBusy = live?.segments.some(seg => seg.tools.some(t => t.status === 'running'));

    return <div className="companion">
        {/* 抽屉顶部：按住往下拖可以收起（只认这一条，聊天区上下滑照常滚动） */}
        <header className="companion-head glass glass-strong" onPointerDown={event => { if (onGrab && !event.target.closest('button')) onGrab(event); }}>
            {onGrab && <span className="drawer-grabber" aria-hidden="true" />}
            <div className="companion-title">
                <NavButton icon="back" label="返回" onClick={onBack} />
                <LiquidMark size={34} energy={running ? .9 : .3} />
                <div><strong>小助理</strong><small>{stopping ? '正在停止…' : running || pending ? '正在回复…' : '记得你所有的会'}</small></div>
            </div>
            <div className="companion-actions">
                <CreditsPill credits={credits} open={() => setCreditsOpen(true)} />
                <NavButton icon="more" label="更多" ref={menuButton} onClick={() => setMenu(true)} />
            </div>
            <Menu anchor={menuButton} open={menu} onClose={() => setMenu(false)} label="小助理">
                <MenuItem icon="trash" destructive disabled={!messages.length || running || outbox.some(item => item.status !== 'failed')} onSelect={() => { setMenu(false); setConfirmClear(true); }}>清空对话</MenuItem>
            </Menu>
        </header>

        <div className="companion-scroll" ref={scroller}>
            <div className="companion-list">
                {companion.more != null && <button type="button" className="btn btn-gray btn-small older" onClick={companion.loadOlder}>更早的消息</button>}
                {loaded && !messages.length && !live && !outbox.length && <motion.div className="companion-empty" initial={{ opacity: 0, y: 12 }} animate={{ opacity: 1, y: 0 }} transition={softSpring}>
                    <LiquidMark size={96} energy={.4} />
                    <strong>有什么要我帮忙的？</strong>
                    <p>我能查你所有会议的结论、待办和原话，帮你记住习惯，到点提醒你。</p>
                    <div className="suggestions">
                        {SUGGESTIONS.map(item => <motion.button key={item} type="button" whileTap={{ scale: .96 }} onClick={() => send(item)}>{item}</motion.button>)}
                    </div>
                </motion.div>}
                {items}
                <AnimatePresence>{typing && !live?.thinking && <Typing key="typing" label={live?.queue != null ? (live.queue > 0 ? `排队中，前面还有 ${live.queue} 位` : '排队中，马上开始') : toolBusy ? '查资料中' : '正在输入'} />}</AnimatePresence>
            </div>
        </div>

        <form ref={composerRef} className={`composer glass glass-strong${voiceMode ? ' voice-mode' : ''}`} onSubmit={event => { event.preventDefault(); send(); }}>
            {voiceMode
                ? <HoldToTalk blockedReason={meetingBusy ? '正在开会录音，麦克风被占用，会议结束后再用语音输入。' : ''}
                    onError={message => toast(message, 'bad')}
                    onText={spoken => send(spoken)} />
                : <textarea ref={field} rows={1} value={text} placeholder="问问小助理…"
                    onChange={event => { setText(event.target.value); resize(); }}
                    onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); send(); } }} />}
            <AnimatePresence mode="popLayout" initial={false}>
                {running && (!live.waiting || live.queue != null) && (voiceMode || !text.trim())
                    && <motion.button key="stop" type="button" className="composer-btn stop" aria-label={stopping ? '正在停止' : '停止'} onClick={stop} disabled={stopping}
                        initial={{ scale: .5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: .5, opacity: 0 }} transition={spring}>
                        <Icon name="stop" /></motion.button>}
                {!voiceMode && text.trim()
                    ? <motion.button key="send" type="submit" className="composer-btn" aria-label="发送"
                        initial={{ scale: .5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: .5, opacity: 0 }} transition={spring}>
                        <Icon name="up" /></motion.button>
                    : <motion.button key={voiceMode ? 'keyboard' : 'voice'} type="button" className="composer-btn mode"
                        aria-label={voiceMode ? '切换到键盘输入' : '切换到语音输入'} onClick={() => setInputMode(voiceMode ? 'text' : 'voice')}
                        initial={{ scale: .5, opacity: 0 }} animate={{ scale: 1, opacity: 1 }} exit={{ scale: .5, opacity: 0 }} transition={spring}>
                        <Icon name={voiceMode ? 'keyboard' : 'voice'} /></motion.button>}
            </AnimatePresence>
        </form>

        <CreditsSheet credits={credits} open={creditsOpen} onClose={() => setCreditsOpen(false)} />
        <Sheet open={confirmClear} onClose={() => setConfirmClear(false)} busy={clearing} title="清空对话？"
            actions={[<button key="c" className="btn btn-gray" type="button" disabled={clearing} onClick={() => setConfirmClear(false)}>取消</button>,
                <button key="d" className="btn btn-danger" type="button" disabled={clearing} onClick={clear}>
                    {clearing ? <><JstLoader size={18} tone="current" />正在清空…</> : '清空'}</button>]}>
            <p>聊天记录会被清空。长期记忆和提醒不受影响，小助理仍然记得你的习惯。</p>
        </Sheet>
    </div>;
}
