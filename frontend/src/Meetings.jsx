import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, LayoutGroup, MotionConfig, animate, motion, useDragControls, useMotionValue, useTransform } from 'motion/react';
import {
    Banner, Icon, NavBar, NavButton, Sheet, ToastProvider, clockText, dateText, dayLabel, pushSpring, softSpring, spring,
    timeFormat, useToast,
} from './ui.jsx';
import { MeetingDetail, labels, processing } from './MeetingDetail.jsx';
import { MemoryPage } from './Memory.jsx';
import { SettingsPage } from './Settings.jsx';
import { CompanionPage, useCompanion } from './Companion.jsx';
import { useMeetings } from './useMeetings.js';
import { apiUrl, request } from './recording/api.js';
import { MeetingCapture } from './recording/register-capture.js';
import { MicrophoneMeter, meterLabels } from './recording/mic-meter.js';

const busyPhases = new Set(['opening', 'recording', 'paused', 'saving']);
export const inProgress = phase => busyPhases.has(phase) || ['restoring', 'retry', 'recover'].includes(phase);
const liveLabels = { starting: '等待收音', receiving: '正在接收录音', paused: '暂未收到录音', ending: '正在结束' };
const actions = {
    idle: '开始会议', opening: '正在打开麦克风…', recording: '结束', paused: '继续录音',
    remote: '查看当前会议', saving: '正在保存…', retry: '重试保存', restoring: '正在连接…',
    recover: '重新连接', other: '检查当前会议',
};
const meetingApp = /JstMeetingApp\//.test(navigator.userAgent);
const inAppBrowser = /MicroMessenger|wxwork|DingTalk|AliApp|Lark|Feishu|\bQQ\/|Weibo/i.test(navigator.userAgent);
const phaseTone = { failed: 'bad', too_short: 'warn', no_minutes: 'warn', asr_pending: 'warn', no_speech: 'warn' };
const wide = () => window.matchMedia('(min-width: 1000px)').matches;

// ------------------------------------------------------------ 路由：#meeting-12 / #memory / #settings
function readRoute() {
    const hash = location.hash;
    const meeting = /^#meeting-(\d+)$/.exec(hash);
    if (meeting) return { tab: 'meetings', detail: Number(meeting[1]) };
    if (hash === '#memory') return { tab: 'memory', detail: null };
    if (hash === '#memory-history') return { tab: 'memory', detail: null, sub: 'history' };
    if (hash === '#settings') return { tab: 'settings', detail: null };
    if (hash === '#assistant') return { tab: 'assistant', detail: null };
    return { tab: 'meetings', detail: null };
}

// 页面是旧版本（服务器已经更新，而这个页面是之前打开的）：回到前台时问一下服务器，发现了就提醒刷新。
// 只提醒，不自动刷新：录音、保存期间更是连提醒都不出现。
function useStaleBuild(config) {
    const [stale, setStale] = useState(false);
    useEffect(() => {
        if (!config.build) return undefined;
        let alive = true;
        const check = async () => {
            if (document.hidden) return;
            try {
                const response = await fetch(apiUrl('/api/meeting-build'), { cache: 'no-store', credentials: 'same-origin' });
                const data = response.ok ? await response.json() : null;
                if (alive && data?.build) setStale(data.build !== config.build);
            } catch { /* 网络不好时下次再问 */ }
        };
        const timer = setInterval(check, 5 * 60 * 1000);
        document.addEventListener('visibilitychange', check);
        window.addEventListener('focus', check);
        window.addEventListener('online', check);
        return () => {
            alive = false;
            clearInterval(timer);
            document.removeEventListener('visibilitychange', check);
            window.removeEventListener('focus', check);
            window.removeEventListener('online', check);
        };
    }, [config.build]);
    return stale;
}

