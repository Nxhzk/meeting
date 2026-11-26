import { createContext, useCallback, useContext, useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { AnimatePresence, motion, useDragControls } from 'motion/react';

// ------------------------------------------------------------ 动效参数（iOS 弹簧）
export const spring = { type: 'spring', stiffness: 520, damping: 44, mass: 1 };
export const softSpring = { type: 'spring', stiffness: 340, damping: 34, mass: .9 };
export const pushSpring = { type: 'spring', stiffness: 380, damping: 40, mass: 1 };

// ------------------------------------------------------------ 图标（线条风格，接近 SF Symbols）
const paths = {
    mic: <><rect x="9" y="3" width="6" height="11" rx="3" /><path d="M5.5 11a6.5 6.5 0 0 0 13 0M12 17.5V21M8.5 21h7" /></>,
    stop: <rect x="6.5" y="6.5" width="11" height="11" rx="2.5" fill="currentColor" stroke="none" />,
    pause: <><rect x="7" y="5.5" width="3.2" height="13" rx="1.2" fill="currentColor" stroke="none" /><rect x="13.8" y="5.5" width="3.2" height="13" rx="1.2" fill="currentColor" stroke="none" /></>,
    more: <><circle cx="6" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none" /><circle cx="18" cy="12" r="1.6" fill="currentColor" stroke="none" /></>,
    close: <path d="m6.5 6.5 11 11m0-11-11 11" />,
    back: <path d="M15 4.5 7.5 12l7.5 7.5" />,
    chevron: <path d="m9 5 7 7-7 7" />,
    down: <path d="m6 9.5 6 6 6-6" />,
    copy: <><rect x="8.5" y="8.5" width="11" height="12" rx="2.5" /><path d="M15.5 8.5V6a2.5 2.5 0 0 0-2.5-2.5H6A2.5 2.5 0 0 0 3.5 6v7.5A2.5 2.5 0 0 0 6 16h2.5" /></>,
    sparkles: <><path d="M10 3.5 11.6 8a3 3 0 0 0 1.9 1.9L18 11.5l-4.5 1.6a3 3 0 0 0-1.9 1.9L10 19.5 8.4 15a3 3 0 0 0-1.9-1.9L2 11.5l4.5-1.6A3 3 0 0 0 8.4 8Z" /><path d="M18.5 2.5v4M16.5 4.5h4M19 16v3M17.5 17.5h3" /></>,
    trash: <><path d="M4 7h16M9.5 7V4.5h5V7M6 7l1 12.5a1.5 1.5 0 0 0 1.5 1.5h7a1.5 1.5 0 0 0 1.5-1.5L18 7" /><path d="M10 11v6M14 11v6" /></>,
    waveform: <path d="M3 12h1.5M6.5 8v8M10 4.5v15M13.5 7.5v9M17 10v4M20.5 11.5v1" />,
    keyboard: <><rect x="2.5" y="5.5" width="19" height="13" rx="3" /><path d="M6.5 9.5h.01M10 9.5h.01M14 9.5h.01M17.5 9.5h.01M6.5 12.5h.01M10 12.5h.01M14 12.5h.01M17.5 12.5h.01M8.5 15.5h7" /></>,
    voice: <><circle cx="12" cy="12" r="9.5" /><path d="M9 10.2v3.6M12 8.2v7.6M15 10.2v3.6" /></>,
    brain: <><path d="M9 4.5a3 3 0 0 0-3 3 3 3 0 0 0-2 5 3 3 0 0 0 2 4.5 3 3 0 0 0 3 2.5 3 3 0 0 0 3-3V7a2.5 2.5 0 0 0-3-2.5Z" /><path d="M15 4.5a3 3 0 0 1 3 3 3 3 0 0 1 2 5 3 3 0 0 1-2 4.5 3 3 0 0 1-3 2.5 3 3 0 0 1-3-3V7a2.5 2.5 0 0 1 3-2.5Z" /></>,
    gear: <><circle cx="12" cy="12" r="3.2" /><path d="M12 2.8v2.4M12 18.8v2.4M21.2 12h-2.4M5.2 12H2.8M18.5 5.5l-1.7 1.7M7.2 16.8l-1.7 1.7M18.5 18.5l-1.7-1.7M7.2 7.2 5.5 5.5" /></>,
    person: <><circle cx="12" cy="8" r="4" /><path d="M4.5 20.5a7.5 7.5 0 0 1 15 0" /></>,
    folder: <path d="M3.5 7.5A2 2 0 0 1 5.5 5.5H10l2 2.5h6.5a2 2 0 0 1 2 2v7.5a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2Z" />,
    warning: <><path d="M10.3 4.2 2.9 17.5A2 2 0 0 0 4.6 20.5h14.8a2 2 0 0 0 1.7-3L13.7 4.2a2 2 0 0 0-3.4 0Z" /><path d="M12 9.5v4.5M12 17.2v.1" /></>,
    heart: <path d="M12 20s-7.5-4.6-7.5-10A4.3 4.3 0 0 1 12 7.4 4.3 4.3 0 0 1 19.5 10c0 5.4-7.5 10-7.5 10Z" />,
    plus: <path d="M12 5v14M5 12h14" />,
    clock: <><circle cx="12" cy="12" r="8.5" /><path d="M12 7.5V12l3 2" /></>,
    calendar: <><rect x="3.5" y="5" width="17" height="15.5" rx="3" /><path d="M3.5 10h17M8 3v4M16 3v4" /></>,
    pencil: <path d="M14.5 5.5 18.5 9.5M4 20l1-4.5L15.5 5a2.1 2.1 0 0 1 3 0l.5.5a2.1 2.1 0 0 1 0 3L8.5 19Z" />,
    history: <><path d="M3.5 12a8.5 8.5 0 1 0 2.5-6" /><path d="M3.5 4v4h4M12 8v4.5l3 1.5" /></>,
    restore: <><path d="M4 12a8 8 0 1 0 2.3-5.6" /><path d="M4 4.5v4h4" /></>,
    check: <path d="m5 12.5 4.5 4.5L19 7.5" />,
    checkCircle: <><circle cx="12" cy="12" r="9" /><path d="m8 12.3 2.8 2.8L16.2 9.6" /></>,
    info: <><circle cx="12" cy="12" r="9" /><path d="M12 11v5.5M12 7.6v.1" /></>,
    refresh: <><path d="M20 11.5A8 8 0 0 0 6.2 6.3L4 8.5M4 4v4.5h4.5" /><path d="M4 12.5a8 8 0 0 0 13.8 5.2L20 15.5M20 20v-4.5h-4.5" /></>,
    logout: <><path d="M14 4.5h3.5a2 2 0 0 1 2 2v11a2 2 0 0 1-2 2H14" /><path d="M10 8l-4 4 4 4M6 12h10" /></>,
    doc: <><path d="M7 3.5h7l4.5 4.5v11a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2v-13.5a2 2 0 0 1 2-2Z" /><path d="M14 3.5V8h4.5M8.5 13h7M8.5 16.5h5" /></>,
    link: <path d="M9.5 14.5 14.5 9.5M10.5 6.5l1.4-1.4a4 4 0 0 1 5.7 5.7l-1.4 1.4M13.5 17.5l-1.4 1.4a4 4 0 0 1-5.7-5.7l1.4-1.4" />,
    play: <path d="M8 5.2v13.6a1 1 0 0 0 1.52.85l11-6.8a1 1 0 0 0 0-1.7l-11-6.8A1 1 0 0 0 8 5.2Z" fill="currentColor" stroke="none" />,
    pauseSolid: <><rect x="6.5" y="5" width="4" height="14" rx="1.4" fill="currentColor" stroke="none" /><rect x="13.5" y="5" width="4" height="14" rx="1.4" fill="currentColor" stroke="none" /></>,
    back15: <><path d="M4.5 12.5a7.5 7.5 0 1 0 2.2-5.3" /><path d="M4.5 3.5v4h4" /><text x="12.4" y="15.6" fontSize="7.2" fontWeight="700" textAnchor="middle" fill="currentColor" stroke="none" fontFamily="system-ui">15</text></>,
    fwd15: <><path d="M19.5 12.5a7.5 7.5 0 1 1-2.2-5.3" /><path d="M19.5 3.5v4h-4" /><text x="11.6" y="15.6" fontSize="7.2" fontWeight="700" textAnchor="middle" fill="currentColor" stroke="none" fontFamily="system-ui">15</text></>,
    download: <><path d="M12 4v11M7.5 10.5 12 15l4.5-4.5" /><path d="M5 19.5h14" /></>,
    up: <path d="M12 19V5M6 11l6-6 6 6" strokeWidth="2.2" />,
    lightbulb: <><path d="M9 18h6M10 21h4M12 3a6 6 0 0 0-3.6 10.8c.6.5 1 1.2 1.1 2V16h5v-.2c.1-.8.5-1.5 1.1-2A6 6 0 0 0 12 3Z" /></>,
    pin: <><path d="M9 3h6l-1 6 3 3v2H7v-2l3-3-1-6ZM12 14v7" /></>,
    compress: <><path d="M4 9h16M4 15h16M12 3v4l-2-2M12 7l2-2M12 21v-4l-2 2M12 17l2 2" /></>,
};

export function Icon({ name, ...rest }) {
    return <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" strokeWidth="1.8"
        strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" {...rest}>{paths[name]}</svg>;
}

// ------------------------------------------------------------ 导航栏（大标题，滚动后收起）
// 左右滑动时摆在旁边的那一页：页面还没切过去，不跟着当前页面的滚动收起大标题
export const PeekContext = createContext(false);

export function useScrolled(target, threshold = 24) {
    const [scrolled, setScrolled] = useState(false);
    const peeking = useContext(PeekContext);
    useEffect(() => {
        if (peeking) { setScrolled(false); return; }
        const node = target?.current ?? window;
        const read = () => setScrolled((node === window ? window.scrollY : node.scrollTop) > threshold);
        read();
        node.addEventListener('scroll', read, { passive: true });
        return () => node.removeEventListener('scroll', read);
    }, [target, threshold, peeking]);
    return scrolled;
}

export function NavBar({ title, subtitle, left, right, large = true, scrollRoot, inlineTitle, titleAfter = 0 }) {
    // large：大标题页；否则 titleAfter 像素后才在导航栏中间显示标题（页面自己有大号标题时）。
    const scrolled = useScrolled(scrollRoot, large ? 40 : Math.max(4, titleAfter));
    return <>
        <header className="navbar" data-scrolled={scrolled}>
            <div className="navbar-glass glass glass-strong" aria-hidden="true" />
            <div className="navbar-bar">
                <div className="navbar-side">{left}</div>
                <AnimatePresence initial={false}>
                    {((!large && !titleAfter) || scrolled) && <motion.div key="t" className="navbar-title" aria-hidden={large || titleAfter ? true : undefined}
                        initial={{ opacity: 0, y: 6 }} animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: 6 }}
                        transition={{ duration: .18 }}>{inlineTitle ?? title}</motion.div>}
                </AnimatePresence>
                <div className="navbar-side">{right}</div>
            </div>
        </header>
        {large && <motion.h1 className="large-title" animate={{ opacity: scrolled ? 0 : 1, scale: scrolled ? .96 : 1 }}
            transition={{ duration: .2 }}>{title}{subtitle && <small>{subtitle}</small>}</motion.h1>}
    </>;
}

