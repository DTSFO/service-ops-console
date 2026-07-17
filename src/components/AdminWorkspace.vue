<template>
    <Teleport to="body">
        <div v-if="open" class="admin-backdrop" @click.self="$emit('close')">
            <section class="admin-workspace" role="dialog" aria-modal="true" aria-labelledby="admin-title">
                <header class="admin-header">
                    <div><span class="section-kicker">administration</span><h2 id="admin-title">管理工作区</h2><p>资产、权限、审计和运行配置均由部署者维护。</p></div>
                    <div class="admin-header-actions"><button type="button" class="brush-btn" @click="refresh">刷新</button><button type="button" class="brush-btn" @click="$emit('close')">关闭</button></div>
                </header>

                <div v-if="!session?.authenticated" class="admin-login">
                    <h3>管理员登录</h3>
                    <p>管理接口使用 Session + CSRF 保护；请勿把密码写入仓库或 URL。</p>
                    <form @submit.prevent="submitLogin">
                        <label>用户名<input v-model="loginForm.username" autocomplete="username" required></label>
                        <label>密码<input v-model="loginForm.password" type="password" autocomplete="current-password" required></label>
                        <button class="primary-btn" type="submit" :disabled="busy">{{ busy ? '登录中…' : '登录' }}</button>
                    </form>
                    <p v-if="error" class="admin-error">{{ error }}</p>
                </div>

                <template v-else>
                    <nav class="admin-tabs" aria-label="管理模块">
                        <button v-for="item in tabs" :key="item.id" type="button" :class="{ active: tab === item.id }" @click="tab = item.id">{{ item.label }}</button>
                        <span class="admin-user">{{ session.username || 'admin' }} <button type="button" class="link-button" @click="signOut">退出</button></span>
                    </nav>
                    <div class="admin-body">
                        <p v-if="error" class="admin-error">{{ error }}</p>
                        <div v-if="loading" class="admin-loading">读取管理数据…</div>

                        <section v-else-if="tab === 'registry'" class="admin-grid">
                            <div v-if="editorOpen" class="admin-panel admin-panel-wide"><header><h3>新增 {{ editorKind === 'hosts' ? '主机' : editorKind === 'groups' ? '分组' : '服务' }}</h3><button type="button" class="link-button" @click="editorOpen = false">取消</button></header><form class="admin-form" @submit.prevent="saveRecord"><label>JSON schema<textarea v-model="editorJson" rows="12" required></textarea></label><small class="admin-hint">仅管理员可编辑高级字段。SSH、探针、控制和更新步骤必须使用已验证的配置结构，秘密只能引用环境变量名。</small><button class="primary-btn" type="submit" :disabled="busy">保存记录</button></form></div>
                            <div class="admin-panel"><header><h3>主机</h3><button type="button" class="secondary-btn" @click="newRecord('hosts')">新增</button></header><div v-for="item in data.hosts" :key="item.id" class="admin-row"><span><strong>{{ item.name }}</strong><small>{{ item.id }} · {{ item.mode || item.control?.mode || 'local' }}</small></span><div class="row-actions"><button type="button" class="link-button" @click="editRecord('hosts', item)">编辑</button><button type="button" class="link-button danger-link" @click="remove('hosts', item)">删除</button></div></div></div>
                            <div class="admin-panel"><header><h3>分组</h3><button type="button" class="secondary-btn" @click="newRecord('groups')">新增</button></header><div v-for="item in data.groups" :key="item.id" class="admin-row"><span><strong>{{ item.name }}</strong><small>{{ item.id }}</small></span><div class="row-actions"><button type="button" class="link-button" @click="editRecord('groups', item)">编辑</button><button type="button" class="link-button danger-link" @click="remove('groups', item)">删除</button></div></div></div>
                            <div class="admin-panel admin-panel-wide"><header><h3>服务注册</h3><button type="button" class="secondary-btn" @click="newRecord('services')">新增</button></header><div v-for="item in data.services" :key="item.id" class="admin-row"><span><strong>{{ item.name }}</strong><small>{{ item.id }} · {{ item.host }} / {{ item.group }}</small></span><div class="row-actions"><button type="button" class="link-button" @click="editRecord('services', item)">编辑</button><button type="button" class="link-button danger-link" @click="remove('services', item)">删除</button></div></div></div>
                        </section>

                        <section v-else-if="tab === 'tokens'" class="admin-grid token-layout">
                            <div class="admin-panel"><header><h3>Agent Token</h3></header><form class="admin-form" @submit.prevent="createToken"><label>名称<input v-model="tokenForm.name" required placeholder="automation-client"></label><label>有效期（可选）<input v-model="tokenForm.expiresAt" type="datetime-local"></label><fieldset><legend>Scopes</legend><label v-for="scope in scopes" :key="scope.id" class="checkbox"><input v-model="tokenForm.scopes" type="checkbox" :value="scope.id"> <span><strong>{{ scope.id }}</strong><small>{{ scope.description }}</small></span></label></fieldset><button class="primary-btn" type="submit" :disabled="busy">创建 Token</button></form><div v-if="newToken" class="token-once"><strong>仅显示一次</strong><code>{{ newToken }}</code><button type="button" class="secondary-btn" @click="copyToken">复制</button></div></div>
                            <div class="admin-panel"><header><h3>已登记 Token</h3></header><div v-for="item in data.tokens" :key="item.id" class="admin-row"><span><strong>{{ item.name }}</strong><small>{{ item.tokenPrefix }} · {{ item.scopes?.join(', ') }} · {{ item.disabledAt ? '已禁用' : '启用' }}</small></span><div class="row-actions"><button type="button" class="link-button" @click="editToken(item)">编辑</button><button type="button" class="link-button" @click="toggleToken(item)">{{ item.disabledAt ? '启用' : '禁用' }}</button><button type="button" class="link-button danger-link" @click="revokeToken(item)">吊销</button></div></div><p v-if="!data.tokens?.length" class="admin-empty">暂无 Token</p></div>
                        </section>

                        <section v-else-if="tab === 'audit'" class="admin-panel audit-panel"><header><h3>审计日志</h3></header><div v-for="entry in data.audit" :key="entry.id || entry.createdAt" class="audit-row"><time>{{ entry.createdAt || entry.timestamp }}</time><strong>{{ entry.action }}</strong><span>{{ entry.actor || 'system' }}</span><code>{{ entry.targetId || entry.serviceId || '' }}</code></div><p v-if="!data.audit?.length" class="admin-empty">暂无审计事件</p></section>

                        <section v-else-if="tab === 'integrations'" class="admin-grid">
                            <div class="admin-panel"><header><h3>SSH 主机</h3></header><div v-for="item in data.sshHosts" :key="item.id" class="admin-row"><span><strong>{{ item.name || item.id }}</strong><small>{{ item.id }} · {{ item.backend || 'openssh' }}</small></span><div class="row-actions"><button type="button" class="secondary-btn" @click="probeSsh(item)">探针</button><button type="button" class="danger-btn" @click="executeSsh(item)">执行</button></div></div><p v-if="!data.sshHosts?.length" class="admin-empty">尚未配置 SSH 主机</p><small class="admin-hint">只显示已配置标识；命令必须命中 allowlist，执行需要显式 confirm。</small></div>
                            <div class="admin-panel"><header><h3>Cloudflare / 上游 MCP</h3></header><template v-for="item in data.cloudflare" :key="item.id"><div class="admin-row"><span><strong>{{ item.name || item.id }}</strong><small>{{ item.id }} · {{ item.capabilities?.write ? '读写' : '只读' }}</small></span><button type="button" class="secondary-btn" @click="listCloudflareTools(item)">工具</button></div><div v-if="cloudflareTools[item.id]?.length" class="integration-tools"><button v-for="tool in cloudflareTools[item.id]" :key="tool.name" type="button" :class="tool.access === 'write' ? 'danger-btn' : 'secondary-btn'" @click="callCloudflareTool(item, tool)">{{ tool.name }} · {{ tool.access }}</button></div></template><p v-if="!data.cloudflare?.length" class="admin-empty">尚未配置上游 MCP</p><small class="admin-hint">Authorization 只通过环境变量注入；未分类工具默认拒绝，写工具需 confirm。</small></div>
                            <div v-if="integrationResult" class="admin-panel admin-panel-wide"><header><h3>最近一次集成结果</h3><button type="button" class="link-button" @click="integrationResult = ''">清空</button></header><pre class="integration-result">{{ integrationResult }}</pre></div>
                        </section>

                        <section v-else class="admin-grid"><div class="admin-panel admin-panel-wide"><header><h3>部署配置</h3></header><dl class="config-list"><div><dt>数据目录</dt><dd>{{ data.configuration?.dataDir || '由 OPS_DATA_DIR / OPS_DB_PATH 配置' }}</dd></div><div><dt>高权限操作</dt><dd>{{ data.configuration?.privilegedOperations === true ? '已启用（仍需 scopes + confirm）' : '默认关闭' }}</dd></div><div><dt>允许的 stdio scopes</dt><dd>{{ (data.configuration?.stdioScopes || ['services:read', 'services:status', 'updates:read']).join(', ') }}</dd></div><div><dt>秘密来源</dt><dd>仅环境变量或仓库外文件引用；UI 不回显凭据</dd></div></dl></div><div class="admin-panel"><header><h3>安全提示</h3></header><ul class="admin-notes"><li>生产环境必须使用 HTTPS、Session Secret 和管理员 Argon2 密码哈希。</li><li>SSH 命令仅匹配部署者 allowlist；Cloudflare 写工具需要 write capability 与 confirm=true。</li><li>SQLite 备份前先停服务，恢复后检查文件权限并重新启动。</li></ul></div></section>
                    </div>
                </template>
            </section>
        </div>
    </Teleport>
