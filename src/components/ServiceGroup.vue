<template>
    <section v-show="visibleCount > 0" class="group-section" :class="{ collapsed }" :data-group-section="group.id">
        <div class="section-heading">
            <div class="section-heading-text">
                <span class="section-kicker">{{ group.id }}</span>
                <h2>{{ group.name }}</h2>
                <p>{{ group.description }}</p>
            </div>
            <div class="section-heading-aside">
                <strong>{{ visibleCount }}</strong>
                <button
                    type="button"
                    class="section-collapse"
                    :title="collapsed ? '展开' : '收起'"
                    :aria-label="(collapsed ? '展开' : '收起') + ' ' + group.name"
                    :aria-expanded="!collapsed"
                    @click="$emit('toggle-collapse', group.id)"
                >
                    <span v-html="icon('chevron')" :class="{ rotate: !collapsed }"></span>
                    <span v-if="collapsed" class="section-collapse-label">展开</span>
                </button>
            </div>
        </div>
        <div class="service-grid-wrapper">
            <div class="service-grid">
                <ServiceCard
                    v-for="service in services"
                    :key="service.id"
                    v-show="isServiceVisible(service.id)"
                    v-memo="[
                        isServiceVisible(service.id),
                        statusesById[service.id],
                        versionsById[service.id],
                        statusLoading,
                        busyActions[service.id] || '',
                        checkingVersionIds.has(service.id),
                        checkingAllVersions,
                        highlightedServiceId === service.id,
                        canControl
                    ]"
                    :service="service"
                    :hosts-by-id="hostsById"
                    :services-by-id="servicesById"
                    :status="statusesById[service.id]"
                    :version-status="versionsById[service.id]"
                    :status-loading="statusLoading"
                    :busy-action="busyActions[service.id] || ''"
                    :checking-version="checkingVersionIds.has(service.id) || checkingAllVersions"
                    :version-busy="Boolean(checkingAllVersions || checkingVersionIds.size)"
                    :highlight="highlightedServiceId === service.id"
                    :can-control="canControl"
                    @focus-service="$emit('focus-service', $event)"
                    @show-details="$emit('show-details', $event)"
                    @control="(...args) => $emit('control', ...args)"
                    @check-version="$emit('check-version', $event)"
                />
            </div>
        </div>
    </section>
</template>

<script setup>
import ServiceCard from './ServiceCard.vue';
import { icon } from '../icons';

const props = defineProps({
    group: { type: Object, required: true },
    services: { type: Array, default: () => [] },
    visibleCount: { type: Number, default: 0 },
    visibleServiceIds: { type: Object, default: null },
    hostsById: { type: Object, default: () => ({}) },
    servicesById: { type: Object, default: () => ({}) },
    statusesById: { type: Object, default: () => ({}) },
    versionsById: { type: Object, default: () => ({}) },
    statusLoading: { type: Boolean, default: false },
    busyActions: { type: Object, default: () => ({}) },
    checkingVersionIds: { type: Object, required: true },
    checkingAllVersions: { type: Boolean, default: false },
    highlightedServiceId: { type: String, default: '' },
    collapsed: { type: Boolean, default: false },
    canControl: { type: Boolean, default: true }
});

defineEmits(['focus-service', 'show-details', 'control', 'check-version', 'toggle-collapse']);

function isServiceVisible(serviceId) {
    return !props.visibleServiceIds || props.visibleServiceIds.has(serviceId);
}
</script>
