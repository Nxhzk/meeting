import { useCallback, useEffect, useRef, useState } from 'react';
import { Header, Icon, Messages, Sheet, clockText, dateText, timeFormat } from './ui.jsx';
import { MeetingDetail, labels, processing } from './MeetingDetail.jsx';
import { useMeetings } from './useMeetings.js';
import { currentCsrf, request } from './recording/api.js';
import { MeetingCapture } from './recording/register-capture.js';
import { MicrophoneMeter, meterLabels } from './recording/mic-meter.js';

const busyPhases = new Set(['opening', 'recording', 'paused', 'saving']);
const inProgress = phase => busyPhases.has(phase) || ['restoring', 'retry', 'recover'].includes(phase);
const liveLabels = { starting: '等待收音', receiving: '正在接收录音', paused: '暂未收到录音', ending: '正在结束' };
const actions = {
    idle: '开始会议', opening: '正在打开麦克风…', recording: '结束会议', paused: '继续录音',
    remote: '查看当前会议', saving: '正在保存…', retry: '重试保存', restoring: '正在连接…',
    recover: '重新连接', other: '检查当前会议',
};
const meetingApp = /JstMeetingApp\//.test(navigator.userAgent);
const inAppBrowser = /MicroMessenger|wxwork|DingTalk|AliApp|Lark|Feishu|\bQQ\/|Weibo/i.test(navigator.userAgent);

function RecordingControl({ mode, startedAt, notice, meter, action, disabled }) {
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
        // Legacy APKs observe the stable DOM IDs below. If their observer ran
        // before React mounted, report through the same origin-checked bridge.
        if (!window.__jstApp) {
            try { window.JstApp?.postMessage(`${mode}|${startedAt ? clockText((Date.now() - startedAt) / 1000) : ''}`); } catch { /* Browser only. */ }
        }
    }, [mode, startedAt]);
    const tip = inAppBrowser && ['idle', 'opening', 'recording', 'paused'].includes(mode)
        ? '当前在微信、钉钉等 App 里打开，锁屏或切走时更容易停止收音。建议用浏览器打开。'
        : live ? (meetingApp ? '录音可在后台继续。请确认已按应用引导开启后台权限。' : '录音时请保持本页亮屏，尽量不要锁屏或切到其他 App。') : '';
    return <div className="control-stack">
        <div id="meeting-control" className="meeting-control" data-phase={mode}>
            <button id="meeting-action" className="primary-button meeting-action" type="button" disabled={disabled} onClick={action}>
                {mode === 'recording' ? <Icon name="stop" /> : ['idle', 'paused'].includes(mode) && <Icon name="mic" />}
                {actions[mode]}
            </button>
            <div className="record-live" hidden={!live}>
                <span id="meeting-clock" className="meeting-clock" role="timer" aria-label="会议用时">{clock}</span>
                {mode === 'recording' && <div className="meeting-meter" data-state={meter.state} style={{ '--meter-level': meter.level }}>
                    <span className="meter-wave" aria-hidden="true">{Array.from({ length: 7 }, (_, i) => <i key={i} />)}</span>
                    <span role="status">{meterLabels[meter.state]}</span>
                </div>}
                {mode === 'paused' && <span className="paused-state">收音已暂停</span>}
            </div>
        </div>
        {notice.text && <div className="notice" data-tone={notice.tone} role="status">{notice.text}</div>}
        {tip && <p className="notice" data-tone={inAppBrowser ? 'warn' : undefined}>{tip}</p>}
    </div>;
}

