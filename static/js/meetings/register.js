import { request } from './api.js?v=5';
import { MeetingCapture } from './register-capture.js?v=jst-live-4';
import { MicrophoneMeter } from './mic-meter.js';

const $ = (id) => document.getElementById(id);
const list = $('meeting-list');
const audio = $('meeting-audio');
const deleteDialog = $('delete-dialog');
const deleteConfirm = $('delete-confirm');
const deleteCancel = $('delete-cancel');
const transcriptionReady = document.body.dataset.transcriptionReady !== 'no';
const summaryReady = transcriptionReady && document.body.dataset.summaryReady !== 'no';
const dateFormat = new Intl.DateTimeFormat('zh-CN', {
    year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});
const rowMonth = new Intl.DateTimeFormat('zh-CN', { month: 'numeric' });
const rowTime = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });
const status = {
    saving: '正在保存', waiting: '等待整理', transcribing: '正在识别发言', summarizing: '正在生成摘要',
    ready: '摘要已生成', asr_pending: '录音已保存', failed: '整理未成功', no_minutes: '暂无摘要', too_short: '内容太少',
};
const pending = new Set(['saving', 'waiting', 'transcribing', 'summarizing']);
const busy = new Set(['opening', 'recording', 'paused', 'saving']);
const buttons = {
    idle: ['准备开会', summaryReady ? '结束会议后，自动生成会议摘要。' : transcriptionReady ? '结束后会转成文字，自动摘要暂未开通。' : '可以先录音，语音转写暂未开通。', '开始会议', true],
    opening: ['正在准备', '如果浏览器询问是否使用麦克风，请点「允许」。', '正在打开麦克风…', false],
    recording: ['会议进行中', '切到后台不会结束会议。锁屏可能暂停麦克风，请留意录音状态。', '结束会议', true],
    paused: ['会议仍在进行', '麦克风已暂停。可以继续录音，或在下方列表结束会议。', '继续录音', true],
    remote: ['已有会议在进行', '下方可查看收音状态，也可以从这台设备结束会议。', '查看当前会议', true],
    saving: ['会议已结束', '正在保存刚才的会议，请先不要关闭网页。', '正在保存…', false],
    retry: ['会议尚未保存', summaryReady ? '保存后，摘要就会自动生成。' : transcriptionReady ? '保存后会自动转成文字。' : '请先保存录音，转写暂未开通。', '重试保存', true],
    restoring: ['正在检查上次会议', '请稍等片刻。', '正在检查…', false],
    recover: ['上次会议待恢复', '请先检查网络，再点一下重新连接。', '重新连接', true],
    other: ['另一个标签页正在开会', '可在这里的会议列表查看状态或结束会议。', '重新检查', true],
};
const phaseText = {
    saving: '正在保存会议，保存后会自动整理。',
    waiting: transcriptionReady ? '会议已保存，正在等待整理。您可以先去忙别的。' : '会议已保存，转写暂未开通。',
    asr_pending: '录音已保存。转写开通后，可回到这里点「重新整理」。',
    transcribing: summaryReady ? '正在把发言转成文字，接下来会生成摘要。' : '正在把发言转成文字，完成后可查看原文。',
    summarizing: '正在生成会议摘要，完成后会自动显示在这里。',
    failed: '这次没能整理完成。',
    no_minutes: summaryReady ? '这场会议暂时没有摘要。' : '自动摘要暂未开通，您可以查看发言原文。',
    too_short: '这次能识别到的发言太少，没有生成摘要。',
};
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

function updateControl(mode, startedAt) {
    const localMode = mode;
    if (mode === 'idle' && liveRows.length) mode = 'remote';
    const [title, hint, label, enabled] = buttons[mode];
    $('meeting-control').dataset.phase = mode;
    $('meeting-heading').textContent = title;
    $('meeting-hint').textContent = hint;
    $('meeting-action-label').textContent = label;
    $('meeting-action').disabled = !enabled;
    // SVGElement does not implement HTMLElement.hidden.
    $('start-icon').toggleAttribute('hidden', mode !== 'idle');
    $('end-icon').toggleAttribute('hidden', mode !== 'recording');
    $('consent-note').hidden = mode !== 'idle';
    $('meeting-clock').hidden = !['recording','paused'].includes(mode);
    $('site-footer').toggleAttribute('inert', busy.has(mode) || mode === 'retry');
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
        if (!interrupted && !automatic) notify(summaryReady ? '会议已保存，摘要会自动生成。您可以稍后回来查看。' : transcriptionReady ? '会议已保存。您可以稍后回来查看发言原文。' : '会议已保存。转写暂未开通，录音会保留。');
        if (listRequest) await listRequest;
        await refreshList();
        if (!document.hidden && !detailId && !interrupted && !automatic && !cards.some((card) => card.id === id)) {
            notify(summaryReady ? '会议已保存。请稍后重新打开网页查看摘要。' : '会议已保存。请稍后重新打开网页查看记录。');
        }
    },
    notice: notify,
});

