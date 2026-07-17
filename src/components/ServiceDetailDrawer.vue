<template>
    <Teleport to="body">
        <Transition name="service-detail">
            <div v-if="modalVisible" class="service-detail-backdrop" @click.self="emit('close')">
                <aside
                    ref="panel"
                    class="service-detail-drawer"
                    role="dialog"
                    aria-modal="true"
                    :aria-labelledby="titleId"
                    :aria-describedby="descriptionId"
                    tabindex="-1"
                    @click.stop
                >
                    <header class="service-detail-header">
                        <div class="service-detail-heading">
                            <span class="service-detail-kicker">服务详情</span>
                            <h2 :id="titleId">{{ serviceName }}</h2>
                            <code>{{ serviceId }}</code>
                        </div>
                        <button
                            ref="closeButton"
                            type="button"
                            class="service-detail-close"
                            :aria-label="'关闭 ' + serviceName + ' 详情'"
                            title="关闭详情"
                            @click="emit('close')"
                        >
                            <span v-html="icon('close')"></span>
                        </button>
                    </header>

                    <div ref="scrollContainer" class="service-detail-scroll">
                        <section class="service-detail-section" aria-labelledby="service-detail-overview">
                            <h3 id="service-detail-overview">概览</h3>
                            <p :id="descriptionId" class="service-detail-description">{{ serviceDescription }}</p>
                            <dl class="service-detail-list">
                                <div><dt>服务 ID</dt><dd><code>{{ serviceId }}</code></dd></div>
                                <div>
                                    <dt>主机</dt>
                                    <dd>
                                        <strong>{{ hostLabel }}</strong>
                                        <code v-if="hostId && hostLabel !== hostId">{{ hostId }}</code>
                                        <small v-if="hostDescription">{{ hostDescription }}</small>
                                    </dd>
                                </div>
                                <div>
                                    <dt>分组</dt>
                                    <dd>
                                        <strong>{{ groupLabel }}</strong>
                                        <code v-if="groupId && groupLabel !== groupId">{{ groupId }}</code>
                                        <small v-if="groupDescription">{{ groupDescription }}</small>
                                    </dd>
                                </div>
                                <div><dt>分类</dt><dd>{{ categoryLabel }}</dd></div>
                                <div>
                                    <dt>运行状态</dt>
                                    <dd>
                                        <StatusPill v-if="hasStatus || statusLoading" :status="statusValue" :loading="statusLoading" />
                                        <span v-else class="service-detail-empty">未检测</span>
                                    </dd>
                                </div>
                                <div>
                                    <dt>健康状态</dt>
                                    <dd>
                                        <StatusPill v-if="healthStatus" :status="healthStatus" />
                                        <span v-else class="service-detail-empty">未检测</span>
                                        <small v-if="healthCheckedAt">检测于 {{ formatDate(healthCheckedAt) }}</small>
                                    </dd>
                                </div>
                            </dl>
                        </section>

                        <section class="service-detail-section" aria-labelledby="service-detail-location">
                            <h3 id="service-detail-location">部署位置</h3>
                            <div v-if="detailLoading" class="service-detail-loading"><span class="btn-spinner"></span><span>读取部署详情</span></div>
                            <dl v-else-if="locationRows.length" class="service-detail-list">
                                <div v-for="row in locationRows" :key="row.key">
                                    <dt>{{ row.label }}</dt>
                                    <dd><code>{{ row.value }}</code></dd>
                                </div>
                            </dl>
                            <p v-else class="service-detail-empty service-detail-empty-block">{{ locationError || detailError || '未配置部署位置' }}</p>
                        </section>

                        <section class="service-detail-section" aria-labelledby="service-detail-health">
                            <h3 id="service-detail-health">健康探测</h3>
                            <dl v-if="healthRows.length" class="service-detail-list">
                                <div v-for="row in healthRows" :key="row.key">
                                    <dt>{{ row.label }}</dt>
                                    <dd>
                                        <strong>{{ row.value }}</strong>
                                        <small v-if="row.detail">{{ row.detail }}</small>
                                    </dd>
                                </div>
                            </dl>
                            <p v-else class="service-detail-empty service-detail-empty-block">{{ healthError || '未返回详细探测结果' }}</p>
                        </section>

                        <section class="service-detail-section" aria-labelledby="service-detail-version">
                            <h3 id="service-detail-version">版本</h3>
                            <dl class="service-detail-list">
                                <div><dt>当前版本</dt><dd><strong>{{ currentVersion }}</strong></dd></div>
                                <div><dt>最新版本</dt><dd>{{ latestVersion }}</dd></div>
                                <div>
                                    <dt>更新状态</dt>
                                    <dd><span class="version-state" :class="versionStateClass">{{ versionStateText }}</span></dd>
                                </div>
                            </dl>
                        </section>

                        <section class="service-detail-section" aria-labelledby="service-detail-update-plan">
                            <h3 id="service-detail-update-plan">更新计划</h3>
                            <template v-if="updatePlan">
                                <dl class="service-detail-list">
                                    <div><dt>目标版本</dt><dd>{{ updatePlan.targetVersion || '未检测' }}</dd></div>
                                    <div><dt>运行环境</dt><dd>{{ runtimeLabel }}</dd></div>
                                    <div><dt>计划摘要</dt><dd><code>{{ updatePlan.planDigest }}</code></dd></div>
                                </dl>
                                <ol class="service-detail-plan">
                                    <li v-for="step in updatePlan.steps || []" :key="step.index">
                                        <strong>{{ step.index + 1 }}. {{ step.type }}</strong>
                                        <span v-if="step.action">{{ step.action }}</span>
                                    </li>
                                </ol>
                            </template>
                            <p v-else class="service-detail-empty service-detail-empty-block">{{ updatePlanError || '未配置更新步骤' }}</p>
                        </section>

                        <section class="service-detail-section" aria-labelledby="service-detail-control">
                            <h3 id="service-detail-control">服务控制</h3>
                            <dl class="service-detail-list">
                                <div><dt>控制适配器</dt><dd><strong>{{ controlTypeLabel }}</strong></dd></div>
                                <div><dt>功能状态</dt><dd>{{ canControl ? '已由部署者启用' : '当前部署未启用' }}</dd></div>
                            </dl>
                            <div v-if="canControl" class="service-detail-control-actions">
                                <button type="button" class="control-btn start" :disabled="Boolean(busyAction)" @click="emit('control', serviceId, 'start')">启动</button>
                                <button type="button" class="control-btn stop" :disabled="Boolean(busyAction)" @click="emit('control', serviceId, 'stop')">停止</button>
                                <button type="button" class="control-btn restart" :disabled="Boolean(busyAction)" @click="emit('control', serviceId, 'restart')">重启</button>
                            </div>
                        </section>

                        <section class="service-detail-section" aria-labelledby="service-detail-navigation">
                            <h3 id="service-detail-navigation">入口与仓库</h3>
                            <div class="service-detail-entry-row">
                                <strong>前端入口</strong>
                                <a v-if="frontendHref" class="service-detail-link" :href="frontendHref" target="_blank" rel="noopener noreferrer" title="打开部署者配置的服务入口">
                                    <span v-html="icon('open')"></span><span>打开</span>
                                </a>
                                <span v-else class="service-detail-empty">无前端入口</span>
                            </div>
                            <div class="service-detail-repositories">
                                <strong>仓库</strong>
                                <div v-if="repositoryLinks.length" class="service-detail-repository-links">
                                    <a v-for="link in repositoryLinks" :key="link.url + link.label" class="service-detail-repository-link" :href="link.url" target="_blank" rel="noopener noreferrer" :title="'打开 ' + link.label + ' 仓库'">
                                        <span v-html="icon('github')"></span><span>{{ link.label }}</span>
                                    </a>
                                </div>
                                <span v-else class="service-detail-empty">未提供仓库</span>
                            </div>
                        </section>

                        <section class="service-detail-section" aria-labelledby="service-detail-related">
                            <h3 id="service-detail-related">关联服务</h3>
                            <div v-if="relatedServices.length" class="service-detail-related-list">
                                <button v-for="item in relatedServices" :key="item.id" type="button" class="service-detail-related" :title="'切换到 ' + (item.name || item.id)" :aria-label="'切换到 ' + (item.name || item.id) + ' 详情'" @click="emit('select-service', item.id)">
                                    <span class="service-detail-related-icon" v-html="icon('details')"></span>
                                    <span class="service-detail-related-copy"><strong>{{ item.name || item.id }}</strong><small>{{ item.id }}</small></span>
                                </button>
                            </div>
                            <p v-else class="service-detail-empty service-detail-empty-block">无有效关联服务</p>
                        </section>
                    </div>
                </aside>
            </div>
        </Transition>
    </Teleport>
