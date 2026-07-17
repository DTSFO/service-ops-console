export function getInitialVersionLabel(service = {}) {
    const current = service.update && service.update.current;
    if (!current) return '待检测';
    return current.version || current.label || '待检测';
}

export function getServiceDetailsTriggerId(serviceId) {
    return 'service-details-' + encodeURIComponent(String(serviceId || ''));
}

export function repositoryRoleLabel(role) {
    if (role === 'backend') return '后端';
    if (role === 'management-frontend' || role === 'frontend') return '前端';
    return '仓库';
}

function normalizeUrl(url) {
    return String(url || '').replace(/\/+$/, '');
}

function isHttpUrl(value) {
    try {
        const url = new URL(String(value || ''));
        return url.protocol === 'http:' || url.protocol === 'https:';
    } catch {
        return false;
    }
}

export function getRepositoryLinks(service = {}) {
    const links = [];
    const seen = new Set();
    const extraRepositories = Array.isArray(service.extraRepositories)
        ? service.extraRepositories.filter(repo => repo && isHttpUrl(repo.url))
        : [];

    if (isHttpUrl(service.repositoryUrl)) {
        const primaryExtra = extraRepositories.find(repo => normalizeUrl(repo.url) === normalizeUrl(service.repositoryUrl));
        links.push({
            url: service.repositoryUrl,
            label: primaryExtra ? repositoryRoleLabel(primaryExtra.role) : (extraRepositories.length ? '后端' : '仓库')
        });
        seen.add(normalizeUrl(service.repositoryUrl));
    }

    extraRepositories.forEach(repo => {
        const normalized = normalizeUrl(repo.url);
        if (seen.has(normalized)) return;
        links.push({
            url: repo.url,
            label: repositoryRoleLabel(repo.role)
        });
        seen.add(normalized);
    });

    return links;
}

export function getCurrentVersionLabel(service, versionStatus) {
    if (versionStatus) {
        return formatVersion(versionStatus.currentVersion, versionStatus.currentRevision);
    }
    return getInitialVersionLabel(service);
}

export function getLatestVersionLabel(service = {}, versionStatus) {
    if (versionStatus) return formatLatest(versionStatus);
    const source = service.update && service.update.source;
    if (source && source.type === 'github' && source.repo) return 'GitHub ' + source.repo;
    return source && source.label ? source.label : '本地版本';
}

export function formatVersion(value, revision) {
    if (value) return value;
    if (revision) return 'git@' + revision;
    return '未检测';
}

export function formatLatest(status) {
    if (status.latestVersion) return '最新 ' + status.latestVersion;
    if (status.latestRevision) return '最新 git@' + status.latestRevision;
    if (status.sourceType === 'static') return status.sourceLabel || '本地版本';
    return status.error ? '检测失败' : '最新 未检测';
}

export function formatNextCheck(value) {
    if (!value) return '13:00';
    const date = new Date(value);
    if (Number.isNaN(date.getTime())) return '13:00';
    return date.toLocaleString('zh-CN', {
        timeZone: 'Asia/Shanghai',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false
    }).replaceAll('/', '-');
}

export function versionStateLabel(status) {
    const labels = {
        current: '最新',
        outdated: '可更新',
        static: '固定',
        unknown: '未知',
        unchecked: '未检测',
        error: '失败'
    };
    return labels[status] || '未检测';
}
