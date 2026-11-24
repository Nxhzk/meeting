export const meterLabels = {
    checking: '正在检测麦克风…',
    sound: '已收到声音',
    quiet: '暂未听到声音',
    muted: '麦克风暂不可用',
    unavailable: '无法检测音量',
};
const NOISE_FLOOR = 0.003;
const QUIET_AFTER_MS = 1500;
const SAMPLE_INTERVAL_MS = 65;

// Listen to the very same stream as MediaRecorder without playing or uploading it.
export class MicrophoneMeter {
    constructor(update) {
        this.update = update;
        this.context = null;
        this.source = null;
        this.timer = null;
    }

    prepare() {
        const AudioContextClass = window.AudioContext || window.webkitAudioContext;
        if (this.context || !AudioContextClass) return;
        try {
            this.context = new AudioContextClass();
            this.resume();
        } catch { /* The level display is optional; recording must still work. */ }
    }

    resume() {
        if (this.context && ['suspended', 'interrupted'].includes(this.context.state)) {
            this.context.resume().catch(() => {});
        }
    }

    display(state, level = 0) {
        const rounded = Number(level.toFixed(2));
        if (this.state === state && this.level === rounded) return;
        this.state = state;
        this.level = rounded;
        this.update({ state, level: rounded });
    }

    start(stream) {
        if (this.timer !== null) return;
        this.display('checking');
        try {
            const track = stream?.getAudioTracks()[0];
            if (!this.context || !track) return this.display('unavailable');
            const analyser = this.context.createAnalyser();
            analyser.fftSize = 2048;
            const buffer = new Float32Array(analyser.fftSize);
            this.source = this.context.createMediaStreamSource(stream);
            this.source.connect(analyser); // No connection to the speakers.
            this.resume();

            const started = performance.now();
            let lastSound = -Infinity;
            const tick = () => {
                if (document.hidden) return;
                const now = performance.now();
                const checking = now - started < QUIET_AFTER_MS;
                if (!track.enabled || track.muted || track.readyState !== 'live') {
                    lastSound = -Infinity;
                    return this.display('muted');
                }
                if (this.context.state !== 'running') {
                    lastSound = -Infinity;
                    return this.display(checking ? 'checking' : 'unavailable');
                }
                analyser.getFloatTimeDomainData(buffer);
                let sum = 0;
                let squares = 0;
                for (const sample of buffer) {
                    sum += sample;
                    squares += sample * sample;
                }
                // Ignore DC offset and very faint background noise.
                const rms = Math.sqrt(Math.max(0, squares / buffer.length - (sum / buffer.length) ** 2));
                if (rms > NOISE_FLOOR) lastSound = now;
                const level = Math.min(1, 4.5 * Math.sqrt(Math.max(0, rms - NOISE_FLOOR)));
                this.display(now - lastSound < QUIET_AFTER_MS ? 'sound' : checking ? 'checking' : 'quiet', level);
            };
            tick();
            this.timer = window.setInterval(tick, SAMPLE_INTERVAL_MS);
        } catch {
            this.stop();
            this.display('unavailable');
        }
    }

    stop() {
        window.clearInterval(this.timer);
        this.timer = null;
        this.source?.disconnect();
        this.source = null;
        const context = this.context;
        this.context = null;
        if (context && context.state !== 'closed') context.close().catch(() => {});
        this.display('checking');
    }
}
