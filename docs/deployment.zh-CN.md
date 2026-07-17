# 部署说明

[English](deployment.md) · [CLI、MCP 与 Skill](cli-mcp.zh-CN.md)

本指南部署完整控制台，并连接部署者自己维护的基础设施。示例使用 `app-host`、`remote-host`、`example-api` 和 `example.com`，请在仓库外的私有配置中替换。

## 1. 安装与准备秘密

```bash
git clone https://github.com/DTSFO/service-ops-console.git /srv/service-ops-console
cd /srv/service-ops-console
npm ci
sudo groupadd --system service-ops 2>/dev/null || true
sudo useradd --system --gid service-ops --home-dir /var/lib/service-ops-console --shell /usr/sbin/nologin service-ops 2>/dev/null || true
sudo install -d -o root -g service-ops -m 0750 /etc/service-ops-console
sudo install -d -o service-ops -g service-ops -m 0750 /var/lib/service-ops-console
sudo install -o root -g service-ops -m 0640 .env.example /etc/service-ops-console/service-ops-console.env
sudo install -o root -g service-ops -m 0640 config/inventory.privileged.example.json /etc/service-ops-console/inventory.json
sudo install -o root -g service-ops -m 0640 config/ssh-hosts.example.json /etc/service-ops-console/ssh-hosts.json
sudo install -o root -g service-ops -m 0640 config/cloudflare-servers.example.json /etc/service-ops-console/cloudflare.json
sudo install -o root -g service-ops -m 0640 /dev/null /etc/service-ops-console/secrets.env
sudoedit /etc/service-ops-console/service-ops-console.env
sudoedit /etc/service-ops-console/secrets.env
```

运行 `npm run password:hash` 生成 Argon2id 密码哈希并设置 `OPS_ADMIN_PASSWORD_HASH`，使用高熵随机值设置 `OPS_SESSION_SECRET`。探针 Authorization、SSH 私钥/口令和上游授权应写入 `secrets.env` 或由密钥管理器注入；JSON 只填写变量名。示例 systemd 服务直接读取 `root:service-ops`、权限 `0640` 的 `secrets.env`；只有使用独立凭据加载器、无需 `service-ops` 进程直接读取文件时，才可将对应秘密文件设为 `0600`。

生产环境至少需要：

| 变量 | 用途 |
| --- | --- |
| `OPS_ADMIN_USERNAME` | 管理员登录名 |
| `OPS_ADMIN_PASSWORD_HASH` | Argon2id 哈希，不能写明文密码 |
| `OPS_SESSION_SECRET` | 随机 Session 签名密钥 |
| `OPS_SESSION_TTL_DAYS` | 登录 Session 与 Cookie 的有效天数，默认 `30` |
| `OPS_SESSION_ROLLING` | 活跃访问时是否续期，默认 `true` |
| `OPS_PUBLIC_URL` | 规范 HTTPS 地址 |
| `OPS_REQUIRE_DASHBOARD_AUTH` | 仪表盘读取是否要求管理员 Session 或带 scope 的 Bearer Token |
| `OPS_DATA_DIR` / `OPS_DB_PATH` | SQLite 和 Session 数据目录 |
| `OPS_CONFIG_PATH` | inventory JSON |
| `OPS_SSH_HOSTS_PATH` | SSH 注册表 JSON（可选） |
| `OPS_CLOUDFLARE_SERVERS_PATH` | 上游 MCP 注册表 JSON（可选） |
| `OPS_ENABLE_PRIVILEGED_OPERATIONS` | 全局开关，审核后才设为 `true` |
| `OPS_ENABLE_SERVICE_CONTROL` | 启用结构化服务启停重启 |
| `OPS_ENABLE_UPDATE_APPLY` | 启用带摘要更新计划执行 |
| `OPS_ENABLE_SSH_EXECUTION` | 启用 allowlist SSH 探针/命令 |
| `OPS_ENABLE_CLOUDFLARE_WRITE` | 启用分类后的上游写工具 |
| `OPS_STDIO_SCOPES` | 本地 stdio MCP 的逗号分隔 scopes |
| `OPS_UPDATE_CHECK_INTERVAL_MS` | 固定检查间隔（毫秒）；设为 `0` 时改用每日/手动调度 |
| `OPS_UPDATE_CHECK_DAILY_TIME` | 可选的每日 `HH:MM` 检查时间；示例使用 13:00 |
| `OPS_UPDATE_CHECK_TIMEZONE_OFFSET_MINUTES` | 每日调度使用的 UTC 偏移，请按部署时区配置 |

完整列表见 [`.env.example`](../.env.example)。生成的文件不能提交到 Git。

