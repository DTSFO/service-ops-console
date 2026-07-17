# Service Ops Console

Service Ops Console 是一个可自行部署、由使用者配置的服务运维控制台。它包含 Vue 前端、带认证的 HTTP API、CLI、MCP 传输、带 scope 的 Agent Token、SQLite 服务注册表、审计日志、健康与版本检查、服务控制、allowlist SSH 执行，以及分类后的上游 MCP（包括 Cloudflare）工具。

[English](README.md) · [部署说明](docs/deployment.zh-CN.md) · [CLI、MCP 与 Skill](docs/cli-mcp.zh-CN.md) · [架构说明](docs/architecture.md)

## 能力范围

- 在 SQLite 中注册任意数量的主机、分组和服务；仓库中的 inventory 只是 schema 示例。
- 在 Vue 控制台查看服务详情、关联关系、健康状态、版本、更新计划和配置入口。
- 通过结构化适配器启动、停止、重启和执行更新。高影响写操作要求已认证用户、匹配 scope、开启对应高权限开关并显式提交 `confirm: true`；普通注册表编辑仍会经过 schema 校验并写入审计。
- 通过 SSH 探针或单行命令操作远端主机；命令必须匹配该主机的前缀/正则 allowlist，控制台不提供无约束 root shell。
- 通过 HTTPS 调用上游 MCP。工具必须显式标记为 `read` 或 `write`；写工具同时需要 write capability 和确认。
- 管理带过期、禁用/吊销和 scope 选择的 Agent Token；Token 只存 SHA-256 哈希，完整密钥仅创建时显示一次。
- 将注册、控制、更新、SSH 和上游调用写入审计表。

主机、域名、服务名、健康地址、SSH 目标、Cloudflare 地址和凭据均由部署者配置。公开仓库只保留占位示例。

## 快速开始

环境要求：Node.js 22 或更新版本、npm；非本地部署还需要 HTTPS 反向代理。

```bash
git clone https://github.com/DTSFO/service-ops-console.git
cd service-ops-console
npm ci
cp .env.example .env
cp config/inventory.privileged.example.json inventory.local.json
export OPS_CONFIG_PATH="$PWD/inventory.local.json"
```

启动前必须替换 `inventory.local.json` 中的全部示例主机、域名、unit/container 名、仓库、健康命令和更新命令；只有需要 SSH/上游集成时才复制并编辑对应示例。完成适配器、凭据、allowlist、scope 和确认流程审核前，所有高权限功能开关都保持 `false`。先通过密码工具的隐藏 TTY/stdin 提示生成 Argon2id 管理员密码哈希，再编辑被忽略的 `.env` 填入自己的值。inventory、SQLite 数据库、Session 目录和所有秘密环境文件都应放在 Git 之外。

```bash
npm run password:hash
npm run api
```

同源部署构建前端：

```bash
VITE_BASE_PATH=/ VITE_API_BASE=/ npm run build
```

用 Caddy/Nginx 提供 `dist/`，并把 `/api/` 与 `/mcp` 反向代理到 Node 进程。打开配置的公网地址，使用管理员账号登录。

## 配置文件

- `config/inventory.example.json`：公开资产字段和有边界的 HTTP 健康探针。
- `config/inventory.privileged.example.json`：展示 systemd 控制、exact-policy 命令健康探针和更新步骤；Docker、launchd 与 GitHub 来源变体见部署说明。
- `config/ssh-hosts.example.json`：展示 OpenSSH alias 与命令策略；ssh2 和环境变量凭据字段见部署说明。
- `config/cloudflare-servers.example.json`：HTTPS 上游 MCP 和工具分类。
- `.env.example`：运行时、Session、数据库、高权限、SSH 和 MCP 变量；非秘密项使用安全默认值或占位值，秘密值保持为空。

完整 schema、环境变量、SQLite 备份/恢复、systemd、Caddy、TLS、迁移和回滚见[部署说明](docs/deployment.zh-CN.md)。

## CLI、MCP 与 Skill

```bash
npm link
service-ops --help
service-ops services list
service-ops services status
service-ops services update-plan example-api
service-ops-mcp
```

CLI 支持本地模式和带认证的 HTTP MCP 模式。stdio MCP 从 `OPS_STDIO_SCOPES` 读取权限，不会默认授予全部 scope。仓库 Skill 位于 `.agents/skills/service-ops-console-ops/SKILL.md`，要求使用准确 ID、检查 scope、对高影响或破坏性写操作确认并脱敏输出。Codex、Claude Desktop、WSL、Token 和排障示例见 [CLI、MCP 与 Skill](docs/cli-mcp.zh-CN.md)。

## 安全边界

高影响操作必须先设置 `OPS_ENABLE_PRIVILEGED_OPERATIONS=true`，但这只是其中一道门：还需要 Session/Agent Token 认证、scope 授权、已配置的 allowlist，以及 `confirm: true`。秘密只能通过环境变量名或仓库外文件引用，不接受写在 inventory JSON 中，不在 DTO 或日志中返回。公网使用 HTTPS、严格文件权限、低权限系统用户、限流、CSRF 防护和定期 SQLite 备份。

发布前请阅读 [SECURITY.md](SECURITY.md)。

## 开发与验证

```bash
npm ci
npm run dev
npm test
npm run safety
npm run build
git diff --check
```

测试会 mock SSH、运行时命令、GitHub 和上游 MCP，不会连接生产系统。

## 许可证

MIT