export function NavButton({ icon, label, children, glass = false, ...rest }) {
    return <motion.button type="button" whileTap={{ scale: .9 }} transition={spring}
        className={`nav-button${glass ? ' glass' : ''}${children ? '' : ' icon-only'}`} aria-label={children ? undefined : label} title={label} {...rest}>
        {icon && <Icon name={icon} />}{children}
    </motion.button>;
}

// ------------------------------------------------------------ 底部面板（可下拉关闭）
// ------------------------------------------------------------ 系统返回键
// 安卓壳按返回键时先调 window.__jstBack()：页面上有打开的面板、菜单、拉出的删除按钮，就先关最上面那一个，
// 返回 true；什么都没开才返回 false，由壳去做页面后退（关小助理、退出会议详情）或退到后台。
const backStack = [];
window.__jstBack = () => {
    const top = backStack.at(-1);
    if (!top) return false;
    top.close();
    return true;
};

/** open 期间登记到返回栈：按返回键时调用 close。后打开的先关。 */
export function useBackClose(open, close) {
    const latest = useRef(close);
    latest.current = close;
    useEffect(() => {
        if (!open) return;
        const entry = { close: () => latest.current() };
        backStack.push(entry);
        return () => {
            const index = backStack.lastIndexOf(entry);
            if (index >= 0) backStack.splice(index, 1);
        };
    }, [open]);
}

