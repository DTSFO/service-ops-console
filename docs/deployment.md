# Deployment guide

[简体中文](deployment.zh-CN.md) · [CLI, MCP, and Skill](cli-mcp.md)

This guide deploys the complete console against operator-owned infrastructure. The examples use `app-host`, `remote-host`, `example-api`, and `example.com`; replace them in your private configuration.

## 1. Install and prepare secrets

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

Generate a password hash with `npm run password:hash` and set it as `OPS_ADMIN_PASSWORD_HASH`. Generate a long random `OPS_SESSION_SECRET`. Put probe authorization, SSH private-key/passphrase, and upstream authorization in `secrets.env` or a secret manager; JSON files contain only variable names. The example systemd service reads `secrets.env` as `root:service-ops` mode `0640`; use mode `0600` only when a separate credential loader supplies the values to the service without requiring the `service-ops` process to read that file directly.

Required production variables:

| Variable | Meaning |
| --- | --- |
| `OPS_ADMIN_USERNAME` | Administrator login name |
| `OPS_ADMIN_PASSWORD_HASH` | Argon2id hash, never the plaintext password |
| `OPS_SESSION_SECRET` | Random session signing secret |
| `OPS_SESSION_TTL_DAYS` | Login session and cookie lifetime in days; defaults to `30` |
| `OPS_SESSION_ROLLING` | Renew the expiry window on active requests; defaults to `true` |
| `OPS_PUBLIC_URL` | Canonical HTTPS URL |
| `OPS_REQUIRE_DASHBOARD_AUTH` | Require an administrator session or scoped Bearer token for dashboard reads |
| `OPS_DATA_DIR` / `OPS_DB_PATH` | SQLite and session data location |
| `OPS_CONFIG_PATH` | Inventory JSON |
| `OPS_SSH_HOSTS_PATH` | SSH registry JSON (optional) |
| `OPS_CLOUDFLARE_SERVERS_PATH` | Upstream MCP registry JSON (optional) |
| `OPS_ENABLE_PRIVILEGED_OPERATIONS` | Global gate; `true` only after review |
| `OPS_ENABLE_SERVICE_CONTROL` | Enable structured service start/stop/restart |
| `OPS_ENABLE_UPDATE_APPLY` | Enable applying digest-bound update plans |
| `OPS_ENABLE_SSH_EXECUTION` | Enable allow-listed SSH probes/commands |
| `OPS_ENABLE_CLOUDFLARE_WRITE` | Enable classified upstream write tools |
| `OPS_STDIO_SCOPES` | Comma-separated scopes for local stdio MCP |
| `OPS_UPDATE_CHECK_INTERVAL_MS` | Fixed interval in milliseconds; `0` selects daily/manual scheduling |
| `OPS_UPDATE_CHECK_DAILY_TIME` | Optional daily `HH:MM` check time; the example uses 13:00 |
| `OPS_UPDATE_CHECK_TIMEZONE_OFFSET_MINUTES` | UTC offset used for daily scheduling; configure the deployment's timezone |

See [`.env.example`](../.env.example) for the complete list. Never commit the resulting files.

`OPS_SESSION_TTL_DAYS` accepts a positive number and controls both the server-side session record and browser cookie. With `OPS_SESSION_ROLLING=true`, active administrator sessions renew that window; set it to `false` for a fixed expiry measured from login. For an eight-hour fixed session, for example, use `OPS_SESSION_TTL_DAYS=0.333333` and `OPS_SESSION_ROLLING=false`.

## 2. Configure inventory and integrations

Start with the example files and replace every invented record. IDs must be lowercase and unique. A service references a host and group and may define:

- `health`: `static`, bounded `http`, structured-argv `command`, or `composite` with `includeRuntime` plus multiple HTTP/command checks.
- `control`: `systemd`, `docker`, `launchd`, or `none`; controls become available only when the host and feature flags permit them.
- `update`: current version, GitHub source, and explicitly allowed control/command steps. Structured controls use argv without shell interpolation; administrator-defined command steps are accepted only after validation and allowlist checks.
- `url`, `repositoryUrl`, `related`, and display metadata. These values are browser-visible.

Control shapes are `{ "type": "systemd", "name": "unit-name" }`, `{ "type": "docker", "name": "container-name", "command": ["docker"] }`, and `{ "type": "launchd", "name": "label", "plist": "/absolute/path.plist" }`. Any controller may set an argv `command` prefix, so a deployment may use `["sudo", "-n", "systemctl"]` or `["sudo", "-n", "docker"]` without enabling a free-form shell command. A host uses `{ "control": { "mode": "local" } }` for the API machine or `{ "control": { "mode": "ssh", "sshHostId": "remote-host" } }` to map runtime operations to a record in `ssh-hosts.json`.

