import { request } from './api.js?v=5';
import { clearChunks, dropChunk, readChunks, stageChunk } from './spool.js';

const BASE = '/upload/session';
const CHUNK_MS = 5000;
const MAX_MEETING_MS = 60 * 60 * 1000;
const LATE_DATA_MS = 2000;
const SESSION_ID = /^[a-z0-9-]{16,64}$/i;
const MIME_TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus'];
// How many times one interruption may reopen the microphone on its own
// before the meeting waits for a tap on 「继续录音」.
const AUTO_RESUME_TRIES = 3;
const AUTO_RESUME_DELAY_MS = 600;
const sessionPath = (id) => `${BASE}/${encodeURIComponent(id)}`;
const gapText = (ms) => {
    const seconds = Math.max(1, Math.round(ms / 1000));
    return seconds < 60 ? `${seconds} 秒` : `${Math.floor(seconds / 60)} 分${seconds % 60 ? ` ${seconds % 60} 秒` : '钟'}`;
};

export class MeetingCapture {
    constructor({ owner, update, complete, notice, meter }) {
        this.key = `speakr.meeting-draft.v1.${owner}`;
        this.update = update;
        this.complete = complete;
        this.notice = notice;
        this.meter = meter;
        this.mode = 'idle';
        this.queue = [];
        this.failures = 0;
        this.sequence = 0;
        this.release = null;
        this.pausedAt = null;
        this.autoResumeTries = 0;
        window.addEventListener('online', () => {
            this.checkDeadline();
            if (this.session && ['recording', 'paused', 'saving', 'retry'].includes(this.mode)) this.resume();
        });
        const returned = () => {
            if (document.hidden || !['recording','paused'].includes(this.mode) || this.checkDeadline()) return;
            if (this.mode === 'paused') return this.autoResume();
            this.keepScreenOn();
            this.meter?.resume();
        };
        document.addEventListener('visibilitychange', () => {
            if (!document.hidden) return returned();
            if (this.checkDeadline() || this.recorder?.state !== 'recording') return;
            // Commit the current slice when the phone is about to background the page.
            try { if (this.recorder.state === 'recording') this.recorder.requestData(); } catch { /* The browser may pause capture. */ }
        });
        window.addEventListener('pageshow', returned);
        window.addEventListener('focus', returned);
        window.addEventListener('storage', (event) => {
            if (event.key === this.key && ['idle', 'other'].includes(this.mode)) this.restore();
        });
        this.beforeUnload = (event) => {
            event.preventDefault();
            event.returnValue = '';
        };
    }

    show(mode) {
        const wasBusy = ['opening', 'recording', 'paused', 'saving'].includes(this.mode);
        const isBusy = ['opening', 'recording', 'paused', 'saving'].includes(mode);
        if (wasBusy && !isBusy) window.removeEventListener('beforeunload', this.beforeUnload);
        if (!wasBusy && isBusy) window.addEventListener('beforeunload', this.beforeUnload);
        this.mode = mode;
        if (mode === 'recording') this.keepScreenOn();
        else if (this.screenLock) {
            this.screenLock.release().catch(() => {});
            this.screenLock = null;
        }
        this.update(mode, this.session?.startedAt);
        if (mode === 'recording') this.meter?.start(this.stream);
        else if (mode !== 'opening') this.meter?.stop();
    }

    async keepScreenOn() {
        if (this.screenLock || this.screenLockPending || !navigator.wakeLock || document.hidden) return;
        this.screenLockPending = true;
        try {
            const lock = await navigator.wakeLock.request('screen');
            if (this.mode !== 'recording') return await lock.release();
            this.screenLock = lock;
            lock.addEventListener('release', () => { if (this.screenLock === lock) this.screenLock = null; });
        } catch { /* Older browsers and battery-saving mode can decline. */ }
        finally { this.screenLockPending = false; }
    }

    pointer() {
        try {
            const data = JSON.parse(localStorage.getItem(this.key));
            return data && SESSION_ID.test(data.id) ? data : null;
        } catch {
            return null;
        }
    }

    savePointer() {
        try {
            localStorage.setItem(this.key, JSON.stringify(this.session));
        } catch { /* The active page can still upload without local storage. */ }
    }

    forget(id) {
        try {
            if (this.pointer()?.id === id) localStorage.removeItem(this.key);
        } catch { /* best effort */ }
    }

    async lock() {
        if (this.release || !navigator.locks) return true;
        return new Promise((resolve) => {
            navigator.locks.request(this.key, { ifAvailable: true }, (lock) => {
                if (!lock) return resolve(false);
                return new Promise((release) => {
                    this.release = release;
                    resolve(true);
                });
            }).catch(() => resolve(!this.pointer()));
        });
    }

