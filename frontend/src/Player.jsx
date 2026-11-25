import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Icon, clockText, speakerColor, spring } from './ui.jsx';
import { apiUrl } from './recording/api.js';

/* 录音播放器：真实波形（后端 /audio/<id>/peaks）、拖动/点击定位、
   ±15 秒、倍速、下载。<audio> 只做解码，界面全部自绘。 */

const SPEEDS = [1, 1.25, 1.5, 2];
const BAR = 3;
const GAP = 2;
const STEP = BAR + GAP;
const PER_SEC = 4;                 // 磁带模式：每秒 4 根柱
const PX_PER_SEC = STEP * PER_SEC;  // = 20px/秒
const TAPE_AFTER = 120;            // 超过 2 分钟用磁带模式
const H = 56;

/** 解析峰值文件：MAGIC(4) + uint32 头长度 + JSON 头 + 各级 int8 (min,max) 对。 */
function decodePeaks(buffer) {
    const view = new DataView(buffer);
    const length = view.getUint32(4, true);
    const header = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 8, length)));
    const start = 8 + length;
    return {
        duration: header.duration,
        levels: header.levels.map(level => ({
            length: level.length,
            pairs: new Int8Array(buffer, start + level.offset, level.length * 2),
        })),
    };
}

/** 把峰值压成 count 根柱子（0~1）：每段取最大振幅，按 95% 分位数归一化
 *  （远场录音整体偏小、偶有尖峰），再压缩动态范围，让说话段落清楚可见。 */
function bars(peaks, count) {
    if (!peaks || !count) return null;
    const level = [...peaks.levels].reverse().find(l => l.length >= count) || peaks.levels[0];
    const out = new Float32Array(count);
    const per = level.length / count;
    for (let i = 0; i < count; i++) {
        let peak = 0;
        const from = Math.floor(i * per);
        const to = Math.max(from + 1, Math.floor((i + 1) * per));
        for (let j = from; j < to && j < level.length; j++) {
            peak = Math.max(peak, Math.abs(level.pairs[j * 2]), Math.abs(level.pairs[j * 2 + 1]));
        }
        out[i] = peak / 127;
    }
    const sorted = Float32Array.from(out).sort();
    const ref = sorted[Math.floor(sorted.length * .95)] || sorted[sorted.length - 1] || 1;
    for (let i = 0; i < count; i++) out[i] = Math.min(1, Math.pow(out[i] / ref, 0.65));
    return out;
}

/** 没有峰值时的装饰波形（固定种子，不随机跳动）。 */
function placeholder(count, seed) {
    const out = new Float32Array(count);
    let x = seed || 7;
    for (let i = 0; i < count; i++) {
        x = (x * 1103515245 + 12345) & 0x7fffffff;
        const envelope = 0.45 + 0.35 * Math.sin(i / count * Math.PI * 3 + seed);
        out[i] = Math.max(.12, envelope * (0.5 + (x % 1000) / 2000));
    }
    return out;
}

function usePeaks(recordingId) {
    const [peaks, setPeaks] = useState(null);
    useEffect(() => {
        if (!recordingId) return;
        let alive = true;
        let timer;
        let tries = 0;
        const load = async () => {
            try {
                const response = await fetch(apiUrl(`/audio/${recordingId}/peaks`), { credentials: 'same-origin', cache: 'no-store' });
                if (!alive) return;
                if (response.status === 202 && tries++ < 15) { timer = setTimeout(load, 2000); return; }
                if (response.status !== 200) return;
                setPeaks(decodePeaks(await response.arrayBuffer()));
            } catch { /* 用装饰波形 */ }
        };
        load();
        return () => { alive = false; clearTimeout(timer); };
    }, [recordingId]);
    return peaks;
}

function cssColors(node) {
    const style = getComputedStyle(node);
    const read = name => style.getPropertyValue(name).trim();
    return { a: read('--wave-a'), b: read('--wave-b'), base: read('--fill-2'), label: read('--label'), sub: read('--label-3'), card: read('--card') };
}