OpenSSH records require `target` and may use `identityFileFromEnv`. ssh2 records require `host` and `username`, with `port`, `passwordFromEnv`, `privateKeyFromEnv`, and `passphraseFromEnv` as optional environment-backed credentials. Upstream MCP records may use `authorizationEnv`, a static `oauthAccessTokenEnv`, environment-backed refresh with `oauthRefreshTokenEnv` plus `oauthClientIdEnv`, or an operator-owned OAuth store selected by `credentialsPath`/`credentialsPathEnv` and `credentialKey`/`credentialNames`. The store accepts a root credential record or keyed records under `servers`; records use the common `access_token`, `refresh_token`, `client_id`, `expires_at`, and optional `client_secret` fields. Keep it outside Git with mode `0600`. A refresh atomically persists rotated tokens and expiry data. `oauthClientSecretEnv` and an explicit HTTPS `oauthTokenEndpoint` remain optional; otherwise the client discovers `/.well-known/oauth-authorization-server` and falls back to the same origin's `/token` endpoint when discovery is unavailable. Invalid MCP sessions and authentication failures are reinitialized/refreshed once before failing. `protocolVersion`, `timeoutMs`, and `maximumResponseBytes` are per-server bounded transport settings. `headersFromEnv` adds administrator-managed headers; every callable tool must appear in `toolPolicy` as `read` or `write`.

SSH records select `local`, `openssh`, or `ssh2` and can enable a prefix/regex allowlist. Commands are single-line and shell composition, substitution, redirection, and globbing operators are rejected before execution; configure complete command prefixes or anchored regular expressions for the remaining argv-like command text. Credentials are referenced through `passwordFromEnv`, `privateKeyFromEnv`, `passphraseFromEnv`, or `identityFileFromEnv`; inline secret fields are rejected. Cloudflare/upstream records require HTTPS, environment-backed authorization or a protected credential store, and an explicit read/write `toolPolicy`.

A command health probe runs on the service's configured local or SSH host as structured argv. Remote execution serializes that argv and permits only the exact generated command. For example:

```json
"health": {
  "type": "command",
  "command": ["service-ops-health-example-api", "--quiet"],
  "timeoutMs": 5000,
  "expectedExitCode": 0
}
```

GitHub update sources support three strategies. `release` reads the latest release, `tag` reads matching tags (optionally filtered by `tagPattern`), and `commit` resolves a branch/tag/SHA through `ref`:

Current-version resolvers support `static`, `docker-label`, structured-argv `command`, and `git`. `locate_service` uses bounded structured probes for Docker, systemd, launchd, and configured Git paths; it never accepts a command from the caller. A failed version refresh keeps the last successful cache and marks it stale. Configure either a non-zero `OPS_UPDATE_CHECK_INTERVAL_MS` or `OPS_UPDATE_CHECK_DAILY_TIME`; set both interval and daily time empty/zero to use only the dashboard, CLI, MCP, or an external timer.

```json
{ "type": "github", "repo": "owner/project", "strategy": "release" }
{ "type": "github", "repo": "owner/project", "strategy": "tag", "tagPattern": "^v\\d+\\.\\d+\\.\\d+$" }
{ "type": "github", "repo": "owner/project", "strategy": "commit", "ref": "main" }
```

For the `commit` strategy, `ref` selects the branch, tag, or SHA to resolve; when omitted it defaults to `HEAD`. Keep `current` independently configured (for example a static deployed version), review the returned target and steps, and apply only the unchanged plan digest. Replace every sample repository, pattern, ref, helper command, and runtime target with deployment-owned values.

The inventory JSON is a first-run seed. Once SQLite contains any host, group, or service record, later inventory edits do not overwrite the database. Use the authenticated web workspace, local administrator CLI, or scoped API/MCP tools to manage registry records. The local administrator CLI validates and atomically updates the SSH JSON registry, which is re-read on subsequent SSH operations; direct edits must retain mode `0600`. Upstream MCP JSON is loaded at process start, so restart after changing it. To intentionally re-seed, stop the service, back up SQLite, move the old database aside, verify the inventory, and start with a new empty database; do not delete the only backup.

## 3. Build and run

For a domain root:

```bash
VITE_BASE_PATH=/ VITE_API_BASE=/ npm run build
OPS_CONFIG_PATH=/etc/service-ops-console/inventory.json \
OPS_SSH_HOSTS_PATH=/etc/service-ops-console/ssh-hosts.json \
OPS_CLOUDFLARE_SERVERS_PATH=/etc/service-ops-console/cloudflare.json \
npm run api
```

The API binds to `127.0.0.1` by default. It serves JSON under `/api/`; the reverse proxy serves `dist/`. Login, CSRF, rate limits, scopes, and audit logging are enforced by the application. Keep the process on loopback and expose only HTTPS at the edge.

## 4. systemd and Caddy