// ------------------------------------------------------------ 录音控件（常驻：安卓壳监视 #meeting-control）
function RecordingDock({ mode, startedAt, notice, meter, action, disabled, low }) {
    const [now, setNow] = useState(Date.now);
    const live = ['recording', 'paused'].includes(mode);
    useEffect(() => {
        if (!live) return;
        const update = () => setNow(Date.now());
        update();
        const timer = setInterval(update, 1000);
        document.addEventListener('visibilitychange', update);
        return () => { clearInterval(timer); document.removeEventListener('visibilitychange', update); };
    }, [live]);
    const clock = startedAt ? clockText((Math.max(now, startedAt) - startedAt) / 1000) : '00:00';
    useEffect(() => {
        // 老版 APK 通过稳定的 DOM ID 观察录音状态；若它的观察器先于 React
        // 挂载就已运行，经同一个桥接主动报告一次。
        if (!window.__jstApp) {
            try { window.JstApp?.postMessage(`${mode}|${startedAt ? clockText((Date.now() - startedAt) / 1000) : ''}`); } catch { /* 仅浏览器 */ }
        }
    }, [mode, startedAt]);
    const tip = inAppBrowser && ['idle', 'opening', 'recording', 'paused'].includes(mode)
        ? '当前在微信、钉钉等 App 里打开，锁屏或切走时更容易停止收音。建议用浏览器打开。'
        : live ? (meetingApp ? '录音可在后台继续。' : '录音时请保持本页亮屏，不要锁屏或切到其他 App。') : '';
    return <div className="dock" data-place={low ? 'low' : undefined}>
        <motion.div layout className="dock-card glass" transition={softSpring} style={{ borderRadius: 30 }}>
            <motion.div layout="position" id="meeting-control" className="meeting-control" data-phase={mode}>
                <AnimatePresence mode="popLayout" initial={false}>
                    {live && <motion.div key="live" className="record-live" initial={{ opacity: 0, x: -12 }} animate={{ opacity: 1, x: 0 }}
                        exit={{ opacity: 0, x: -12 }} transition={softSpring}>
                        <span className="rec-dot" aria-hidden="true" />
                        <span id="meeting-clock" className="meeting-clock" role="timer" aria-label="会议用时">{clock}</span>
                        {mode === 'recording' ? <span className="meter" data-state={meter.state} style={{ '--meter-level': meter.level }}>
                            <span className="meter-wave" aria-hidden="true">{Array.from({ length: 7 }, (_, i) => <i key={i} />)}</span>
                            <span className="meter-label" role="status">{meterLabels[meter.state]}</span>
                        </span> : <span className="meter"><span className="meter-label">收音已暂停</span></span>}
                    </motion.div>}
                </AnimatePresence>
                {!live && <span id="meeting-clock" hidden>{clock}</span>}
                <motion.button layout id="meeting-action" className="meeting-action" type="button" disabled={disabled} onClick={action}
                    whileTap={{ scale: .95 }} transition={softSpring}>
                    {mode === 'recording' ? <Icon name="stop" /> : ['idle', 'paused'].includes(mode) ? <Icon name="mic" />
                        : ['saving', 'opening', 'restoring'].includes(mode) ? <span className="spinner" aria-hidden="true" /> : null}
                    {actions[mode]}
                </motion.button>
            </motion.div>
            <AnimatePresence initial={false}>
                {(notice.text || tip) && <motion.p key={notice.text || tip} className="dock-note" data-tone={notice.text ? notice.tone : (inAppBrowser ? 'warn' : undefined)}
                    initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                    transition={softSpring} role="status">{notice.text || tip}</motion.p>}
            </AnimatePresence>
        </motion.div>
    </div>;
}

// ------------------------------------------------------------ 会议列表
function SwipeRow({ children, onDelete, enabled, label }) {
    const x = useMotionValue(0);
    const actionOpacity = useTransform(x, [-96, -30, 0], [1, .4, 0]);
    if (!enabled) return children(null);
    const settle = (_e, info) => {
        const open = info.offset.x < -60 || info.velocity.x < -500;
        animate(x, open ? -96 : 0, spring);
    };
    return <div className="swipe">
        <motion.button type="button" className="swipe-action" style={{ opacity: actionOpacity }} aria-label={label}
            onClick={() => { animate(x, 0, spring); onDelete(); }}>
            <span style={{ display: 'grid', justifyItems: 'center', gap: 2 }}><Icon name="trash" />删除</span>
        </motion.button>
        {children({ drag: 'x', style: { x }, dragConstraints: { left: -96, right: 0 }, dragElastic: { left: .2, right: 0 },
            dragDirectionLock: true, onDragEnd: settle })}
    </div>;
}

