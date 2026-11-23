import { request } from './api.js?v=5';
import { MeetingCapture } from './register-capture.js?v=jst-live-5';
import { MicrophoneMeter } from './mic-meter.js';

const $ = (id) => document.getElementById(id);
const list = $('meeting-list');
const audio = $('meeting-audio');
const deleteDialog = $('delete-dialog');
const deleteConfirm = $('delete-confirm');
const deleteCancel = $('delete-cancel');
const options = $('options-dialog');
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});
const rowDate = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' });
const rowTime = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
const status = {
    saving: '正在保存', waiting: '等待整理', transcribing: '正在转写', summarizing: '正在生成摘要',
    asr_pending: '等待转写', failed: '整理失败', no_minutes: '暂无摘要', too_short: '发言太少',
};
const pending = new Set(['saving', 'waiting', 'transcribing', 'summarizing']);
const busy = new Set(['opening', 'recording', 'paused', 'saving']);
const actions = {
    idle: '开始会议', opening: '正在打开麦克风…', recording: '结束会议', paused: '继续录音',
    remote: '查看当前会议', saving: '正在保存…', retry: '重试保存', restoring: '正在连接…',
    recover: '重新连接', other: '检查当前会议',
};
const phaseText = { ...status, asr_pending: '录音已保存，等待转写。', too_short: '发言太少，未生成摘要。' };
const loginHref = document.body.dataset.loginUrl;
let cards = [];
let liveRows = [];
let liveSelected = null;
let endInFlight = false;
let optimisticEnd = null;
let lastCaptureMode = null;
let mayDelete = false;
let deleteTarget = null;
let deleting = false;
let before = null;
let moreLoaded = false;
let listLoaded = false;
let listRequest = null;
let listTimer;
let detailTimer;
let detailSerial = 0;
let detailId = null;
let detail = null;
let lastRowId = null;
let lastDetailView = '';
let elapsedFrom = null;
let copyTimer;

function rowDateText(value) {
    const date = new Date(value || '');
    if (Number.isNaN(date.getTime())) return '';
    return date.getFullYear() === new Date().getFullYear()
        ? `${rowDate.format(date)} ${rowTime.format(date)}` : dateFormat.format(date);
}

function dateText(value) {
    const date = new Date(value || '');
    return Number.isNaN(date.getTime()) ? '' : dateFormat.format(date);
}

