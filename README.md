# Service Ops Console

Service Ops Console is a self-hosted, configurable service operations console. It provides a Vue dashboard, authenticated HTTP API, CLI, MCP transports, scoped Agent Tokens, SQLite-backed registry, audit events, health and version checks, service controls, allow-listed SSH execution, and classified upstream MCP tools (including Cloudflare integrations).

[简体中文](README.zh-CN.md) · [Deployment](docs/deployment.md) · [CLI, MCP, and Skill](docs/cli-mcp.md) · [Architecture](docs/architecture.md)

## What it does

- Register any number of hosts, groups, and services in SQLite; the example inventory is only a schema reference.
- Show service details, relationships, health, versions, update plans, and configured entry points in the Vue console.
- Start, stop, restart, and apply updates through structured adapters. High-impact writes require an authenticated actor, a matching scope, the relevant privileged feature flags, and `confirm: true`; ordinary registry edits remain schema-validated and audited.
- Run SSH probes or single-line commands only when the selected SSH host's prefix/regex allowlist accepts them. Shell composition, substitution, redirection, and globbing operators are rejected before execution; the console never exposes an unrestricted root shell.
- Call upstream MCP servers over HTTPS. Tools must be explicitly classified as `read` or `write`; write tools require both a write capability and confirmation.
- Manage Agent Tokens with expiry, disable/revoke, scope selection, and one-time secret display. Tokens are stored as SHA-256 hashes.
- Record registry and operational changes in an append-only audit table.

All hosts, domains, service names, health URLs, SSH targets, Cloudflare endpoints, and credentials are deployment-owned configuration. The public repository contains placeholders only.

## Quick start

Requirements: Node.js 22+, npm, and an HTTPS reverse proxy for any non-local deployment.

```bash
git clone https://github.com/DTSFO/service-ops-console.git
cd service-ops-console
npm ci
cp .env.example .env
cp config/inventory.privileged.example.json inventory.local.json
export OPS_CONFIG_PATH="$PWD/inventory.local.json"
```

Before starting, replace every example host, domain, unit/container name, repository, health command, and update command in `inventory.local.json`; copy and edit the SSH/upstream examples only when those integrations are needed. Keep every privileged feature flag `false` until its adapter, credentials, allowlist, scopes, and confirmation flow have been reviewed. Generate an Argon2id password hash through the password helper's hidden TTY/stdin prompt, then edit the ignored `.env` file with your own values. Keep the inventory, SQLite database, session directory, and all secret environment files outside Git.

```bash
npm run password:hash
npm run api
```

Build the frontend for a same-origin deployment:

```bash
VITE_BASE_PATH=/ VITE_API_BASE=/ npm run build
```

Serve `dist/` through Caddy/Nginx and proxy `/api/` plus `/mcp` to the Node process. Open the configured public URL and sign in with the administrator account.

## Configuration map

- `config/inventory.example.json` documents public inventory fields and bounded HTTP health probes.
- `config/inventory.privileged.example.json` illustrates structured systemd control, an exact-policy command health check, and an update sequence; the deployment guide lists Docker, launchd, and GitHub source variants.
- `config/ssh-hosts.example.json` illustrates an OpenSSH alias and command policy; the deployment guide lists ssh2 and environment-backed credential fields.
- `config/cloudflare-servers.example.json` documents HTTPS upstream MCP servers and tool classification.
- `.env.example` lists runtime, session, database, privilege, SSH, and MCP variables with safe defaults or placeholders. Secret values are intentionally blank.

See the [deployment guide](docs/deployment.md) for schema validation, environment variables, SQLite backup/restore, systemd, Caddy, TLS, migrations, and rollback.

## CLI, MCP, and Skill

```bash
npm link
service-ops --help
service-ops services list
service-ops services status
service-ops services update-plan example-api
service-ops-mcp
```

The CLI supports local operations and authenticated HTTP MCP mode. The stdio MCP server reads `OPS_STDIO_SCOPES`; it does not grant all scopes by default. The repository Skill is at `.agents/skills/service-ops-console-ops/SKILL.md` and requires exact IDs, scope checks, confirmation for high-impact or destructive writes, and redacted output. See [CLI, MCP, and Skill](docs/cli-mcp.md) for Codex, Claude Desktop, WSL, token, and troubleshooting examples.

## Security boundary

High-impact actions are disabled until `OPS_ENABLE_PRIVILEGED_OPERATIONS=true`, and that flag is only one gate: session/Agent Token authentication, scope authorization, configured allowlists, and `confirm: true` are also required. Secrets are referenced by environment-variable name or a file outside the repository; they are never accepted in inventory JSON, returned in DTOs, or written to logs. Use HTTPS, restrictive file permissions, a dedicated unprivileged service account, rate limits, CSRF protection, and regular SQLite backups.

Read [SECURITY.md](SECURITY.md) before exposing the API publicly.

## Development and verification

```bash
npm ci
npm run dev
npm test
npm run safety
npm run build
git diff --check
```

Tests mock SSH, runtime commands, GitHub, and upstream MCP calls. They do not connect to production systems.

## License

MIT
