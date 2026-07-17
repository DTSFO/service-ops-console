<template>
    <nav class="topbar">
        <div class="topbar-inner">
            <a class="brand" :href="baseUrl" aria-label="Service Ops Console">
                <span class="brand-mark">S</span>
                <span class="brand-copy">
                    <strong>Service Ops Console</strong>
                    <small>Self-hosted service operations workspace</small>
                </span>
            </a>

            <div class="topbar-actions">
                <div v-if="operationText" class="operation-status" role="status" aria-live="polite" aria-atomic="true">
                    <span class="activity-dot" aria-hidden="true"></span>
                    <span>{{ operationText }}</span>
                </div>
                <button type="button" class="brush-btn" :disabled="checkingVersions" @click="$emit('check-versions')">
                    <span v-if="checkingVersions" class="btn-spinner" aria-hidden="true"></span>
                    <span v-else v-html="icon('version')"></span>
                    <span>{{ checkingVersions ? '检测中' : '批量检测' }}</span>
                </button>
                <button type="button" class="brush-btn" :disabled="refreshingStatuses" @click="$emit('refresh-statuses')">
                    <span v-if="refreshingStatuses" class="btn-spinner" aria-hidden="true"></span>
                    <span v-else v-html="icon('refresh')"></span>
                    <span>{{ refreshingStatuses ? '刷新中' : '刷新' }}</span>
                </button>
                <a class="brush-btn" href="https://github.com/DTSFO/service-ops-console" target="_blank" rel="noopener noreferrer">
                    <span v-html="icon('github')"></span>
                    <span>源码</span>
                </a>
                <button type="button" class="brush-btn" @click="$emit('open-admin')">
                    <span v-html="icon('settings')"></span>
                    <span>管理</span>
                </button>
            </div>
        </div>
    </nav>
</template>

<script setup>
import { icon } from '../icons';

const baseUrl = import.meta.env.BASE_URL;

defineProps({
    operationText: { type: String, default: '' },
    checkingVersions: { type: Boolean, default: false },
    refreshingStatuses: { type: Boolean, default: false }
});

defineEmits(['check-versions', 'refresh-statuses', 'open-admin']);
</script>