let openSheets = 0;   // 同时开着几个面板（叠着开时，最后一个关上才放开后面的页面）

export function Sheet({ open, onClose, title, busy = false, children, actions, labelledBy }) {
    const dialog = useRef(null);
    const drag = useDragControls();
    const headingId = useId();
    useEffect(() => {
        const node = dialog.current;
        if (!node) return;
        if (open && !node.open) node.showModal();
    }, [open]);
    const close = () => { if (!busy) onClose(); };
    useBackClose(open, close);   // 正在提交（busy）时按返回键：面板不关，也不退出软件
    // 内容一屏放得下（不用滚动）时，整个面板任何地方都能往下拖着关；要滚动时只拖把手和标题栏
    const [body, setBody] = useState(null);
    const [fits, setFits] = useState(false);
    useEffect(() => {
        if (!body) return;
        const measure = () => setFits(body.scrollHeight <= body.clientHeight + 1);
        measure();
        const observer = new ResizeObserver(measure);
        observer.observe(body);
        for (const child of body.children) observer.observe(child);
        return () => observer.disconnect();
    }, [body, children]);
    useEffect(() => {
        if (!open) return;
        openSheets += 1;
        document.documentElement.classList.add('sheet-open');
        return () => {
            openSheets -= 1;
            if (!openSheets) document.documentElement.classList.remove('sheet-open');
        };
    }, [open]);
    const dragFromBody = event => {
        if (fits && !event.target.closest('input, textarea, select, [contenteditable="true"]')) drag.start(event);
    };
    return <AnimatePresence onExitComplete={() => dialog.current?.open && dialog.current.close()}>
        {open && <dialog key="sheet" ref={dialog} className="sheet-dialog" aria-labelledby={labelledBy || headingId}
            onCancel={event => { event.preventDefault(); close(); }}>
            <motion.div className="sheet-scrim" onClick={close} initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                transition={{ duration: .25 }} />
            <div className="sheet-host">
                <motion.div className="sheet glass glass-strong" role="document"
                    initial={{ y: '100%' }} animate={{ y: 0 }} exit={{ y: '100%' }} transition={pushSpring}
                    drag="y" dragControls={drag} dragListener={false} dragConstraints={{ top: 0, bottom: 0 }} dragElastic={{ top: 0, bottom: .6 }}
                    onDragEnd={(_e, info) => { if (info.offset.y > 120 || info.velocity.y > 600) close(); }}>
                    <div className="sheet-grabber" onPointerDown={event => drag.start(event)} aria-hidden="true" />
                    {title && <div className="sheet-head" onPointerDown={event => drag.start(event)}>
                        <h2 id={headingId}>{title}</h2>
                        <button className="sheet-close" type="button" aria-label="关闭" onClick={close} disabled={busy}><Icon name="close" /></button>
                    </div>}
                    <div ref={setBody} className={`sheet-body${fits ? ' fits' : ''}`} onPointerDown={dragFromBody}>{children}</div>
                    {actions && <div className={`sheet-actions${Array.isArray(actions) && actions.length === 2 ? ' two' : ''}`}>{actions}</div>}
                </motion.div>
            </div>
        </dialog>}
    </AnimatePresence>;
}