</template>

<script setup>
import { computed, nextTick, onBeforeUnmount, ref, watch } from 'vue';
import { fetchServiceOperationsDetail } from '../api/dashboard';
import { icon } from '../icons';
import { getCurrentVersionLabel, getLatestVersionLabel, getRepositoryLinks, versionStateLabel } from '../utils/services';
import StatusPill from './StatusPill.vue';

const props = defineProps({
    open: { type: Boolean, default: false }, service: { type: Object, default: null }, host: { type: Object, default: null },
    group: { type: Object, default: null }, status: { type: Object, default: null }, health: { type: Object, default: null },
    versionStatus: { type: Object, default: null }, servicesById: { type: Object, default: () => ({}) },
    statusLoading: { type: Boolean, default: false }, versionsLoading: { type: Boolean, default: false },
    canControl: { type: Boolean, default: false }, busyAction: { type: String, default: '' }
});
const emit = defineEmits(['close', 'select-service', 'control']);
const panel = ref(null); const closeButton = ref(null); const scrollContainer = ref(null);
const detailService = ref(null); const location = ref(null); const detailedHealth = ref(null); const detailedVersion = ref(null); const updatePlan = ref(null);
const detailLoading = ref(false); const detailError = ref(''); const locationError = ref(''); const healthError = ref(''); const updatePlanError = ref('');
const titleId = 'service-detail-title'; const descriptionId = 'service-detail-description';
const modalVisible = computed(() => props.open && Boolean(props.service));
const serviceId = computed(() => String(props.service?.id || '未提供'));
const serviceName = computed(() => props.service?.name || props.service?.id || '未命名服务');
const serviceDescription = computed(() => props.service?.description || '暂无描述');
const hostId = computed(() => props.service?.host || props.host?.id || '');
const hostLabel = computed(() => props.host?.name || hostId.value || '未提供');
const hostDescription = computed(() => props.host?.description || '');
const groupId = computed(() => props.service?.group || props.group?.id || '');
const groupLabel = computed(() => props.group?.name || groupId.value || '未提供');
const groupDescription = computed(() => props.group?.description || '');
const categoryLabel = computed(() => props.service?.category || '未分类');
const hasStatus = computed(() => Boolean(props.status?.status?.trim?.()));
const statusValue = computed(() => hasStatus.value ? props.status.status : 'unknown');
const effectiveHealth = computed(() => detailedHealth.value || props.health);
const healthStatus = computed(() => effectiveHealth.value?.status || '');
const healthCheckedAt = computed(() => effectiveHealth.value?.checkedAt || '');
const effectiveVersion = computed(() => detailedVersion.value || props.versionStatus);
const currentVersion = computed(() => getCurrentVersionLabel(props.service, effectiveVersion.value));
const latestVersion = computed(() => getLatestVersionLabel(props.service, effectiveVersion.value));
const versionStateClass = computed(() => props.versionsLoading && !effectiveVersion.value ? 'is-checking' : effectiveVersion.value?.updateStatus || 'unchecked');
const versionStateText = computed(() => props.versionsLoading && !effectiveVersion.value ? '读取中' : versionStateLabel(effectiveVersion.value?.updateStatus || 'unchecked'));
const frontendHref = computed(() => props.service?.url || '');
const repositoryLinks = computed(() => getRepositoryLinks(props.service || {}));
const relatedServices = computed(() => [...new Set(props.service?.related || [])].map(id => props.servicesById[id]).filter(Boolean));
const controlType = computed(() => detailService.value?.control?.type || updatePlan.value?.runtime?.controlType || props.service?.control?.type || '未公开');
const controlTypeLabel = computed(() => ({ systemd: 'systemd', docker: 'Docker', launchd: 'launchd', none: '未配置' })[controlType.value] || controlType.value);
const runtimeLabel = computed(() => [updatePlan.value?.runtime?.hostMode, updatePlan.value?.runtime?.controlType].filter(Boolean).join(' · ') || '未配置');