function MeetingRows({ cards, current, openDetail, canDelete, deleteLocked, openDelete }) {
    const groups = useMemo(() => {
        const out = [];
        for (const card of cards) {
            const label = dayLabel(card.date);
            if (out.at(-1)?.label !== label) out.push({ label, cards: [] });
            out.at(-1).cards.push(card);
        }
        return out;
    }, [cards]);
    return groups.map(group => <section className="section" key={group.label} aria-label={group.label}>
        <h2 className="section-label">{group.label}</h2>
        <ul className="group list" role="list">
            <AnimatePresence initial={false}>
                {group.cards.map(card => <motion.li key={card.id} layout initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, height: 0 }} transition={softSpring}>
                    <SwipeRow enabled={canDelete && !processing.has(card.phase) && !deleteLocked && Boolean(card.deletion_identity)}
                        label={`删除：${card.title}`} onDelete={() => openDelete(card)}>
                        {dragProps => <motion.button type="button" className="row" data-recording-id={card.id}
                            aria-current={current === card.id || undefined} onClick={() => openDetail(card.id)} {...(dragProps || {})}>
                            <span className="row-icon" style={{ background: processing.has(card.phase) ? 'var(--tint)' : card.phase === 'failed' ? 'var(--red)' : '#5e5ce6' }}>
                                <Icon name={processing.has(card.phase) ? 'sparkles' : 'waveform'} />
                            </span>
                            <span className="row-main">
                                <span className="row-title">{card.title}</span>
                                <span className="row-sub">
                                    {card.date && <time dateTime={card.date}>{timeFormat.format(new Date(card.date))}</time>}
                                    {card.phase !== 'ready' && <span className="chip" data-tone={processing.has(card.phase) ? 'busy' : phaseTone[card.phase]}>
                                        {processing.has(card.phase) && <span className="dot" />}{labels[card.phase] || '状态待更新'}
                                    </span>}
                                </span>
                            </span>
                            <Icon name="chevron" className="chevron" />
                        </motion.button>}
                    </SwipeRow>
                </motion.li>)}
            </AnimatePresence>
        </ul>
    </section>);
}

function MeetingsHome({ library, loginUrl, current, openLive, openDetail, openDelete, optimisticEnd, deleteLocked, scrollRoot, localSession }) {
    const { data, load, loading } = library;
    // 本机正在录的那场由底部录音控件显示，这里只列其他设备上的会议
    const others = data.live.filter(row => row.id !== localSession);
    return <div className="page">
        <NavBar title="会议" scrollRoot={scrollRoot} />
        <div className="content">
            <AnimatePresence initial={false}>
                {others.length > 0 && <motion.section key="live" className="section" aria-label="进行中的会议"
                    initial={{ opacity: 0, scale: .96 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .96 }} transition={softSpring}>
                    {others.map(row => {
                        const phase = optimisticEnd === row.id ? 'ending' : row.phase;
                        return <motion.button key={row.id} type="button" className="live-card" onClick={() => openLive(row.id)} whileTap={{ scale: .98 }}>
                            <span className="pulse"><Icon name="mic" /></span>
                            <span className="row-main">
                                <span className="row-title">进行中的会议</span>
                                <span className="row-sub">{dateText(row.started_at, true)} · {liveLabels[phase] || '状态待更新'}</span>
                            </span>
                            <Icon name="chevron" className="chevron" />
                        </motion.button>;
                    })}
                </motion.section>}
            </AnimatePresence>
            {data.error === 'login' ? <div className="empty"><Icon name="person" /><strong>登录已失效</strong><p><a href={loginUrl}>重新登录</a>后查看会议。</p></div>
                : data.error === 'network' && !data.cards.length ? <div className="empty"><Icon name="warning" /><strong>无法加载会议</strong><p>请检查网络。</p>
                    <button className="btn btn-gray btn-small" type="button" id="list-refresh" disabled={loading} onClick={() => load()}>重新加载</button></div>
                : !data.loaded ? <div className="center"><span className="spinner" aria-label="正在加载" /></div>
                : !data.cards.length && !others.length ? <div className="empty"><Icon name="waveform" /><strong>还没有会议</strong><p>点下方「开始会议」录音，结束后会自动整理出会议摘要和注意事项。</p></div>
                : <LayoutGroup>
                    <MeetingRows cards={data.cards} current={current} openDetail={openDetail} canDelete={data.canDelete}
                        deleteLocked={deleteLocked} openDelete={openDelete} />
                </LayoutGroup>}
            {data.error === 'network' && data.cards.length > 0 && <div className="section"><Banner tone="warn">网络不稳定，列表可能不是最新的。</Banner></div>}
            {data.more != null && <div className="section" style={{ display: 'grid' }}>
                <button className="btn btn-gray" type="button" disabled={loading} onClick={() => load(true)}>更早的会议</button>
            </div>}
        </div>
    </div>;
}

