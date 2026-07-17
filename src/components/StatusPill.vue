<template>
    <span class="status-pill" :class="{ 'is-loading': loading }">
        <span class="status-dot" :class="dotClass"></span>
        <span>{{ label }}</span>
    </span>
</template>

<script setup>
import { computed } from 'vue';

const props = defineProps({
    status: { type: String, default: 'unknown' },
    loading: { type: Boolean, default: false }
});

const normalized = computed(() => props.loading ? 'loading' : props.status);

const label = computed(() => {
    if (normalized.value === 'loading') return '刷新中';
    if (normalized.value === 'active' || normalized.value === 'running') return '运行中';
    if (normalized.value === 'inactive') return '已停止';
    return '异常';
});

const dotClass = computed(() => {
    if (normalized.value === 'loading') return 'status-loading';
    if (normalized.value === 'active' || normalized.value === 'running') return 'status-active';
    if (normalized.value === 'inactive') return 'status-inactive';
    return 'status-error';
});
</script>
