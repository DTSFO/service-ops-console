<template>
    <TopBar
        :operation-text="operationText"
        :checking-versions="checkingAllVersions"
        :refreshing-statuses="statusLoading"
        @check-versions="handleCheckVersions()"
        @refresh-statuses="refreshStatuses(true)"
        @open-admin="adminOpen = true"
    />

    <main class="page" :style="pageStyle">
        <div v-if="bootLoading" class="boot-panel">
            <span class="btn-spinner" aria-hidden="true"></span>
            <span>加载中</span>
        </div>

        <div v-else-if="!dashboardReady" class="boot-panel">
            <span>请先登录以查看运维控制台</span>
            <button type="button" class="primary-btn" @click="adminOpen = true">管理员登录</button>
        </div>

        <template v-else>
            <HeroPanel>
                <MetricsStrip
                    :host-count="hosts.length"
                    :service-count="services.length"
                    :active-count="activeCount"
                    :attention-count="attentionCount"
                    :frontend-count="frontendCount"
                    :update-count="updateCount"
                    :next-check-time="nextCheckTime"
                    :visible-count="visibleCount"
                    :pending-status="statusLoading"
                    :pending-versions="versionsLoading || checkingAllVersions || checkingVersionIds.size > 0"
                />
            </HeroPanel>

            <ServiceFilters
                v-model:host="filters.host"
                v-model:group="filters.group"
                v-model:query="filters.query"
                :hosts="hosts"
                :groups="groups"
                :visible-count="visibleCount"
                @reset="resetFilters"
            />

            <div v-if="visibleCount === 0" class="empty-state">没有匹配当前筛选条件的服务。</div>

            <ServiceGroup
                v-for="item in visibleGroups"
                :key="item.group.id"
                :group="item.group"
                :services="item.services"
                :visible-count="item.visibleCount"
                :visible-service-ids="visibleServiceIds"
                :hosts-by-id="hostsById"
                :services-by-id="servicesById"
                :statuses-by-id="statusesById"
                :versions-by-id="versionsById"
                :status-loading="statusLoading"
                :busy-actions="busyActions"
                :checking-version-ids="checkingVersionIds"
                :checking-all-versions="checkingAllVersions"
                :highlighted-service-id="highlightedServiceId"
                :can-control="canControl"
                :collapsed="collapsedGroups.has(item.group.id)"
                @focus-service="focusService"
                @show-details="openServiceDetails"
                @control="handleControl"
                @check-version="handleCheckVersions"
                @toggle-collapse="toggleGroupCollapse"
            />

            <ToolsSection :tools="tools" />
        </template>
    </main>

    <ServiceDetailDrawer
        :open="detailOpen"
        :service="selectedService"
        :host="selectedHost"
        :group="selectedGroup"
        :status="selectedStatus"
        :health="selectedHealth"
        :version-status="selectedVersionStatus"
        :services-by-id="servicesById"
        :status-loading="statusLoading"
        :versions-loading="versionsLoading"
        :can-control="canControl"
        :busy-action="selectedService ? busyActions[selectedService.id] || '' : ''"
        @close="closeServiceDetails"
        @select-service="selectServiceDetails"
        @control="handleControl"
    />

    <AdminWorkspace :open="adminOpen" @close="adminOpen = false" @authenticated="handleAuthenticated" />

    <ToastHost :message="toastMessage" />
</template>

<script setup>
import { computed, nextTick, onMounted, ref, watch } from 'vue';
import { useDashboardData } from './composables/useDashboardData';
import { useServiceCommands } from './composables/useServiceCommands';
import { useServiceFilters } from './composables/useServiceFilters';
import { useToast } from './composables/useToast';
import TopBar from './components/TopBar.vue';
import HeroPanel from './components/HeroPanel.vue';
import MetricsStrip from './components/MetricsStrip.vue';
import ServiceFilters from './components/ServiceFilters.vue';
import ServiceGroup from './components/ServiceGroup.vue';
import ToolsSection from './components/ToolsSection.vue';
import ToastHost from './components/ToastHost.vue';
import ServiceDetailDrawer from './components/ServiceDetailDrawer.vue';
import AdminWorkspace from './components/AdminWorkspace.vue';
import { fetchSession } from './api/dashboard';

const { toastMessage, showToast } = useToast();
const dashboard = useDashboardData(showToast);
const {
    activeCount,
    attentionCount,
    backgroundUrl,
    bootLoading,
    canControl,
    frontendCount,
    groups,
    groupsById,
    hosts,
    hostsById,
    healthById,
    loadHealth,
    loadBootstrap,
    loadStatuses,
    loadVersions,
    nextAutoCheckAt,
    nextCheckTime,
    services,
    servicesById,
    statusesById,
    statusLoading,
    tools,
    updateCount,
    versionStatuses,
    versionsById,
    versionsLoading
} = dashboard;