// ------------------------------------------------------------ 标签栏
const tabs = [
    { key: 'assistant', label: '小助理', icon: 'sparkles', hash: '#assistant' },
    { key: 'meetings', label: '会议', icon: 'waveform', hash: '' },
    { key: 'memory', label: '记忆', icon: 'brain', hash: '#memory' },
    { key: 'settings', label: '设置', icon: 'gear', hash: '#settings' },
];

function TabBar({ tab, select, badges = {} }) {
    return <nav className="tabbar-wrap" aria-label="主导航">
        <div className="tabbar glass" role="tablist">
            {tabs.map(item => <motion.button key={item.key} type="button" role="tab" className="tab" aria-selected={tab === item.key}
                onClick={() => select(item)} whileTap={{ scale: .9 }} transition={spring}>
                {tab === item.key && <motion.span layoutId="tab-pill" className="tab-pill" transition={spring} />}
                <span className="tab-icon"><Icon name={item.icon} />
                    <AnimatePresence>{badges[item.key] > 0 && <motion.i className="tab-badge" key="b" initial={{ scale: 0 }} animate={{ scale: 1 }} exit={{ scale: 0 }} transition={spring} />}</AnimatePresence>
                </span>
                <span>{item.label}</span>
            </motion.button>)}
        </div>
    </nav>;
}