Copy [`deploy/service-ops-console.service.example`](../deploy/service-ops-console.service.example), adjust paths, and install it as `/etc/systemd/system/service-ops-console.service`. Keep the service user unprivileged and grant only the SSH/config/database permissions it needs.

```bash
sudo install -o root -g root -m 0644 deploy/service-ops-console.service.example /etc/systemd/system/service-ops-console.service
sudo systemctl daemon-reload
sudo systemctl enable --now service-ops-console
sudo systemctl status service-ops-console
```

For OpenSSH aliases, keep a system-owned client config, verified `known_hosts`, and identity files readable only by the service account; do not rely on a human user's `~/.ssh` when `ProtectHome=true`. System service control requires a narrowly scoped polkit/sudo policy, Docker control requires access to the selected socket, and a local update helper that writes outside `/var/lib/service-ops-console` requires an explicit additional `ReadWritePaths=` entry. Grant only the exact manager, unit, socket, and deployment directory required by configured operations.

The companion [`deploy/Caddyfile.example`](../deploy/Caddyfile.example) serves `dist/`, proxies `/api/`, and enables HTTPS. Set `OPS_PUBLIC_URL` to the same canonical origin.

## 5. SQLite backup, restore, and upgrades

Stop the service before copying the database and session directory, or use SQLite's online backup API. Back up inventory, SSH/upstream registries, environment files, and external secret material separately; do not place secrets in the database. Store configuration/secret archives encrypted or in a root-only backup location.

For scheduled backups, install the provided `deploy/backup-service-ops-console.sh` plus the example service and timer. The script uses SQLite online backup, archives administrator-selected configuration paths, sets backup files to `0600`, and removes files older than the configured retention period:

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

`OPS_BACKUP_CONFIG_PATHS` is colon-separated. Change the timer schedule, executable path, unit name, paths, and retention for the deployment, and make the unit's `ReadOnlyPaths`/`ReadWritePaths` match them exactly. Because the archive may contain credentials, keep the destination root-only, encrypt or transfer it to protected storage, and test restoration regularly.

```bash
backup_stamp=$(date +%F-%H%M%S)
sudo install -d -o root -g root -m 0700 /var/backups/service-ops-console
sudo systemctl stop service-ops-console
sudo sqlite3 /var/lib/service-ops-console/service-ops.sqlite ".backup /var/backups/service-ops-console/database-${backup_stamp}.sqlite"
sudo tar -C /var/lib/service-ops-console -czf "/var/backups/service-ops-console/sessions-${backup_stamp}.tgz" sessions
sudo tar -C /etc -czf "/var/backups/service-ops-console/config-${backup_stamp}.tgz" service-ops-console
sudo systemctl start service-ops-console
```

Restore only while the service is stopped. Keep the failed database for forensics, restore matching database and configuration backups, fix ownership and permissions, then verify health and inventory after startup. Restoring the matching `sessions` archive preserves still-valid sessions; omitting it and removing/recreating the sessions directory intentionally signs every browser session out.

```bash
sudo systemctl stop service-ops-console
sudo mv /var/lib/service-ops-console/service-ops.sqlite /var/lib/service-ops-console/service-ops.sqlite.failed
sudo sqlite3 /var/lib/service-ops-console/service-ops.sqlite '.restore /var/backups/service-ops-console/database-YYYY-MM-DD-HHMMSS.sqlite'
sudo tar -C /etc -xzf /var/backups/service-ops-console/config-YYYY-MM-DD-HHMMSS.tgz
# Optional: preserve matching sessions instead of signing everyone out.
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

If sessions should be invalidated, omit the `rm`/`tar`/recursive `chown` session lines above and recreate an empty directory instead:

```bash
sudo rm -rf /var/lib/service-ops-console/sessions
sudo install -d -o service-ops -g service-ops -m 0750 /var/lib/service-ops-console/sessions
```

After restoring environment, SSH, or upstream MCP files, always restart the process because those registries are loaded at startup.

Before an upgrade, run `npm test`, `npm run safety`, and `npm run build` in a clean checkout. Keep the previous release directory for rollback. Database migrations are versioned and run at startup; restore a matching backup if a rollback crosses a migration boundary.

## 6. Verification and troubleshooting

```bash
curl -fsS https://ops.example.com/api/healthz
service-ops services list
service-ops services status
service-ops services update-plan example-api
```

If login fails, check the Argon2 hash, session directory permissions, canonical URL, and clock. If a service is inactive, inspect the configured environment variable name, DNS, timeout, and expected status without printing its secret. If a control is denied, verify the session/token scope, `OPS_ENABLE_PRIVILEGED_OPERATIONS`, host control mode, command policy, and `confirm: true`. If an upstream tool is unavailable, verify HTTPS, capability flags, tool classification, and the environment-backed authorization.