const {
    filters,
    resetFilters,
    visibleCount,
    visibleServiceIds,
    visibleGroups
} = useServiceFilters({
    groups,
    hostsById,
    services,
    servicesById
});

const {
    busyActions,
    checkingAllVersions,
    checkingVersionIds,
    handleCheckVersions,
    handleControl,
    operationText,
    refreshStatuses
} = useServiceCommands({
    canControl,
    loadStatuses,
    nextAutoCheckAt,
    services,
    servicesById,
    showToast,
    statusLoading,
    versionStatuses
});

const highlightedServiceId = ref('');
const selectedServiceId = ref('');
const adminOpen = ref(false);
const dashboardReady = ref(false);
const selectedService = computed(() => servicesById.value[selectedServiceId.value] || null);
const selectedHost = computed(() => selectedService.value ? hostsById.value[selectedService.value.host] || null : null);
const selectedGroup = computed(() => selectedService.value ? groupsById.value[selectedService.value.group] || null : null);
const selectedStatus = computed(() => selectedService.value ? statusesById.value[selectedService.value.id] || null : null);
const selectedHealth = computed(() => selectedService.value ? healthById.value[selectedService.value.id] || null : null);
const selectedVersionStatus = computed(() => selectedService.value ? versionsById.value[selectedService.value.id] || null : null);
const detailOpen = computed(() => Boolean(selectedService.value));
let highlightTimer = 0;
let detailReturnServiceId = '';

function openServiceDetails(serviceId) {
    if (!servicesById.value[serviceId]) return;
    if (!detailOpen.value) detailReturnServiceId = serviceId;
    selectedServiceId.value = serviceId;
}
function selectServiceDetails(serviceId) {
    if (servicesById.value[serviceId]) selectedServiceId.value = serviceId;
}
async function closeServiceDetails() {
    const serviceId = detailReturnServiceId || selectedServiceId.value;
    if (!serviceId) return;
    selectedServiceId.value = '';
    detailReturnServiceId = '';
    await nextTick();
    document.getElementById('service-details-' + encodeURIComponent(serviceId))?.focus();
}

watch(servicesById, nextServicesById => {
    if (selectedServiceId.value && !nextServicesById[selectedServiceId.value]) closeServiceDetails();
});

const COLLAPSED_GROUPS_KEY = 'service-ops-console-collapsed-groups';
const collapsedGroups = ref(loadCollapsedGroups());

function loadCollapsedGroups() {
    try {
        const raw = window.localStorage.getItem(COLLAPSED_GROUPS_KEY);
        if (!raw) return new Set();
        const parsed = JSON.parse(raw);
        return new Set(Array.isArray(parsed) ? parsed : []);
    } catch {
        return new Set();
    }
}

function persistCollapsedGroups() {
    try {
        window.localStorage.setItem(COLLAPSED_GROUPS_KEY, JSON.stringify([...collapsedGroups.value]));
    } catch {
        /* ignore */
    }
}

function toggleGroupCollapse(groupId) {
    const next = new Set(collapsedGroups.value);
    if (next.has(groupId)) next.delete(groupId);
    else next.add(groupId);
    collapsedGroups.value = next;
    persistCollapsedGroups();
}

const pageStyle = computed(() => ({
    '--dashboard-bg': `url("${backgroundUrl.value}")`
}));

async function focusService(serviceId) {
    resetFilters();
    // 若目标服务所在分组被折叠，自动展开
    const target = servicesById.value[serviceId];
    if (target && collapsedGroups.value.has(target.group)) {
        const next = new Set(collapsedGroups.value);
        next.delete(target.group);
        collapsedGroups.value = next;
        persistCollapsedGroups();
    }
    await nextTick();
    const card = document.getElementById('service-' + CSS.escape(serviceId));
    if (!card) return;
    highlightedServiceId.value = serviceId;
    card.scrollIntoView({ block: 'center', behavior: 'smooth' });
    window.clearTimeout(highlightTimer);
    highlightTimer = window.setTimeout(() => {
        highlightedServiceId.value = '';
    }, 1800);
}

onMounted(async () => {
    const session = await fetchSession().catch(() => ({ authenticated: false, dashboardAuthRequired: false }));
    if (session.dashboardAuthRequired && !session.authenticated) {
        bootLoading.value = false;
        adminOpen.value = true;
        return;
    }
    const loaded = await loadBootstrap();
    dashboardReady.value = Boolean(loaded);
    if (!services.value.length) return;
    loadStatuses(false);
    loadHealth();
    loadVersions();
});

async function handleAuthenticated() {
    adminOpen.value = false;
    const loaded = await loadBootstrap({ force: true });
    dashboardReady.value = Boolean(loaded);
    if (!services.value.length) return;
    loadStatuses(false, { force: true });
    loadHealth();
    loadVersions({ force: true });
}
</script>
