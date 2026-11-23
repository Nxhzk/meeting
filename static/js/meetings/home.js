import { request } from './api.js?v=5';
import { MeetingCapture } from './capture.js?v=5';
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
const status = {
    saving: '正在保存', waiting: '等待整理', transcribing: '正在识别发言', summarizing: '正在生成纪要',
    ready: '纪要已生成', asr_pending: '录音已保存', failed: '整理未成功', no_minutes: '暂无纪要', too_short: '内容太少',
};
const pending = new Set(['saving', 'waiting', 'transcribing', 'summarizing']);
const busy = new Set(['opening', 'recording', 'saving']);
const buttons = {
    idle: ['准备开会', summaryReady ? '结束会议后自动生成纪要，最长录制 1 小时。' : transcriptionReady ? '会议结束后会转成文字，自动纪要暂未开通。' : '现在可以记录会议，转写暂未开通。', '开始会议', true],
    opening: ['正在准备', '如果浏览器询问是否使用麦克风，请点「允许」。', '正在打开麦克风…', false],
    recording: ['会议进行中', '到一小时会自动结束。为避免漏录，请保持页面打开，不要手动锁屏。', '结束会议', true],
    saving: ['会议已结束', '正在保存刚才的会议，请先不要关闭网页。', '正在保存…', false],
    retry: ['会议尚未保存', summaryReady ? '保存后，纪要就会自动生成。' : transcriptionReady ? '保存后会自动转成文字。' : '请先保存录音，转写暂未开通。', '重试保存', true],
    restoring: ['正在检查上次会议', '请稍等片刻。', '正在检查…', false],
    recover: ['有一场未完成的会议', transcriptionReady ? '可把已保留的内容整理成纪要。' : '可以继续保存已记录的发言。', '保存上次会议', true],
    other: ['另一个标签页正在开会', '请回到原来的标签页结束会议。', '重新检查', true],
};
const phaseText = {
    saving: '正在保存会议，保存后会自动整理。',
    waiting: transcriptionReady ? '会议已保存，正在等待整理。您可以先去忙别的。' : '会议已保存，转写暂未开通。',
    asr_pending: '录音已保存。转写开通后，可回到这里点「重新整理」。',
    transcribing: summaryReady ? '正在把发言转成文字，接下来会生成纪要。' : '正在把发言转成文字，完成后可查看原文。',
    summarizing: '正在生成会议纪要，完成后会自动显示在这里。',
    failed: '这次没能整理完成。',
    no_minutes: summaryReady ? '这场会议暂时没有纪要。' : '自动纪要暂未开通，您可以查看发言原文。',
    too_short: '这次能识别到的发言太少，没有生成纪要。',
};
const loginHref = document.body.dataset.loginUrl;
let cards = [];
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
    $('meeting-clock').hidden = mode !== 'recording';
    $('site-footer').toggleAttribute('inert', busy.has(mode) || mode === 'retry');
    updateDeleteButtons(mode);
    elapsedFrom = mode === 'recording' ? startedAt : null;
    updateClock();
}

const capture = new MeetingCapture({
    owner: document.body.dataset.owner,
    update: updateControl,
    meter: new MicrophoneMeter($('meeting-meter')),
    complete: async (id, interrupted, automatic) => {
        if (!interrupted && !automatic) notify(summaryReady ? '会议已保存，纪要会自动生成。您可以稍后回来查看。' : transcriptionReady ? '会议已保存。您可以稍后回来查看发言原文。' : '会议已保存。转写暂未开通，录音会保留。');
        if (listRequest) await listRequest;
        await refreshList();
        if (!document.hidden && !detailId && !interrupted && !automatic && !cards.some((card) => card.id === id)) {
            notify(summaryReady ? '会议已保存。请稍后重新打开网页查看纪要。' : '会议已保存。请稍后重新打开网页查看记录。');
        }
    },
    notice: notify,
});

function createRow(id) {
    const item = document.createElement('li');
    item.dataset.id = id;
    const button = document.createElement('button');
    button.className = 'meeting-row';
    button.type = 'button';
    // These are fixed markup; all text received from the server uses textContent.
    button.innerHTML = '<span class="row-content"><span class="row-title"></span><time class="row-date"></time></span><span class="status-pill"></span><svg class="row-arrow" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="m6 3.5 4.5 4.5L6 12.5"/></svg>';
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
        if (time.dateTime !== (card.date || '')) {
            time.dateTime = card.date || '';
            time.textContent = dateText(card.date);
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
    $('list-message').hidden = cards.length > 0;
    $('list-message').textContent = cards.length ? '' : '暂无会议记录。点击「开始会议」即可记录。';
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
                    cards = [];
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
                    message.textContent = '暂时读不到会议记录，请检查网络后再试。';
                    $('list-refresh').hidden = false;
                }
            }
        } finally {
            $('list-more').disabled = false;
            listRequest = null;
            if (!document.hidden && !detailId) listTimer = setTimeout(refreshList, cards.some((card) => pending.has(card.phase)) ? 4000 : 18000);
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
    } else if (window.confirm(`删除「${label}」？录音、发言原文和纪要会一并删除，无法恢复。`)) {
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
    const duration = meeting.duration > 0 ? ` · ${clockText(meeting.duration)}` : '';
    const dateLabel = dateText(meeting.date);
    date.hidden = !dateLabel;
    date.textContent = dateLabel + duration;
    const html = meeting.summary_html || '';
    $('minutes-section').hidden = !html;
    const message = $('detail-message');
    const lines = meeting.transcript || [];
    const progress = (phaseText[meeting.phase] || '') + (lines.length && !html ? ' 已识别的文字可在下方查看。' : '');
    if (message.textContent !== progress) message.textContent = progress;
    $('detail-retry').hidden = !meeting.retry;
    $('detail-retry').textContent = meeting.retry === 'transcription' ? '重新整理' : '生成会议纪要';
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

$('meeting-action').addEventListener('click', () => capture.press());
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
            feedback('浏览器没有允许自动复制。已选中纪要，可手动复制。');
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