function clockText(seconds) {
    seconds = Math.max(0, Math.floor(seconds));
    const pad = (value) => String(value).padStart(2, '0');
    return `${seconds >= 3600 ? `${pad(Math.floor(seconds / 3600))}:` : ''}${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

function updateClock() {
    if (elapsedFrom) $('meeting-clock').textContent = clockText((Date.now() - elapsedFrom) / 1000);
}

function notify(text, tone = 'good') {
    const box = $('meeting-notice');
    box.textContent = text;
    box.dataset.tone = tone;
    box.hidden = !text;
}

// WeChat, DingTalk and similar in-app browsers stop the microphone far more
// readily than Safari or Chrome when the phone locks or switches apps.
const IN_APP_BROWSER = /MicroMessenger|wxwork|DingTalk|AliApp|Lark|Feishu|\bQQ\/|Weibo/i.test(navigator.userAgent || '');
const TIP_IN_APP = '当前在微信、钉钉等 App 里打开，锁屏或切走时更容易停止收音。建议点右上角「…」，选择在浏览器打开。';
const TIP_RECORDING = '录音时请保持本页亮屏，尽量不要锁屏或切到其他 App。';
// Our Android app keeps recording in the background (foreground service).
const MEETING_APP = /JstMeetingApp\//.test(navigator.userAgent || '');
const TIP_RECORDING_APP = '可以锁屏或切到其他 App，录音会在后台继续。';
const ADVICE_APP = '在捷士通智能会议 App 里录音，锁屏或切到其他 App 都会继续录。小米、华为、OPPO、vivo 等手机请在 设置 → 应用 → 捷士通智能会议 → 耗电 里选「无限制」。';
if (MEETING_APP && $('record-advice')) $('record-advice').textContent = ADVICE_APP;

function updateTip(mode) {
    const tip = $('record-tip');
    if (!tip) return;
    const text = IN_APP_BROWSER && ['idle', 'opening', 'recording', 'paused'].includes(mode) ? TIP_IN_APP
        : ['recording', 'paused'].includes(mode) ? (MEETING_APP ? TIP_RECORDING_APP : TIP_RECORDING) : '';
    if (tip.textContent !== text) tip.textContent = text;
    tip.dataset.tone = IN_APP_BROWSER ? 'warn' : '';
    tip.hidden = !text;
}

function updateControl(mode, startedAt) {
    const localMode = mode;
    updateTip(mode);
    if ((mode === 'idle' || mode === 'other') && liveRows.length) mode = 'remote';
    const recording = mode === 'recording', paused = mode === 'paused';
    $('meeting-control').dataset.phase = mode;
    const label = $('meeting-action-label');
    if (label.textContent !== actions[mode]) label.textContent = actions[mode];
    $('meeting-action').disabled = ['opening', 'saving', 'restoring'].includes(mode);
    $('start-icon').toggleAttribute('hidden', mode !== 'idle' && !paused);
    $('end-icon').toggleAttribute('hidden', !recording);
    $('record-live').hidden = !recording && !paused;
    $('paused-state').hidden = !paused;
    $('logout-button').disabled = busy.has(localMode) || localMode === 'retry';
    updateDeleteButtons(localMode);
    elapsedFrom = ['recording','paused'].includes(mode) ? startedAt : null;
    if (lastCaptureMode !== mode && ['recording','paused','saving','idle'].includes(mode)) {
        queueMicrotask(() => { if (!document.hidden && !detailId) refreshList(); });
    }
    lastCaptureMode = mode;
    updateClock();
}

const capture = new MeetingCapture({
    owner: document.body.dataset.owner,
    update: updateControl,
    meter: new MicrophoneMeter($('meeting-meter')),
    complete: async (id, interrupted, automatic) => {
        if (listRequest) await listRequest;
        await refreshList();
        if (!interrupted && !automatic && !document.hidden && !detailId) {
            if (cards.some(card => card.id === id)) $('action-status').textContent = '会议已保存';
            else notify('会议已保存，列表暂未更新。', 'warn');
        }
    },
    notice: notify,
});

const liveLabels = { starting: '等待收音', receiving: '正在接收录音', paused: '暂未收到录音', ending: '正在结束' };
function renderLive() {
    const box = $('live-meetings');
    const existing = new Map([...box.children].map(item => [item.dataset.key,item]));
    liveRows.forEach((row, index) => {
        let li = existing.get(row.id);
        if (!li) {
            li = document.createElement('li'); li.dataset.key = row.id;
            li.innerHTML = '<button class="live-row" type="button"><span class="live-main"><strong>进行中的会议</strong><small></small></span><span class="live-badge"></span><span aria-hidden="true">›</span></button>';
            li.firstElementChild.addEventListener('click', () => openLive(row.id));
        }
        li.querySelector('small').textContent = rowDateText(row.started_at);
        const phase = optimisticEnd === row.id ? 'ending' : row.phase;
        li.dataset.phase = phase; li.querySelector('.live-badge').textContent = liveLabels[phase] || '状态待更新';
        if (box.children[index] !== li) box.insertBefore(li,box.children[index] || null);
        existing.delete(row.id);
    });
    existing.forEach(li => li.remove()); box.hidden = !liveRows.length;
    if (liveSelected) syncLiveDialog();
}
function syncLiveDialog() {
    const row = liveRows.find(r => r.id === liveSelected);
    if (!row) {
        $('live-state').textContent = '会议已结束'; $('live-end').disabled = true;
        $('live-end').textContent = '已结束'; return;
    }
    $('live-date').textContent = rowDateText(row.started_at);
    const ending = row.phase === 'ending' || optimisticEnd === row.id;
    const until = row.meeting_ends_at && rowTime.format(new Date(row.meeting_ends_at));
    const state = ending ? '正在保存最后一段录音' : liveLabels[row.phase] || '状态待更新';
    const desc = ending || !until ? state : `${state} · ${until} 自动结束`;
    if ($('live-state').textContent !== desc) $('live-state').textContent = desc;
    $('live-end').disabled = ending || endInFlight;
    $('live-end').textContent = ending ? '正在结束…' : '结束会议';
}
function openLive(id) {
    liveSelected = id; $('live-feedback').hidden = true; syncLiveDialog();
    const d = $('live-dialog'); if (!d.open) d.showModal();
}
$('live-back').addEventListener('click', () => $('live-dialog').close());
$('live-dialog').addEventListener('close', () => { liveSelected = null; });
$('live-end').addEventListener('click', async () => {
    const id = liveSelected; if (!id || endInFlight) return;
    endInFlight = true; syncLiveDialog();
    try {
        if (capture.session?.id === id && ['recording','paused'].includes(capture.mode)) {
            capture.stop(); // Flush local queued chunks before asking the server to finalize.
        } else {
            await request(`/api/meetings/live/${encodeURIComponent(id)}/end`, {method:'POST', json:{}});
        }
        optimisticEnd = id;
        if (liveSelected === id) $('live-dialog').close();
        $('action-status').textContent = '正在结束会议';
        if (listRequest) await listRequest;
        await refreshList();
    } catch {
        if (liveSelected === id) { $('live-feedback').hidden = false; $('live-feedback').textContent = '未能确认是否结束，请检查网络后重试。'; }
    } finally { endInFlight = false; if (liveSelected) syncLiveDialog(); }
});

function createRow(id) {
    const item = document.createElement('li');
    item.dataset.id = id;
    const button = document.createElement('button');
    button.className = 'meeting-row';
    button.type = 'button';
    // These are fixed markup; all text received from the server uses textContent.
    button.innerHTML = '<span class="row-title"></span><span class="row-meta"><time class="row-time"></time><span class="status-pill" hidden></span></span>';
    button.addEventListener('click', () => {
        if (busy.has(capture.mode)) {
            notify('请先结束并保存当前会议，再查看其他记录。', 'warn');
            $('meeting-action').focus();
            return;
        }
        lastRowId = id;
        history.pushState({ meeting: id }, '', `#meeting-${id}`);
        navigate();
    });
    const remove = document.createElement('button');
    remove.className = 'row-delete';
    remove.type = 'button';
    remove.textContent = '删除';
    remove.addEventListener('click', () => openDelete(id, remove));
    item.append(button, remove);
    return item;
}