`OPS_SESSION_TTL_DAYS` 接受正数，同时控制服务端 Session 记录和浏览器 Cookie。`OPS_SESSION_ROLLING=true` 时，活跃的管理员 Session 会滚动续期；设为 `false` 时，有效期从登录时固定计算。例如固定八小时可配置 `OPS_SESSION_TTL_DAYS=0.333333` 与 `OPS_SESSION_ROLLING=false`。

## 2. 配置 inventory 与集成

从示例文件开始，替换所有虚构记录。ID 必须为小写且唯一。服务引用一个主机和分组，并可配置：

- `health`：`static`、有边界的 HTTP、结构化 argv 命令探针，或通过 `includeRuntime` 组合运行状态与多个 HTTP/命令检查的 `composite`。
- `control`：`systemd`、`docker`、`launchd` 或 `none`；只有主机控制模式和高权限开关允许时才可用。
- `update`：当前版本、GitHub 来源和明确允许的控制/命令步骤。结构化控制使用 argv，不做 shell 插值；管理员配置的命令步骤只有通过校验和 allowlist 后才执行。
- `url`、`repositoryUrl`、`related` 和展示元数据。这些字段会显示在浏览器中。

控制结构分别为 `{ "type": "systemd", "name": "unit-name" }`、`{ "type": "docker", "name": "container-name", "command": ["docker"] }` 和 `{ "type": "launchd", "name": "label", "plist": "/absolute/path.plist" }`。每种控制器都可使用 argv `command` 前缀，例如 `["sudo", "-n", "systemctl"]` 或 `["sudo", "-n", "docker"]`，但不会开放自由 shell 字符串。主机使用 `{ "control": { "mode": "local" } }` 表示 API 所在机器，或用 `{ "control": { "mode": "ssh", "sshHostId": "remote-host" } }` 把运行操作映射到 `ssh-hosts.json` 的记录。

OpenSSH 记录需要 `target`，可用 `identityFileFromEnv`；ssh2 记录需要 `host`、`username`，并可通过 `port`、`passwordFromEnv`、`privateKeyFromEnv`、`passphraseFromEnv` 引用环境凭据。上游 MCP 可使用 `authorizationEnv`、静态 `oauthAccessTokenEnv`、`oauthRefreshTokenEnv` + `oauthClientIdEnv` 的环境变量刷新，或通过 `credentialsPath`/`credentialsPathEnv` 与 `credentialKey`/`credentialNames` 选择管理员维护的 OAuth 凭据文件。凭据文件既可直接保存一条记录，也可在 `servers` 下按 key 保存；字段采用常见的 `access_token`、`refresh_token`、`client_id`、`expires_at`，并可选 `client_secret`。文件应位于 Git 外且权限为 `0600`；刷新后会原子写回轮换后的 Token 和过期时间。`oauthClientSecretEnv` 和显式 HTTPS `oauthTokenEndpoint` 仍为可选；未指定时先发现 `/.well-known/oauth-authorization-server`，发现不可用则回退到同源 `/token`。认证失败或 MCP Session 失效时只自动刷新/重新初始化一次。`protocolVersion`、`timeoutMs`、`maximumResponseBytes` 可按服务器设置且有严格上限。`headersFromEnv` 可注入管理员维护的请求头；所有可调用工具都必须在 `toolPolicy` 中标成 `read` 或 `write`。

SSH 记录选择 `local`、`openssh` 或 `ssh2`，并可启用前缀/正则 allowlist。命令必须单行；shell 组合、替换、重定向和 glob 运算符会在执行前拒绝，请为剩余的 argv 风格命令配置完整前缀或锚定正则。凭据通过 `passwordFromEnv`、`privateKeyFromEnv`、`passphraseFromEnv` 或 `identityFileFromEnv` 引用；直接写秘密字段会被拒绝。Cloudflare/上游记录必须使用 HTTPS、环境变量授权或受保护的凭据文件，并为工具显式设置 `read`/`write` 分类。

命令健康探针以结构化 argv 在服务配置的本地或 SSH 主机执行。远端会把 argv 安全序列化，并只允许 exact 生成命令。例如：

```json
"health": {
  "type": "command",
  "command": ["service-ops-health-example-api", "--quiet"],
  "timeoutMs": 5000,
  "expectedExitCode": 0
}
```

GitHub 更新源支持三种策略：`release` 读取最新 Release，`tag` 读取标签（可用 `tagPattern` 过滤），`commit` 通过 `ref` 解析分支、标签或 SHA：

