const CACHE_PREFIX = 'service-ops-console';
const CACHE_VERSION = 2;

export const CACHE_TTL = {
    bootstrap: 10 * 60 * 1000,
    statuses: 5 * 60 * 1000,
    versions: 10 * 60 * 1000
};

function now() {
    return Date.now();
}

function keyFor(name) {
    return `${CACHE_PREFIX}:${name}:v${CACHE_VERSION}`;
}

export function readDashboardCache(name, ttl = CACHE_TTL[name] || 0) {
    try {
        const raw = window.localStorage.getItem(keyFor(name));
        if (!raw) return null;
        const entry = JSON.parse(raw);
        if (!entry || entry.version !== CACHE_VERSION || !entry.data || !entry.writtenAt) {
            return null;
        }

        const age = now() - entry.writtenAt;
        return {
            data: entry.data,
            writtenAt: entry.writtenAt,
            age,
            fresh: ttl > 0 && age <= ttl
        };
    } catch {
        return null;
    }
}

export function writeDashboardCache(name, data) {
    try {
        window.localStorage.setItem(keyFor(name), JSON.stringify({
            version: CACHE_VERSION,
            writtenAt: now(),
            data
        }));
    } catch {
        /* localStorage can be full or disabled; dashboard should still work. */
    }
}