function renderList() {
    const existing = new Map([...list.children].map((item) => [Number(item.dataset.id), item]));
    cards.forEach((card, index) => {
        const item = existing.get(card.id) || createRow(card.id);
        const title = item.querySelector('.row-title');
        if (title.textContent !== card.title) title.textContent = card.title;
        const time = item.querySelector('time');
        if (!time.hasAttribute('datetime') || time.dateTime !== (card.date || '')) {
            time.dateTime = card.date || '';
            time.textContent = rowDateText(card.date);
            time.hidden = !time.textContent;
        }
        const badge = item.querySelector('.status-pill');
        if (badge.dataset.phase !== card.phase) {
            badge.dataset.phase = card.phase;
            badge.hidden = card.phase === 'ready';
            badge.textContent = badge.hidden ? '' : status[card.phase] || '状态待更新';
        }
        if (list.children[index] !== item) list.insertBefore(item, list.children[index] || null);
        existing.delete(card.id);
    });
    existing.forEach((item) => item.remove());
    updateDeleteButtons(capture.mode);
    const empty = !cards.length && !liveRows.length;
    const message = $('list-message');
    message.hidden = !empty;
    if (empty && message.textContent !== '暂无会议记录') message.textContent = '暂无会议记录';
    $('list-refresh').hidden = true;
    $('list-more').hidden = before === null;
}