// ------------------------------------------------------------ 弹出菜单
export function Menu({ anchor, open, onClose, children, label }) {
    const [place, setPlace] = useState(null);
    useBackClose(open, onClose);
    useLayoutEffect(() => {
        if (!open || !anchor?.current) return;
        const rect = anchor.current.getBoundingClientRect();
        const right = Math.max(12, window.innerWidth - rect.right);
        const below = rect.bottom + 8;
        setPlace(below > window.innerHeight * .62 ? { right, bottom: window.innerHeight - rect.top + 8, origin: 'bottom right' }
            : { right, top: below, origin: 'top right' });
    }, [open, anchor]);
    useEffect(() => {
        if (!open) return;
        const key = event => { if (event.key === 'Escape') onClose(); };
        window.addEventListener('keydown', key);
        return () => window.removeEventListener('keydown', key);
    }, [open, onClose]);
    return createPortal(<AnimatePresence>
        {open && place && <div className="menu-host" onClick={onClose} key="menu">
            <motion.div className="menu glass glass-strong" role="menu" aria-label={label}
                style={{ right: place.right, top: place.top, bottom: place.bottom, transformOrigin: place.origin }}
                initial={{ opacity: 0, scale: .6 }} animate={{ opacity: 1, scale: 1 }} exit={{ opacity: 0, scale: .8 }}
                transition={{ type: 'spring', stiffness: 600, damping: 38 }} onClick={event => event.stopPropagation()}
                onAnimationComplete={() => document.querySelector('.menu [role^="menuitem"]')?.focus()}>
                {children}
            </motion.div>
        </div>}
    </AnimatePresence>, document.body);
}

