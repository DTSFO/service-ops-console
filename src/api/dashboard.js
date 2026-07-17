const configuredApiBase = import.meta.env.VITE_API_BASE;
const apiBase = typeof configuredApiBase === 'string'
    ? configuredApiBase.trim().replace(/\/$/, '')
    : '';

let csrfToken = '';

function apiUrl(path) {
    return `${apiBase}${path}`;
}

async function parseResponse(response) {
    if (response.status === 204) return {};
    const contentType = response.headers?.get?.('content-type') || '';
    const payload = contentType.includes('application/json') || (!contentType && typeof response.json === 'function')
        ? await response.json()
        : { message: await response.text() };
    if (!response.ok) {
        const error = new Error(payload.message || payload.error || `Request failed: ${response.status}`);
        error.status = response.status;
        error.payload = payload;
        throw error;
    }
    if (payload?.csrfToken) csrfToken = payload.csrfToken;
    return payload;
}

export async function request(path, options = {}) {
    const method = String(options.method || 'GET').toUpperCase();
    const headers = new Headers(options.headers || {});
    if (!new Set(['GET', 'HEAD', 'OPTIONS']).has(method) && csrfToken) {
        headers.set('x-csrf-token', csrfToken);
    }
    return parseResponse(await fetch(apiUrl(path), {
        ...options,
        method,
        headers,
        credentials: 'include'
    }));
}

function jsonRequest(path, method, body) {
    return request(path, {
        method,
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(body)
    });
}

export function fetchDashboardBootstrap() {
    return request('/api/inventory');
}

export function fetchServiceStatuses() {
    return request('/api/statuses');
}

export function fetchServiceHealth() {
    return request('/api/health');
}

export function fetchVersionStatuses() {
    return request('/api/versions');
}

export function checkVersions(serviceId = '', serviceIds = []) {
    const suffix = serviceId ? `/${encodeURIComponent(serviceId)}` : '';
    return jsonRequest(`/api/versions${suffix}/check`, 'POST', {
        confirm: true,
        ...(serviceId || !Array.isArray(serviceIds) || serviceIds.length === 0 ? {} : { serviceIds })
    });
}

export function runServiceControl(serviceId, action) {
    return jsonRequest(`/api/services/${encodeURIComponent(serviceId)}/control`, 'POST', {
        action,
        confirm: true
    });
}

export function fetchServiceOperationsDetail(serviceId) {
    const id = encodeURIComponent(serviceId);
    return Promise.allSettled([
        request(`/api/ops/services?query=${encodeURIComponent(serviceId)}`),
        request(`/api/ops/services/${id}/location`),
        request(`/api/ops/services/${id}/health`),
        request(`/api/ops/services/${id}/versions`),
        request(`/api/ops/services/${id}/update-plan`)
    ]).then(([service, location, health, versions, updatePlan]) => ({
        service,
        location,
        health,
        versions,
        updatePlan
    }));
}

export function fetchSession() {
    return request('/api/session');
}

export function login(username, password) {
    return jsonRequest('/api/login', 'POST', { username, password });
}

export function logout() {
    return jsonRequest('/api/logout', 'POST', { confirm: true });
}

export function fetchAdminOverview() {
    const optional = (path, fallback) => request(path).catch(() => fallback);
    return Promise.all([
        request('/api/admin/hosts'),
        request('/api/admin/groups'),
        request('/api/admin/services'),
        request('/api/admin/agent-tokens'),
        request('/api/admin/audit'),
        request('/api/admin/configuration'),
        optional('/api/admin/ssh-hosts', { hosts: [] }),
        optional('/api/admin/cloudflare', { servers: [] })
    ]).then(([hosts, groups, services, tokens, audit, configuration, ssh, cloudflare]) => ({
        hosts: hosts.hosts || hosts.items || hosts,
        groups: groups.groups || groups.items || groups,
        services: services.services || services.items || services,
        tokens: tokens.tokens || tokens.items || tokens,
        tokenScopes: tokens.scopes || [],
        audit: audit.events || audit.logs || audit.items || audit,
        configuration,
        sshHosts: ssh.hosts || ssh.items || ssh,
        cloudflare: cloudflare.servers || cloudflare.items || cloudflare
    }));
}

export function createAdminRecord(kind, input) {
    return jsonRequest(`/api/admin/${kind}`, 'POST', input);
}

export function updateAdminRecord(kind, id, input) {
    return jsonRequest(`/api/admin/${kind}/${encodeURIComponent(id)}`, 'PATCH', input);
}

export function deleteAdminRecord(kind, id, input = {}) {
    return jsonRequest(`/api/admin/${kind}/${encodeURIComponent(id)}`, 'DELETE', {
        ...input,
        confirm: true
    });
}

export function createAgentToken(input) {
    return jsonRequest('/api/admin/agent-tokens', 'POST', input);
}

export function updateAgentToken(id, input) {
    return jsonRequest(`/api/admin/agent-tokens/${encodeURIComponent(id)}`, 'PATCH', input);
}

export function revokeAgentToken(id) {
    return jsonRequest(`/api/admin/agent-tokens/${encodeURIComponent(id)}`, 'DELETE', { confirm: true });
}

export function setCsrfTokenForTests(value = '') {
    csrfToken = value;
}
