const icons = {
    grid: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="4" width="7" height="7" rx="1"></rect><rect x="13" y="4" width="7" height="7" rx="1"></rect><rect x="4" y="13" width="7" height="7" rx="1"></rect><rect x="13" y="13" width="7" height="7" rx="1"></rect></svg>',
    core: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3l8 4.5v9L12 21l-8-4.5v-9L12 3z"></path><path d="M12 12l8-4.5M12 12v9M12 12L4 7.5"></path></svg>',
    ai: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 4v4M12 16v4M4 12h4M16 12h4"></path><path d="M8.5 8.5l-2-2M15.5 8.5l2-2M8.5 15.5l-2 2M15.5 15.5l2 2"></path><circle cx="12" cy="12" r="3"></circle></svg>',
    api: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 8l-4 4 4 4M18 8l4 4-4 4"></path><path d="M14 4l-4 16"></path></svg>',
    content: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="4" y="5" width="16" height="14" rx="2"></rect><path d="M8 9h8M8 13h5"></path></svg>',
    infra: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"></path><path d="M7 7v10M17 7v10"></path></svg>',
    start: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M8 5v14l11-7z"></path></svg>',
    stop: '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="7" y="7" width="10" height="10" rx="1"></rect></svg>',
    restart: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"></path><path d="M21 4v6h-6"></path></svg>',
    open: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 17 17 7"></path><path d="M9 7h8v8"></path></svg>',
    refresh: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M21 12a9 9 0 1 1-3-6.7"></path><path d="M21 4v6h-6"></path></svg>',
    version: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20.6 13.4 13.4 20.6a2 2 0 0 1-2.8 0L3 13V3h10l7.6 7.6a2 2 0 0 1 0 2.8z"></path><circle cx="7.5" cy="7.5" r="1"></circle></svg>',
    search: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="7"></circle><path d="M20 20l-3.5-3.5"></path></svg>',
    terminal: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 17l6-5-6-5"></path><path d="M12 19h8"></path></svg>',
    clock: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 7v5l3 2.5"></path></svg>',
    key: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="7.5" cy="15.5" r="5.5"></circle><path d="M12 12l9-9"></path><path d="M16 7l3 3"></path><path d="M19 4l1 1"></path></svg>',
    settings: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="3"></circle><path d="M19.4 15a1.8 1.8 0 0 0 .36 1.98l.06.06-1.42 1.42-.06-.06a1.8 1.8 0 0 0-1.98-.36 1.8 1.8 0 0 0-1.1 1.65V20h-2v-.31a1.8 1.8 0 0 0-1.1-1.65 1.8 1.8 0 0 0-1.98.36l-.06.06-1.42-1.42.06-.06A1.8 1.8 0 0 0 9.1 15a1.8 1.8 0 0 0-1.65-1.1H7v-2h.45A1.8 1.8 0 0 0 9.1 10a1.8 1.8 0 0 0-.36-1.98l-.06-.06L10.1 6.5l.06.06a1.8 1.8 0 0 0 1.98.36A1.8 1.8 0 0 0 13.24 5.3V5h2v.3a1.8 1.8 0 0 0 1.1 1.66 1.8 1.8 0 0 0 1.98-.36l.06-.06 1.42 1.42-.06.06a1.8 1.8 0 0 0-.36 1.98 1.8 1.8 0 0 0 1.65 1.1H21v2h-.3A1.8 1.8 0 0 0 19.4 15z"></path></svg>',
    details: '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 10v6M12 7h.01"></path></svg>',
    github: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M15 22v-4a4.8 4.8 0 0 0-1-3.5c3 0 6-2 6-5.5.08-1.25-.27-2.48-1-3.5.28-1.15.28-2.35 0-3.5 0 0-1 0-3 1.5-2.64-.5-5.36-.5-8 0C6 2 5 2 5 2c-.3 1.15-.3 2.35 0 3.5A5.4 5.4 0 0 0 4 9c0 3.5 3 5.5 6 5.5-.39.49-.68 1.05-.85 1.65-.17.6-.22 1.23-.15 1.85v4"></path><path d="M9 18c-4.51 2-5-2-7-2"></path></svg>',
    chevron: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M6 9l6 6 6-6"></path></svg>',
    close: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M18 6 6 18"></path><path d="m6 6 12 12"></path></svg>',

    /* === 8 格指标专用图标(对齐概念图水墨线描风格) === */

    // VPS - 服务器机架(3 层带电源点)
    'metric-vps': '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="3" y="3.5" width="18" height="5" rx="1"></rect><rect x="3" y="9.5" width="18" height="5" rx="1"></rect><rect x="3" y="15.5" width="18" height="5" rx="1"></rect><circle cx="6.5" cy="6" r="0.65" fill="currentColor" stroke="none"></circle><circle cx="6.5" cy="12" r="0.65" fill="currentColor" stroke="none"></circle><circle cx="6.5" cy="18" r="0.65" fill="currentColor" stroke="none"></circle><line x1="9.5" y1="6" x2="18" y2="6"></line><line x1="9.5" y1="12" x2="18" y2="12"></line><line x1="9.5" y1="18" x2="18" y2="18"></line></svg>',

    // 服务总数 - 立方体(同 core)
    'metric-services': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5l8.5 4.8v9.4L12 21.5l-8.5-4.8V7.3L12 2.5z"></path><path d="M12 12.2l8.5-4.9M12 12.2v9.3M12 12.2L3.5 7.3"></path></svg>',

    // 运行中 - 实心三角播放
    'metric-running': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 4v16l13-8L7 4z" fill="currentColor" stroke="none" opacity="0.86"></path><path d="M7 4v16l13-8L7 4z"></path></svg>',

    // 已停止/异常 - 警告三角
    'metric-warning': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 2.5L22 21H2L12 2.5z"></path><path d="M12 9.5v5.2"></path><circle cx="12" cy="17.6" r="0.8" fill="currentColor" stroke="none"></circle></svg>',

    // 前端入口 - 地球(经纬线)
    'metric-globe': '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M3 12h18"></path><path d="M12 3a13 13 0 0 1 0 18M12 3a13 13 0 0 0 0 18"></path></svg>',

    // 可更新 - 双向刷新
    'metric-update': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 12a9 9 0 0 1 15.5-6.3"></path><path d="M21 12a9 9 0 0 1-15.5 6.3"></path><path d="M18.5 2.5v3.2h-3.2"></path><path d="M5.5 21.5v-3.2h3.2"></path></svg>',

    // 下次检测 - 时钟(同 clock)
    'metric-clock': '<svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="12" cy="12" r="9"></circle><path d="M12 6.5v5.5l3.5 2.6"></path><circle cx="12" cy="12" r="0.8" fill="currentColor" stroke="none"></circle></svg>',

    // 当前筛选 - 漏斗
    'metric-funnel': '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M3 4.5h18l-7 9v5.5l-4 2v-7.5L3 4.5z"></path></svg>'
};

export function icon(name) {
    return icons[name] || icons.grid;
}
