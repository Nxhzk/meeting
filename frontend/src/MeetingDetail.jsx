import { useEffect, useRef, useState } from 'react';
import { Icon, clockText, dateText } from './ui.jsx';
import { request } from './recording/api.js';

export const labels = {
    saving: '正在保存', waiting: '等待整理', transcribing: '正在转写', summarizing: '正在生成摘要',
    asr_pending: '等待转写', failed: '整理失败', no_minutes: '暂无摘要', too_short: '发言太少',
};
export const processing = new Set(['saving', 'waiting', 'transcribing', 'summarizing']);
const phaseText = { ...labels, asr_pending: '录音已保存，等待转写。', too_short: '发言太少，未生成摘要。' };

function AudioPanel({ src, showMissing }) {
    const [error, setError] = useState(false);
    const ref = useRef(null);
    if (!src && !showMissing) return null;
    return <section className="audio-panel" aria-labelledby="audio-heading">
        <h3 id="audio-heading"><Icon name="audio" />录音回放</h3>
        {src && <audio ref={ref} src={src} controls preload="none" aria-labelledby="audio-heading" hidden={error}
            onError={() => setError(true)} />}
        {(error || !src) && <p className="audio-feedback" role="status">{error ? '暂时无法播放这段录音。' : '没有可播放的录音。'}</p>}
        {error && <button id="audio-retry" className="secondary-button" type="button" onClick={() => {
            setError(false);
            ref.current?.load();
        }}>重新加载录音</button>}
    </section>;
}

function Transcript({ lines }) {
    if (!lines?.length) return null;
    return <details className="transcript-section">
        <summary>发言原文</summary>
        <div className="transcript-text">{lines.map((line, index) => <p key={index}>
            {(line.speaker || line.start != null) && <strong className="speaker-line">
                {[line.speaker, line.start != null && clockText(line.start)].filter(Boolean).join(' · ')}
            </strong>}
            {line.text}
        </p>)}</div>
    </details>;
}

async function copyText(text) {
    try {
        await navigator.clipboard.writeText(text);
        return true;
    } catch {
        const field = document.createElement('textarea');
        field.className = 'copy-buffer';
        field.value = text;
        field.readOnly = true;
        document.body.append(field);
        try {
            field.select();
            field.setSelectionRange(0, text.length);
            return document.execCommand('copy');
        } catch { return false; }
        finally { field.remove(); }
    }
}

function DocumentSection({ html, title, meeting, announce }) {
    const documentRef = useRef(null);
    const buttonRef = useRef(null);
    const timer = useRef(null);
    const [copied, setCopied] = useState(false);
    const [feedback, setFeedback] = useState('');
    useEffect(() => () => clearTimeout(timer.current), []);

    const copy = async () => {
        const source = documentRef.current;
        const clone = source.cloneNode(true);
        for (const li of clone.querySelectorAll('li')) {
            const list = li.parentElement;
            li.prepend(list.tagName === 'OL' ? `${[...list.children].indexOf(li) + 1}. ` : '• ');
        }
        clone.className = 'copy-buffer';
        clone.setAttribute('aria-hidden', 'true');
        document.body.append(clone);
        const text = [meeting.title, dateText(meeting.date), clone.innerText.trim()].filter(Boolean).join('\n\n');
        clone.remove();
        const success = await copyText(text);
        if (!source.isConnected) return;
        if (success) {
            setFeedback('');
            setCopied(true);
            announce?.(`${title}已复制`);
            buttonRef.current?.focus();
            clearTimeout(timer.current);
            timer.current = setTimeout(() => setCopied(false), 2000);
        } else {
            const range = document.createRange();
            range.selectNodeContents(source);
            const selection = window.getSelection();
            selection?.removeAllRanges();
            selection?.addRange(range);
            setFeedback(`已选中${title}，请手动复制。`);
        }
    };

    return <section className="minutes-section" aria-label={title}>
        <div className="minutes-toolbar"><h3>{title}</h3>
            <button ref={buttonRef} className="text-button" type="button" onClick={copy}>
                <Icon name="copy" />{copied ? '已复制' : `复制${title === '会议摘要' ? '摘要' : title}`}
            </button>
        </div>
        {/* The endpoint allows document tags only; no attributes, links or remote media. */}
        <div className="minutes-text" ref={documentRef} dangerouslySetInnerHTML={{ __html: html }} />
        {feedback && <p className="detail-feedback" role="status">{feedback}</p>}
    </section>;
}

export function MeetingRecord({ meeting, title, message, announce, headingRef, children }) {
    const date = meeting && [dateText(meeting.date), meeting.duration > 0 && `时长 ${clockText(meeting.duration)}`].filter(Boolean).join('　·　');
    return <article className="detail-paper">
        <header className="detail-header">
            <h2 id="detail-title" className="display-heading" tabIndex={-1} ref={headingRef}>{meeting?.title || title || '会议记录'}</h2>
            {date && <p className="detail-date">{date}</p>}
        </header>
        {meeting && <AudioPanel key={meeting.audio_url} src={meeting.audio_url} showMissing={!processing.has(meeting.phase)} />}
        <div className="detail-message" role="status" aria-live="polite">{message}</div>
        {meeting?.summary_html && <DocumentSection title="会议摘要" html={meeting.summary_html} meeting={meeting} announce={announce} />}
        {meeting?.notes_html && <DocumentSection title="笔记" html={meeting.notes_html} meeting={meeting} announce={announce} />}
        {children}
        <Transcript lines={meeting?.transcript} />
    </article>;
}

export function MeetingDetail({ id, title, back, loginUrl, announce }) {
    const heading = useRef(null);
    const [meeting, setMeeting] = useState(null);
    const [message, setMessage] = useState('正在加载…');
    const [refresh, setRefresh] = useState(0);
    const [sending, setSending] = useState(false);
    const [feedback, setFeedback] = useState('');

    useEffect(() => {
        window.scrollTo(0, 0);
        heading.current?.focus({ preventScroll: true });
    }, []);

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
                setMessage(phaseText[data.phase] || '');
                if (processing.has(data.phase)) schedule(3600);
            } catch (error) {
                if (!active) return;
                if ([401, 404].includes(error.status)) setMeeting(null);
                if (error.status === 401) {
                    setMessage(<>登录已失效，请<a href={loginUrl}>重新登录</a>。</>);
                } else if (error.status === 404) {
                    setMessage('这条会议记录找不到了。');
                } else {
                    setMessage('暂时打不开这条会议记录，正在重试。');
                    schedule(6000);
                }
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
    }, [id, refresh, loginUrl]);

    async function retry() {
        if (!meeting?.retry || sending) return;
        setSending(true);
        setFeedback('');
        try {
            await request(`/recording/${id}/reprocess_${meeting.retry}`, { method: 'POST', json: {} });
            setRefresh(n => n + 1);
        } catch { setFeedback('这次没有提交成功，请稍后再试。'); }
        finally { setSending(false); }
    }

    return <section id="meeting-detail" aria-labelledby="detail-title">
        <button className="back-button" type="button" onClick={back}><Icon name="back" />返回列表</button>
        <MeetingRecord meeting={meeting} title={title} message={message} announce={announce} headingRef={heading}>
            {meeting?.retry && <button id="detail-retry" className="secondary-button" type="button" disabled={sending} onClick={retry}>
                {meeting.retry === 'transcription' ? '重新整理' : '生成会议摘要'}
            </button>}
            {feedback && <div className="detail-feedback" role="status">{feedback}</div>}
        </MeetingRecord>
    </section>;
}
