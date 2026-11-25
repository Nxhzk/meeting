import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import {
    Banner, Icon, Menu, MenuItem, NavBar, NavButton, Sheet, clockText, copyText, dateText, durationText, relativeTime,
    softSpring, useToast,
} from './ui.jsx';
import { request } from './recording/api.js';
import { LiquidOrb } from './LiquidOrb.jsx';
import { Player } from './Player.jsx';
import { AgentTrace, currentActivity } from './AgentTrace.jsx';
import { JstAvatar, JstLoader } from './JstMark.jsx';

export const labels = {
    saving: '正在保存', waiting: '等待整理', transcribing: '正在转写', summarizing: '正在生成摘要',
    asr_pending: '等待转写', failed: '整理失败', no_minutes: '暂无摘要', too_short: '发言太少', no_speech: '没有说话内容',
};
export const processing = new Set(['saving', 'waiting', 'transcribing', 'summarizing']);
const phaseText = {
    saving: '正在保存录音…', waiting: '排队等待整理…', transcribing: '正在把录音转成文字…',
    asr_pending: '录音已保存，等待转写。', too_short: '发言太少，没有生成摘要。', no_minutes: '还没有会议摘要。',
    no_speech: '这段录音里没有识别到说话内容，可能是静音、环境噪声，或者录音太短。',
};
const FEEDBACK_MAX = 2000;
// 只画确定按顺序发生的大步骤；会议助手内部怎么穿插（读、想、查记忆、写、改）
// 不分阶段，直接展示它此刻真实在做的事和完整的调用记录。
const PIPELINE = ['保存录音', '转成文字', '会议助手整理'];
const ENERGY = { saving: .25, waiting: .2, transcribing: .45, summarizing: .85 };
const pipelineIndex = phase => (phase === 'saving' || phase === 'waiting' ? 0 : phase === 'transcribing' ? 1 : 2);

function useElapsed(since) {
    const [mounted] = useState(Date.now);
    const [now, setNow] = useState(Date.now);
    useEffect(() => {
        const timer = setInterval(() => setNow(Date.now()), 1000);
        return () => clearInterval(timer);
    }, []);
    const start = since ? Date.parse(since) : NaN;
    return Math.max(0, Math.floor((now - (Number.isNaN(start) ? mounted : start)) / 1000));
}

// ------------------------------------------------------------ 生成进度
function AssistantProgress({ phase, regenerating, trace, since }) {
    const index = pipelineIndex(phase);
    const elapsed = useElapsed(since);
    const working = phase === 'summarizing';
    const title = working ? (regenerating ? '会议助手正在重新生成' : '会议助手正在整理') : labels[phase];
    const detail = working ? currentActivity(trace) : phaseText[phase];
    return <div className="group progress-card" role="status" aria-live="polite">
        <div className="progress-hero">
            <LiquidOrb size={92} energy={ENERGY[phase] ?? .5} />
            <div className="progress-copy">
                <strong>{title}</strong>
                <AnimatePresence mode="popLayout" initial={false}>
                    <motion.p key={detail.replace(/ · [0-9,]+ 字符$/, '')} initial={{ opacity: 0, y: 8, filter: 'blur(4px)' }} animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }}
                        exit={{ opacity: 0, y: -8, filter: 'blur(4px)' }} transition={{ duration: .35, ease: [.3, .7, .4, 1] }}>{detail}</motion.p>
                </AnimatePresence>
                <span className="progress-elapsed">已用 {clockText(elapsed)}</span>
            </div>
        </div>
        {!regenerating && <ol className="pipeline" aria-label="整理进度">
            {PIPELINE.map((name, i) => {
                const state = i < index ? 'done' : i === index ? 'now' : 'todo';
                return <li key={name} data-state={state}>
                    <span className="pipe-track">{state === 'now' && <span className="pipe-fill" />}</span>
                    <span className="pipe-label">{name}</span>
                </li>;
            })}
        </ol>}
        {phase === 'summarizing' && <AgentTrace events={trace || []} />}
    </div>;
}

