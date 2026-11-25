import { MotionConfig, motion } from 'motion/react';
import { Icon, Messages, softSpring } from './ui.jsx';

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
    return <form className={className} method="post" action={action} {...props}>
        <input type="hidden" name="csrf_token" value={config.csrfToken} />
        {children}
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
        <button className="btn btn-primary btn-block" type="submit">登录</button>
    </Form>;
    return <>
        {config.ssoUrl && <form className="auth-form" action={config.ssoUrl} method="get" style={{ marginBottom: 16 }}>
            {config.next && <input type="hidden" name="next" value={config.next} />}
            <button className={`btn ${config.passwordLoginDisabled ? 'btn-primary' : 'btn-gray'} btn-block`} type="submit">
                使用 {config.ssoProvider} 登录
            </button>
            <label className="check-label"><input type="checkbox" name="remember" value="1" /> 保持登录</label>
        </form>}
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
            <button className="btn btn-gray btn-block" type="submit">重新发送验证邮件</button>
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
        <button type="submit" className="btn btn-primary btn-block">{page === 'forgot' ? '发送重置邮件' : authLabels[page]}</button>
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
                <button type="submit" className="btn btn-gray btn-block">保存资料</button>
            </Form>
        </div>
        {config.canChangePassword && <div className="group">
            <Form className="form-stack" action={config.passwordUrl} config={config}>
                <h3>修改密码</h3>
                <Field name="current_password" label="当前密码" type="password" autoComplete="current-password" required />
                <Field name="new_password" label="新密码" type="password" autoComplete="new-password" required />
                <Field name="confirm_password" label="确认新密码" type="password" autoComplete="new-password" required />
                <button type="submit" className="btn btn-gray btn-block">更改密码</button>
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