function refreshList(older = false) {
    if (listRequest) return listRequest;
    if (older && before === null) return Promise.resolve();
    clearTimeout(listTimer);
    $('list-more').disabled = true;
    listRequest = (async () => {
        try {
            const result = await request(`/api/meetings${older ? `?before=${before}` : ''}`);
            liveRows = Array.isArray(result.live_meetings) ? result.live_meetings : [];
            if (optimisticEnd && !liveRows.some(row => row.id === optimisticEnd)) optimisticEnd = null;
            renderLive(); capture.syncLive(liveRows);
            if (capture.mode === 'idle' || capture.mode === 'other') updateControl(capture.mode);
            mayDelete = result.may_delete === true;
            if (older || !moreLoaded) before = result.next_before;
            const previous = moreLoaded && !older && result.meetings.length
                ? cards.filter((card) => card.id < result.meetings.at(-1).id) : [];
            const merged = older ? [...cards, ...result.meetings] : [...result.meetings, ...previous];
            cards = [...new Map(merged.map((card) => [card.id, card])).values()];
            if (older) moreLoaded = true;
            listLoaded = true;
            renderList();
        } catch (error) {
            if (!listLoaded || older || error.status === 401) {
                const message = $('list-message');
                message.hidden = false;
                if (error.status === 401) {
                    cards = []; liveRows = []; renderLive();
                    mayDelete = false;
                    before = null;
                    moreLoaded = false;
                    list.replaceChildren();
                    $('list-more').hidden = true;
                    const login = document.createElement('a');
                    login.href = loginHref;
                    login.textContent = '重新登录';
                    message.replaceChildren('登录已失效，请', login, '。');
                    $('list-refresh').hidden = true;
                } else {
                    message.textContent = '无法加载会议记录，请检查网络。';
                    $('list-refresh').hidden = false;
                }
            }
        } finally {
            $('list-more').disabled = false;
            listRequest = null;
            if (!document.hidden && !detailId) listTimer = setTimeout(refreshList, (liveRows.length || busy.has(capture.mode)) ? 3000 : cards.some((card) => pending.has(card.phase)) ? 4000 : 8000);
        }
    })();
    return listRequest;
}

function updateDeleteButtons(mode) {
    for (const [index, item] of [...list.children].entries()) {
        const button = item.querySelector('.row-delete');
        const card = cards[index];
        const processing = pending.has(card.phase);
        button.hidden = !mayDelete || processing;
        button.disabled = !card.deletion_identity || processing || mode !== 'idle' || deleting;
        const label = processing ? '整理完成后可删除' : mode !== 'idle' ? '请先完成当前会议' : `删除：${card.title}`;
        if (button.getAttribute('aria-label') !== label) {
            button.setAttribute('aria-label', label);
            button.title = label;
        }
    }
}

function openDelete(id, button) {
    const card = cards.find((entry) => entry.id === id);
    if (button.disabled || !card?.deletion_identity || deleting) return;
    deleteTarget = { card, button };
    $('library-feedback').textContent = '';
    const label = [card.title, dateText(card.date)].filter(Boolean).join(' · ');
    $('delete-target').textContent = label;
    $('delete-feedback').hidden = true;
    if (typeof deleteDialog.showModal === 'function') {
        deleteDialog.showModal();
    } else if (window.confirm(`删除「${label}」？录音、原文和摘要将一并删除，无法恢复。`)) {
        confirmDelete();
    } else {
        deleteTarget = null;
    }
}

function syncDeleteControls() {
    deleteCancel.disabled = deleting;
    deleteConfirm.disabled = deleting;
    deleteConfirm.textContent = deleting ? '正在删除…' : '确认删除';
    updateDeleteButtons(capture.mode);
}