function MeetingList({ library, loginUrl, mode, openLive, openDetail, openDelete, optimisticEnd, deleting, unavailable }) {
    const { data, load, loading } = library;
    return <div className="meeting-library">
        {data.live.length > 0 && <ul className="live-meetings" role="list" aria-label="进行中的会议">
            {data.live.map(row => {
                const phase = optimisticEnd === row.id ? 'ending' : row.phase;
                return <li key={row.id} data-phase={phase}>
                    <button className="live-row" type="button" onClick={() => openLive(row.id)}>
                        <span className="live-main"><strong>进行中的会议</strong><small>{dateText(row.started_at, true)}</small></span>
                        <span className="live-badge">{liveLabels[phase] || '状态待更新'}</span><span aria-hidden="true">›</span>
                    </button>
                </li>;
            })}
        </ul>}
        <div className="list-message" aria-live="polite" hidden={data.loaded && !data.error && (data.cards.length || data.live.length)}>
            {data.error === 'login' ? <>登录已失效，请<a href={loginUrl}>重新登录</a>。</>
                : data.error ? '无法加载会议记录，请检查网络。'
                : !data.loaded ? '正在加载…' : '暂无会议记录'}
        </div>
        <ul className="meeting-list" role="list">
            {data.cards.map(card => <li key={card.id}>
                <button className="meeting-row" type="button" data-recording-id={card.id} onClick={() => openDetail(card.id)}>
                    <span className="row-title">{card.title}</span>
                    <span className="row-meta">
                        {card.date && <time className="row-time" dateTime={card.date}>{dateText(card.date, true)}</time>}
                        {card.phase !== 'ready' && <span className="status-pill" data-phase={card.phase}>{labels[card.phase] || '状态待更新'}</span>}
                    </span>
                </button>
                {data.canDelete && !processing.has(card.phase) && <button className="row-delete" type="button" aria-label={`删除：${card.title}`}
                    disabled={!card.deletion_identity || mode !== 'idle' || deleting || unavailable}
                    onClick={event => openDelete(card, event.currentTarget)}>删除</button>}
            </li>)}
        </ul>
        {data.error === 'network' && <button id="list-refresh" className="secondary-button" type="button" disabled={loading} onClick={() => load()}>重新加载列表</button>}
        {data.more != null && <button className="secondary-button more-button" type="button" disabled={loading} onClick={() => load(true)}>更早的会议</button>}
    </div>;
}

function hashRecording() {
    const match = /^#meeting-(\d+)$/.exec(location.hash);
    const id = match ? Number(match[1]) : null;
    return Number.isSafeInteger(id) && id > 0 ? id : null;
}

