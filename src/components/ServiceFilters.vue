<template>
    <div class="filter-wrap">
        <section class="filter-panel" aria-label="服务筛选">
            <label class="search-box">
                <span v-html="icon('search')"></span>
                <input
                    id="dashboard-service-search"
                    name="serviceSearch"
                    :value="query"
                    type="search"
                    placeholder="搜索服务、主机、分类或关联项"
                    autocomplete="off"
                    @input="$emit('update:query', $event.target.value)"
                >
            </label>
            <div class="filters" aria-label="筛选条件">
                <select id="dashboard-host-filter" name="hostFilter" :value="host" class="filter-field" aria-label="按主机筛选" @change="$emit('update:host', $event.target.value)">
                    <option value="all">全部主机</option>
                    <option v-for="item in hosts" :key="item.id" :value="item.id">{{ item.name }}</option>
                </select>
                <select id="dashboard-group-filter" name="groupFilter" :value="group" class="filter-field" aria-label="按分组筛选" @change="$emit('update:group', $event.target.value)">
                    <option value="all">全部分组</option>
                    <option v-for="item in groups" :key="item.id" :value="item.id">{{ item.name }}</option>
                </select>
                <button type="button" class="filter-reset" @click="$emit('reset')">
                    <span v-html="icon('refresh')"></span>
                    <span>重置</span>
                </button>
            </div>
        </section>
        <p class="filter-summary">{{ summary }}</p>
    </div>
</template>

<script setup>
import { computed } from 'vue';
import { icon } from '../icons';

const props = defineProps({
    hosts: { type: Array, default: () => [] },
    groups: { type: Array, default: () => [] },
    host: { type: String, default: 'all' },
    group: { type: String, default: 'all' },
    query: { type: String, default: '' },
    visibleCount: { type: Number, default: 0 }
});

defineEmits(['update:host', 'update:group', 'update:query', 'reset']);

const summary = computed(() => {
    const active = [
        props.host !== 'all' ? '主机' : '',
        props.group !== 'all' ? '分组' : '',
        props.query.trim() ? '搜索' : ''
    ].filter(Boolean);
    return active.length ? `已按${active.join('、')}筛选,显示 ${props.visibleCount} 个服务` : '显示全部服务';
});
</script>