</template>

<script setup>
import { computed, onMounted, reactive, ref, watch } from 'vue';
import { createAdminRecord, createAgentToken, deleteAdminRecord, fetchAdminOverview, fetchSession, login, logout, request, revokeAgentToken, updateAdminRecord, updateAgentToken } from '../api/dashboard';

const props = defineProps({ open: { type: Boolean, default: false } });
const emit = defineEmits(['close', 'changed', 'toast', 'authenticated']);

const tabs = [
    { id: 'registry', label: '资产与注册' },
    { id: 'tokens', label: 'Agent Token' },
    { id: 'audit', label: '审计' },
    { id: 'configuration', label: '配置与安全' },
    { id: 'integrations', label: 'SSH / Cloudflare' }
];
const fallbackScopes = [
    { id: 'services:read', description: '读取公开服务清单' },
    { id: 'services:status', description: '读取状态与健康' },
    { id: 'services:locate', description: '读取服务运行位置' },
    { id: 'services:control', description: '执行已配置且确认的服务控制' },
    { id: 'services:write', description: '创建或修改允许的服务字段' },
    { id: 'services:delete', description: '删除、恢复或永久删除服务' },
    { id: 'services:audit', description: '读取审计记录' },
    { id: 'hosts:read', description: '读取主机注册表' },
    { id: 'hosts:write', description: '管理主机注册表（仅管理员上下文）' },
    { id: 'groups:read', description: '读取服务分组' },
    { id: 'groups:write', description: '管理服务分组（仅管理员上下文）' },
    { id: 'updates:read', description: '读取版本、更新方式与计划' },
    { id: 'updates:check', description: '执行版本来源检查' },
    { id: 'updates:apply', description: '执行带摘要且确认的更新计划' },
    { id: 'ssh:read', description: '读取 SSH 主机标识' },
    { id: 'ssh:execute', description: '执行 allowlist SSH 命令' },
    { id: 'cloudflare:read', description: '读取上游 MCP 服务器与工具' },
    { id: 'cloudflare:call', description: '调用已分类的上游工具' },
    { id: 'tokens:manage', description: '管理 Agent Token 生命周期' }
];
const session = ref(null);
const data = reactive({ hosts: [], groups: [], services: [], tokens: [], tokenScopes: [], audit: [], configuration: {}, sshHosts: [], cloudflare: [] });
const scopes = computed(() => data.tokenScopes.length ? data.tokenScopes : fallbackScopes);
const tab = ref('registry');
const loading = ref(false);
const busy = ref(false);
const error = ref('');
const newToken = ref('');
const loginForm = reactive({ username: '', password: '' });
const tokenForm = reactive({ name: '', expiresAt: '', scopes: ['services:read', 'services:status'] });
const editorOpen = ref(false);
const editorKind = ref('services');
const editorJson = ref('');
const editorId = ref('');
const cloudflareTools = reactive({});
const integrationResult = ref('');

