import { computed, shallowRef, ref } from 'vue';
import {
    fetchDashboardBootstrap,
    fetchServiceHealth,
    fetchServiceStatuses,
    fetchVersionStatuses
} from '../api/dashboard';
import { formatNextCheck } from '../utils/services';
import { readDashboardCache, writeDashboardCache } from '../utils/dashboardCache';

function normalizeList(value) {
    return Array.isArray(value) ? value : [];
}

function buildServiceSearchText(service, hostsById, groupsById, servicesById) {
    const relatedNames = (service.related || [])
        .map(id => servicesById[id] && servicesById[id].name)
        .filter(Boolean)
        .join(' ');
    const host = hostsById[service.host];
    const group = groupsById[service.group];

    return [
        service.id,
        service.name,
        service.description,
        service.host,
        host && host.name,
        host && host.description,
        group && group.name,
        group && group.description,
        relatedNames
    ].filter(Boolean).join(' ').toLowerCase();
}

function hydrateServices(rawServices, rawHosts, rawGroups) {
    const hostsById = Object.fromEntries(rawHosts.map(item => [item.id, item]));
    const groupsById = Object.fromEntries(rawGroups.map(item => [item.id, item]));
    const servicesById = Object.fromEntries(rawServices.map(item => [item.id, item]));

    return rawServices.map(service => ({
        ...service,
        searchText: buildServiceSearchText(service, hostsById, groupsById, servicesById)
    }));
}