当前版本解析支持 `static`、`docker-label`、结构化 argv `command` 和 `git`。`locate_service` 使用有边界的结构化探针读取 Docker、systemd、launchd 和已配置 Git 路径，不接受调用方传入命令。版本刷新失败时会保留上次成功缓存并标记为 stale。可配置非零 `OPS_UPDATE_CHECK_INTERVAL_MS`，或使用 `OPS_UPDATE_CHECK_DAILY_TIME`；若固定间隔为 0 且每日时间留空，则只通过仪表盘、CLI、MCP 或外部定时器触发。

```json
{ "type": "github", "repo": "owner/project", "strategy": "release" }
{ "type": "github", "repo": "owner/project", "strategy": "tag", "tagPattern": "^v\\d+\\.\\d+\\.\\d+$" }
{ "type": "github", "repo": "owner/project", "strategy": "commit", "ref": "main" }
```

使用 `commit` 策略时，`ref` 用于选择要解析的分支、标签或 SHA；省略时默认为 `HEAD`。`current` 应独立配置（例如部署版本的静态值）；执行前检查返回的目标和步骤，只应用摘要未变化的计划。所有示例仓库、正则、ref、helper 命令和运行目标都必须替换成部署者自己的值。

inventory JSON 只在 SQLite 首次为空时用于初始化。数据库已有任意主机、分组或服务记录后，继续修改 inventory 不会覆盖数据库；后续应通过带认证的 Web 管理区、本地管理员 CLI 或带 scope 的 API/MCP 工具管理注册表。本地管理员 CLI 会校验并原子更新 SSH JSON，后续 SSH 操作会重新读取该注册表；直接编辑时必须保持 `0600` 权限。上游 MCP JSON 在进程启动时加载，修改后需要重启。确需重新 seed 时，应先停服务并备份 SQLite，再把旧数据库移走、校验 inventory，然后以空数据库启动；不能删除唯一备份。

## 3. 构建与运行

域名根路径同源部署：

```bash
VITE_BASE_PATH=/ VITE_API_BASE=/ npm run build
OPS_CONFIG_PATH=/etc/service-ops-console/inventory.json \
OPS_SSH_HOSTS_PATH=/etc/service-ops-console/ssh-hosts.json \
OPS_CLOUDFLARE_SERVERS_PATH=/etc/service-ops-console/cloudflare.json \
npm run api
```

API 默认监听 `127.0.0.1`，在 `/api/` 提供 JSON；反向代理提供 `dist/`。应用负责登录、CSRF、限流、scope 和审计。进程保持回环监听，只在边缘暴露 HTTPS。

## 4. systemd 与 Caddy

复制 [`deploy/service-ops-console.service.example`](../deploy/service-ops-console.service.example)，调整路径后安装为 `/etc/systemd/system/service-ops-console.service`。使用低权限用户，只授予读取配置、访问 SSH 客户端和 SQLite 数据所需的权限。

```bash
sudo install -o root -g root -m 0644 deploy/service-ops-console.service.example /etc/systemd/system/service-ops-console.service
sudo systemctl daemon-reload
sudo systemctl enable --now service-ops-console
sudo systemctl status service-ops-console
```

OpenSSH alias 应使用系统维护的客户端配置、已核验的 `known_hosts` 和仅服务账号可读的身份文件；`ProtectHome=true` 时不要依赖人工账号的 `~/.ssh`。控制 systemd 系统服务需要最小化 polkit/sudo 规则，Docker 控制需要目标 socket 权限；若本地更新 helper 要写 `/var/lib/service-ops-console` 之外的目录，还要为 unit 增加精确的 `ReadWritePaths=`。只授权配置中实际使用的 manager、unit、socket 和部署目录。

配套 [`deploy/Caddyfile.example`](../deploy/Caddyfile.example) 提供 `dist/`、反代 `/api/` 并启用 HTTPS。`OPS_PUBLIC_URL` 应与规范域名一致。

## 5. SQLite 备份、恢复与升级

复制数据库和 Session 目录前先停服务，或使用 SQLite online backup API。inventory、SSH/上游注册表、环境文件和外部秘密也应分别备份；不要把秘密写入数据库。配置/秘密归档应加密，或保存在仅 root 可访问的备份目录。

定时备份可安装仓库中的 `deploy/backup-service-ops-console.sh` 以及示例 service/timer。脚本使用 SQLite 在线备份，归档管理员指定的配置路径，把备份文件设为 `0600`，并按配置的保留天数清理旧文件：

```bash
sudo install -o root -g root -m 0750 deploy/backup-service-ops-console.sh /usr/local/libexec/service-ops-console-backup
sudo install -o root -g root -m 0644 deploy/service-ops-console-backup.service.example /etc/systemd/system/service-ops-console-backup.service
sudo install -o root -g root -m 0644 deploy/service-ops-console-backup.timer.example /etc/systemd/system/service-ops-console-backup.timer
sudoedit /etc/service-ops-console/backup.env
sudo systemctl daemon-reload
sudo systemctl enable --now service-ops-console-backup.timer
sudo systemctl start service-ops-console-backup.service
```

