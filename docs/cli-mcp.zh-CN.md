# CLI、MCP 与 Skill 指南

[English](cli-mcp.md) · [部署说明](deployment.zh-CN.md) · [架构说明](architecture.md)

CLI、HTTP API、HTTP MCP、stdio MCP 和仓库 Skill 使用同一套运维契约，读取部署者的 SQLite 注册表与配置，不再维护第二份硬编码资产清单。

## 安装

```bash
git clone https://github.com/DTSFO/service-ops-console.git
cd service-ops-console
npm ci
npm link
service-ops --help
```

`npm link` 会把当前检出的 CLI 安装到本地 PATH；切换 checkout 或版本后需要重新执行。CLI 配置遵循 XDG 基础目录，默认位于 `${XDG_CONFIG_HOME:-$HOME/.config}/service-ops-console/cli.json`；需要隔离配置时可用 `OPS_CLI_CONFIG` 覆盖。更新配置时先在同目录写临时文件再原子 rename；支持 POSIX 权限的平台会把目录设为 `0700`、配置文件设为 `0600`。

本地命令运行前设置 `OPS_DATA_DIR`、`OPS_DB_PATH`、`OPS_CONFIG_PATH`、`OPS_SSH_HOSTS_PATH`、`OPS_CLOUDFLARE_SERVERS_PATH` 和秘密环境变量。远程使用时配置 HTTPS MCP 端点，并通过 stdin 写入 Agent Token。`service-ops config show` 会隐藏保存的 Authorization 值。

```bash
service-ops config set-endpoint https://ops.example.com/mcp
<受保护的 Token 来源> | service-ops config set-token --stdin
service-ops config set-mode remote
service-ops config show
```

首次为远程 CLI 创建 Token 时，先以管理员登录 Web 控制台，打开 Agent Tokens，按最小权限创建 Token，并只从一次性返回中保存密钥。应通过密码管理器、受保护提示或其他不回显来源传给 stdin；不要把真实 Token 替换进 `<受保护的 Token 来源>`。本地模式可直接使用部署 `.env` 和 inventory 完成管理引导。

MCP 与上游调用可等价地使用内联 JSON、文件或 stdin：

```bash
service-ops mcp call list_services '{"query":"api"}'
service-ops mcp call create_group --json ./group.json
printf '%s' '{"query":"api"}' | service-ops mcp call list_services -
service-ops cf call cloudflare-api inspect_record --json ./arguments.json
```

## CLI 命令

| 命令 | 用途 | 写操作门槛 |
| --- | --- | --- |
| `service-ops config set-endpoint\|set-token --stdin\|set-mode\|show` | 维护受保护的本地 CLI 配置 | 本地文件权限 |
| `service-ops services list` | 列出或搜索配置的服务 | `services:read` |
| `service-ops services locate <serviceId>` | 解析配置的主机和运行位置 | `services:locate` |
| `service-ops services status\|health [serviceId]` | 读取运行与健康状态 | `services:status` |
| `service-ops services versions <serviceId>` | 读取版本信息 | `updates:read` |
| `service-ops services update-check [serviceId]` | 检查单个版本源；省略 ID 时批量检查全部服务 | `updates:check` |
| `service-ops services update-method\|update-plan <serviceId>` | 输出更新方式和带摘要计划 | `updates:read` |
| `service-ops services update-apply <serviceId> --digest … --confirm` | 应用未变化的计划 | `updates:apply` + confirm |
| `service-ops sync-service <serviceId> --confirm` | 在一个受控 CLI 流程中生成计划并立即应用该次返回的准确摘要 | `updates:read` + `updates:apply` + confirm |
| `service-ops services control <serviceId> <start\|stop\|restart> --confirm` | 执行结构化服务控制 | `services:control` + confirm |
| `service-ops ssh hosts\|probe\|exec` | 查看或使用已配置 SSH 主机 | `ssh:read` / `ssh:execute` + confirm |
| `service-ops cf servers\|tools\|call` | 列出或调用分类后的上游工具 | `cloudflare:read` / `cloudflare:call`，写工具需 confirm |
| `service-ops registry hosts\|groups\|services` | 管理 SQLite 注册表 | 对应 write scope |
| `service-ops tokens <list\|create\|update\|revoke>` | 管理带 scope 的 Agent Token，不读取密钥 | `tokens:manage` |

缺少认证、scope、开关、allowlist 或确认时，危险命令会 fail closed。CLI 不接受在位置参数中传入私钥、密码或 Token，应使用环境引用或受保护的 stdin/配置。

不同执行上下文的权限边界如下：

| 上下文 | 注册与配置能力 | 运维访问 |
| --- | --- | --- |
| 管理员 Web Session | 完整主机/分组/服务配置、Token、审计、SSH 和上游 MCP | Session + CSRF；危险操作仍需开关和确认 |
| 本地 CLI | 直接使用部署文件和 SQLite 的完整管理员操作 | 依赖本地进程权限并拥有全部定义 scope |
| 远程 HTTP MCP / CLI | 带 scope 的读取、受管主机/分组写入、安全展示字段编辑、控制、更新、SSH 执行、上游 MCP、审计和 Token 委派 | 不能远程修改仅部署配置可写的服务字段，也不能写管理员维护的 SSH/上游注册表 |
| stdio MCP | 按配置 scope 过滤工具，不作为管理员注册通道 | 面向本地可信集成 |

`control`、`health`、`update`、SSH 映射等部署专用字段应通过管理员 Web Session 或本地 CLI 配置。远程 `services:write` Token 不能注入命令、探针或秘密。

