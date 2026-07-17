<template>
    <div class="version-strip" :class="{ 'is-checking': checking }">
        <div class="version-copy">
            <span class="version-label" v-html="icon('version')"></span>
            <div class="version-text">
                <span>版本 · <strong>{{ currentVersion }}</strong></span>
                <small :title="latestTitle">{{ latestVersion }}</small>
            </div>
            <div v-if="repositoryLinks.length" class="repository-links">
                <a
                    v-for="link in repositoryLinks"
                    :key="link.url + link.label"
                    class="repo-link"
                    :href="link.url"
                    target="_blank"
                    rel="noopener noreferrer"
                    :title="'打开 ' + link.label + ' GitHub 仓库'"
                >
                    <span v-html="icon('github')"></span>
                    <span>{{ link.label }}</span>
                </a>
            </div>
        </div>
        <div class="version-actions">
            <span class="version-state" :class="stateClass" :title="stateTitle">{{ stateLabel }}</span>
            <button
                type="button"
                class="version-check-btn"
                :class="{ 'is-loading': checking }"
                :disabled="busy"
                :title="'检测 ' + service.name + ' 更新'"
                :aria-label="'检测 ' + service.name + ' 更新'"
                @click="$emit('check', service.id)"
            >
                <span v-if="checking" class="btn-spinner" aria-hidden="true"></span>
                <span v-else v-html="icon('refresh')"></span>
            </button>
        </div>
    </div>
</template>

<script setup>
import { computed } from 'vue';
import { icon } from '../icons';
import {
    getCurrentVersionLabel,
    getLatestVersionLabel,
    getRepositoryLinks,
    versionStateLabel
} from '../utils/services';

const props = defineProps({
    service: { type: Object, required: true },
    versionStatus: { type: Object, default: null },
    checking: { type: Boolean, default: false },
    busy: { type: Boolean, default: false }
});

defineEmits(['check']);

const currentVersion = computed(() => getCurrentVersionLabel(props.service, props.versionStatus));
const latestVersion = computed(() => getLatestVersionLabel(props.service, props.versionStatus));

const latestTitle = computed(() => props.versionStatus ? (props.versionStatus.latestUrl || props.versionStatus.sourceLabel || '') : '');
const stateClass = computed(() => props.checking ? 'is-checking' : (props.versionStatus && props.versionStatus.updateStatus || 'unchecked'));
const stateLabel = computed(() => props.checking ? '检测中' : versionStateLabel(props.versionStatus && props.versionStatus.updateStatus || 'unchecked'));
const stateTitle = computed(() => props.checking ? '正在检测版本' : (props.versionStatus && (props.versionStatus.error || props.versionStatus.sourceLabel) || ''));
const repositoryLinks = computed(() => getRepositoryLinks(props.service));
</script>