export function MenuItem({ icon, children, sub, onSelect, destructive, checked, disabled }) {
    return <button type="button" role={checked === undefined ? 'menuitem' : 'menuitemradio'} aria-checked={checked}
        className={destructive ? 'destructive' : undefined} disabled={disabled} onClick={onSelect}>
        <span>{children}{sub && <span className="menu-sub">{sub}</span>}</span>
        {checked !== undefined ? <Icon name="check" className="check" /> : icon && <Icon name={icon} />}
    </button>;
}

// ------------------------------------------------------------ 分段控件
export function Segmented({ options, value, onChange, label }) {
    const id = useId();
    return <div className="segmented" role="group" aria-label={label}>
        {options.map(option => <button key={option.value} type="button" aria-pressed={value === option.value}
            onClick={() => onChange(option.value)}>
            {value === option.value && <motion.span layoutId={`seg-${id}`} layoutDependency={value} className="segmented-thumb" transition={spring} />}
            {option.label}
        </button>)}
    </div>;
}

export function Toggle({ checked, onChange, label }) {
    return <button type="button" role="switch" aria-checked={checked} aria-label={label} className="toggle" onClick={() => onChange(!checked)}><i /></button>;
}

// ------------------------------------------------------------ 提示
const ToastContext = createContext(() => {});
export const useToast = () => useContext(ToastContext);

export function ToastProvider({ children }) {
    const [toast, setToast] = useState(null);
    const timer = useRef(null);
    const show = useCallback((text, tone = 'good') => {
        clearTimeout(timer.current);
        setToast({ text, tone, key: Date.now() });
        timer.current = setTimeout(() => setToast(null), 2600);
    }, []);
    useEffect(() => () => clearTimeout(timer.current), []);
    const icon = toast?.tone === 'good' ? 'checkCircle' : toast?.tone === 'bad' ? 'warning' : 'info';
    return <ToastContext.Provider value={show}>
        {children}
        <div className="toast-host" role="status" aria-live="polite">
            <AnimatePresence>
                {toast && <motion.div key={toast.key} className="toast glass glass-strong" data-tone={toast.tone}
                    initial={{ opacity: 0, y: -24, scale: .9 }} animate={{ opacity: 1, y: 0, scale: 1 }} exit={{ opacity: 0, y: -16, scale: .95 }}
                    transition={softSpring}><Icon name={icon} />{toast.text}</motion.div>}
            </AnimatePresence>
        </div>
    </ToastContext.Provider>;
}

