<template>
    <div class="metrics-panel" aria-label="服务统计">
        <div v-for="metric in metrics" :key="metric.key" class="metric" :class="metric.className">
            <span class="metric-icon" v-html="icon(metric.icon)"></span>
            <span class="metric-label">{{ metric.label }}</span>
            <strong v-if="!metric.lines" :id="metric.id || null">{{ metric.value }}</strong>
            <strong v-else :id="metric.id || null" class="metric-multiline">
                <span v-for="(line, i) in metric.lines" :key="i">{{ line }}</span>
            </strong>
            <small>{{ metric.unit }}</small>
        </div>
    </div>
</template>

<script setup>
import { computed } from 'vue';
import { icon } from '../icons';

const props = defineProps({
    hostCount: { type: Number, default: 0 },
    serviceCount: { type: Number, default: 0 },
    activeCount: { type: [Number, String], default: '--' },
    attentionCount: { type: [Number, String], default: '--' },
    frontendCount: { type: Number, default: 0 },
    updateCount: { type: [Number, String], default: '--' },
    nextCheckTime: { type: String, default: '13:00' },
    visibleCount: { type: [Number, String], default: '--' },
    pendingStatus: { type: Boolean, default: false },
    pendingVersions: { type: Boolean, default: false }
});

const nextCheckLines = computed(() => {
    const text = String(props.nextCheckTime || '').trim();
    if (!text) return ['--'];
    // "05-04 13:00" -> ["05-04", "13:00"]; if 已经是单段(只有时间),保持 1 行
    const parts = text.split(/\s+/);
    return parts.length >= 2 ? parts.slice(0, 2) : parts;
});

const metrics = computed(() => [
    { key: 'hosts', icon: 'metric-vps', label: '受管主机', value: props.hostCount, unit: '台' },
    { key: 'services', icon: 'metric-services', label: '服务总数', value: props.serviceCount, unit: '项' },
    { key: 'active', icon: 'metric-running', label: '运行中', value: props.activeCount, unit: '项', className: ['active', props.pendingStatus && 'is-pending'] },
    { key: 'attention', icon: 'metric-warning', label: '已停止/异常', value: props.attentionCount, unit: '项', className: ['attention', props.pendingStatus && 'is-pending'] },
    { key: 'frontend', icon: 'metric-globe', label: '前端入口', value: props.frontendCount, unit: '个' },
    { key: 'updates', icon: 'metric-update', label: '可更新', value: props.updateCount, unit: '项', className: ['attention', props.pendingVersions && 'is-pending'] },
    { key: 'next', icon: 'metric-clock', label: '下次检测', lines: nextCheckLines.value, unit: '自动巡检', className: ['is-time', props.pendingVersions && 'is-pending'] },
    { key: 'visible', icon: 'metric-funnel', label: '当前筛选', value: props.visibleCount, unit: '项' }
]);
</script>