本地模式可传入经过校验的完整服务 JSON 或 patch。下面示例同时配置结构化控制、exact-policy 命令健康探针和 GitHub 更新计划；使用前必须替换全部值：

```bash
service-ops config set-mode local
service-ops registry services create '{"id":"example-api","name":"Example API","description":"Operator-managed API","host":"app-host","group":"core","category":"app","url":"https://api.example.com/","related":[],"control":{"type":"systemd","name":"example-api"},"health":{"type":"command","command":["service-ops-health-example-api"],"timeoutMs":5000,"expectedExitCode":0},"update":{"current":{"type":"static","version":"1.0.0"},"source":{"type":"github","repo":"owner/project","strategy":"release"},"commandPolicy":{"enabled":true,"prefixes":["service-ops-update-example-api"],"patterns":[]},"steps":[{"type":"control","action":"stop"},{"type":"command","command":"service-ops-update-example-api","allow":true},{"type":"control","action":"start"}]}}'
```

SSH 主机和上游 MCP Server 仍是管理员维护的 JSON 注册表，分别由 `OPS_SSH_HOSTS_PATH`、`OPS_CLOUDFLARE_SERVERS_PATH` 引用，不能通过远程 registry Token 创建。本地管理员 CLI 可使用 `service-ops ssh plan|create|update|delete` 校验并原子增删改 SSH 注册项，后续操作会重新读取 SSH 注册表。上游 MCP 注册表变化仍需重启 API/stdio。直接编辑受保护文件时必须保持权限、环境变量引用和工具策略正确。

## HTTP MCP 与 stdio MCP

带认证的 HTTP MCP 端点是 `/mcp`；浏览器/管理 REST 仍位于 `/api/`。MCP 会按 scope 提供 Tools，以及服务、主机、分组、状态、健康、版本、更新计划、审计、SSH 主机标识和上游分类工具的只读 Resources/资源模板。使用 `Authorization: Bearer …` 传入 Agent Token，并且只授予客户端需要的 scope。不要把 Token 直接写进 shell 历史；上面的示例从已有的受保护环境来源读取。stdio server 启动示例：

```bash
OPS_CONFIG_PATH=/etc/service-ops-console/inventory.json \
OPS_DATA_DIR=/var/lib/service-ops-console \
OPS_DB_PATH=/var/lib/service-ops-console/service-ops.sqlite \
OPS_STDIO_SCOPES=services:read,services:status,updates:read \
npm run mcp
```

stdio 适合本地可信进程。桌面客户端配置只传非秘密路径，秘密通过进程环境注入。Server 会按 scope 过滤工具，并要求控制、SSH 执行、更新应用和上游写操作提交 `confirm: true`。

冒烟测试：

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | npm run --silent mcp
```

## Codex、Claude Desktop 与 WSL

使用绝对路径，并将配置文件放在仓库之外。Codex 示例：

```bash
codex mcp add service-ops-console \
  --env OPS_CONFIG_PATH=/etc/service-ops-console/inventory.json \
  --env OPS_DATA_DIR=/var/lib/service-ops-console \
  --env OPS_DB_PATH=/var/lib/service-ops-console/service-ops.sqlite \
  --env OPS_STDIO_SCOPES=services:read,services:status,updates:read \
  -- node /srv/service-ops-console/mcp/stdio.js
```

Claude Desktop 只配置 `command`、`args` 和非秘密 `env`。WSL 客户端可使用 `wsl.exe -d Ubuntu -- node /srv/service-ops-console/mcp/stdio.js`。不要在 JSON/TOML 示例中写 Authorization、SSH 私钥或密码。

## 仓库 Skill

Skill 位于 `.agents/skills/service-ops-console-ops/SKILL.md`。它会先解析准确 ID，再读取状态/版本，按主机或分组汇总，并对凭据和私有拓扑脱敏。高影响或破坏性写操作要求明确确认；普通的 schema 校验注册表创建/更新仍受 scope 控制并写入审计。调用被拒绝时会说明所需 scope。

支持扫描仓库内 `.agents/skills/` 的 Agent 可直接从当前 checkout 发现它。若要在仓库外使用，请把整个目录复制到 `${CODEX_HOME:-$HOME/.codex}/skills/service-ops-console-ops`，再重启或刷新 Agent 客户端。全局 Skill 应与已链接的 `service-ops` CLI 来自同一个 tag/checkout，更新时同步替换，避免命令和安全规则版本不一致。

修改后校验：

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py" \
  .agents/skills/service-ops-console-ops
```

仅客户端使用的环境变量包括 `OPS_CLI_CONFIG`、`XDG_CONFIG_HOME`、`OPS_CLI_MODE`、`OPS_MCP_URL`、`OPS_AGENT_TOKEN` 和 `OPS_MCP_AUTHORIZATION`。Server/stdio 变量仍以 `.env.example` 为准；除非该进程本身就是目标客户端，否则不要把远程 Agent Token 存进服务端环境文件。

## 常见问题

- **401/403：** 检查 Session/Agent Token、过期时间、scope、浏览器 CSRF 和高权限开关。
- **没有服务：** 检查 `OPS_DB_PATH` 权限和首次 inventory seed。
- **SSH 被拒绝：** 检查主机 ID、后端、allowlist 和单行命令，不要为方便而放宽策略。
- **上游工具被拒绝：** 检查 HTTPS、环境变量授权、capability 以及 read/write 分类。
- **MCP 启动但工具缺失：** 检查 `OPS_STDIO_SCOPES`；工具会按设计过滤。
