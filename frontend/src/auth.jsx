import { Header, Messages } from './ui.jsx';

function Field({ name, label, errors, ...input }) {
    const messages = errors?.[name] || [];
    return <div className="login-field">
        <label htmlFor={name}>{label}</label>
        <input id={name} name={name} aria-invalid={messages.length > 0 || undefined}
            aria-describedby={messages.length ? `${name}-errors` : undefined} {...input} />
        {messages.length > 0 && <ul className="field-errors" id={`${name}-errors`}>
            {messages.map((message, i) => <li key={i}>{message}</li>)}
        </ul>}
    </div>;
}

function Form({ action, config, children, ...props }) {
    // Regular form navigation keeps Flask-Login, rate limits and redirects intact.
    return <form className="login-form" method="post" action={action} {...props}>
        <input type="hidden" name="csrf_token" value={config.csrfToken} />
        {children}
    </form>;
}

function Login({ config }) {
    const form = <Form action={config.formUrl} config={config}>
        <Field name="email" label="账号" type="text" autoComplete="username" autoCapitalize="none" spellCheck={false}
            defaultValue={config.email} errors={config.errors} required />
        <Field name="password" label="密码" type="password" autoComplete="current-password" errors={config.errors} required />
        <div className="login-options">
            <label className="remember-label"><input type="checkbox" name="remember" defaultChecked={config.remember} /> 保持登录</label>
            {!config.passwordLoginDisabled && <a href={config.forgotUrl}>忘记密码</a>}
        </div>
        <button className="primary-button login-submit" type="submit">登录</button>
    </Form>;
    return <>
        {config.ssoUrl && <form className="login-form sso-form" action={config.ssoUrl} method="get">
            {config.next && <input type="hidden" name="next" value={config.next} />}
            <button className={`${config.passwordLoginDisabled ? 'primary-button' : 'secondary-button'} login-submit`} type="submit">
                使用 {config.ssoProvider} 登录
            </button>
            <label className="remember-label"><input type="checkbox" name="remember" value="1" /> 保持登录</label>
        </form>}
        {config.passwordLoginDisabled ? <details className="login-fallback" open={config.showPasswordForm}>
            <summary>使用账号和密码登录</summary>{form}
        </details> : <>{form}{config.registerUrl && <p className="login-register"><a href={config.registerUrl}>注册账号</a></p>}</>}
    </>;
}

const authLabels = { login: '登录', register: '注册账号', forgot: '找回密码', reset: '设置新密码', email: '检查邮箱', verified: '邮箱已验证', account: '账号设置' };

function PublicForm({ config }) {
    const { page, errors, email, username, formUrl } = config;
    if (page === 'login') return <Login config={config} />;
    if (page === 'email' || page === 'verified') return <>
        <p>{page === 'verified' ? '邮箱验证完成，可以登录了。' : config.emailMessage}</p>
        {config.resendUrl && <Form action={config.resendUrl} config={config}>
            <input type="hidden" name="email" value={email || ''} />
            <button className="secondary-button" type="submit">重新发送验证邮件</button>
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
        <button type="submit" className="primary-button login-submit">{page === 'forgot' ? '发送重置邮件' : authLabels[page]}</button>
    </Form>;
}

function Account({ config }) {
    const { profile } = config;
    return <>
        <p className="detail-date">{profile.username} · {profile.email}</p>
        <Form className="login-form account-form" action={config.formUrl} config={config}>
            <Field name="user_name" label="姓名" defaultValue={profile.name} autoComplete="name" />
            <Field name="user_job_title" label="职位" defaultValue={profile.jobTitle} autoComplete="organization-title" />
            <Field name="user_company" label="公司" defaultValue={profile.company} autoComplete="organization" />
            <button type="submit" className="secondary-button">保存资料</button>
        </Form>
        {config.canChangePassword && <Form className="login-form account-form" action={config.passwordUrl} config={config}>
            <h3>修改密码</h3>
            <Field name="current_password" label="当前密码" type="password" autoComplete="current-password" required />
            <Field name="new_password" label="新密码" type="password" autoComplete="new-password" required />
            <Field name="confirm_password" label="确认新密码" type="password" autoComplete="new-password" required />
            <button type="submit" className="secondary-button">更改密码</button>
        </Form>}
    </>;
}

export function AuthPage({ config }) {
    const account = config.page === 'account';
    return <>
        <Header config={config} />
        <main className="login-main">
            <section className="login-paper" aria-label={authLabels[config.page]}>
                <h2 className={config.page === 'login' ? 'sr-only' : undefined}>{authLabels[config.page]}</h2>
                <Messages messages={config.messages} />
                {account ? <Account config={config} /> : <PublicForm config={config} />}
                {config.page !== 'login' && <p className="login-register"><a href={account ? config.homeUrl : config.loginUrl}>
                    {account ? '返回会议记录' : '返回登录'}
                </a></p>}
            </section>
        </main>
    </>;
}