function setupCanvas(canvas, width, height) {
    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
        canvas.width = Math.round(width * dpr);
        canvas.height = Math.round(height * dpr);
        canvas.style.width = `${width}px`;
        canvas.style.height = `${height}px`;
    }
    const ctx = canvas.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, width, height);
    return ctx;
}

function drawBar(ctx, x, level, height, mid) {
    const h = Math.max(3, level * height);
    ctx.beginPath();
    ctx.roundRect ? ctx.roundRect(x, mid - h / 2, BAR, h, BAR / 2) : ctx.rect(x, mid - h / 2, BAR, h);
    ctx.fill();
}

function clockShort(seconds) {
    const m = Math.floor(seconds / 60);
    const h = Math.floor(m / 60);
    return h ? `${h}:${String(m % 60).padStart(2, '0')}:${String(Math.floor(seconds % 60)).padStart(2, '0')}` : `${m}:${String(Math.floor(seconds % 60)).padStart(2, '0')}`;
}

// ------------------------------------------------------------ 实时字幕
// 只显示说话原文，去掉单独的语气词和口头禅；长句按播放进度只显示当前分句。
const FILLER = /(^|[，,。.！!？?、\s])(?:嗯+|啊+|呃+|额+|哦+|噢+|唉+|哎+|诶+|欸+|那个|就是说|然后呢|对对对?|是吧)(?=[，,。.！!？?、\s]|$)/g;

function tidy(text) {
    let out = text;
    for (let i = 0; i < 3; i++) out = out.replace(FILLER, '$1');
    out = out.replace(/^[，,。.、\s]+/, '').replace(/[，,、\s]{2,}/g, '，').replace(/([\u4e00-\u9fff]{2,6})\1+/g, '$1').trim();
    return /[\u4e00-\u9fffA-Za-z0-9]/.test(out) ? out : '';
}

function clauses(text) {
    const parts = text.match(/[^，,。！!？?；;]+[，,。！!？?；;]?/g) || [text];
    // 把太短的分句并到前一句，避免字幕一闪而过
    const merged = [];
    for (const part of parts) {
        if (merged.length && (merged.at(-1).length < 8 || part.length < 4)) merged[merged.length - 1] += part;
        else merged.push(part);
    }
    return merged;
}

function useCaption(lines, seconds) {
    const prepared = useMemo(() => (lines || [])
        .map(line => ({ ...line, text: tidy(line.text || ''), t0: line.t0 ?? line.start, t1: line.t1 }))
        .filter(line => line.text && line.t0 != null)
        .map((line, i, all) => ({ ...line, t1: line.t1 ?? all[i + 1]?.t0 ?? line.t0 + 6, parts: clauses(line.text) })), [lines]);
    return useMemo(() => {
        if (!prepared.length) return null;
        let lo = 0, hi = prepared.length - 1, hit = -1;
        while (lo <= hi) {
            const mid = (lo + hi) >> 1;
            if (prepared[mid].t0 <= seconds) { hit = mid; lo = mid + 1; } else hi = mid - 1;
        }
        if (hit < 0) return { idle: true, line: prepared[0], part: prepared[0].parts[0], key: 'pre' };
        const line = prepared[hit];
        if (seconds > line.t1 + 2.5) return { gap: true, line, part: '', key: `gap-${hit}` };
        const progress = Math.min(.999, Math.max(0, (seconds - line.t0) / Math.max(.5, line.t1 - line.t0)));
        const total = line.parts.reduce((n, p) => n + p.length, 0);
        let acc = 0, index = 0;
        for (; index < line.parts.length - 1; index++) {
            acc += line.parts[index].length;
            if (acc / total > progress) break;
        }
        return { line, part: line.parts[index], key: `${hit}-${index}` };
    }, [prepared, seconds]);
}

