// Same-origin session cookies and CSRF are owned by Flask, not Android.
let prefix = '';
let token = '';
let refreshInFlight;

export function initRequests(config) {
    prefix = config.prefix;
    token = config.csrfToken;
}

export function currentCsrf() { return token; }

/** 应用挂载前缀下的完整路径（媒体、二进制文件等不走 request() 的地址）。 */
export function apiUrl(path) { return `${prefix}${path}`; }

export class RequestError extends Error {
    constructor(status, data = null) {
        super(`Meeting request failed (${status})`);
        this.status = status;
        this.data = data;
    }
}

async function refreshCsrf() {
    if (!refreshInFlight) {
        refreshInFlight = request('/api/csrf-token').then(data => {
            if (!data?.csrf_token) throw new Error('Missing CSRF token');
            token = data.csrf_token;
        }).finally(() => { refreshInFlight = null; });
    }
    await refreshInFlight;
}

export async function request(path, { method = 'GET', json, blob, contentType, timeout = 12000 } = {}) {
    const headers = { Accept: 'application/json' };
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    if (blob) headers['Content-Type'] = contentType || 'application/octet-stream';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    const send = async () => {
        if (method !== 'GET') headers['X-CSRFToken'] = token;
        const response = await fetch(`${prefix}${path}`, {
            method, headers, cache: 'no-store', signal: controller.signal,
            credentials: 'same-origin', body: blob ?? (json === undefined ? undefined : JSON.stringify(json)),
        });
        if (response.redirected && new URL(response.url).pathname === `${prefix}/login`) throw new RequestError(401);
        if (response.status === 204) return null;
        const data = await response.json().catch(() => null);
        if (!response.ok || !data) throw new RequestError(response.status, data);
        return data;
    };
    try {
        return await send();
    } catch (error) {
        // Only retry a mutation the server has explicitly rejected before execution.
        if (method === 'GET' || error.data?.csrf_retryable !== true) throw error;
        await refreshCsrf();
        return await send();
    } finally {
        clearTimeout(timer);
    }
}
