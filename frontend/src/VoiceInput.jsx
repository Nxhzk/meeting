/* 小助理的语音模式（和豆包一样）：输入栏变成一整条「按住说话」，松开识别后直接发出，上滑取消。
   录一段短语音 → 发给服务器（/api/assistant/transcribe）→ 识别出的文字交给 onText（直接发送）。 */
import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { createPortal } from 'react-dom';
import { JstLoader } from './JstMark.jsx';
import { request } from './recording/api.js';

const MAX_MS = 60_000;          // 一次最多说一分钟
const MIN_MS = 600;             // 太短的当作误触
const CANCEL_DISTANCE = 70;     // 手指上滑这么多（像素）就是取消
const TYPES = ['audio/webm;codecs=opus', 'audio/mp4', 'audio/ogg;codecs=opus', 'audio/webm'];

function pickType() {
    if (typeof MediaRecorder === 'undefined') return null;
    return TYPES.find(type => MediaRecorder.isTypeSupported?.(type)) ?? '';
}

export function HoldToTalk({ disabled, blockedReason, onText, onError, onBusy }) {
    const [phase, setPhase] = useState('idle');     // idle | starting | recording | recognizing
    const [cancel, setCancel] = useState(false);
    const [elapsed, setElapsed] = useState(0);
    const [level, setLevel] = useState(0);
    const session = useRef(null);

    useEffect(() => () => session.current?.teardown(), []);
    useEffect(() => { onBusy?.(phase === 'recognizing'); }, [phase, onBusy]);

    async function begin(event) {
        if (disabled || phase !== 'idle') return;
        if (blockedReason) { onError(blockedReason); return; }
        const type = pickType();
        if (type === null || !navigator.mediaDevices?.getUserMedia) { onError('这个浏览器不支持语音输入。'); return; }
        try { event.currentTarget.setPointerCapture?.(event.pointerId); } catch { /* 拿不到指针也能录，只是手指滑出按钮后收不到移动 */ }
        const startY = event.clientY;
        const current = { startY, released: false, cancel: false };
        session.current = current;
        setPhase('starting'); setCancel(false); setElapsed(0); setLevel(0);
        let stream;
        try {
            stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
        } catch {
            session.current = null; setPhase('idle');
            onError('没有麦克风权限。请在系统设置里允许本应用使用麦克风。');
            return;
        }
        if (session.current !== current) { stream.getTracks().forEach(t => t.stop()); return; }
        if (current.released) {
            // 第一次会弹出权限对话框：手指早就松开了，这次不算
            stream.getTracks().forEach(t => t.stop());
            session.current = null; setPhase('idle');
            onError('已允许使用麦克风，请再按住说话。');
            return;
        }
        const chunks = [];
        const recorder = new MediaRecorder(stream, type ? { mimeType: type, audioBitsPerSecond: 32000 } : undefined);
        recorder.ondataavailable = e => { if (e.data.size) chunks.push(e.data); };
        // 音量条
        let audioContext, frame;
        try {
            audioContext = new AudioContext();
            const analyser = audioContext.createAnalyser();
            analyser.fftSize = 512;
            audioContext.createMediaStreamSource(stream).connect(analyser);
            const data = new Uint8Array(analyser.fftSize);
            const tick = () => {
                analyser.getByteTimeDomainData(data);
                let peak = 0;
                for (const v of data) peak = Math.max(peak, Math.abs(v - 128));
                setLevel(Math.min(1, peak / 64));
                setElapsed(performance.now() - current.startedAt);
                frame = requestAnimationFrame(tick);
            };
            frame = requestAnimationFrame(tick);
        } catch { /* 没有音量条也能录 */ }
        current.startedAt = performance.now();
        current.recorder = recorder;
        current.limit = setTimeout(() => finish(current), MAX_MS);
        current.teardown = () => {
            clearTimeout(current.limit);
            cancelAnimationFrame(frame);
            audioContext?.close().catch(() => {});
            stream.getTracks().forEach(t => t.stop());
            if (recorder.state !== 'inactive') { recorder.ondataavailable = null; recorder.onstop = null; try { recorder.stop(); } catch { /* 已停 */ } }
        };
        current.done = new Promise(resolve => { recorder.onstop = () => resolve(new Blob(chunks, { type: recorder.mimeType || type || 'audio/webm' })); });
        recorder.start();
        navigator.vibrate?.(15);
        setPhase('recording');
    }

    function move(event) {
        const current = session.current;
        if (!current) return;
        const cancelling = current.startY - event.clientY > CANCEL_DISTANCE;
        if (cancelling !== current.cancel) { current.cancel = cancelling; setCancel(cancelling); }
    }

    async function finish(current = session.current) {
        if (!current || current.finished) return;
        current.released = true;
        if (!current.recorder) return;          // 还在等麦克风：begin() 会处理
        current.finished = true;
        clearTimeout(current.limit);
        const duration = performance.now() - current.startedAt;
        if (current.recorder.state !== 'inactive') current.recorder.stop();
        const blob = await current.done;
        current.teardown();
        session.current = null;
        if (current.cancel) { setPhase('idle'); return; }
        if (duration < MIN_MS || blob.size < 800) { setPhase('idle'); onError('说话时间太短了。'); return; }
        setPhase('recognizing');
        try {
            const { text } = await request('/api/assistant/transcribe', { method: 'POST', blob, contentType: blob.type, timeout: 30000 });
            if (text?.trim()) onText(text.trim());
            else onError('没有听清，请再说一遍。');
        } catch (error) {
            onError(error.data?.error || '语音识别失败，请稍后再试。');
        } finally { setPhase('idle'); }
    }

    const holding = phase === 'starting' || phase === 'recording';
    const seconds = Math.floor(elapsed / 1000);
    return <>
        <button type="button" className={`hold-to-talk${holding ? ' holding' : ''}${cancel ? ' cancel' : ''}`} aria-label="按住说话"
            disabled={disabled || phase === 'recognizing'}
            onPointerDown={begin} onPointerMove={move} onPointerUp={() => finish()} onPointerCancel={() => { if (session.current) session.current.cancel = true; finish(); }}
            onContextMenu={event => event.preventDefault()}>
            {phase === 'recognizing' ? <><JstLoader size={18} tone="current" />正在识别…</>
                : holding ? (cancel ? '松开 取消' : '松开 发送') : '按住说话'}
        </button>
        {createPortal(<AnimatePresence>
            {holding && <motion.div key="voice" className={`voice-overlay${cancel ? ' cancel' : ''}`} role="status"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }} transition={{ duration: .15 }}>
                <motion.div className="voice-card glass glass-strong" initial={{ y: 24, scale: .94 }} animate={{ y: 0, scale: 1 }} exit={{ y: 16, scale: .96 }}>
                    {phase === 'starting' ? <JstLoader size={36} />
                        : <div className="voice-bars" aria-hidden="true">
                            {[.55, .8, 1, .8, .55].map((k, i) => <span key={i} style={{ transform: `scaleY(${.18 + Math.min(1, level * k * 1.6) * .82})` }} />)}
                        </div>}
                    <strong>{cancel ? '松开手指，取消发送' : phase === 'starting' ? '正在打开麦克风…' : '松开 发送，上滑 取消'}</strong>
                    {phase === 'recording' && <span className="voice-time">{seconds >= 50 ? `还能说 ${Math.max(0, 60 - seconds)} 秒` : `0:${String(seconds).padStart(2, '0')}`}</span>}
                </motion.div>
            </motion.div>}
        </AnimatePresence>, document.body)}
    </>;
}