// ------------------------------------------------------------ 摘要正文
function Minutes({ html }) {
    const ref = useRef(null);
    useEffect(() => {
        // 「本次注意事项」用暖色标题
        for (const h2 of ref.current?.querySelectorAll('h2') || []) {
            h2.classList.toggle('caution', h2.textContent.trim() === '本次注意事项');
        }
        // 表格放进可横向滚动的容器，宽表格不撑破卡片
        for (const table of ref.current?.querySelectorAll('table') || []) {
            if (table.parentElement?.classList.contains('table-scroll')) continue;
            const wrap = document.createElement('div');
            wrap.className = 'table-scroll';
            table.replaceWith(wrap);
            wrap.append(table);
        }
    }, [html]);
    // 接口只放行文档标签，没有属性、链接和外部资源。
    return <div className="minutes" ref={ref} dangerouslySetInnerHTML={{ __html: html }} />;
}

function plainText(node, meeting) {
    const clone = node.cloneNode(true);
    for (const li of clone.querySelectorAll('li')) {
        const list = li.parentElement;
        li.prepend(list.tagName === 'OL' ? `${[...list.children].indexOf(li) + 1}. ` : '• ');
    }
    clone.className = 'copy-buffer';
    document.body.append(clone);
    const text = [meeting.title, dateText(meeting.date), clone.innerText.trim()].filter(Boolean).join('\n\n');
    clone.remove();
    return text;
}

function SummarySection({ meeting, onRegenerate, onVersion, versionView, loadingVersion }) {
    const toast = useToast();
    const body = useRef(null);
    const versionButton = useRef(null);
    const [menu, setMenu] = useState(false);
    const versions = meeting.versions || [];
    const latest = versions[0];
    const shown = versionView || latest;
    const html = versionView?.html ?? meeting.summary_html;
    const copy = async () => {
        if (!body.current) return;
        toast((await copyText(plainText(body.current, meeting))) ? '摘要已复制' : '复制失败，请长按选择文字', 'good');
    };
    return <section className="section" aria-labelledby="summary-heading">
        <div className="summary-toolbar">
            <h2 id="summary-heading">会议摘要</h2>
            <div className="summary-tools">
                {versions.length > 1 && <button ref={versionButton} type="button" className="version-button" aria-haspopup="menu"
                    aria-expanded={menu} onClick={() => setMenu(true)}>v{shown?.version}<Icon name="down" /></button>}
                <NavButton icon="copy" label="复制摘要" onClick={copy} />
                {meeting.can_regenerate && <NavButton icon="sparkles" label="重新生成" onClick={onRegenerate} />}
            </div>
        </div>
        <div className="group summary-card">
            <AnimatePresence mode="wait" initial={false}>
                <motion.div key={shown?.version ?? 'current'} ref={body} initial={{ opacity: 0 }} animate={{ opacity: loadingVersion ? .4 : 1 }}
                    exit={{ opacity: 0 }} transition={{ duration: .18 }}>
                    <Minutes html={html} />
                </motion.div>
            </AnimatePresence>
            {shown && <p className="version-note">
                <Icon name={shown.source === 'legacy' ? 'history' : 'sparkles'} />
                <span>{shown.source === 'legacy' ? '旧系统生成的摘要' : `会议助手 v${shown.version}`}
                    {shown.created_at && ` · ${relativeTime(shown.created_at)}`}
                    {shown.feedback && <><br />修改意见：{shown.feedback}</>}
                    {versionView && versionView.version !== latest?.version && <><br />正在查看历史版本，<button type="button" className="source-link" onClick={() => onVersion(null)}>回到最新</button></>}
                </span>
            </p>}
        </div>
        <Menu anchor={versionButton} open={menu} onClose={() => setMenu(false)} label="摘要版本">
            {versions.map(v => <MenuItem key={v.version} checked={(shown?.version) === v.version}
                sub={[v.source === 'legacy' ? '旧系统' : '会议助手', relativeTime(v.created_at)].filter(Boolean).join(' · ')}
                onSelect={() => { setMenu(false); onVersion(v.version === latest?.version ? null : v.version); }}>
                v{v.version}{v.feedback ? ` · ${v.feedback.slice(0, 14)}${v.feedback.length > 14 ? '…' : ''}` : ''}
            </MenuItem>)}
        </Menu>
    </section>;
}

// ------------------------------------------------------------ 录音与原文
function AudioCard({ src, showMissing, recordingId, duration, lines }) {
    if (!src && !showMissing) return null;
    return <section className="section" aria-label="录音回放">
        {src ? <Player src={src} recordingId={recordingId} fallbackDuration={duration} lines={lines} />
            : <div className="group player-card"><p className="player-note" role="status">没有可播放的录音。</p></div>}
    </section>;
}

