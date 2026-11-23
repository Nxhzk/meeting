const appPrefix = document.body.dataset.appPrefix || '';

export class RequestError extends Error {
    constructor(status, data = null) {
        super(`Meeting request failed (${status})`);
        this.status = status;
        this.data = data;
    }
}

export async function request(path, { method = 'GET', json, blob, timeout = 12000 } = {}) {
    const headers = { Accept: 'application/json' };
    if (method !== 'GET') headers['X-CSRFToken'] = document.querySelector('[name="csrf-token"]').content;
    if (json !== undefined) headers['Content-Type'] = 'application/json';
    if (blob) headers['Content-Type'] = 'application/octet-stream';
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const response = await fetch(`${appPrefix}${path}`, {
            method, headers, cache: 'no-store', signal: controller.signal,
            credentials: 'same-origin', body: blob || (json === undefined ? undefined : JSON.stringify(json)),
        });
        if (response.redirected && new URL(response.url).pathname === `${appPrefix}/login`) throw new RequestError(401);
        if (response.status === 204) return null;
        const data = await response.json().catch(() => null);
        if (!response.ok || !data) throw new RequestError(response.status, data);
        return data;
    } finally {
        clearTimeout(timer);
    }
}