async function confirmDelete() {
    if (!deleteTarget || deleting || capture.mode !== 'idle') return;
    const { card } = deleteTarget;
    deleting = true;
    $('delete-feedback').hidden = true;
    syncDeleteControls();
    let removed = false;
    try {
        const result = await request(`/api/meetings/${card.id}`, {
            method: 'DELETE', json: { identity: card.deletion_identity },
        });
        removed = result.success === true;
        if (!removed) throw new Error('Deletion not confirmed');
    } catch (error) {
        removed = error.status === 404;
        if (!removed) {
            const message = error.data?.error || (error.status === 401
                ? '登录已失效，请重新登录后再试。' : '暂时无法确认删除结果，请返回列表查看或稍后再试。');
            const box = $(deleteDialog.open ? 'delete-feedback' : 'library-feedback');
            box.textContent = message;
            box.hidden = false;
        }
    } finally {
        deleting = false;
        syncDeleteControls();
        if (removed) {
            if (listRequest) await listRequest;
            cards = cards.filter((entry) => entry.id !== card.id || entry.deletion_identity !== card.deletion_identity);
            renderList();
            $('library-feedback').textContent = '';
            $('action-status').textContent = '会议已删除';
            if (deleteDialog.open) deleteDialog.close();
            else deleteTarget = null;
            $('library-heading').focus();
            refreshList();
        } else if (!deleteDialog.open) {
            deleteTarget = null;
            refreshList();
        }
    }
}

deleteConfirm.addEventListener('click', confirmDelete);
deleteCancel.addEventListener('click', () => deleteDialog.close());
deleteDialog.addEventListener('cancel', (event) => { if (deleting) event.preventDefault(); });
deleteDialog.addEventListener('close', () => {
    if (deleteTarget?.button.isConnected && !deleteTarget.button.disabled) deleteTarget.button.focus();
    deleteTarget = null;
});

function renderTranscript(lines, container) {
    const fragment = document.createDocumentFragment();
    for (const line of lines || []) {
        const row = document.createElement('p');
        if (line.speaker || line.start != null) {
            const caption = document.createElement('strong');
            caption.className = 'speaker-line';
            caption.textContent = [line.speaker, line.start != null ? clockText(line.start) : null].filter(Boolean).join(' · ');
            row.append(caption);
        }
        row.append(line.text || '');
        fragment.append(row);
    }
    container.replaceChildren(fragment);
}

function resetAudio() {
    $('detail-audio').hidden = true;
    audio.hidden = true;
    $('audio-retry').hidden = true;
    $('audio-feedback').hidden = true;
    if (audio.hasAttribute('src')) {
        audio.pause();
        audio.removeAttribute('src');
        audio.load();
    }
}

function renderAudio(meeting) {
    const source = meeting.audio_url;
    if (!source) {
        resetAudio();
        if (meeting.phase !== 'saving' && !pending.has(meeting.phase)) {
            $('detail-audio').hidden = false;
            $('audio-feedback').textContent = '没有可播放的录音。';
            $('audio-feedback').hidden = false;
        }
        return;
    }
    $('detail-audio').hidden = false;
    if (audio.getAttribute('src') !== source) {
        audio.src = source;
        audio.hidden = false;
        $('audio-feedback').hidden = true;
        $('audio-retry').hidden = true;
    }
}

audio.addEventListener('error', () => {
    if (!audio.hasAttribute('src') || !audio.error) return;
    audio.hidden = true;
    $('audio-feedback').textContent = '暂时无法播放这段录音。';
    $('audio-feedback').hidden = false;
    $('audio-retry').hidden = false;
});
$('audio-retry').addEventListener('click', () => {
    if (!detail?.audio_url) return;
    resetAudio();
    renderAudio(detail);
    audio.load();
    audio.focus();
});