const liveLabels = { starting: '等待首段录音', receiving: '正在接收录音', paused: '最近未收到录音', ending: '正在结束会议' };
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
        li.querySelector('small').textContent = `${dateText(row.started_at)} 开始`;
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
        $('live-state').textContent = '会议已结束。'; $('live-description').hidden = true; $('live-end').disabled = true;
        $('live-end').textContent = '已结束'; return;
    }
    $('live-description').hidden = false;
    $('live-date').textContent = `${dateText(row.started_at)} 开始`;
    const ending = row.phase === 'ending' || optimisticEnd === row.id;
    const until = row.meeting_ends_at && rowTime.format(new Date(row.meeting_ends_at));
    const text = {starting: '还没有收到录音。', receiving: '正在接收录音。', paused: '最近没有收到音频，会议仍保留。', ending: '正在结束，等待最后的录音片段。'};
    const desc = (text[ending ? 'ending' : row.phase] || '') + (ending || !until ? '' : ` 最迟 ${until} 自动结束。`);
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
        notify('正在结束会议并保存已收到的录音。');
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
    button.innerHTML = '<span class="row-stamp" aria-hidden="true"><span class="row-day"></span><span class="row-month"></span></span><span class="row-title"></span><time class="row-time"><span class="row-hour" aria-hidden="true"></span><span class="row-full-date sr-only"></span></time><span class="status-pill"></span><svg class="row-arrow" viewBox="0 0 20 20" fill="none" stroke="currentColor" stroke-linecap="round" stroke-linejoin="round" stroke-width="1.5" aria-hidden="true"><path d="m8 5 5 5-5 5"/></svg>';
    button.addEventListener('click', () => {
        if (busy.has(capture.mode)) {
            notify(capture.mode === 'recording' ? '请先结束当前会议，再查看之前的会议记录。' : '请稍等，当前会议保存后就可以查看记录。', 'warn');
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
            const date = new Date(card.date || '');
            const valid = !Number.isNaN(date.getTime());
            item.querySelector('.row-day').textContent = valid ? String(date.getDate()).padStart(2, '0') : '—';
            item.querySelector('.row-month').textContent = valid ? rowMonth.format(date) : '';
            const hour = valid ? rowTime.format(date) : '';
            time.querySelector('.row-hour').textContent = valid && date.getFullYear() !== new Date().getFullYear() ? `${date.getFullYear()} · ${hour}` : hour;
            time.querySelector('.row-full-date').textContent = dateText(card.date);
            time.hidden = !valid;
        }
        const badge = item.querySelector('.status-pill');
        if (badge.dataset.phase !== card.phase) {
            badge.dataset.phase = card.phase;
            badge.textContent = status[card.phase] || '状态待更新';
        }
        if (list.children[index] !== item) list.insertBefore(item, list.children[index] || null);
        existing.delete(card.id);
    });
    existing.forEach((item) => item.remove());
    updateDeleteButtons(capture.mode);
    const count = $('library-count');
    count.hidden = false;
    const total = cards.length + liveRows.length;
    count.textContent = before === null ? `共 ${total} 场` : `已显示 ${total} 场`;
    $('list-message').dataset.empty = String(!cards.length);
    $('list-message').hidden = cards.length > 0 || liveRows.length > 0;
    $('list-message').textContent = cards.length ? '' : '还没有会议记录。第一场会议结束后，可在这里查看。';
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
            if (capture.mode === 'idle') updateControl('idle');
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
                delete message.dataset.empty;
                if (error.status === 401) {
                    cards = []; liveRows = []; renderLive();
                    mayDelete = false;
                    before = null;
                    moreLoaded = false;
                    list.replaceChildren();
                    $('library-count').hidden = true;
                    $('list-more').hidden = true;
                    const login = document.createElement('a');
                    login.href = loginHref;
                    login.textContent = '重新登录';
                    message.replaceChildren('登录已失效，请', login, '。');
                    $('list-refresh').hidden = true;
                } else {
                    message.textContent = '暂时读不到会议记录，请检查网络后再试。';
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
        button.hidden = !mayDelete;
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
    } else if (window.confirm(`删除「${label}」？录音、发言原文和摘要会一并删除，无法恢复。`)) {
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
            $('library-feedback').textContent = '这条会议记录已移除。';
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
            $('audio-feedback').textContent = '这条记录没有可播放的录音。';
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
    const progress = (phaseText[meeting.phase] || '') + (lines.length && !html ? ' 已识别的文字可在下方查看。' : '');
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
    detail = null;
    $('transcript-section').open = false;
    for (const id of ['detail-date', 'minutes-section', 'detail-retry', 'transcript-section', 'detail-feedback']) $(id).hidden = true;
    $('detail-title').textContent = cards.find((card) => card.id === next)?.title || '会议记录';
    $('detail-message').textContent = '正在打开会议记录…';
    window.scrollTo(0, 0);
    $('detail-title').focus({ preventScroll: true });
    refreshDetail();
}

$('meeting-action').addEventListener('click', () => {
    if (capture.mode === 'idle' && liveRows.length) openLive(liveRows[0].id);
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

$('copy-minutes').addEventListener('click', async () => {
    const id = detailId;
    const text = plainMinutes();
    try {
        if (!navigator.clipboard?.writeText) throw new Error('Clipboard unavailable');
        await navigator.clipboard.writeText(text);
        if (detailId === id) feedback('已复制，可以粘贴到微信或文档。');
    } catch {
        if (detailId !== id) return;
        const input = document.createElement('textarea');
        input.value = text;
        input.className = 'copy-buffer';
        input.readOnly = true;
        document.body.append(input);
        input.select();
        input.setSelectionRange(0, text.length);
        let copied = false;
        try { copied = document.execCommand('copy'); } catch { /* blocked by the browser */ }
        input.remove();
        if (copied) {
            $('copy-minutes').focus();
            feedback('已复制，可以粘贴到微信或文档。');
        } else {
            const range = document.createRange();
            range.selectNodeContents($('minutes-text'));
            window.getSelection()?.removeAllRanges();
            window.getSelection()?.addRange(range);
            feedback('浏览器没有允许自动复制。已选中摘要，可手动复制。');
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