    unlock() {
        this.release?.();
        this.release = null;
    }

    // The phone paused the microphone while this page stayed open (screen
    // locked, app switched, a call came in). Reopen it as soon as the page is
    // in front again, into the same meeting, so nobody has to tap 「继续录音」.
    // A reloaded page still waits for a tap: restore() never sets pausedAt.
    autoResume() {
        clearTimeout(this.autoResumeTimer);
        if (!this.pausedAt || this.mode !== 'paused' || !this.session || this.session.ended) return;
        if (this.autoResumeTries >= AUTO_RESUME_TRIES) return;
        this.autoResumeTimer = setTimeout(() => {
            if (document.hidden || this.mode !== 'paused' || !this.pausedAt || this.checkDeadline()) return;
            this.autoResumeTries += 1;
            this.start({ automatic: true });
        }, AUTO_RESUME_DELAY_MS);
    }

    async press() {
        clearTimeout(this.autoResumeTimer);
        if (this.mode === 'idle' || this.mode === 'paused') return this.start();
        if (this.mode === 'recover') return this.restore(false);
        if (this.mode === 'recording') return this.checkDeadline() || this.stop();
        if (this.mode === 'retry' || this.mode === 'other') return this.restore(true);
    }

    async start({ automatic = false } = {}) {
        if (!automatic) this.notice('');
        if (!window.isSecureContext) {
            this.notice('这个地址不能打开麦克风。请使用本机地址或受信任的 HTTPS 地址。', 'error');
            return;
        }
        if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
            this.notice('这个浏览器不能开启会议。请用新版 Safari、Chrome 或 Edge 打开。', 'error');
            return;
        }
        const resuming = this.mode === 'paused' && this.session;
        this.show('opening');
        // Unlock Web Audio within the user gesture on mobile browsers.
        this.meter?.prepare();
        try {
            if (!await this.lock()) return this.show('other');
            if (!resuming && this.pointer()) return this.restore(false);
            this.stream = await navigator.mediaDevices.getUserMedia({ audio: true, video: false });
            const chosen = (resuming && this.session.mime) || MIME_TYPES.find((type) => MediaRecorder.isTypeSupported?.(type));
            const options = { audioBitsPerSecond: 64000 };
            if (chosen) options.mimeType = chosen;
            let recorder;
            try { recorder = new MediaRecorder(this.stream, options); }
            catch (error) {
                if (error.name !== 'NotSupportedError' || !chosen) throw error;
                recorder = new MediaRecorder(this.stream);
            }
            const mime = (recorder.mimeType || chosen || '').split(';')[0].toLowerCase();
            if (!mime) throw new DOMException('Unsupported recording format', 'NotSupportedError');
            const opened = resuming ? await request(sessionPath(this.session.id))
                : await request(BASE, { method: 'POST', json: { mime_type: mime, meeting_mode: true } });
            if (!SESSION_ID.test(opened.session_id)) throw new Error('Invalid recording session');
            if (resuming && (opened.status !== 'recording' || opened.end_requested || opened.meeting_remaining_ms <= 0)) {
                this.closeMic();
                if (opened.status === 'recording') { this.show('paused'); this.stop({ automatic: opened.meeting_remaining_ms <= 0 }); }
                else this.finish(opened.finalized_recording_id || null, '这场会议已经结束。');
                return;
            }
            if (resuming && mime !== opened.mime_type) throw new DOMException('Changed recording format','NotSupportedError');
            const budget = Number.isFinite(opened.meeting_remaining_ms)
                ? Math.min(MAX_MEETING_MS, Math.max(0, opened.meeting_remaining_ms)) : MAX_MEETING_MS;
            const startedAt = resuming ? this.session.startedAt : Date.now();
            this.session = { ...(resuming ? this.session : {}), id: opened.session_id, startedAt, endsAt: Date.now() + budget,
                mime, ended: false, interrupted: Boolean(resuming) };
            this.monotonicEnd = performance.now() + budget;
            this.discardTail = false;
            this.savePointer();
            if (!resuming) { this.sequence = 0; this.queue = []; }
            this.failures = 0;
            this.recorder = recorder;
            recorder.addEventListener('dataavailable', ({ data }) => {
                if (this.session?.id !== opened.session_id) return;
                // Some browsers deliver one big blob after the phone wakes.
                // Do not upload clearly late audio from a suspended tab.
                this.checkDeadline();
                if (data.size && !this.discardTail) {
                    const chunk = { index: ++this.sequence, blob: data };
                    stageChunk(opened.session_id, chunk);
                    this.queue.push(chunk);
                    this.pump();
                }
            });
            recorder.addEventListener('stop', () => this.onStop(opened.session_id), { once: true });
            recorder.addEventListener('error', () => this.pauseInput(recorder), { once: true });
            for (const track of this.stream.getAudioTracks()) {
                track.addEventListener('ended', () => this.pauseInput(recorder), { once: true });
                track.addEventListener('mute', () => {
                    if (this.mode !== 'recording' || this.session?.id !== opened.session_id) return;
                    this.session.interrupted = true;
                    this.savePointer();
                    this.notice('麦克风暂时中断。请回到会议页面保持亮屏，已录下的内容会保留，回来后会自动接着录。', 'warn');
                });
                track.addEventListener('unmute', () => {
                    if (this.mode === 'recording' && this.session?.id === opened.session_id) {
                        this.notice('麦克风已恢复，中断期间可能有漏录。', 'warn');
                    }
                });
            }
            recorder.start(CHUNK_MS);
            this.show('recording');
            if (resuming && this.pausedAt) {
                this.notice(`已接着录音。中间约 ${gapText(Date.now() - this.pausedAt)}没录到。`, 'warn');
            } else if (resuming) {
                this.notice('');
            }
            this.pausedAt = null;
            this.autoResumeTries = 0;
            this.scheduleDeadline();
            this.pump();
        } catch (error) {
            this.closeMic();
            if (resuming) {
                this.recorder = null;
                this.show('paused');
                this.notice(automatic && this.autoResumeTries < AUTO_RESUME_TRIES
                    ? '没能自动接着录音，下次回到本页会再试一次；也可以点「继续录音」。'
                    : '麦克风暂时不能使用。会议仍保留，可点「继续录音」重试，也可在列表结束会议。', 'warn');
                this.scheduleDeadline();
                return;
            }
            if (this.session) {
                // Only a newly opened, empty session can reach this branch.
                const { id } = this.session;
                request(sessionPath(id), { method: 'DELETE' }).catch(() => {});
                this.forget(id);
                this.session = null;
            }
            this.recorder = null;
            this.unlock();
            this.show('idle');
            let text = '暂时无法开始会议，请确认网络连接后再试。';
            if (error.status === 401) text = '登录已失效，请刷新页面重新登录。';
            else if (['NotAllowedError', 'SecurityError'].includes(error.name)) text = '麦克风未获允许。请在浏览器里允许使用麦克风，再点「开始会议」。';
            else if (['NotFoundError', 'NotReadableError', 'OverconstrainedError'].includes(error.name)) text = '无法使用麦克风。请检查麦克风是否已连接，或是否被其他软件占用。';
            else if (error.name === 'NotSupportedError') text = '浏览器不支持当前的录音格式，请换用 Safari、Chrome 或 Edge。';
            else if ([413, 507].includes(error.status)) text = '会议存储空间不足，请联系管理员。';
            this.notice(text, 'error');
        }
    }

    timeRemaining() {
        return Math.min(this.session.endsAt - Date.now(), this.monotonicEnd - performance.now());
    }

    scheduleDeadline() {
        clearTimeout(this.deadlineTimer);
        const remaining = this.timeRemaining();
        if (!this.checkDeadline()) {
            this.deadlineTimer = setTimeout(() => this.scheduleDeadline(), Math.max(1, remaining));
        }
    }

    checkDeadline() {
        if (!['recording','paused'].includes(this.mode) || !this.session) return false;
        const remaining = this.timeRemaining();
        if (remaining > 0) return false;
        this.stop({ automatic: true, discardTail: remaining < -LATE_DATA_MS });
        return true;
    }

    stop({ interrupted = false, automatic = false, discardTail = false } = {}) {
        if (!['recording','paused'].includes(this.mode) || !this.session) return;
        clearTimeout(this.deadlineTimer);
        clearTimeout(this.autoResumeTimer);
        this.pausedAt = null;
        this.discardTail = discardTail;
        this.session.ended = true;
        this.session.interrupted ||= interrupted || discardTail;
        this.session.automatic = automatic;
        this.savePointer();
        this.show('saving');
        if (this.recorder && this.recorder.state !== 'inactive') this.recorder.stop();
        else if (!this.recorder) this.resume(); // A paused meeting has no further stop event.
    }

    pauseInput(recorder) {
        if (this.recorder !== recorder || this.session?.ended || recorder.state === 'inactive') return;
        try { recorder.stop(); } catch { /* A native stop event is already pending. */ }
    }

    onStop(id) {
        if (this.session?.id !== id) return;
        clearTimeout(this.deadlineTimer);
        if (!this.session.ended) {
            // A browser/OS can stop the input while the meeting itself is still live.
            this.recorder = null;
            this.session.interrupted = true;
            this.closeMic();
            this.savePointer();
            this.show('paused');
            this.pausedAt ||= Date.now();
            this.autoResumeTries = 0;
            this.notice(document.hidden
                ? '收音被手机暂停了，会议没有结束。回到本页会自动接着录。'
                : '麦克风已暂停，会议没有结束。正在自动接着录…', 'warn');
            this.scheduleDeadline();
            this.pump();
            this.autoResume();
            return;
        }
        this.recorder = null;
        this.closeMic();
        this.show('saving');
        this.resume();
    }

    closeMic() {
        this.stream?.getTracks().forEach((track) => track.stop());
        this.stream = null;
    }

    resume() {
        clearTimeout(this.timer);
        this.timer = null;
        this.failures = 0;
        if (this.mode === 'retry') this.show('saving');
        this.pump();
    }

    async pump() {
        if (this.pumping || this.timer || !this.session) return;
        this.pumping = true;
        const id = this.session.id;
        const path = sessionPath(id);
        try {
            while (this.queue.length) {
                const chunk = this.queue[0];
                try {
                    await request(`${path}/chunks/${chunk.index}`, { method: 'POST', blob: chunk.blob, timeout: 20000 });
                } catch (error) {
                    // The server may have written the chunk even if its ACK
                    // was lost. Only advance for an explicit in-order reply.
                    if (error.status === 409 && error.data?.meeting_closed) {
                        const automatic = Boolean(error.data.meeting_limit_reached);
                        this.stop({ automatic, discardTail: true });
                        this.session.automatic ||= automatic;
                        this.session.interrupted ||= chunk.index > error.data.chunk_count;
                        this.savePointer();
                        this.discardTail = true;
                        for (const queued of this.queue) dropChunk(id, queued);
                        this.queue = [];
                        this.sequence = error.data.chunk_count || 0;
                        this.session.finalizing = ['finalizing', 'finalized', 'failed'].includes(error.data.status);
                        if (['aborted', 'expired'].includes(error.data.status) || (!this.sequence && !this.session.finalizing)) {
                            this.finish(null, automatic ? '会议已到一小时，但没有收到可保存的录音。' : '这场会议已结束，没有可继续保存的录音。');
                            return;
                        }
                        break;
                    }
                    if (error.status !== 409 || !(error.data?.expected_chunk_index > chunk.index)) throw error;
                }
                this.queue.shift();
                dropChunk(id, chunk);
                if (this.failures && this.mode === 'recording') this.notice('');
                this.failures = 0;
            }
            // MediaRecorder sends its last dataavailable before stop.
            if (this.session.ended && !this.recorder) {
                if (!this.sequence && !this.session.finalizing) {
                    await request(`/api/meetings/live/${encodeURIComponent(id)}/end`, { method: 'POST', json: {} });
                    this.finish(null, this.session.automatic
                        ? '会议已到一小时，但没有收到可保存的录音。' : '没有收到会议声音，请重新开始会议。');
                    return;
                }
                try {
                    const result = await request(`${path}/finalize`, { method: 'POST', json: { meeting_mode: true } });
                    if (!Number.isSafeInteger(result.recording_id)) throw new Error('Missing meeting id');
                    this.finish(result.recording_id);
                } catch (error) {
                    if (error.status !== 409) throw error;
                    // A lost finalize response may arrive after the worker
                    // has already stitched the file and started transcribing.
                    const status = await request(path);
                    if (!Number.isSafeInteger(status.finalized_recording_id) || !['finalized', 'failed'].includes(status.status)) throw error;
                    this.finish(status.finalized_recording_id);
                }
            }
        } catch (error) {
            this.failures += 1;
            const login = error.status === 401;
            if (['recording','paused'].includes(this.mode)) {
                this.notice(login ? '登录已失效。请在另一个标签页重新登录，再回到这里。' : '连接不稳，正在保留已录下的内容。请先不要关闭网页。', 'warn');
            } else {
                this.show('retry');
                this.notice(login ? '登录已失效。请在另一个标签页重新登录，再点「重试保存」。' : '暂时没能保存。请检查网络，连接恢复后会自动重试。', 'warn');
            }
            const delay = login ? 12000 : Math.min(12000, 1200 * 2 ** Math.min(this.failures - 1, 4));
            this.timer = setTimeout(() => {
                this.timer = null;
                if (this.mode === 'retry') this.show('saving');
                this.pump();
            }, delay);
        } finally {
            this.pumping = false;
        }
    }

    async restore(submit = false) {
        // Keep the in-memory queue when this tab already has a pending save.
        if (this.mode === 'retry' && this.session) return this.resume();
        if (this.mode === 'restoring') return;
        const draft = this.pointer();
        if (!draft) {
            this.unlock();
            this.show('idle');
            return;
        }
        this.show('restoring');
        try {
            if (!await this.lock()) return this.show('other');
            if (this.pointer()?.id !== draft.id) {
                this.unlock();
                return this.show('idle');
            }
            const remote = await request(sessionPath(draft.id));
            const timedOut = !draft.ended && remote.meeting_remaining_ms === 0;
            if (Number.isSafeInteger(remote.finalized_recording_id) && ['finalized', 'failed'].includes(remote.status)) {
                this.session = { ...draft, automatic: draft.automatic || timedOut,
                    interrupted: draft.interrupted || timedOut };
                return this.finish(remote.finalized_recording_id);
            }
            if (!['recording', 'finalizing'].includes(remote.status)) {
                this.session = draft;
                return this.finish(null, timedOut
                    ? '会议已到一小时，但没有收到可保存的录音。' : '没有可继续保存的会议，可以开始新的会议。');
            }
            this.queue = [];
            this.sequence = remote.chunk_count || 0;
            let gap = false;
            if (remote.status === 'recording') {
                for (const chunk of await readChunks(draft.id)) {
                    if (chunk.index <= this.sequence) continue;
                    if (chunk.index !== this.sequence + 1) { gap = true; break; }
                    this.queue.push(chunk);
                    this.sequence = chunk.index;
                }
            }
            if (!submit && !draft.ended && !timedOut && remote.status === 'recording' && !remote.end_requested) {
                // Reopening the tab never starts the microphone without a gesture,
                // nor does it silently finish the server-side meeting.
                if (gap) throw new Error('Local audio sequence gap');
                const budget = Math.max(0, Math.min(MAX_MEETING_MS, remote.meeting_remaining_ms));
                this.session = { ...draft, ended: false, interrupted: true, mime: remote.mime_type, endsAt: Date.now() + budget };
                this.monotonicEnd = performance.now() + budget;
                this.savePointer(); this.show('paused'); this.scheduleDeadline(); this.pump();
                return;
            }
            this.session = { ...draft, ended: true, automatic: draft.automatic || timedOut,
                interrupted: draft.interrupted || !draft.ended || gap, finalizing: remote.status === 'finalizing' };
            this.savePointer();
            this.show('saving');
            this.resume();
        } catch (error) {
            if (error.status === 404) {
                this.session = draft;
                this.finish(null, '上次未完成的会议已不在，可重新开始。');
                return;
            }
            this.show('recover');
            this.notice(error.status === 401 ? '请重新登录，再继续保存上次会议。' : '暂时连不上服务器。请检查网络，再继续保存上次会议。', 'warn');
        }
    }

    syncLive(rows) {
        const id = this.session?.id;
        if (!id || !['recording','paused'].includes(this.mode)) return;
        const row = rows.find(row => row.id === id);
        if (row?.end_requested) { this.stop(); return; }
        // A list response may predate creation. Confirm absence by ID before stopping.
        if (row || this.checkingRemote) return;
        this.checkingRemote = true;
        request(sessionPath(id)).then(state => {
            if (this.session?.id !== id || !['recording','paused'].includes(this.mode)) return;
            if (state.status !== 'recording') this.finish(state.finalized_recording_id || null, '会议已结束。');
            else if (state.end_requested) this.stop();
        }).catch(() => {}).finally(() => { this.checkingRemote = false; });
    }

    finish(id, message) {
        const draft = this.session;
        clearTimeout(this.deadlineTimer);
        clearTimeout(this.autoResumeTimer);
        this.pausedAt = null;
        this.closeMic();
        clearTimeout(this.timer);
        this.timer = null;
        this.recorder = null;
        this.session = null;
        if (draft) for (const chunk of this.queue) dropChunk(draft.id, chunk);
        this.queue = [];
        if (draft) {
            this.forget(draft.id);
            clearChunks(draft.id);
        }
        this.unlock();
        this.show('idle');
        const result = draft?.automatic && id
            ? (draft.interrupted ? '已到一小时，已保存收到的录音。中断期间可能有漏录。' : '已到一小时，会议已自动结束并保存。')
            : draft?.interrupted ? '已保存能找回的内容，摘要可能不完整。' : '';
        this.notice(message || result, draft?.interrupted || message ? 'warn' : 'good');
        if (id) this.complete(id, Boolean(draft?.interrupted), Boolean(draft?.automatic));
    }
}