async function refresh() {
    loading.value = true;
    error.value = '';
    try {
        session.value = await fetchSession();
        if (session.value?.authenticated) Object.assign(data, await fetchAdminOverview());
    } catch (cause) { error.value = cause.message || '管理数据读取失败'; }
    finally { loading.value = false; }
}

async function submitLogin() {
    busy.value = true; error.value = '';
    try { session.value = await login(loginForm.username, loginForm.password); Object.assign(data, await fetchAdminOverview()); loginForm.password = ''; emit('authenticated', session.value); }
    catch (cause) { error.value = cause.message || '登录失败'; }
    finally { busy.value = false; }
}

async function signOut() { await logout().catch(() => {}); session.value = { authenticated: false }; }
async function createToken() {
    busy.value = true; error.value = ''; newToken.value = '';
    try { const result = await createAgentToken({ ...tokenForm }); newToken.value = result.token || result.secret || ''; await refresh(); tokenForm.name = ''; }
    catch (cause) { error.value = cause.message || 'Token 创建失败'; }
    finally { busy.value = false; }
}
async function revokeToken(item) {
    if (!window.confirm(`吊销 Token「${item.name}」？此操作不可撤销。`)) return;
    try { await revokeAgentToken(item.id); await refresh(); } catch (cause) { error.value = cause.message || 'Token 吊销失败'; }
}
async function toggleToken(item) {
    try { await updateAgentToken(item.id, { disabled: !item.disabledAt }); await refresh(); }
    catch (cause) { error.value = cause.message || 'Token 状态更新失败'; }
}
async function editToken(item) {
    const name = window.prompt('Token 名称：', item.name || '');
    if (name === null || !name.trim()) return;
    const scopesValue = window.prompt('Scopes（逗号分隔）：', (item.scopes || []).join(','));
    if (scopesValue === null) return;
    const expiresAt = window.prompt('过期时间（ISO 8601；留空表示不过期）：', item.expiresAt || '');
    if (expiresAt === null) return;
    try {
        await updateAgentToken(item.id, {
            name: name.trim(),
            scopes: scopesValue.split(',').map((scope) => scope.trim()).filter(Boolean),
            expiresAt: expiresAt.trim() || null
        });
        await refresh();
    } catch (cause) { error.value = cause.message || 'Token 更新失败'; }
}
async function remove(kind, item) {
    if (!window.confirm(`删除「${item.name || item.id}」？关联数据可能受影响。`)) return;
    const options = {};
    if (kind === 'groups' && (Number(item.serviceCount || item.service_count || 0) > 0 || data.services.some((service) => (service.group || service.groupId) === item.id))) {
        const choices = data.groups.filter((group) => group.id !== item.id).map((group) => group.id);
        const replacementGroup = window.prompt(`该分组仍有服务，请输入替代分组 ID（可选：${choices.join(', ')}）：`, choices[0] || '');
        if (!replacementGroup) return;
        options.replacementGroup = replacementGroup;
    }
    try { await deleteAdminRecord(kind, item.id, options); await refresh(); } catch (cause) { error.value = cause.message || '删除失败'; }
}
function newRecord(kind) {
    editorKind.value = kind;
    editorId.value = '';
    editorJson.value = JSON.stringify(kind === 'hosts'
        ? { id: 'new-host', name: 'New Host', description: '', mode: 'local', enabled: true, metadata: {} }
        : kind === 'groups'
            ? { id: 'new-group', name: 'New Group', description: '' }
            : { id: 'new-service', name: 'New Service', description: '', host: data.hosts[0]?.id || 'app-host', group: data.groups[0]?.id || 'core', category: 'app', control: { type: 'none' }, health: { type: 'static', value: 'unknown' } }, null, 2);
    error.value = '';
    editorOpen.value = true;
}
function editRecord(kind, item) { editorKind.value = kind; editorId.value = item.id; editorJson.value = JSON.stringify(item, null, 2); editorOpen.value = true; error.value = ''; }
async function saveRecord() {
    busy.value = true; error.value = '';
    try { const payload = JSON.parse(editorJson.value); if (editorId.value) await updateAdminRecord(editorKind.value, editorId.value, payload); else await createAdminRecord(editorKind.value, payload); editorOpen.value = false; await refresh(); }
    catch (cause) { error.value = cause instanceof SyntaxError ? 'JSON 格式错误' : (cause.message || '保存失败'); }
    finally { busy.value = false; }
}
async function probeSsh(item) {
    if (!window.confirm(`对 SSH 主机「${item.name || item.id}」执行连通性探针？`)) return;
    try { const result = await request(`/api/admin/ssh-hosts/${encodeURIComponent(item.id)}/probe`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ confirm: true }) }); integrationResult.value = JSON.stringify(result, null, 2); error.value = ''; } catch (cause) { error.value = cause.message || 'SSH 探针失败'; }
}
async function executeSsh(item) {
    const command = window.prompt(`输入已配置 allowlist 的单行命令（${item.name || item.id}）：`);
    if (!command || !window.confirm('确认执行此 allowlist 命令？')) return;
    try { const result = await request(`/api/admin/ssh-hosts/${encodeURIComponent(item.id)}/execute`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ command, confirm: true }) }); integrationResult.value = JSON.stringify(result, null, 2); error.value = ''; } catch (cause) { error.value = cause.message || 'SSH 命令失败'; }
}
async function listCloudflareTools(item) {
    try { const payload = await request(`/api/admin/cloudflare/${encodeURIComponent(item.id)}/tools`); cloudflareTools[item.id] = payload.tools || []; error.value = ''; } catch (cause) { error.value = cause.message || '上游工具读取失败'; }
}
async function callCloudflareTool(server, tool) {
    const raw = window.prompt(`输入 ${tool.name} 的 JSON 参数：`, '{}');
    if (raw === null) return;
    let args;
    try { args = JSON.parse(raw); } catch { error.value = '工具参数必须是有效 JSON'; return; }
    const isWrite = tool.access === 'write';
    if (isWrite && !window.confirm(`确认调用写工具 ${tool.name}？`)) return;
    try { const result = await request(`/api/admin/cloudflare/${encodeURIComponent(server.id)}/tools/${encodeURIComponent(tool.name)}/call`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ arguments: args, confirm: isWrite }) }); integrationResult.value = JSON.stringify(result, null, 2); error.value = ''; }
    catch (cause) { error.value = cause.message || '上游工具调用失败'; }
}
async function copyToken() { if (newToken.value && navigator.clipboard) await navigator.clipboard.writeText(newToken.value); }
watch(() => props.open, (open) => { if (open) refresh(); });
onMounted(() => { if (props.open) refresh(); });
</script>