function renderDetail(meeting) {
    detail = meeting;
    renderAudio(meeting);
    const title = $('detail-title');
    if (title.textContent !== meeting.title) title.textContent = meeting.title;
    const date = $('detail-date');
    const hasDuration = meeting.duration > 0;
    const dateLabel = dateText(meeting.date);
    date.hidden = !dateLabel && !hasDuration;
    date.textContent = [dateLabel, hasDuration ? `时长 ${clockText(meeting.duration)}` : ''].filter(Boolean).join('　·　');
    const html = meeting.summary_html || '';
    $('minutes-section').hidden = !html;
    const message = $('detail-message');
    const lines = meeting.transcript || [];
    const progress = phaseText[meeting.phase] || '';
    if (message.textContent !== progress) message.textContent = progress;
    $('detail-retry').hidden = !meeting.retry;
    $('detail-retry').textContent = meeting.retry === 'transcription' ? '重新整理' : '生成会议摘要';
    $('transcript-section').hidden = !lines.length;
    const signature = `${meeting.id}/${meeting.phase}/${meeting.retry || ''}/${html}`;
    if (lastDetailView !== signature) {
        lastDetailView = signature;
        // This endpoint serves only a strict subset of server-sanitized document HTML.
        $('minutes-text').innerHTML = html;
        renderTranscript(lines, $('transcript-text'));
    }
}

async function refreshDetail(id = detailId) {
    if (!id) return;
    clearTimeout(detailTimer);
    const serial = ++detailSerial;
    try {
        const meeting = await request(`/api/meetings/${id}`);
        if (detailId !== id || serial !== detailSerial) return;
        renderDetail(meeting);
        if (!document.hidden && pending.has(meeting.phase)) detailTimer = setTimeout(refreshDetail, 3600);
    } catch (error) {
        if (detailId !== id || serial !== detailSerial) return;
        const box = $('detail-message');
        // Don't leave private text visible after a sign-out or a deletion.
        if (error.status === 401 || error.status === 404) {
            resetAudio();
            detail = null;
            lastDetailView = '';
            $('detail-title').textContent = '会议记录';
            for (const part of ['detail-date', 'minutes-section', 'transcript-section', 'detail-retry', 'detail-feedback']) $(part).hidden = true;
            $('minutes-text').replaceChildren();
            $('transcript-text').replaceChildren();
        }
        box.textContent = error.status === 404 ? '这条会议记录找不到了。' : '暂时打不开这条会议记录，正在重试。';
        if (error.status === 401) {
            const login = document.createElement('a');
            login.href = loginHref;
            login.textContent = '重新登录';
            box.replaceChildren('登录已失效，请', login, '。');
        } else if (error.status !== 404 && !document.hidden) {
            lastDetailView = '';
            detailTimer = setTimeout(refreshDetail, 6000);
        }
    }
}

function navigate() {
    const match = /^#meeting-(\d+)$/.exec(location.hash);
    const next = match ? Number(match[1]) : null;
    if (!Number.isSafeInteger(next) && next !== null) return;
    if (next === detailId) return;
    if (next && busy.has(capture.mode)) {
        history.replaceState(null, '', location.pathname + location.search);
        return;
    }
    const fromDetail = Boolean(detailId);
    resetAudio();
    detailId = next;
    detailSerial++;
    clearTimeout(detailTimer);
    $('meeting-home').hidden = Boolean(next);
    $('meeting-detail').hidden = !next;
    if (!next) {
        refreshList();
        const button = lastRowId && list.querySelector(`[data-id="${lastRowId}"] button`);
        if (fromDetail) (button || $('meeting-action')).focus();
        return;
    }
    clearTimeout(listTimer);
    lastDetailView = '';
    clearTimeout(copyTimer);
    $('copy-label').textContent = '复制摘要';
    detail = null;
    $('transcript-section').open = false;
    for (const id of ['detail-date', 'minutes-section', 'detail-retry', 'transcript-section', 'detail-feedback']) $(id).hidden = true;
    $('detail-title').textContent = cards.find((card) => card.id === next)?.title || '会议记录';
    $('detail-message').textContent = '正在加载…';
    window.scrollTo(0, 0);
    $('detail-title').focus({ preventScroll: true });
    refreshDetail();
}

