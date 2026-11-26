import { createContext, useContext, useEffect, useState } from 'react';
import { MotionConfig, motion } from 'motion/react';
import { Icon, Messages, softSpring } from './ui.jsx';
import { JstLoader } from './JstMark.jsx';

// 表单提交后到新页面出来之前：按钮上转加载动画、不能重复点（不然像是卡住了）
const Submitting = createContext(false);

function SubmitButton({ className, busyText = '请稍候…', children }) {
    const busy = useContext(Submitting);
    return <button className={className} type="submit" disabled={busy} aria-busy={busy || undefined}>
        {busy ? <><JstLoader size={18} tone="current" />{busyText}</> : children}
    </button>;
}

function usePendingSubmit() {
    const [busy, setBusy] = useState(false);
    // 从下一页按返回回到这里（页面被浏览器缓存）：恢复可点
    useEffect(() => {
        const reset = () => setBusy(false);
        window.addEventListener('pageshow', reset);
        return () => window.removeEventListener('pageshow', reset);
    }, []);
    return [busy, () => setBusy(true)];
}

function Field({ name, label, errors, ...input }) {
    const messages = errors?.[name] || [];
    return <div className="field">
        <label htmlFor={name}>{label}</label>
        <input id={name} name={name} className="input" aria-invalid={messages.length > 0 || undefined}
            aria-describedby={messages.length ? `${name}-errors` : undefined} {...input} />
        {messages.length > 0 && <ul className="field-errors" id={`${name}-errors`}>
            {messages.map((message, i) => <li key={i}>{message}</li>)}
        </ul>}
    </div>;
}

function Form({ action, config, children, className = 'auth-form', ...props }) {
    // 普通表单提交：保留 Flask-Login、频率限制和跳转。
    const [busy, submitted] = usePendingSubmit();
    return <form className={className} method="post" action={action} {...props}
        onSubmit={event => { if (busy) event.preventDefault(); else submitted(); }}>
        <input type="hidden" name="csrf_token" value={config.csrfToken} />
        <Submitting.Provider value={busy}>{children}</Submitting.Provider>
    </form>;
}

function SsoForm({ config, children }) {
    const [busy, submitted] = usePendingSubmit();
    return <form className="auth-form" action={config.ssoUrl} method="get" style={{ marginBottom: 16 }}
        onSubmit={event => { if (busy) event.preventDefault(); else submitted(); }}>
        <Submitting.Provider value={busy}>{children}</Submitting.Provider>
    </form>;
}

function Login({ config }) {
    const form = <Form action={config.formUrl} config={config}>
        <Field name="email" label="账号" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false}
            defaultValue={config.email} errors={config.errors} required placeholder="用户名或邮箱" />
        <Field name="password" label="密码" type="password" autoComplete="current-password" errors={config.errors} required placeholder="密码" />
        <div className="auth-options">
            <label className="check-label"><input type="checkbox" name="remember" defaultChecked={config.remember} /> 保持登录</label>
            {!config.passwordLoginDisabled && <a href={config.forgotUrl}>忘记密码</a>}
        </div>
        <SubmitButton className="btn btn-primary btn-block" busyText="正在登录…">登录</SubmitButton>
    </Form>;
    return <>
        {config.ssoUrl && <SsoForm config={config}>
            {config.next && <input type="hidden" name="next" value={config.next} />}
            <SubmitButton className={`btn ${config.passwordLoginDisabled ? 'btn-primary' : 'btn-gray'} btn-block`} busyText="正在跳转…">
                使用 {config.ssoProvider} 登录
            </SubmitButton>
            <label className="check-label"><input type="checkbox" name="remember" value="1" /> 保持登录</label>
        </SsoForm>}
        {config.passwordLoginDisabled ? <details open={config.showPasswordForm}>
            <summary style={{ color: 'var(--tint)', minHeight: 44 }}>使用账号和密码登录</summary>{form}
        </details> : <>{form}{config.registerUrl && <div className="auth-links"><a href={config.registerUrl}>注册账号</a></div>}</>}
    </>;
}

const authLabels = { login: '登录', register: '注册账号', forgot: '找回密码', reset: '设置新密码', email: '检查邮箱', verified: '邮箱已验证', account: '账号与资料' };