// ------------------------------------------------------------ 杂项
export function Messages({ messages = [] }) {
    return messages.map(({ tone, text }, index) => <div key={index} className="banner auth-message" data-tone={tone === 'error' ? 'bad' : 'info'} role="status">
        <Icon name={tone === 'error' ? 'warning' : 'info'} /><p>{text}</p>
    </div>);
}

export function Banner({ tone = 'info', icon, title, children }) {
    return <div className="banner" data-tone={tone} role={tone === 'bad' ? 'alert' : 'status'}>
        <Icon name={icon || (tone === 'bad' || tone === 'warn' ? 'warning' : 'info')} />
        <div>{title && <strong>{title}</strong>}{children && <p>{children}</p>}</div>
    </div>;
}

const avatarColors = ['#0a84ff', '#30b0c7', '#ff9500', '#af52de', '#34c759', '#ff375f', '#5e5ce6', '#a2845e'];
export function speakerColor(name = '') {
    let hash = 0;
    for (const char of name) hash = (hash * 31 + char.codePointAt(0)) >>> 0;
    return avatarColors[hash % avatarColors.length];
}

const dateTime = new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false });
const shortDate = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric' });
const weekday = new Intl.DateTimeFormat('zh-CN', { weekday: 'long' });
export const timeFormat = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false });

export function dateText(value, short = false) {
    const date = new Date(value || '');
    if (Number.isNaN(date.getTime())) return '';
    return short && date.getFullYear() === new Date().getFullYear() ? `${shortDate.format(date)} ${timeFormat.format(date)}` : dateTime.format(date);
}

function startOfDay(date) { const d = new Date(date); d.setHours(0, 0, 0, 0); return d; }

/** 列表分组用：今天 / 昨天 / 本周几 / 某月某日 */
export function dayLabel(value) {
    const date = new Date(value || '');
    if (Number.isNaN(date.getTime())) return '更早';
    const days = Math.round((startOfDay(new Date()) - startOfDay(date)) / 86400000);
    if (days <= 0) return '今天';
    if (days === 1) return '昨天';
    if (days < 7) return weekday.format(date);
    return date.getFullYear() === new Date().getFullYear() ? shortDate.format(date)
        : new Intl.DateTimeFormat('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' }).format(date);
}

export function relativeTime(value) {
    const date = new Date(value || '');
    if (Number.isNaN(date.getTime())) return '';
    const minutes = Math.round((Date.now() - date) / 60000);
    if (minutes < 1) return '刚刚';
    if (minutes < 60) return `${minutes} 分钟前`;
    if (minutes < 24 * 60) return `${Math.round(minutes / 60)} 小时前`;
    return dateText(value, true);
}

export function clockText(seconds) {
    seconds = Math.max(0, Math.floor(seconds));
    const pad = value => String(value).padStart(2, '0');
    const hours = Math.floor(seconds / 3600);
    return `${hours ? `${pad(hours)}:` : ''}${pad(Math.floor(seconds / 60) % 60)}:${pad(seconds % 60)}`;
}

export function durationText(seconds) {
    if (!seconds) return '';
    const minutes = Math.round(seconds / 60);
    if (minutes < 1) return `${Math.round(seconds)} 秒`;
    if (minutes < 60) return `${minutes} 分钟`;
    return `${Math.floor(minutes / 60)} 小时${minutes % 60 ? ` ${minutes % 60} 分` : ''}`;
}

export async function copyText(text) {
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