function Transcript({ lines }) {
    const [open, setOpen] = useState(false);
    const [limit, setLimit] = useState(200);
    if (!lines?.length) return null;
    return <section className="section" aria-label="发言原文">
        <div className="group">
            <button type="button" className="disclosure" aria-expanded={open} onClick={() => setOpen(!open)}>
                <span>发言原文 <span style={{ color: 'var(--label-2)', fontWeight: 400 }}>· {lines.length} 句</span></span>
                <Icon name="chevron" />
            </button>
            <AnimatePresence initial={false}>
                {open && <motion.div key="t" initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                    transition={softSpring} style={{ overflow: 'hidden' }}>
                    <div className="transcript">
                        {lines.slice(0, limit).map((line, index) => {
                            const name = line.speaker || '发言';
                            return <div className="utterance" key={index}>
                                <JstAvatar size={34} className="avatar" />
                                <div>
                                    <div className="utterance-head">{line.speaker && <strong>{line.speaker}</strong>}{line.start != null && <span>{clockText(line.start)}</span>}</div>
                                    <p>{line.text}</p>
                                </div>
                            </div>;
                        })}
                        {lines.length > limit && <div style={{ padding: '4px 16px 14px' }}>
                            <button type="button" className="btn btn-gray btn-small" onClick={() => setLimit(limit + 400)}>再显示 {Math.min(400, lines.length - limit)} 句</button>
                        </div>}
                    </div>
                </motion.div>}
            </AnimatePresence>
        </div>
    </section>;
}

// ------------------------------------------------------------ 重新生成面板
function RegenerateSheet({ open, onClose, onSubmit, sending, error }) {
    const [text, setText] = useState('');
    const field = useRef(null);
    useEffect(() => { if (open) setTimeout(() => field.current?.focus(), 350); }, [open]);
    const suggestions = ['注意事项写得更具体', '下一步补全负责人和时间', '纪要再精简一些', '补充遗漏的讨论'];
    return <Sheet open={open} onClose={onClose} busy={sending} title="重新生成摘要"
        actions={<button className="btn btn-primary btn-block" type="button" disabled={sending} onClick={() => onSubmit(text.trim())}>
            {sending ? <JstLoader size={18} tone="current" /> : <Icon name="sparkles" />}{sending ? '正在提交…' : '重新生成'}
        </button>}>
        <p>会议助手会带着上一版的完整上下文接着改，并重新对照长期记忆。每次结果都保留为一个版本。</p>
        <div className="field">
            <label htmlFor="regen-feedback">修改意见（可不填）</label>
            <textarea id="regen-feedback" ref={field} className="textarea" maxLength={FEEDBACK_MAX} value={text}
                placeholder="比如：注意事项写得更具体，下一步补全负责人" onChange={event => setText(event.target.value)} />
            <span className="counter">{text.length}/{FEEDBACK_MAX}</span>
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8, marginTop: 4 }}>
            {suggestions.map(item => <button key={item} type="button" className="chip" style={{ height: 30, padding: '0 12px', fontSize: 14 }}
                onClick={() => setText(current => current ? `${current}；${item}` : item)}>{item}</button>)}
        </div>
        {error && <div style={{ marginTop: 12 }}><Banner tone="bad">{error}</Banner></div>}
    </Sheet>;
}

// ------------------------------------------------------------ 详情页
export function MeetingRecord({ meeting }) {
    // 分享页：只读
    return <div className="page"><div className="content">
        <div className="detail-head"><h1>{meeting?.title || '会议记录'}</h1>
            <div className="detail-meta">{meeting?.date && <span><Icon name="calendar" />{dateText(meeting.date)}</span>}</div></div>
        {meeting?.summary_html && <section className="section"><div className="group summary-card"><Minutes html={meeting.summary_html} /></div></section>}
        {meeting?.notes_html && <section className="section"><div className="section-label">笔记</div><div className="group summary-card"><Minutes html={meeting.notes_html} /></div></section>}
        <Transcript lines={meeting?.transcript} />
    </div></div>;
}