function PublicForm({ config }) {
    const { page, errors, email, username, formUrl } = config;
    if (page === 'login') return <Login config={config} />;
    if (page === 'email' || page === 'verified') return <>
        <p style={{ color: 'var(--label-2)' }}>{page === 'verified' ? '邮箱验证完成，可以登录了。' : config.emailMessage}</p>
        {config.resendUrl && <Form action={config.resendUrl} config={config}>
            <input type="hidden" name="email" value={email || ''} />
            <SubmitButton className="btn btn-gray btn-block" busyText="正在发送…">重新发送验证邮件</SubmitButton>
        </Form>}
    </>;
    return <Form action={formUrl} config={config}>
        {page === 'register' && <Field name="username" label="用户名" autoComplete="username" minLength={2} maxLength={20}
            errors={errors} defaultValue={username} required />}
        {page !== 'reset' && <Field name="email" label="邮箱" type="email" autoComplete="email" errors={errors} defaultValue={email} required />}
        {page !== 'forgot' && <>
            <Field name="password" label="新密码" type="password" autoComplete="new-password" errors={errors} required />
            <Field name="confirm_password" label="确认密码" type="password" autoComplete="new-password" errors={errors} required />
        </>}
        <SubmitButton className="btn btn-primary btn-block" busyText={page === 'forgot' ? '正在发送…' : '正在提交…'}>
            {page === 'forgot' ? '发送重置邮件' : authLabels[page]}</SubmitButton>
    </Form>;
}

function Account({ config }) {
    const { profile } = config;
    return <>
        <p style={{ margin: '0 0 16px', color: 'var(--label-2)', textAlign: 'center' }}>{profile.username} · {profile.email}</p>
        <div className="group">
            <Form className="form-stack" action={config.formUrl} config={config}>
                <h3>资料</h3>
                <Field name="user_name" label="姓名" defaultValue={profile.name} autoComplete="name" />
                <Field name="user_job_title" label="职位" defaultValue={profile.jobTitle} autoComplete="organization-title" />
                <Field name="user_company" label="公司" defaultValue={profile.company} autoComplete="organization" />
                <p className="section-foot" style={{ padding: 0 }}>会议助手会参考这些信息，例如知道纪要由谁记录。</p>
                <SubmitButton className="btn btn-gray btn-block" busyText="正在保存…">保存资料</SubmitButton>
            </Form>
        </div>
        {config.canChangePassword && <div className="group">
            <Form className="form-stack" action={config.passwordUrl} config={config}>
                <h3>修改密码</h3>
                <Field name="current_password" label="当前密码" type="password" autoComplete="current-password" required />
                <Field name="new_password" label="新密码" type="password" autoComplete="new-password" required />
                <Field name="confirm_password" label="确认新密码" type="password" autoComplete="new-password" required />
                <SubmitButton className="btn btn-gray btn-block" busyText="正在保存…">更改密码</SubmitButton>
            </Form>
        </div>}
    </>;
}

export function AuthPage({ config }) {
    const account = config.page === 'account';
    return <MotionConfig reducedMotion="user">
        <main className="auth">
            <div className="aurora" aria-hidden="true"><i /><i /><i /></div>
            <motion.section className={`auth-card glass${account ? ' auth-account' : ''}`} aria-label={authLabels[config.page]}
                initial={{ opacity: 0, y: 24, scale: .97 }} animate={{ opacity: 1, y: 0, scale: 1 }} transition={softSpring}>
                <div className="auth-brand">
                    <span className="auth-logo"><img src={config.logoUrl.replace('logo.png', 'mark.png')} alt="" /></span>
                    <div>
                        <h1>{config.page === 'login' ? '捷士通智能会议' : authLabels[config.page]}</h1>
                        {config.page === 'login' && <p>录音、转写，会议助手帮你整理纪要和注意事项</p>}
                    </div>
                </div>
                <Messages messages={config.messages} />
                {account ? <Account config={config} /> : <PublicForm config={config} />}
                {config.page !== 'login' && <div className="auth-links"><a href={account ? config.homeUrl : config.loginUrl}>
                    <Icon name="back" width="16" height="16" style={{ verticalAlign: '-3px' }} /> {account ? '返回' : '返回登录'}
                </a></div>}
            </motion.section>
        </main>
    </MotionConfig>;
}