const LOCATION_LABELS = { hostId: '主机 ID', hostMode: '主机模式', controlType: '控制类型', controlName: '控制目标', container: '容器', unit: 'systemd 单元', label: 'launchd 标签', domain: 'launchd 域', plist: 'plist', path: '项目路径', packagePath: '包文件', source: '探测来源', image: '镜像', state: '运行状态', composeProject: 'Compose 项目', composeService: 'Compose 服务', composeWorkingDir: 'Compose 目录', fragmentPath: '单元文件', workingDirectory: '工作目录', mainPid: '主进程 PID', gitRoot: 'Git 根目录', gitOrigin: 'Git 远端', gitBranch: 'Git 分支', gitRevision: 'Git 修订' };
function displayValue(value) { return Array.isArray(value) ? value.join(', ') : typeof value === 'boolean' ? (value ? '是' : '否') : String(value); }
const locationRows = computed(() => {
    if (!location.value) return [];
    const sources = [location.value.configured || {}, location.value.runtime || {}, location.value.repository || {}];
    const seen = new Set(); const rows = [];
    for (const source of sources) for (const [key, value] of Object.entries(source)) {
        if (!LOCATION_LABELS[key] || value === null || value === undefined || value === '' || key === 'raw' || seen.has(key)) continue;
        seen.add(key); rows.push({ key, label: LOCATION_LABELS[key], value: displayValue(value) });
    }
    return rows;
});
const healthRows = computed(() => {
    const health = effectiveHealth.value;
    if (!health) return [];
    const rows = [];
    if (health.runtime) rows.push({ key: 'runtime', label: '运行探测', value: health.runtime.status || (health.runtime.ok ? 'active' : 'inactive'), detail: '' });
    (health.checks || []).forEach((check, index) => rows.push({ key: `check-${index}`, label: check.type === 'http' ? 'HTTP 探测' : check.type === 'command' ? '命令探测' : '配置探测', value: check.status || (check.ok ? 'active' : 'degraded'), detail: [check.httpStatus, check.exitCode, check.commandLabel].filter(value => value !== null && value !== undefined && value !== '').join(' · ') }));
    return rows;
});
function formatDate(value) { const date = new Date(value); return Number.isNaN(date.getTime()) ? value : date.toLocaleString('zh-CN'); }
function settledValue(result) { return result?.status === 'fulfilled' ? result.value : null; }
function settledMessage(result) {
    if (result?.status !== 'rejected') return '';
    if (result.reason?.status === 401) return '管理员登录后可查看';
    if (result.reason?.status === 403) return '当前账号没有读取该详情的权限';
    if (result.reason?.status === 404) return '未找到对应配置';
    if (result.reason?.payload?.error === 'update_not_configured') return '未配置更新步骤';
    return '部署详情读取失败';
}