// ------------------------------------------------------------ 主界面
function Workspace({ config }) {
    const toast = useToast();
    const capture = useRef(null);
    const [record, setRecord] = useState({ mode: 'restoring' });
    const [meter, setMeter] = useState({ state: 'checking', level: 0 });
    const [notice, setNotice] = useState({});
    const [route, setRoute] = useState(() => {
        const initial = readRoute();
        return initial.detail == null && config.recordingId ? { tab: 'meetings', detail: config.recordingId } : initial;
    });
    const [split, setSplit] = useState(wide);
    const [liveId, setLiveId] = useState(null);
    const [optimisticEnd, setOptimisticEnd] = useState(null);
    const [ending, setEnding] = useState(false);
    const [liveError, setLiveError] = useState('');
    const [deleteTarget, setDeleteTarget] = useState(null);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState('');
    const detailScroll = useRef(null);
    const edgeDrag = useDragControls();
    const companion = useCompanion(true, config.owner);
    // 小助理是全屏聊天页（像 Telegram 的对话）：返回时回到进来之前的标签
    const lastTab = useRef('meetings');
    useEffect(() => { if (route.tab !== 'assistant' && route.origin !== 'assistant') lastTab.current = route.tab; }, [route.tab, route.origin]);
    const { mode, startedAt } = record;
    const notify = useCallback((text, tone = 'good') => setNotice(text ? { text, tone } : {}), []);
    const onLive = useCallback(rows => capture.current?.syncLive(rows), []);
    const showingList = route.tab === 'meetings' && (split || !route.detail);
    const library = useMeetings(showingList, onLive, busyPhases.has(mode));
    const { data, load, remove } = library;
    const remote = ['idle', 'other'].includes(mode) && data.live.length > 0;
    const active = data.live.find(row => row.id === liveId);
    const isEnding = active && (active.phase === 'ending' || optimisticEnd === active.id);
    const actionsLocked = inProgress(mode) || Boolean(deleteTarget) || Boolean(liveId);
    const stale = useStaleBuild(config);

    useEffect(() => {
        const media = window.matchMedia('(min-width: 1000px)');
        const update = () => setSplit(media.matches);
        media.addEventListener('change', update);
        return () => media.removeEventListener('change', update);
    }, []);

    useEffect(() => {
        const recorder = new MeetingCapture({ owner: config.owner, meter: new MicrophoneMeter(setMeter),
            update: (phase, since) => setRecord({ mode: phase, startedAt: since }),
            complete: async (id, interrupted, automatic) => {
                const next = await load();
                if (!interrupted && !automatic && !document.hidden && id) {
                    if (next.cards.some(card => card.id === id)) toast('会议已保存，正在整理');
                    else notify('会议已保存，列表暂未更新。', 'warn');
                }
            }, notice: notify });
        capture.current = recorder;
        recorder.restore();
        return () => { recorder.detach(); capture.current = null; };
    }, [config.owner, load, notify, toast]);

    useEffect(() => {
        if (['recording', 'paused', 'saving', 'idle'].includes(mode) && showingList && !document.hidden) load();
    }, [showingList, load, mode]);

    useEffect(() => {
        if (optimisticEnd && !data.live.some(item => item.id === optimisticEnd)) setOptimisticEnd(null);
    }, [data.live, optimisticEnd]);

    useEffect(() => {
        const navigate = () => {
            const next = readRoute();
            if (next.detail && inProgress(capture.current?.mode)) return;
            // 从小助理里点开的会议：盖在小助理上面（历史记录里带着来源）
            if (next.detail && history.state?.origin) next.origin = history.state.origin;
            setRoute(next);
        };
        window.addEventListener('popstate', navigate);
        window.addEventListener('hashchange', navigate);
        return () => { window.removeEventListener('popstate', navigate); window.removeEventListener('hashchange', navigate); };
    }, []);

    function go(hash, next, replace = false) {
        const url = hash || config.homeUrl;
        if (replace) history.replaceState(next, '', url); else history.pushState(next, '', url);
        setRoute(next);
    }

    function openDetail(id) {
        if (inProgress(capture.current?.mode) || deleting) {
            notify('请先结束并保存当前会议，再查看其他记录。', 'warn');
            return;
        }
        const next = { tab: 'meetings', detail: id };
        go(`#meeting-${id}`, next, split && Boolean(route.detail));
    }

    function back() {
        if (history.state?.detail === route.detail && history.length > 1) history.back();
        else go('', { tab: 'meetings', detail: null }, true);
    }

    function selectTab(item) {
        if (item.key === route.tab && !route.detail && !route.sub) {
            window.scrollTo({ top: 0, behavior: 'smooth' });
            return;
        }
        go(item.hash, { tab: item.key, detail: null }, true);
        window.scrollTo(0, 0);
    }

    function openLive(id) { setLiveError(''); setLiveId(id); }
    async function endLive() {
        if (!active || ending || isEnding) return;
        setEnding(true);
        setLiveError('');
        try {
            const recorder = capture.current;
            if (recorder?.session?.id === liveId && ['recording', 'paused'].includes(recorder.mode)) recorder.stop();
            else await request(`/api/meetings/live/${encodeURIComponent(liveId)}/end`, { method: 'POST', json: {} });
            setOptimisticEnd(liveId);
            setLiveId(null);
            toast('正在结束会议');
            await load();
        } catch { setLiveError('未能确认是否结束，请检查网络后重试。'); }
        finally { setEnding(false); }
    }

    async function confirmDelete() {
        if (!deleteTarget || deleting || capture.current?.mode !== 'idle') return;
        const card = deleteTarget;
        setDeleting(true);
        setDeleteError('');
        let success;
        try {
            success = (await request(`/api/meetings/${card.id}`, { method: 'DELETE', json: { identity: card.deletion_identity } })).success;
            if (!success) throw new Error('Unconfirmed deletion');
        } catch (error) {
            success = error.status === 404;
            if (!success) setDeleteError(error.data?.error || (error.status === 401
                ? '登录已失效，请重新登录后再试。' : '暂时无法确认删除结果，请关闭后刷新列表。'));
        } finally {
            if (success) {
                await remove(card);
                setDeleteTarget(null);
                toast('会议已删除');
                if (route.detail === card.id) go('', { tab: 'meetings', detail: null }, true);
                load();
            }
            setDeleting(false);
        }
    }

    const liveState = !active ? '会议已结束' : isEnding ? '正在保存最后一段录音'
        : `${liveLabels[active.phase] || '状态待更新'}${active.meeting_ends_at ? ` · ${timeFormat.format(new Date(active.meeting_ends_at))} 自动结束` : ''}`;
    const detailCard = data.cards.find(card => card.id === route.detail);
    // 小助理里点开的会议盖在对话上面：返回时对话原样还在（滚动位置不变）
    const overAssistant = route.tab === 'meetings' && Boolean(route.detail) && route.origin === 'assistant';
    const detail = route.tab === 'meetings' && route.detail
        ? <MeetingDetail key={route.detail} id={route.detail} title={detailCard?.title} back={split && !overAssistant ? null : back} backLabel={overAssistant ? '小助理' : '会议'} scrollRoot={detailScroll}
            loginUrl={config.loginUrl} canDelete={data.canDelete && mode === 'idle'} onDelete={card => { setDeleteError(''); setDeleteTarget(card); }}
            onChanged={() => load()} />
        : null;
    const home = <MeetingsHome library={library} loginUrl={config.loginUrl} current={route.detail} openLive={openLive}
        openDetail={openDetail} openDelete={card => { setDeleteError(''); setDeleteTarget(card); }}
        optimisticEnd={optimisticEnd} deleteLocked={mode !== 'idle' || deleting || data.error === 'login'}
        localSession={['recording', 'paused', 'saving', 'opening'].includes(mode) ? capture.current?.session?.id : null} />;
    const companionPage = <CompanionPage key="assistant" companion={companion}
        openMeeting={id => go(`#meeting-${id}`, { tab: 'meetings', detail: id, origin: 'assistant' })}
        onBack={() => { const item = tabs.find(t => t.key === lastTab.current) || tabs[1]; go(item.hash, { tab: item.key, detail: null }, true); }} />;
    const showAssistant = route.tab === 'assistant' || overAssistant;
    const tabPage = route.tab === 'memory' ? <MemoryPage key="memory" config={config} sub={route.sub}
        openMeeting={id => go(`#meeting-${id}`, { tab: 'meetings', detail: id })}
        openHistory={() => go('#memory-history', { tab: 'memory', detail: null, sub: 'history' })}
        closeHistory={() => history.state?.sub === 'history' ? history.back() : go('#memory', { tab: 'memory', detail: null }, true)} />
        : route.tab === 'settings' ? <SettingsPage key="settings" config={config} locked={actionsLocked} />
        : null;

    const updateChip = stale && !actionsLocked && mode === 'idle'
        ? <div key="update" className="update-host"><motion.button type="button" className="update-chip glass glass-strong" onClick={() => location.reload()}
            initial={{ opacity: 0, y: -16, scale: .94 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -12 }} transition={softSpring}>
            <Icon name="refresh" />页面有新版本<strong>刷新</strong>
        </motion.button></div> : null;

    return <div className="app" data-tab={showAssistant ? 'assistant' : route.tab} data-split={split && route.tab === 'meetings' ? 'true' : undefined}>
        {route.tab === 'meetings' && !overAssistant ? (split ? <div className="split">
            <div className="split-list">{home}</div>
            <div className="split-detail">
                <AnimatePresence mode="wait" initial={false}>
                    {detail ? <motion.div key={route.detail} initial={{ opacity: 0, x: 24 }} animate={{ opacity: 1, x: 0 }} exit={{ opacity: 0 }} transition={pushSpring}>
                        <div className="page-stack" ref={detailScroll}>{detail}</div>
                    </motion.div> : <motion.div key="empty" className="split-empty" initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
                        <div className="empty"><Icon name="doc" /><strong>选择一场会议</strong><p>会议摘要、注意事项和发言原文会显示在这里。</p></div>
                    </motion.div>}
                </AnimatePresence>
            </div>
        </div> : <>
            <motion.div animate={{ x: detail ? '-28%' : 0, filter: detail ? 'brightness(.92)' : 'brightness(1)' }} transition={pushSpring}
                aria-hidden={detail ? true : undefined} style={{ pointerEvents: detail ? 'none' : undefined }}>{home}</motion.div>
            <AnimatePresence>
                {detail && <motion.div key={route.detail} className="page-stack" ref={detailScroll}
                    initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={pushSpring}
                    // 和 iOS 一样只认从屏幕左边缘开始的滑动：页面里表格、波形的横向滑动不会触发返回
                    drag="x" dragListener={false} dragControls={edgeDrag} dragDirectionLock
                    dragConstraints={{ left: 0, right: 0 }} dragElastic={{ left: 0, right: .9 }}
                    onPointerDown={event => { if (event.pointerType !== 'mouse' && event.clientX <= 24) edgeDrag.start(event); }}
                    onDragEnd={(_e, info) => { if (info.offset.x > 110 || info.velocity.x > 700) back(); }}>
                    {detail}
                </motion.div>}
            </AnimatePresence>
        </>) : showAssistant ? null : <AnimatePresence mode="wait" initial={false}>
            <motion.div key={route.tab + (route.sub || '')} initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0 }}
                transition={{ duration: .22, ease: [.3, .7, .4, 1] }}>{tabPage}</motion.div>
        </AnimatePresence>}
        <AnimatePresence>{updateChip}</AnimatePresence>
        {/* 小助理：全屏对话，从右侧推入（像 Telegram 打开一个聊天） */}
        <AnimatePresence>
            {showAssistant && <motion.div key="assistant" className="tg-stack"
                initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={pushSpring}>{companionPage}</motion.div>}
        </AnimatePresence>
        <AnimatePresence>
            {overAssistant && <motion.div key={route.detail} className="page-stack over-assistant" ref={detailScroll}
                initial={{ x: '100%' }} animate={{ x: 0 }} exit={{ x: '100%' }} transition={pushSpring}
                drag="x" dragListener={false} dragControls={edgeDrag} dragDirectionLock
                dragConstraints={{ left: 0, right: 0 }} dragElastic={{ left: 0, right: .9 }}
                onPointerDown={event => { if (event.pointerType !== 'mouse' && event.clientX <= 24) edgeDrag.start(event); }}
                onDragEnd={(_e, info) => { if (info.offset.x > 110 || info.velocity.x > 700) back(); }}>
                {detail}
            </motion.div>}
        </AnimatePresence>

        <div hidden={showAssistant || (Boolean(route.tab !== 'meetings' || (!split && route.detail)) && !['recording', 'paused', 'saving', 'opening'].includes(mode))}>
            <RecordingDock mode={remote ? 'remote' : mode} startedAt={startedAt} notice={notice} meter={meter}
                low={Boolean(!split && route.detail)}
                disabled={['opening', 'saving', 'restoring'].includes(mode) || deleting || (mode === 'idle' && data.error === 'login')}
                action={() => { setNotice({}); if (remote) openLive(data.live[0].id); else capture.current?.press(); }} />
        </div>
        {!(route.tab === 'meetings' && route.detail && !split) && !showAssistant && <TabBar tab={route.tab} select={selectTab}
            badges={{ assistant: route.tab === 'assistant' ? 0 : companion.unread, meetings: route.tab !== 'meetings' && busyPhases.has(mode) ? 1 : 0 }} />}

        <Sheet open={Boolean(liveId)} onClose={() => setLiveId(null)} busy={ending} title="进行中的会议"
            actions={[<button key="b" className="btn btn-gray" type="button" disabled={ending} onClick={() => setLiveId(null)}>返回</button>,
                <button key="e" className="btn btn-danger" type="button" disabled={!active || isEnding || ending} onClick={endLive}>
                    {!active ? '已结束' : isEnding || ending ? '正在结束…' : '结束会议'}</button>]}>
            <p>{dateText(active?.started_at, true)}</p>
            <p role="status" style={{ color: 'var(--label)', fontWeight: 600 }}>{liveState}</p>
            {liveError && <Banner tone="bad">{liveError}</Banner>}
        </Sheet>
        <Sheet open={Boolean(deleteTarget)} onClose={() => setDeleteTarget(null)} busy={deleting} title="删除这场会议？"
            actions={[<button key="c" className="btn btn-gray" type="button" disabled={deleting} onClick={() => setDeleteTarget(null)}>取消</button>,
                <button key="d" className="btn btn-danger" type="button" disabled={deleting || mode !== 'idle'} onClick={confirmDelete}>{deleting ? '正在删除…' : '删除'}</button>]}>
            <p style={{ color: 'var(--label)', fontWeight: 600 }}>{deleteTarget && [deleteTarget.title, dateText(deleteTarget.date)].filter(Boolean).join(' · ')}</p>
            <p>录音、原文和所有摘要版本将一并删除，无法恢复。长期记忆会保留。</p>
            {deleteError && <Banner tone="bad">{deleteError}</Banner>}
        </Sheet>
    </div>;
}

export function Meetings({ config }) {
    return <MotionConfig reducedMotion="user">
        <ToastProvider><Workspace config={config} /></ToastProvider>
    </MotionConfig>;
}