export function Meetings({ config }) {
    const capture = useRef(null);
    const [record, setRecord] = useState({ mode: 'restoring' });
    const [meter, setMeter] = useState({ state: 'checking', level: 0 });
    const [notice, setNotice] = useState({});
    const [status, announce] = useState('');
    const fallback = useRef(config.recordingId);
    const [detail, setDetail] = useState(() => hashRecording() ?? fallback.current);
    const [options, setOptions] = useState(false);
    const [liveId, setLiveId] = useState(null);
    const [optimisticEnd, setOptimisticEnd] = useState(null);
    const [ending, setEnding] = useState(false);
    const [liveError, setLiveError] = useState('');
    const [deleteTarget, setDeleteTarget] = useState(null);
    const [deleting, setDeleting] = useState(false);
    const [deleteError, setDeleteError] = useState('');
    const lastRow = useRef(null);
    const heading = useRef(null);
    const restoreFocus = useRef(false);
    const { mode, startedAt } = record;
    const notify = useCallback((text, tone = 'good') => setNotice({ text, tone }), []);
    const onLive = useCallback(rows => capture.current?.syncLive(rows), []);
    const library = useMeetings(!detail, onLive, busyPhases.has(mode));
    const { data, load, remove } = library;
    const remote = ['idle', 'other'].includes(mode) && data.live.length > 0;
    const active = data.live.find(row => row.id === liveId);
    const isEnding = active && (active.phase === 'ending' || optimisticEnd === active.id);
    const actionsLocked = inProgress(mode) || Boolean(deleteTarget) || Boolean(liveId);

    useEffect(() => {
        const recorder = new MeetingCapture({ owner: config.owner, meter: new MicrophoneMeter(setMeter),
            update: (phase, since) => setRecord({ mode: phase, startedAt: since }),
            complete: async (id, interrupted, automatic) => {
                const next = await load();
                if (!interrupted && !automatic && !document.hidden && id) {
                    if (next.cards.some(card => card.id === id)) announce('会议已保存');
                    else notify('会议已保存，列表暂未更新。', 'warn');
                }
            }, notice: notify });
        capture.current = recorder;
        recorder.restore();
        return () => { recorder.detach(); capture.current = null; };
    }, [config.owner, load, notify]);

    useEffect(() => {
        if (['recording', 'paused', 'saving', 'idle'].includes(mode) && !detail && !document.hidden) load();
    }, [detail, load, mode]);

    useEffect(() => {
        if (optimisticEnd && !data.live.some(item => item.id === optimisticEnd)) setOptimisticEnd(null);
    }, [data.live, optimisticEnd]);

    useEffect(() => {
        const navigate = () => {
            const id = hashRecording() ?? fallback.current;
            if (!id || !inProgress(capture.current?.mode)) setDetail(id);
        };
        window.addEventListener('popstate', navigate);
        window.addEventListener('hashchange', navigate);
        return () => { window.removeEventListener('popstate', navigate); window.removeEventListener('hashchange', navigate); };
    }, []);

    useEffect(() => {
        if (detail || !restoreFocus.current) return;
        restoreFocus.current = false;
        (document.querySelector(`[data-recording-id="${lastRow.current}"]`) || heading.current)?.focus();
    }, [detail]);

    function showDetail(id) {
        if (inProgress(capture.current?.mode) || deleting) {
            notify('请先结束并保存当前会议，再查看其他记录。', 'warn');
            document.getElementById('meeting-action')?.focus();
            return;
        }
        lastRow.current = id;
        history.pushState({ meeting: id }, '', `#meeting-${id}`);
        setDetail(id);
    }

    function back() {
        restoreFocus.current = true;
        if (history.state?.meeting === detail) history.back();
        else {
            fallback.current = null;
            history.replaceState(null, '', config.homeUrl);
            setDetail(null);
        }
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
            announce('正在结束会议');
            await load();
        } catch { setLiveError('未能确认是否结束，请检查网络后重试。'); }
        finally { setEnding(false); }
    }

    function closeDelete() {
        const button = deleteTarget?.button;
        setDeleteTarget(null);
        requestAnimationFrame(() => { if (button?.isConnected && !button.disabled) button.focus(); });
    }

    async function confirmDelete() {
        if (!deleteTarget || deleting || capture.current?.mode !== 'idle') return;
        const { card } = deleteTarget;
        setDeleting(true);
        setDeleteError('');
        let success;
        try {
            success = (await request(`/api/meetings/${card.id}`, { method: 'DELETE', json: { identity: card.deletion_identity } })).success;
            if (!success) throw new Error('Unconfirmed deletion');
        } catch (error) {
            success = error.status === 404;
            if (!success) setDeleteError(error.data?.error || (error.status === 401
                ? '登录已失效，请重新登录后再试。' : '暂时无法确认删除结果，请关闭窗口后刷新列表。'));
        } finally {
            if (success) {
                await remove(card);
                setDeleteTarget(null);
                announce('会议已删除');
                requestAnimationFrame(() => heading.current?.focus());
                load();
            }
            setDeleting(false);
        }
    }

    const liveState = !active ? '会议已结束' : isEnding ? '正在保存最后一段录音'
        : `${liveLabels[active.phase] || '状态待更新'}${active.meeting_ends_at ? ` · ${timeFormat.format(new Date(active.meeting_ends_at))} 自动结束` : ''}`;
    return <>
        <Header config={config} onOptions={() => setOptions(true)} />
        <main className="workspace">
            <Messages messages={config.messages} />
            <section id="meeting-home" aria-labelledby="library-heading" hidden={Boolean(detail)}>
                <div className="meeting-toolbar">
                    <RecordingControl mode={remote ? 'remote' : mode} startedAt={startedAt} notice={notice} meter={meter}
                        disabled={['opening', 'saving', 'restoring'].includes(mode) || deleting || (mode === 'idle' && data.error === 'login')}
                        action={() => { announce(''); if (remote) openLive(data.live[0].id); else capture.current?.press(); }} />
                    <h2 id="library-heading" tabIndex={-1} ref={heading}>会议记录</h2>
                </div>
                <MeetingList library={library} loginUrl={config.loginUrl} mode={mode} openLive={openLive} openDetail={showDetail}
                    openDelete={(card, button) => { setDeleteError(''); setDeleteTarget({ card, button }); }}
                    optimisticEnd={optimisticEnd} deleting={deleting} unavailable={Boolean(data.error === 'login')} />
            </section>
            {detail && <MeetingDetail key={detail} id={detail} title={data.cards.find(card => card.id === detail)?.title}
                back={back} loginUrl={config.loginUrl} announce={announce} />}
        </main>
        <p className="sr-only" role="status">{status}</p>
        <Sheet id="options-dialog" labelledBy="options-heading" open={options} close={() => setOptions(false)}>
            <header className="dialog-header"><h2 id="options-heading">录音说明</h2>
                <button className="icon-button" type="button" aria-label="关闭" onClick={() => setOptions(false)}><Icon name="close" /></button>
            </header>
            <p>开始前请告知参会者。{config.transcriptionPending ? '目前仅保存录音，不转写。'
                : config.summaryReady ? '录音和文字将由云服务处理。' : '录音将由云服务转成文字，暂不生成摘要。'}</p>
            <p>会议满 1 小时自动结束。</p>
            <p>{meetingApp ? '后台录音请保持麦克风和通知权限。小米、华为、OPPO、vivo 等手机建议关闭应用的电池限制。'
                : '手机录音请用 Safari 或 Chrome 打开，并保持页面亮屏。'}</p>
            <p>如果系统暂停收音，回到本页会尝试自动接着录；暂停期间的声音不会被录下。</p>
            <div className="options-links">
                {!actionsLocked && <a className="text-button" href={config.accountUrl}>账号设置</a>}
                <button type="button" className="text-button" disabled={actionsLocked} onClick={() => location.reload()}>刷新页面版本</button>
                <form action={config.logoutUrl} method="post" onSubmit={event => {
                    if (actionsLocked) event.preventDefault();
                    else event.currentTarget.elements.csrf_token.value = currentCsrf();
                }}>
                    <input type="hidden" name="csrf_token" defaultValue={config.csrfToken} />
                    <button id="logout-button" className="text-button" type="submit" disabled={actionsLocked}>退出登录</button>
                </form>
            </div>
        </Sheet>
        <Sheet id="live-dialog" labelledBy="live-heading" describedBy="live-state" open={Boolean(liveId)} close={() => setLiveId(null)} busy={ending}>
            <h2 id="live-heading">进行中的会议</h2>
            <p className="detail-date">{dateText(active?.started_at, true)}</p>
            <p id="live-state" className="live-readout" role="status">{liveState}</p>
            {liveError && <p className="delete-feedback" role="alert">{liveError}</p>}
            <div className="dialog-actions">
                <button className="secondary-button" type="button" disabled={ending} onClick={() => setLiveId(null)}>返回</button>
                <button className="danger-button" type="button" disabled={!active || isEnding || ending} onClick={endLive}>
                    {!active ? '已结束' : isEnding || ending ? '正在结束…' : '结束会议'}
                </button>
            </div>
        </Sheet>
        <Sheet id="delete-dialog" labelledBy="delete-heading" describedBy="delete-description" open={Boolean(deleteTarget)} close={closeDelete} busy={deleting}>
            <h2 id="delete-heading">删除这条会议？</h2>
            <p className="delete-target">{deleteTarget && [deleteTarget.card.title, dateText(deleteTarget.card.date)].filter(Boolean).join(' · ')}</p>
            <p id="delete-description">录音、原文和摘要将一并删除，无法恢复。</p>
            {deleteError && <p className="delete-feedback" role="alert">{deleteError}</p>}
            <div className="dialog-actions">
                <button className="secondary-button" type="button" disabled={deleting} onClick={closeDelete}>取消</button>
                <button className="danger-button" type="button" disabled={deleting || mode !== 'idle'} onClick={confirmDelete}>{deleting ? '正在删除…' : '确认删除'}</button>
            </div>
        </Sheet>
    </>;
}