export function useDashboardData(showToast) {
    const bootLoading = ref(true);
    const mode = ref('production');
    const canControl = ref(true);
    const backgroundUrl = ref(`${import.meta.env.BASE_URL}ink-dragon-bg.webp`);
    const hosts = shallowRef([]);
    const groups = shallowRef([]);
    const services = shallowRef([]);
    const tools = shallowRef([]);
    const statuses = shallowRef([]);
    const healthStatuses = shallowRef([]);
    const versionStatuses = shallowRef([]);
    const nextAutoCheckAt = ref('');
    const statusLoading = ref(false);
    const versionsLoading = ref(false);
    let bootstrapRefreshPromise = null;
    let statusRefreshPromise = null;
    let versionRefreshPromise = null;

    const hostsById = computed(() => Object.fromEntries(hosts.value.map(item => [item.id, item])));
    const groupsById = computed(() => Object.fromEntries(groups.value.map(item => [item.id, item])));
    const servicesById = computed(() => Object.fromEntries(services.value.map(item => [item.id, item])));
    const statusesById = computed(() => Object.fromEntries(statuses.value.map(item => [item.id, item])));
    const healthById = computed(() => Object.fromEntries(healthStatuses.value.map(item => [item.id, item])));
    const versionsById = computed(() => Object.fromEntries(versionStatuses.value.map(item => [item.id, item])));
    const frontendCount = computed(() => services.value.filter(service => service.hasFrontend).length);
    const updateCount = computed(() => versionStatuses.value.filter(item => item.updateAvailable).length);
    const nextCheckTime = computed(() => formatNextCheck(nextAutoCheckAt.value));
    const activeCount = computed(() => statuses.value.filter(item => item.status === 'active' || item.status === 'running').length);
    const attentionCount = computed(() => Math.max(services.value.length - activeCount.value, 0));

    function applyBootstrap(payload) {
        const nextHosts = normalizeList(payload.hosts);
        const nextGroups = normalizeList(payload.groups);
        const nextServices = hydrateServices(normalizeList(payload.services), nextHosts, nextGroups);

        backgroundUrl.value = payload.backgroundUrl || backgroundUrl.value;
        mode.value = payload.mode || 'production';
        canControl.value = payload.capabilities?.control !== false;
        hosts.value = nextHosts;
        groups.value = nextGroups;
        services.value = nextServices;
        tools.value = normalizeList(payload.tools);
    }

    function applyStatuses(payload) {
        statuses.value = normalizeList(payload.statuses);
    }

    function applyVersions(payload) {
        versionStatuses.value = normalizeList(payload.statuses);
        nextAutoCheckAt.value = payload.nextAutoCheckAt || '';
    }

    async function refreshBootstrap({ silent = false } = {}) {
        if (bootstrapRefreshPromise) return bootstrapRefreshPromise;
        bootstrapRefreshPromise = (async () => {
            try {
                const payload = await fetchDashboardBootstrap();
                applyBootstrap(payload);
                writeDashboardCache('bootstrap', payload);
                return payload;
            } catch (error) {
                if (!silent) showToast(error.message || '仪表盘加载失败');
                throw error;
            } finally {
                bootLoading.value = false;
                bootstrapRefreshPromise = null;
            }
        })();
        return bootstrapRefreshPromise;
    }

    async function loadBootstrap({ force = false } = {}) {
        const cached = readDashboardCache('bootstrap');
        if (cached) {
            applyBootstrap(cached.data);
            bootLoading.value = false;
            if (cached.fresh && !force) {
                return { fromCache: true, skippedRefresh: true };
            }
            if (!force) {
                refreshBootstrap({ silent: true }).catch(() => {});
                return { fromCache: true, refreshing: true };
            }
        }

        try {
            return await refreshBootstrap({ silent: false });
        } catch {
            return null;
        } finally {
            bootLoading.value = false;
        }
    }

    async function refreshStatuses({ manual = false, showLoading = false, silent = false } = {}) {
        if (statusRefreshPromise) return statusRefreshPromise;
        if (showLoading) statusLoading.value = true;
        statusRefreshPromise = (async () => {
            try {
                const payload = await fetchServiceStatuses();
                applyStatuses(payload);
                writeDashboardCache('statuses', payload);
                if (manual) showToast('状态已刷新');
                return payload;
            } catch (error) {
                if (!silent) showToast(error.message || '状态读取失败');
                throw error;
            } finally {
                if (showLoading) statusLoading.value = false;
                statusRefreshPromise = null;
            }
        })();
        return statusRefreshPromise;
    }

    async function loadStatuses(manual = false, { force = false } = {}) {
        const cached = readDashboardCache('statuses');
        if (!manual && cached) {
            applyStatuses(cached.data);
            if (cached.fresh && !force) {
                return { fromCache: true, skippedRefresh: true };
            }
            if (!force) {
                refreshStatuses({ manual: false, showLoading: false, silent: true }).catch(() => {});
                return { fromCache: true, refreshing: true };
            }
        }

        try {
            return await refreshStatuses({
                manual,
                showLoading: manual || !cached,
                silent: !manual && Boolean(cached)
            });
        } catch {
            return null;
        }
    }

    async function loadHealth() {
        try {
            const payload = await fetchServiceHealth();
            healthStatuses.value = normalizeList(payload.statuses);
            return payload;
        } catch (error) {
            showToast(error.message || '健康探测读取失败');
            return null;
        }
    }

    async function refreshVersions({ showLoading = false, silent = false } = {}) {
        if (versionRefreshPromise) return versionRefreshPromise;
        if (showLoading) versionsLoading.value = true;
        versionRefreshPromise = (async () => {
            try {
                const payload = await fetchVersionStatuses();
                applyVersions(payload);
                writeDashboardCache('versions', payload);
                return payload;
            } catch (error) {
                if (!silent) showToast(error.message || '版本读取失败');
                throw error;
            } finally {
                if (showLoading) versionsLoading.value = false;
                versionRefreshPromise = null;
            }
        })();
        return versionRefreshPromise;
    }

    async function loadVersions({ force = false } = {}) {
        const cached = readDashboardCache('versions');
        if (cached) {
            applyVersions(cached.data);
            if (cached.fresh && !force) {
                return { fromCache: true, skippedRefresh: true };
            }
            if (!force) {
                refreshVersions({ showLoading: false, silent: true }).catch(() => {});
                return { fromCache: true, refreshing: true };
            }
        }

        try {
            return await refreshVersions({
                showLoading: !cached,
                silent: Boolean(cached)
            });
        } catch {
            return null;
        }
    }

    return {
        bootLoading,
        mode,
        canControl,
        backgroundUrl,
        hosts,
        groups,
        services,
        tools,
        statuses,
        healthStatuses,
        versionStatuses,
        nextAutoCheckAt,
        statusLoading,
        versionsLoading,
        hostsById,
        groupsById,
        servicesById,
        statusesById,
        healthById,
        versionsById,
        frontendCount,
        updateCount,
        nextCheckTime,
        activeCount,
        attentionCount,
        loadBootstrap,
        loadStatuses,
        loadHealth,
        loadVersions
    };
}
