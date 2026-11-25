import { useState } from 'react';
import { Icon, NavBar, Sheet } from './ui.jsx';
import { currentCsrf } from './recording/api.js';
import { JstAvatar } from './JstMark.jsx';

const meetingApp = /JstMeetingApp\//.test(navigator.userAgent);

function Row({ icon, color, children, value, href, onClick, disabled, type = 'button', tinted }) {
    const inner = <>
        {icon && <span className="row-icon" style={{ background: color }}><Icon name={icon} /></span>}
        <span className="row-main"><span className="row-title" style={tinted ? { color: 'var(--tint)' } : undefined}>{children}</span></span>
        {value && <span className="row-value">{value}</span>}
        {(href || onClick) && !tinted && <Icon name="chevron" className="chevron" />}
    </>;
    if (href && !disabled) return <a className="row inset-sep" href={href}>{inner}</a>;
    return <button className="row inset-sep" type={type} onClick={onClick} disabled={disabled}>{inner}</button>;
}

export function SettingsPage({ config, locked }) {
    const [notes, setNotes] = useState(false);
    const profile = config.profile || {};
    const name = profile.name || profile.username || '我';
    return <div className="page">
        <NavBar title="设置" />
        <div className="content">
            <section className="section">
                <div className="group profile">
                    <JstAvatar size={58} className="profile-avatar" />
                    <span><strong>{name}</strong><small>@捷士通个人用户</small></span>
                </div>
            </section>
            <section className="section">
                <div className="group">
                    <Row icon="info" color="#0a84ff" onClick={() => setNotes(true)}>录音说明</Row>
                    <Row icon="refresh" color="#34c759" onClick={() => location.reload()} disabled={locked}>刷新页面版本</Row>
                </div>
                <p className="section-foot">{locked ? '录音或保存期间不能刷新页面或退出登录。' : '页面更新后，刷新即可用上新版本，不用重装应用。'}</p>
            </section>
            <section className="section">
                <form className="group" action={config.logoutUrl} method="post" onSubmit={event => {
                    if (locked) event.preventDefault();
                    else event.currentTarget.elements.csrf_token.value = currentCsrf();
                }}>
                    <input type="hidden" name="csrf_token" defaultValue={config.csrfToken} />
                    <button id="logout-button" className="row destructive" type="submit" disabled={locked}>退出登录</button>
                </form>
            </section>
        </div>
        <Sheet open={notes} onClose={() => setNotes(false)} title="录音说明">
            <ul className="note-list" style={{ padding: '0 0 0 18px' }}>
                <li>开始前请告知参会者。{config.transcriptionPending ? '目前仅保存录音，不转写。'
                    : config.summaryReady ? '录音和文字由云服务处理，会议助手会生成摘要和注意事项。' : '录音将由云服务转成文字，暂不生成摘要。'}</li>
                <li>会议满 1 小时自动结束。</li>
                <li>{meetingApp ? '后台录音请保持麦克风和通知权限。小米、华为、OPPO、vivo 等手机建议关闭应用的电池限制。'
                    : '手机录音请用 Safari 或 Chrome 打开，并保持页面亮屏。'}</li>
                <li>如果系统暂停收音，回到本页会尝试自动接着录；暂停期间的声音不会被录下。</li>
            </ul>
        </Sheet>
    </div>;
}
