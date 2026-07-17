import { computed, ref } from 'vue';
import { checkVersions, runServiceControl } from '../api/dashboard';
import { writeDashboardCache } from '../utils/dashboardCache';

export function useServiceCommands({
    canControl,
    loadStatuses,
    nextAutoCheckAt,
    services,
    servicesById,
    showToast,
    statusLoading,
    versionStatuses
}) {
    const checkingAllVersions = ref(false);
    const checkingVersionIds = ref(new Set());
    const busyActions = ref({});
    const operations = ref({});

    const operationText = computed(() => Object.values(operations.value).filter(Boolean).at(-1) || '');

    function setOperation(key, message) {
        const next = { ...operations.value };
        if (message) {
            next[key] = message;
        } else {
            delete next[key];
        }
        operations.value = next;
    }

    async function refreshStatuses(manual = false, options = {}) {
        if (manual) setOperation('status', '正在刷新服务状态');
        try {
            await loadStatuses(manual, options);
        } finally {
            if (manual) setOperation('status');
        }
    }

    async function handleCheckVersions(serviceId = '') {
        const service = serviceId ? servicesById.value[serviceId] : null;
        const operationKey = serviceId ? 'version-' + serviceId : 'versions';
        const operationLabel = service ? `${service.name} 版本检测中` : `正在批量检测 ${services.value.length} 个服务版本`;

        if (serviceId) {
            const next = new Set(checkingVersionIds.value);
            next.add(serviceId);
            checkingVersionIds.value = next;
        } else {
            checkingAllVersions.value = true;
        }
        setOperation(operationKey, operationLabel);

        try {
            const payload = await checkVersions(serviceId);
            versionStatuses.value = payload.statuses || [];
            nextAutoCheckAt.value = payload.nextAutoCheckAt || '';
            writeDashboardCache('versions', payload);
            showToast(service ? `${service.name} 版本检测完成` : '所有服务版本检测完成');
        } catch (error) {
            showToast(error.message || '版本检测失败');
        } finally {
            if (serviceId) {
                const next = new Set(checkingVersionIds.value);
                next.delete(serviceId);
                checkingVersionIds.value = next;
            } else {
                checkingAllVersions.value = false;
            }
            setOperation(operationKey);
        }
    }

    async function handleControl(serviceId, action) {
        const service = servicesById.value[serviceId];
        const labels = { start: '启动', stop: '停止', restart: '重启' };
        if (!service) return;
        if (!canControl.value) {
            showToast('当前部署未启用服务控制，请检查权限与功能开关');
            return;
        }

        if (!window.confirm(`${labels[action]} ${service.name}？此操作会调用部署者配置的控制适配器。`)) {
            return;
        }

        busyActions.value = { ...busyActions.value, [serviceId]: action };
        setOperation('control-' + serviceId, `${service.name} 正在${labels[action]}`);

        let keepBusy = false;
        try {
            await runServiceControl(serviceId, action);
            showToast(`${service.name} 已提交${labels[action]}命令`);
            if (service.self && (action === 'stop' || action === 'restart')) {
                keepBusy = true;
                setOperation('control-' + serviceId, `${service.name} 正在重载页面`);
                window.setTimeout(() => window.location.reload(), 5000);
                return;
            }
            window.setTimeout(() => refreshStatuses(false, { force: true }), 1800);
        } catch (error) {
            showToast(error.message || '命令执行失败');
        } finally {
            if (!keepBusy) {
                const nextBusy = { ...busyActions.value };
                delete nextBusy[serviceId];
                busyActions.value = nextBusy;
                setOperation('control-' + serviceId);
            }
        }
    }

    return {
        busyActions,
        checkingAllVersions,
        checkingVersionIds,
        operationText,
        statusLoading,
        refreshStatuses,
        handleCheckVersions,
        handleControl
    };
}