export function MeetingDetail({ id, title, back, backLabel = '会议', loginUrl, scrollRoot, canDelete, onDelete, onChanged }) {
    const toast = useToast();
    const [meeting, setMeeting] = useState(null);
    const [error, setError] = useState('');
    const [refresh, setRefresh] = useState(0);
    const [sheet, setSheet] = useState(false);
    const [sending, setSending] = useState(false);
    const [sendError, setSendError] = useState('');
    const [versionView, setVersionView] = useState(null);
    const [loadingVersion, setLoadingVersion] = useState(false);
    const [menu, setMenu] = useState(false);
    const menuButton = useRef(null);
    const wasProcessing = useRef(false);
    // 回调放进 ref：父组件每次渲染都会给新函数，不能让它们触发重新加载。
    const callbacks = useRef({});
    callbacks.current = { toast, onChanged };

    useEffect(() => {
        let active = true;
        let timer;
        let inFlight = false;
        const schedule = ms => { if (!document.hidden) timer = setTimeout(load, ms); };
        async function load() {
            if (inFlight || document.hidden) return;
            clearTimeout(timer);
            inFlight = true;
            try {
                const data = await request(`/api/meetings/${id}`);
                if (!active) return;
                setMeeting(data);
                setError('');
                const busy = processing.has(data.phase);
                if (wasProcessing.current && !busy) {
                    const { toast: notify, onChanged: changed } = callbacks.current;
                    if (data.regenerate_error) notify('重新生成没有成功', 'bad');
                    else if (data.phase === 'ready') notify('摘要已更新');
                    setVersionView(null);
                    changed?.();
                }
                wasProcessing.current = busy;
                if (busy) schedule(data.phase === 'summarizing' ? 1200 : 2500);
            } catch (err) {
                if (!active) return;
                if (err.status === 401) { setMeeting(null); setError('login'); }
                else if (err.status === 404) { setMeeting(null); setError('gone'); }
                else { setError('network'); schedule(6000); }
            } finally { inFlight = false; }
        }
        const visibility = () => { if (document.hidden) clearTimeout(timer); else load(); };
        document.addEventListener('visibilitychange', visibility);
        window.addEventListener('online', load);
        load();
        return () => {
            active = false;
            clearTimeout(timer);
            document.removeEventListener('visibilitychange', visibility);
            window.removeEventListener('online', load);
        };
    }, [id, refresh]);

    async function showVersion(version) {
        if (version == null) { setVersionView(null); return; }
        setLoadingVersion(true);
        try { setVersionView(await request(`/api/meetings/${id}/summary/versions/${version}`)); }
        catch { toast('这个版本暂时打不开', 'bad'); }
        finally { setLoadingVersion(false); }
    }

    async function regenerate(feedback) {
        if (sending) return;
        setSending(true);
        setSendError('');
        try {
            await request(`/api/meetings/${id}/summary/regenerate`, { method: 'POST', json: { feedback } });
            // 立刻进入「重新生成」状态、清空调用记录，不等下一次轮询
            setMeeting(current => current && { ...current, phase: 'summarizing', regenerating: true, trace: [], progress_started_at: null, regenerate_error: null });
            setSheet(false);
            wasProcessing.current = true;
            setRefresh(n => n + 1);
        } catch (err) {
            setSendError(err.data?.error || '这次没有提交成功，请稍后再试。');
        } finally { setSending(false); }
    }

    const busy = meeting && processing.has(meeting.phase);
    const head = meeting?.title || title || '会议记录';
    const meta = meeting && [
        meeting.date && <span key="d"><Icon name="calendar" />{dateText(meeting.date)}</span>,
        meeting.duration > 0 && <span key="t"><Icon name="clock" />{durationText(meeting.duration)}</span>,
    ].filter(Boolean);
    const showSummary = meeting?.summary_html;
    const deletable = canDelete && meeting && !busy && meeting.deletion_identity;

    return <div className="page" id="meeting-detail">
        <NavBar large={false} title={head} scrollRoot={scrollRoot} titleAfter={70}
            left={back && <NavButton icon="back" label={`返回${backLabel === '会议' ? '会议列表' : backLabel}`} onClick={back}>{backLabel}</NavButton>}
            right={meeting && <>
                <NavButton icon="more" label="更多" ref={menuButton} onClick={() => setMenu(true)} aria-haspopup="menu" />
                <Menu anchor={menuButton} open={menu} onClose={() => setMenu(false)} label="会议操作">
                    <MenuItem icon="sparkles" disabled={!meeting.can_regenerate} onSelect={() => { setMenu(false); setSendError(''); setSheet(true); }}>重新生成摘要</MenuItem>
                    <MenuItem icon="refresh" onSelect={() => { setMenu(false); setRefresh(n => n + 1); }}>刷新</MenuItem>
                    {deletable && <><hr /><MenuItem icon="trash" destructive onSelect={() => { setMenu(false); onDelete({ ...meeting, title: head }); }}>删除会议</MenuItem></>}
                </Menu>
            </>} />
        <div className="content">
            <motion.div className="detail-head" initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }} transition={softSpring}>
                <h1 tabIndex={-1}>{head}</h1>
                {meta?.length > 0 && <div className="detail-meta">{meta}</div>}
            </motion.div>

            {error === 'login' && <Banner tone="bad" title="登录已失效"><a href={loginUrl}>重新登录</a>后查看。</Banner>}
            {error === 'gone' && <Banner tone="warn" title="这场会议找不到了">它可能已被删除。</Banner>}
            {error === 'network' && <Banner tone="warn">网络不稳定，正在重试…</Banner>}
            {!meeting && !error && <div className="center"><JstLoader size={40} label="正在加载" /></div>}

            {meeting && <>
                <AudioCard key={meeting.audio_url} src={meeting.audio_url} showMissing={!busy} recordingId={id} duration={meeting.duration} lines={meeting.transcript} />
                <AnimatePresence initial={false}>
                    {busy && <motion.section className="section" key="progress" style={{ overflow: 'hidden' }}
                        initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} exit={{ opacity: 0, height: 0 }}
                        transition={{ duration: .45, ease: [.3, .7, .4, 1] }}>
                        <AssistantProgress phase={meeting.phase} since={meeting.progress_started_at}
                            regenerating={Boolean(meeting.regenerating || meeting.versions?.length)} trace={meeting.trace} />
                    </motion.section>}
                </AnimatePresence>
                {meeting.regenerate_error && !busy && <div className="section">
                    <Banner tone="warn" title="上次重新生成没有成功">{meeting.regenerate_error}（当前显示的是之前的版本）</Banner>
                </div>}
                {!busy && !showSummary && phaseText[meeting.phase] && meeting.phase !== 'failed' && <div className="section">
                    <Banner tone={meeting.phase === 'asr_pending' ? 'info' : 'warn'} title={meeting.phase === 'no_speech' ? '没有识别到说话' : undefined}>{phaseText[meeting.phase]}</Banner>
                </div>}
                {meeting.phase === 'failed' && <div className="section"><Banner tone="bad"
                    title={meeting.failed_step === 'summary' ? '会议摘要没有生成出来' : '录音没能整理成文字'}>
                    {[meeting.error, meeting.retry ? '可以重试。' : (meeting.failed_step === 'audio' && !meeting.audio_url ? '录音文件没有保存下来，无法重试。' : '')]
                        .filter(Boolean).join(' ')}</Banner></div>}
                {meeting.retry && <div className="section" style={{ display: 'grid' }}>
                    <button id="detail-retry" className="btn btn-primary" type="button" disabled={sending} onClick={async () => {
                        if (meeting.retry === 'summary') return regenerate('');
                        setSending(true);
                        try { await request(`/recording/${id}/reprocess_transcription`, { method: 'POST', json: {} }); wasProcessing.current = true; setRefresh(n => n + 1); }
                        catch { toast('这次没有提交成功，请稍后再试。', 'bad'); }
                        finally { setSending(false); }
                    }}>
                        <Icon name={meeting.retry === 'summary' ? 'sparkles' : 'refresh'} />{meeting.retry === 'transcription' ? '重新整理' : '生成会议摘要'}
                    </button>
                </div>}
                {showSummary && <SummarySection meeting={meeting} versionView={versionView} loadingVersion={loadingVersion}
                    onVersion={showVersion} onRegenerate={() => { setSendError(''); setSheet(true); }} />}
                <Transcript lines={meeting.transcript} />
            </>}
        </div>
        <RegenerateSheet open={sheet} onClose={() => setSheet(false)} onSubmit={regenerate} sending={sending} error={sendError} />
    </div>;
}