function Captions({ lines, seconds, active }) {
    const caption = useCaption(lines, seconds);
    if (!caption) return null;
    const speaker = caption.line?.speaker;
    const silent = caption.idle || caption.gap;
    return <div className="captions" data-active={active} aria-live="off">
        <AnimatePresence mode="popLayout" initial={false}>
            <motion.div key={silent ? 'silent' : caption.key} className="caption" initial={{ opacity: 0, y: 12, filter: 'blur(6px)' }}
                animate={{ opacity: 1, y: 0, filter: 'blur(0px)' }} exit={{ opacity: 0, y: -10, filter: 'blur(6px)' }}
                transition={{ duration: .32, ease: [.3, .7, .4, 1] }}>
                {silent ? <span className="caption-silence" aria-label="此处无人说话"><i /><i /><i /></span>
                    : <>{speaker && <span className="caption-speaker" style={{ color: speakerColor(speaker) }}>{speaker}</span>}
                        <span className="caption-text">{caption.part}</span></>}
            </motion.div>
        </AnimatePresence>
    </div>;
}

export function Player({ src, recordingId, fallbackDuration, lines }) {
    const audio = useRef(null);
    const wave = useRef(null);
    const canvas = useRef(null);
    const mini = useRef(null);
    const [width, setWidth] = useState(0);
    const [playing, setPlaying] = useState(false);
    const [waiting, setWaiting] = useState(false);
    const [error, setError] = useState(false);
    const [duration, setDuration] = useState(fallbackDuration || 0);
    const [time, setTime] = useState(0);
    const [speed, setSpeed] = useState(1);
    const [scrub, setScrub] = useState(null);   // 拖动中的位置（秒）
    const [scheme, setScheme] = useState(0);
    const [live, setLive] = useState(0);   // 字幕用的当前时间（播放中每 250ms 更新）
    const drag = useRef(null);
    const peaks = usePeaks(recordingId);
    const total = duration || peaks?.duration || 0;
    const tape = total > TAPE_AFTER;
    const fitCount = Math.max(24, Math.floor((width + GAP) / STEP));
    const count = tape ? Math.max(1, Math.ceil(total * PER_SEC)) : fitCount;
    const levels = useMemo(() => bars(peaks, count) || (total ? placeholder(count, recordingId % 97) : new Float32Array(count)), [peaks, count, recordingId, total]);
    const overview = useMemo(() => tape ? (bars(peaks, Math.max(24, Math.floor(width / 3))) || placeholder(Math.max(24, Math.floor(width / 3)), recordingId % 89)) : null,
        [tape, peaks, width, recordingId]);
    const real = Boolean(peaks);

    useEffect(() => {
        const node = wave.current;
        if (!node) return;
        const observer = new ResizeObserver(([entry]) => setWidth(Math.floor(entry.contentRect.width)));
        observer.observe(node);
        const media = matchMedia('(prefers-color-scheme: dark)');
        const change = () => setScheme(n => n + 1);
        media.addEventListener('change', change);
        return () => { observer.disconnect(); media.removeEventListener('change', change); };
    }, []);

    // 画一帧：fit 模式按比例着色；磁带模式以播放头为中心滚动
    const paint = useCallback(seconds => {
        const node = canvas.current;
        if (!node || !width) return;
        const colors = cssColors(node);
        const ctx = setupCanvas(node, width, H);
        const mid = H / 2;
        const gradient = ctx.createLinearGradient(0, 0, width, 0);
        gradient.addColorStop(0, colors.a);
        gradient.addColorStop(1, colors.b);
        if (!tape) {
            const cut = total ? (seconds / total) * width : 0;
            levels.forEach((level, i) => {
                const x = i * STEP;
                ctx.fillStyle = x + BAR / 2 <= cut ? gradient : colors.base;
                drawBar(ctx, x, level, 50, mid);
            });
        } else {
            const center = width / 2;
            const offset = seconds * PX_PER_SEC - center;
            // 贯穿的基线：录音开头之前和结尾之后也看得出轨道
            ctx.fillStyle = colors.base;
            ctx.fillRect(0, mid - 7 - .5, width, 1);
            const first = Math.max(0, Math.floor(offset / STEP) - 1);
            const last = Math.min(levels.length - 1, Math.ceil((offset + width) / STEP) + 1);
            for (let i = first; i <= last; i++) {
                const x = i * STEP - offset;
                ctx.fillStyle = x + BAR / 2 <= center ? gradient : colors.base;
                drawBar(ctx, x, levels[i], 34, mid - 7);
            }
            // 时间刻度：每 5 秒一格，每 15 秒标时间
            ctx.fillStyle = colors.sub;
            ctx.font = '10px -apple-system, system-ui, sans-serif';
            ctx.textAlign = 'center';
            const from = Math.max(0, Math.floor((offset) / PX_PER_SEC / 5) * 5);
            for (let t = from; t * PX_PER_SEC - offset <= width + 20 && t <= total; t += 5) {
                const x = t * PX_PER_SEC - offset;
                if (x < -20) continue;
                ctx.fillRect(x, H - 6, 1, t % 15 === 0 ? 5 : 3);
                if (t % 15 === 0 && Math.abs(x - center) > 22) ctx.fillText(clockShort(t), x, H - 8);
            }
        }
        // 缩略条
        const strip = mini.current;
        if (tape && strip && overview) {
            const sw = width;
            const sctx = setupCanvas(strip, sw, 20);
            const per = sw / overview.length;
            const playedX = total ? (seconds / total) * sw : 0;
            overview.forEach((level, i) => {
                const x = i * per;
                sctx.fillStyle = x <= playedX ? colors.a : colors.base;
                const h = Math.max(2, level * 16);
                sctx.fillRect(x, 10 - h / 2, Math.max(1, per - 1), h);
            });
            const span = (width / PX_PER_SEC) / total * sw;
            sctx.strokeStyle = colors.label;
            sctx.globalAlpha = .55;
            sctx.lineWidth = 1.5;
            sctx.beginPath();
            sctx.roundRect ? sctx.roundRect(Math.max(0.75, playedX - span / 2), 0.75, Math.min(sw - 1.5, span), 18.5, 5) : sctx.rect(playedX - span / 2, 0.75, span, 18.5);
            sctx.stroke();
            sctx.globalAlpha = 1;
        }
    }, [width, tape, total, levels, overview, scheme]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!playing) { paint(scrub ?? time); return; }
        let frame;
        const tick = () => {
            const node = audio.current;
            if (node && scrub == null) paint(node.currentTime);
            frame = requestAnimationFrame(tick);
        };
        frame = requestAnimationFrame(tick);
        return () => cancelAnimationFrame(frame);
    }, [playing, paint, scrub, time]);

    useEffect(() => { if (audio.current) audio.current.playbackRate = speed; }, [speed]);
    useEffect(() => {
        if (!playing) return;
        const timer = setInterval(() => setLive(audio.current?.currentTime || 0), 250);
        return () => clearInterval(timer);
    }, [playing]);

    const clamp = seconds => Math.min(total, Math.max(0, seconds));
    const seek = seconds => {
        const node = audio.current;
        if (!node || !total) return;
        const value = clamp(seconds);
        node.currentTime = value;
        setTime(value);
        paint(value);
    };
    const toggle = () => {
        const node = audio.current;
        if (!node) return;
        if (node.paused) {
            setError(false);
            node.play().catch(() => setError(true));
        } else node.pause();
    };

    // 波形上的拖动：fit 模式点哪到哪；磁带模式拖动带着波形走（像拨磁带）
    const onPointerDown = event => {
        if (!total) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        const rect = wave.current.getBoundingClientRect();
        const x = event.clientX - rect.left;
        const startTime = scrub ?? (audio.current?.currentTime || time);
        drag.current = { x0: event.clientX, t0: startTime, moved: false, rectLeft: rect.left };
        if (!tape) {
            const at = clamp((x / rect.width) * total);
            setScrub(at);
            paint(at);
        }
    };
    const onPointerMove = event => {
        const state = drag.current;
        if (!state) return;
        const dx = event.clientX - state.x0;
        if (Math.abs(dx) > 3) state.moved = true;
        const at = tape ? clamp(state.t0 - dx / PX_PER_SEC) : clamp(((event.clientX - state.rectLeft) / width) * total);
        if (tape && !state.moved) return;
        setScrub(at);
        paint(at);
    };
    const onPointerUp = event => {
        const state = drag.current;
        drag.current = null;
        if (!state) return;
        if (tape && !state.moved) {
            // 轻点：跳到点的位置
            seek(state.t0 + (event.clientX - state.rectLeft - width / 2) / PX_PER_SEC);
        } else if (scrub != null) seek(scrub);
        setScrub(null);
    };
    const onMini = event => {
        const rect = mini.current.getBoundingClientRect();
        seek(((event.clientX - rect.left) / rect.width) * total);
    };
    const onKey = event => {
        const step = { ArrowLeft: -5, ArrowRight: 5, PageDown: -30, PageUp: 30 }[event.key];
        if (step) { event.preventDefault(); seek((scrub ?? time) + step); }
        if (event.key === 'Home') { event.preventDefault(); seek(0); }
        if (event.key === 'End') { event.preventDefault(); seek(total); }
        if (event.key === ' ') { event.preventDefault(); toggle(); }
    };

    const shown = scrub ?? (playing ? live : time);
    if (error && !total) {
        return <div className="player-card group player-broken" role="status">
            <span className="player-broken-icon"><Icon name="waveform" /></span>
            <span className="player-broken-text"><strong>无法播放这段录音</strong><small>文件可能已损坏或格式不支持</small></span>
            <button type="button" className="btn btn-gray btn-small" onClick={() => { setError(false); audio.current?.load(); }}>重试</button>
            <audio ref={audio} src={src} preload="metadata" hidden onError={() => setError(true)}
                onLoadedMetadata={event => { if (Number.isFinite(event.currentTarget.duration)) { setDuration(event.currentTarget.duration); setError(false); } }} />
        </div>;
    }
    const bubbleLeft = tape ? '50%' : (total ? `${(shown / total) * 100}%` : '0%');

    return <div className="player-card group" data-playing={playing} data-tape={tape}>
        <audio ref={audio} src={src} preload="metadata"
            onLoadedMetadata={event => Number.isFinite(event.currentTarget.duration) && setDuration(event.currentTarget.duration)}
            onDurationChange={event => Number.isFinite(event.currentTarget.duration) && setDuration(event.currentTarget.duration)}
            onPlay={() => { setLive(audio.current?.currentTime || 0); setPlaying(true); }} onPause={() => { setPlaying(false); setTime(audio.current?.currentTime || 0); }}
            onEnded={() => { setPlaying(false); setTime(0); paint(0); }}
            onWaiting={() => setWaiting(true)} onPlaying={() => setWaiting(false)} onCanPlay={() => setWaiting(false)}
            onTimeUpdate={event => { if (!playing) setTime(event.currentTarget.currentTime); }}
            onSeeked={event => { setTime(event.currentTarget.currentTime); setLive(event.currentTarget.currentTime); }}
            onError={() => { setError(true); setPlaying(false); }} />

        <div className="player-main">
            <motion.button type="button" className="play-button" onClick={toggle} aria-label={playing ? '暂停' : '播放'}
                whileTap={{ scale: .9 }} transition={spring}>
                <span className="play-halo" aria-hidden="true" />
                <AnimatePresence mode="popLayout" initial={false}>
                    <motion.span key={waiting && playing ? 'w' : playing ? 'p' : 'r'} className="play-icon"
                        initial={{ scale: .4, opacity: 0, rotate: -40 }} animate={{ scale: 1, opacity: 1, rotate: 0 }}
                        exit={{ scale: .4, opacity: 0, rotate: 40 }} transition={spring}>
                        {waiting && playing ? <span className="spinner light" /> : <Icon name={playing ? 'pauseSolid' : 'play'} />}
                    </motion.span>
                </AnimatePresence>
            </motion.button>

            <div className="wave-column">
            <div className="wave" ref={wave} role="slider" tabIndex={0} aria-label="播放进度"
                aria-valuemin={0} aria-valuemax={Math.round(total)} aria-valuenow={Math.round(shown)}
                aria-valuetext={`${clockText(shown)} / ${clockText(total)}`}
                onPointerDown={onPointerDown} onPointerMove={onPointerMove} onPointerUp={onPointerUp}
                onPointerCancel={() => { drag.current = null; setScrub(null); }}
                onKeyDown={onKey} data-real={real} data-tape={tape}>
                <canvas ref={canvas} key={`${real}-${tape}`} className="wave-canvas" aria-hidden="true" />
                {tape ? <span className="wave-center" aria-hidden="true"><i /></span> : null}
                {!tape && <span className="wave-head" aria-hidden="true" style={{ transform: `translateX(${total ? (shown / total) * width : 0}px)` }}><i /></span>}
                <AnimatePresence>
                    {scrub != null && <motion.span className="wave-bubble glass glass-strong" key="b" style={{ left: bubbleLeft }}
                        initial={{ opacity: 0, y: 6, scale: .8 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, scale: .8 }}
                        transition={spring}>{clockText(scrub)}</motion.span>}
                </AnimatePresence>
            </div>
            {tape && <canvas ref={mini} className="wave-mini" onClick={onMini} aria-hidden="true" />}
            </div>
        </div>

        <div className="player-bar">
            <span className="player-time">{clockText(shown)}</span>
            <div className="player-tools">
                <motion.button type="button" className="tool" aria-label="后退 15 秒" onClick={() => seek(shown - 15)} whileTap={{ scale: .85, rotate: -25 }}><Icon name="back15" /></motion.button>
                <motion.button type="button" className="speed" aria-label={`播放速度 ${speed} 倍`} whileTap={{ scale: .9 }}
                    onClick={() => setSpeed(SPEEDS[(SPEEDS.indexOf(speed) + 1) % SPEEDS.length])}>
                    <AnimatePresence mode="popLayout" initial={false}>
                        <motion.span key={speed} initial={{ y: 10, opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: -10, opacity: 0 }} transition={spring}>
                            {speed}×
                        </motion.span>
                    </AnimatePresence>
                </motion.button>
                <motion.button type="button" className="tool" aria-label="前进 15 秒" onClick={() => seek(shown + 15)} whileTap={{ scale: .85, rotate: 25 }}><Icon name="fwd15" /></motion.button>
                <a className="tool" href={`${src}${src.includes('?') ? '&' : '?'}download=true`} aria-label="下载录音"><Icon name="download" /></a>
            </div>
            <span className="player-time end">-{clockText(Math.max(0, total - shown))}</span>
        </div>
        {/* 字幕栏：开始播放后从控制条下展开；暂停时留着最后一句（调暗）；回到开头或播完收起 */}
        <AnimatePresence initial={false}>
            {lines?.length > 0 && (playing || scrub != null || time > 0) && <motion.div key="captions" className="captions-wrap"
                initial={{ height: 0, opacity: 0 }} animate={{ height: 'auto', opacity: 1 }} exit={{ height: 0, opacity: 0 }}
                transition={{ duration: .4, ease: [.3, .7, .4, 1] }}>
                <Captions lines={lines} seconds={shown} active={playing || scrub != null} />
            </motion.div>}
        </AnimatePresence>
        {error && <p className="player-note" role="status">暂时无法播放这段录音。<button type="button" className="source-link" onClick={() => { setError(false); audio.current?.load(); }}>重新加载</button></p>}
    </div>;
}
