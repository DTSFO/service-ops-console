<template>
    <article
        :id="'service-' + service.id"
        class="service-card"
        :class="{ 'is-busy': busy, highlight }"
        @click="handleCardClick"
    >
        <!-- 朱印汉字章：取服务名首个汉字（或字母大写） -->
        <span class="card-seal" aria-hidden="true">{{ sealCharacter }}</span>

        <!-- 水墨折角钩边：左上 + 右下 -->
        <svg class="card-corner top-left" viewBox="0 0 32 32" aria-hidden="true">
            <path d="M2 14V6a4 4 0 0 1 4-4h8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            <path d="M2 4l4 4M6 2l-4 4" fill="none" stroke="currentColor" stroke-width="0.8" opacity="0.55" />
        </svg>
        <svg class="card-corner bottom-right" viewBox="0 0 32 32" aria-hidden="true">
            <path d="M30 18v8a4 4 0 0 1-4 4h-8" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" />
            <path d="M30 28l-4-4M26 30l4-4" fill="none" stroke="currentColor" stroke-width="0.8" opacity="0.55" />
        </svg>

        <!-- 卡片皴笔斜痕（极淡） -->
        <svg class="card-ink" viewBox="0 0 240 160" preserveAspectRatio="none" aria-hidden="true">
            <path d="M0 140 Q 60 130 120 138 T 240 132" stroke="currentColor" stroke-width="0.6" fill="none" opacity="0.3" />
            <path d="M0 152 Q 80 146 160 150 T 240 148" stroke="currentColor" stroke-width="0.4" fill="none" opacity="0.22" />
        </svg>

        <header class="card-head">
            <div class="card-title-row">
                <span class="service-icon" v-html="icon(service.group)"></span>
                <div class="card-main">
                    <h3>{{ service.name }}</h3>
                    <p>{{ service.description }}</p>
                </div>
            </div>
            <div class="card-meta">
                <div class="card-meta-top">
                    <StatusPill :status="statusValue" :loading="statusLoading" />
                    <button
                        :id="detailsButtonId"
                        type="button"
                        class="card-details-btn"
                        :title="'查看 ' + service.name + ' 详情'"
                        :aria-label="'查看 ' + service.name + ' 详情'"
                        @click.stop="emit('show-details', service.id)"
                    >
                        <span v-html="icon('details')"></span>
                    </button>
                </div>
                <span class="host-badge">{{ hostLabel }}</span>
            </div>
        </header>

        <div v-if="relatedServices.length" class="relations" aria-label="关联服务">
            <button
                v-for="item in visibleRelatedServices"
                :key="item.id"
                type="button"
                class="relation-chip"
                :title="item.name"
                @click="$emit('focus-service', item.id)"
            >
                {{ item.name }}
            </button>
            <span v-if="hiddenRelatedCount" class="relation-more">+{{ hiddenRelatedCount }}</span>
        </div>

        <VersionStrip
            :service="service"
            :version-status="versionStatus"
            :checking="checkingVersion"
            :busy="versionBusy"
            @check="$emit('check-version', $event)"
        />

        <footer class="card-actions">
            <a
                v-if="service.url"
                class="open-link"
                :href="service.url"
                target="_blank"
                rel="noopener noreferrer"
                title="打开服务入口"
            >
                <span v-html="icon('open')"></span>
                <span>打开</span>
            </a>
            <span v-else class="open-placeholder">无前端入口</span>
            <div v-if="canControl" class="control-group">
                <button
                    type="button"
                    class="control-btn toggle"
                    :class="toggleAction"
                    :disabled="busy"
                    :title="toggleLabel + ' ' + service.name"
                    :aria-label="toggleLabel + ' ' + service.name"
                    @click="$emit('control', service.id, toggleAction)"
                >
                    <span v-if="busyAction === toggleAction" class="btn-spinner" aria-hidden="true"></span>
                    <span v-else v-html="icon(toggleAction)"></span>
                    <span>{{ busyAction === toggleAction ? toggleLabel + '中' : toggleLabel }}</span>
                </button>
                <button
                    type="button"
                    class="control-btn restart"
                    :disabled="busy"
                    title="重启"
                    @click="$emit('control', service.id, 'restart')"
                >
                    <span v-if="busyAction === 'restart'" class="btn-spinner" aria-hidden="true"></span>
                    <span v-else v-html="icon('restart')"></span>
                    <span>{{ busyAction === 'restart' ? '重启中' : '重启' }}</span>
                </button>
            </div>
            <span v-else class="control-readonly">控制未启用</span>
        </footer>
    </article>
</template>

<script setup>
import { computed } from 'vue';
import { icon } from '../icons';
import { getServiceDetailsTriggerId } from '../utils/services';
import StatusPill from './StatusPill.vue';
import VersionStrip from './VersionStrip.vue';

const props = defineProps({
    service: { type: Object, required: true },
    hostsById: { type: Object, default: () => ({}) },
    servicesById: { type: Object, default: () => ({}) },
    status: { type: Object, default: null },
    versionStatus: { type: Object, default: null },
    statusLoading: { type: Boolean, default: false },
    busyAction: { type: String, default: '' },
    checkingVersion: { type: Boolean, default: false },
    versionBusy: { type: Boolean, default: false },
    highlight: { type: Boolean, default: false },
    canControl: { type: Boolean, default: true }
});

const emit = defineEmits(['focus-service', 'show-details', 'control', 'check-version']);

const CARD_INTERACTIVE_SELECTOR = [
    'a',
    'button',
    'input',
    'select',
    'textarea',
    'label',
    'summary',
    '[role="button"]',
    '[role="link"]',
    '[contenteditable="true"]',
    '[tabindex]:not([tabindex="-1"])'
].join(', ');

const detailsButtonId = computed(() => getServiceDetailsTriggerId(props.service.id));
const statusValue = computed(() => props.status ? props.status.status : 'unknown');
const busy = computed(() => Boolean(props.busyAction));
const hostLabel = computed(() => props.hostsById[props.service.host]?.name || props.service.host);
const relatedServices = computed(() => (props.service.related || []).map(id => props.servicesById[id]).filter(Boolean));
const visibleRelatedServices = computed(() => relatedServices.value.slice(0, 2));
const hiddenRelatedCount = computed(() => Math.max(relatedServices.value.length - visibleRelatedServices.value.length, 0));
const toggleAction = computed(() => statusValue.value === 'active' || statusValue.value === 'running' ? 'stop' : 'start');
const toggleLabel = computed(() => toggleAction.value === 'stop' ? '停止' : '启动');

function handleCardClick(event) {
    if (typeof event.composedPath === 'function') {
        for (const target of event.composedPath()) {
            if (target === event.currentTarget) break;
            if (target instanceof Element && target.matches(CARD_INTERACTIVE_SELECTOR)) return;
        }
    } else if (event.target instanceof Element && event.target.closest(CARD_INTERACTIVE_SELECTOR)) {
        return;
    }
    emit('show-details', props.service.id);
}

// 印章字：服务名首字（中文优先），fallback 到首字母大写
const sealCharacter = computed(() => {
    const name = props.service.name || '';
    const cjk = name.match(/[\u4e00-\u9fff]/);
    if (cjk) return cjk[0];
    const letter = name.match(/[A-Za-z]/);
    return letter ? letter[0].toUpperCase() : '※';
});
</script>