$('meeting-options').addEventListener('click', () => options.showModal());
$('options-close').addEventListener('click', () => options.close());
$('meeting-action').addEventListener('click', () => {
    $('action-status').textContent = '';
    if ((capture.mode === 'idle' || capture.mode === 'other') && liveRows.length) openLive(liveRows[0].id);
    else capture.press();
});
$('list-refresh').addEventListener('click', () => refreshList());
$('list-more').addEventListener('click', () => refreshList(true));
$('detail-back').addEventListener('click', () => {
    if (history.state?.meeting === detailId) history.back();
    else {
        history.replaceState(null, '', location.pathname + location.search);
        navigate();
    }
});
window.addEventListener('popstate', navigate);
window.addEventListener('hashchange', navigate);

function feedback(text) {
    $('detail-feedback').textContent = text;
    $('detail-feedback').hidden = !text;
}

$('detail-retry').addEventListener('click', async () => {
    if (!detail?.retry) return;
    const { id, retry } = detail;
    const button = $('detail-retry');
    button.disabled = true;
    feedback('');
    try {
        await request(`/recording/${id}/reprocess_${retry}`, { method: 'POST', json: {} });
        if (detailId === id) await refreshDetail(id);
    } catch {
        if (detailId === id) feedback('这次没有提交成功，请稍后再试。');
    } finally {
        button.disabled = false;
    }
});

function plainMinutes() {
    const copy = $('minutes-text').cloneNode(true);
    for (const li of copy.querySelectorAll('li')) {
        const list = li.parentElement;
        const bullet = list.tagName === 'OL' ? `${[...list.children].indexOf(li) + 1}.` : '•';
        li.prepend(`${bullet} `);
    }
    // innerText preserves block boundaries only for rendered nodes.
    copy.className = 'copy-buffer';
    copy.removeAttribute('id');
    copy.setAttribute('aria-hidden', 'true');
    document.body.append(copy);
    const body = copy.innerText.trim();
    copy.remove();
    return [$('detail-title').textContent, dateText(detail?.date), body].filter(Boolean).join('\n\n');
}

function copied() {
    feedback('');
    $('copy-label').textContent = '已复制';
    $('action-status').textContent = '摘要已复制';
    clearTimeout(copyTimer);
    copyTimer = setTimeout(() => { $('copy-label').textContent = '复制摘要'; }, 2000);
}

$('copy-minutes').addEventListener('click', async () => {
    const id = detailId;
    const text = plainMinutes();
    try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(text);
        if (detailId === id) copied();
    } catch {
        if (detailId !== id) return;
        const input = document.createElement('textarea');
        input.value = text;
        input.className = 'copy-buffer';
        input.readOnly = true;
        document.body.append(input);
        input.select();
        input.setSelectionRange(0, text.length);
        let didCopy = false;
        try { didCopy = document.execCommand('copy'); } catch { /* blocked by the browser */ }
        input.remove();
        if (didCopy) {
            $('copy-minutes').focus();
            copied();
        } else {
            const range = document.createRange();
            range.selectNodeContents($('minutes-text'));
            window.getSelection()?.removeAllRanges();
            window.getSelection()?.addRange(range);
            feedback('已选中摘要，请手动复制。');
        }
    }
});

document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        clearTimeout(listTimer);
        clearTimeout(detailTimer);
    } else {
        updateClock();
        if (detailId) refreshDetail(); else refreshList();
    }
});
window.addEventListener('online', () => { if (detailId) refreshDetail(); else refreshList(); });
setInterval(updateClock, 1000);
navigate();
if (!detailId) refreshList();
capture.restore();