```env
OPS_DB_PATH=/var/lib/service-ops-console/service-ops.sqlite
OPS_BACKUP_DIR=/var/backups/service-ops-console
OPS_BACKUP_RETENTION_DAYS=14
OPS_BACKUP_CONFIG_PATHS=/etc/service-ops-console:/path/to/other/protected/config
```

`OPS_BACKUP_CONFIG_PATHS` 使用冒号分隔。部署者应修改 timer 时间、可执行文件位置、unit 名称、路径与保留天数，并让 unit 的 `ReadOnlyPaths`/`ReadWritePaths` 与实际路径精确匹配。归档可能包含凭据，因此目标目录必须仅 root 可读，并应加密或转移到受保护存储，定期验证恢复。

```bash
backup_stamp=$(date +%F-%H%M%S)
sudo install -d -o root -g root -m 0700 /var/backups/service-ops-console
sudo systemctl stop service-ops-console
sudo sqlite3 /var/lib/service-ops-console/service-ops.sqlite ".backup /var/backups/service-ops-console/database-${backup_stamp}.sqlite"
sudo tar -C /var/lib/service-ops-console -czf "/var/backups/service-ops-console/sessions-${backup_stamp}.tgz" sessions
sudo tar -C /etc -czf "/var/backups/service-ops-console/config-${backup_stamp}.tgz" service-ops-console
sudo systemctl start service-ops-console
```

恢复操作必须在停服务状态下进行。保留故障数据库用于排查，恢复匹配的数据库和配置备份，修正所有权与权限后启动并验证。恢复同一时间点的 `sessions` 归档可保留仍有效的 Session；不恢复并重建 Session 目录则会让全部浏览器 Session 失效。

```bash
sudo systemctl stop service-ops-console
sudo mv /var/lib/service-ops-console/service-ops.sqlite /var/lib/service-ops-console/service-ops.sqlite.failed
sudo sqlite3 /var/lib/service-ops-console/service-ops.sqlite '.restore /var/backups/service-ops-console/database-YYYY-MM-DD-HHMMSS.sqlite'
sudo tar -C /etc -xzf /var/backups/service-ops-console/config-YYYY-MM-DD-HHMMSS.tgz
# 可选：恢复匹配 Session；否则让所有现有 Session 失效。
sudo rm -rf /var/lib/service-ops-console/sessions
sudo tar -C /var/lib/service-ops-console -xzf /var/backups/service-ops-console/sessions-YYYY-MM-DD-HHMMSS.tgz
sudo chown service-ops:service-ops /var/lib/service-ops-console/service-ops.sqlite
sudo chmod 0640 /var/lib/service-ops-console/service-ops.sqlite
sudo chown -R service-ops:service-ops /var/lib/service-ops-console/sessions
sudo chmod 0750 /var/lib/service-ops-console/sessions
sudo chown root:service-ops /etc/service-ops-console/*.json /etc/service-ops-console/*.env
sudo chmod 0640 /etc/service-ops-console/*.json /etc/service-ops-console/*.env
sudo systemctl start service-ops-console
curl -fsS https://ops.example.com/api/healthz
```

如需让 Session 全部失效，应省略上方 Session 相关的 `rm`、`tar` 和递归 `chown`，改为创建空目录：

```bash
sudo rm -rf /var/lib/service-ops-console/sessions
sudo install -d -o service-ops -g service-ops -m 0750 /var/lib/service-ops-console/sessions
```

恢复环境、SSH 或上游 MCP 文件后必须重启进程，因为这些注册表在启动时加载。

升级前在干净检出目录运行 `npm test`、`npm run safety` 和 `npm run build`，保留上一版本目录以便回滚。数据库迁移按版本在启动时执行；跨迁移边界回滚时应恢复匹配版本的备份。

## 6. 验证与排障

```bash
curl -fsS https://ops.example.com/api/healthz
service-ops services list
service-ops services status
service-ops services update-plan example-api
```

登录失败时检查 Argon2 哈希、Session 目录权限、规范 URL 和系统时钟。服务 inactive 时检查环境变量名称、DNS、超时和期望状态，不能打印秘密。控制被拒绝时检查 Session/Token scope、`OPS_ENABLE_PRIVILEGED_OPERATIONS`、主机控制模式、命令策略和 `confirm: true`。上游工具不可用时检查 HTTPS、capability、工具分类和环境变量授权。
