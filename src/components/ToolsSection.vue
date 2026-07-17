<template>
    <section class="tools-section">
        <div class="section-heading">
            <div>
                <span class="section-kicker">tools</span>
                <h2>工具</h2>
                <p>辅助入口，不执行服务启停命令。</p>
            </div>
        </div>
        <div class="tool-grid">
            <a v-for="tool in tools" :key="tool.id" class="tool-card" :href="tool.url" target="_blank" rel="noopener noreferrer">
                <span class="tool-icon" v-html="icon(iconName(tool))"></span>
                <span>{{ tool.name }}</span>
                <small>{{ tool.description }}</small>
            </a>
        </div>
    </section>
</template>

<script setup>
import { icon } from '../icons';

defineProps({
    tools: { type: Array, default: () => [] }
});

function iconName(tool) {
    if (tool.id === 'source') return 'github';
    if (tool.id === 'architecture') return 'grid';
    return 'grid';
}
</script>
