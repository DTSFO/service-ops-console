import { computed, reactive } from 'vue';

export function useServiceFilters({ groups, hostsById, services, servicesById }) {
    const filters = reactive({
        host: 'all',
        group: 'all',
        query: ''
    });

    const visibleServices = computed(() => {
        const query = filters.query.trim().toLowerCase();
        return services.value.filter(service => {
            const keywords = service.searchText || [
                service.id,
                service.name,
                service.description,
                service.host,
                hostsById.value[service.host]?.name,
                groups.value.find(item => item.id === service.group)?.name,
                (service.related || []).map(id => servicesById.value[id]?.name).filter(Boolean).join(' ')
            ].filter(Boolean).join(' ').toLowerCase();

            return (filters.host === 'all' || service.host === filters.host)
                && (filters.group === 'all' || service.group === filters.group)
                && (!query || keywords.includes(query));
        });
    });

    const visibleServiceIds = computed(() => new Set(visibleServices.value.map(service => service.id)));

    const visibleCount = computed(() => visibleServices.value.length);

    const visibleGroups = computed(() => {
        const servicesByGroup = new Map();
        services.value.forEach(service => {
            if (!servicesByGroup.has(service.group)) servicesByGroup.set(service.group, []);
            servicesByGroup.get(service.group).push(service);
        });

        const countsByGroup = new Map();
        visibleServices.value.forEach(service => {
            countsByGroup.set(service.group, (countsByGroup.get(service.group) || 0) + 1);
        });

        return groups.value
            .map(group => ({
                group,
                services: servicesByGroup.get(group.id) || [],
                visibleCount: countsByGroup.get(group.id) || 0
            }))
            .filter(item => item.services.length);
    });

    function resetFilters() {
        filters.host = 'all';
        filters.group = 'all';
        filters.query = '';
    }

    return {
        filters,
        visibleServices,
        visibleServiceIds,
        visibleCount,
        visibleGroups,
        resetFilters
    };
}
