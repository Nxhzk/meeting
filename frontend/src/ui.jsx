import { useEffect, useRef } from 'react';

const paths = {
    mic: 'M9 5a3 3 0 0 1 6 0v7a3 3 0 1 1-6 0zm-4 6v1a7 7 0 0 0 14 0v-1m-7 8v3m-3 0h6',
    stop: 'M7 7h10v10H7z',
    more: 'M5 12h.01m6.99 0h.01m6.99 0h.01',
    close: 'm6 6 12 12M18 6 6 18',
    back: 'M20 12H4m7-7-7 7 7 7',
    audio: 'M4 14v-2a8 8 0 0 1 16 0v2M4 14h4v7H4zm12 0h4v7h-4z',
    copy: 'M8 8h12v13H8zM4 16V3h12',
};

export function Icon({ name }) {
    return <svg viewBox="0 0 24 24" fill={name === 'stop' ? 'currentColor' : 'none'} stroke="currentColor"
        strokeWidth={name === 'more' ? '3.5' : '1.8'} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={paths[name]} />
    </svg>;
}

export function Header({ config, onOptions }) {
    return <header className="site-header">
        <div className="header-inner">
            <div className="brand-lockup">
                <img className="brand-logo" src={config.logoUrl} width="267" height="105" alt="" />
                <span className="brand-divider" aria-hidden="true" />
                <h1 className="site-title"><span className="sr-only">捷士通</span>智能会议</h1>
            </div>
            {onOptions && <button id="meeting-options" className="icon-button" type="button" aria-label="更多选项"
                title="更多选项" aria-haspopup="dialog" aria-controls="options-dialog" onClick={onOptions}><Icon name="more" /></button>}
        </div>
    </header>;
}

export function Messages({ messages = [] }) {
    return messages.map(({ tone, text }, index) => <p key={index} className="login-message" data-tone={tone} role="status">{text}</p>);
}

export function Sheet({ id, open, close, busy = false, labelledBy, describedBy, children }) {
    const dialog = useRef(null);
    useEffect(() => {
        const node = dialog.current;
        if (open && !node.open) node.showModal();
        if (!open && node.open) node.close();
    }, [open]);
    return <dialog id={id} className="sheet" ref={dialog} aria-labelledby={labelledBy} aria-describedby={describedBy}
        onCancel={event => { event.preventDefault(); if (!busy) close(); }}>
        {children}
    </dialog>;
}

const dateTime = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const shortDate = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' });
export const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

export function dateText(value, short = false) {
    const date = new Date(value || '');
    if (Number.isNaN(date.getTime())) return '';
    return short && date.getFullYear() === new Date().getFullYear() ? `${shortDate.format(date)} ${timeFormat.format(date)}` : dateTime.format(date);
}

export function clockText(seconds) {
    seconds = Math.max(0, Math.floor(seconds));
    const pad = value => String(value).padStart(2, '0');
    const hours = Math.floor(seconds / 3600);
    return `${hours ? `${pad(hours)}:` : ''}${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}