let loadSequence = 0;
watch(() => [modalVisible.value, props.service?.id], async ([visible, id]) => {
    const sequence = ++loadSequence;
    detailService.value = null; location.value = null; detailedHealth.value = null; detailedVersion.value = null; updatePlan.value = null;
    detailError.value = ''; locationError.value = ''; healthError.value = ''; updatePlanError.value = '';
    if (!visible || !id) return;
    detailLoading.value = true;
    const result = await fetchServiceOperationsDetail(id);
    if (sequence !== loadSequence) return;
    const services = settledValue(result.service);
    detailService.value = (Array.isArray(services) ? services : services?.services || []).find(item => item.id === id) || null;
    location.value = settledValue(result.location); locationError.value = settledMessage(result.location);
    const health = settledValue(result.health); detailedHealth.value = health?.statuses?.find(item => item.id === id) || health || null; healthError.value = settledMessage(result.health);
    const versions = settledValue(result.versions); detailedVersion.value = versions?.statuses?.find(item => item.id === id) || versions || null;
    updatePlan.value = settledValue(result.updatePlan); updatePlanError.value = settledMessage(result.updatePlan);
    detailError.value = settledMessage(result.service);
    detailLoading.value = false;
}, { immediate: true });

const FOCUSABLE_SELECTOR = 'a[href],button:not([disabled]),input:not([disabled]),select:not([disabled]),textarea:not([disabled]),[tabindex]:not([tabindex="-1"]),[contenteditable="true"]';
let modalActive = false; let previousBodyOverflow = ''; let previousBodyPaddingRight = '';
function getFocusableElements() { return panel.value ? Array.from(panel.value.querySelectorAll(FOCUSABLE_SELECTOR)).filter(element => element.getClientRects().length > 0) : []; }
function focusInsideDrawer() { (closeButton.value || panel.value)?.focus({ preventScroll: true }); }
function handleDocumentKeydown(event) {
    if (!modalVisible.value) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); emit('close'); return; }
    if (event.key !== 'Tab') return;
    const focusable = getFocusableElements();
    if (!focusable.length) { event.preventDefault(); focusInsideDrawer(); return; }
    const first = focusable[0]; const last = focusable.at(-1); const active = document.activeElement;
    if (event.shiftKey && (active === first || !panel.value.contains(active))) { event.preventDefault(); last.focus(); }
    else if (!event.shiftKey && (active === last || !panel.value.contains(active))) { event.preventDefault(); first.focus(); }
}
function handleDocumentFocus(event) { if (modalVisible.value && panel.value && event.target instanceof Node && !panel.value.contains(event.target)) focusInsideDrawer(); }
function activateModal() {
    if (modalActive) return; modalActive = true; previousBodyOverflow = document.body.style.overflow; previousBodyPaddingRight = document.body.style.paddingRight;
    const scrollbarWidth = Math.max(window.innerWidth - document.documentElement.clientWidth, 0); const currentPadding = Number.parseFloat(window.getComputedStyle(document.body).paddingRight) || 0;
    document.body.style.overflow = 'hidden'; if (scrollbarWidth) document.body.style.paddingRight = currentPadding + scrollbarWidth + 'px';
    document.addEventListener('keydown', handleDocumentKeydown, true); document.addEventListener('focusin', handleDocumentFocus, true);
}
function deactivateModal() {
    if (!modalActive) return; modalActive = false; document.removeEventListener('keydown', handleDocumentKeydown, true); document.removeEventListener('focusin', handleDocumentFocus, true);
    document.body.style.overflow = previousBodyOverflow; document.body.style.paddingRight = previousBodyPaddingRight;
}
watch(modalVisible, async visible => { if (!visible) { deactivateModal(); return; } activateModal(); await nextTick(); focusInsideDrawer(); }, { immediate: true });
watch(() => props.service?.id, async (id, previousId) => { if (!modalVisible.value || !previousId || id === previousId) return; await nextTick(); if (scrollContainer.value) scrollContainer.value.scrollTop = 0; focusInsideDrawer(); });
onBeforeUnmount(() => { loadSequence += 1; deactivateModal(); });
</script>
