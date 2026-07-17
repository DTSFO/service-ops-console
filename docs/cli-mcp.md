# CLI, MCP, and Skill guide

[简体中文](cli-mcp.zh-CN.md) · [Deployment](deployment.md) · [Architecture](architecture.md)

The CLI, HTTP API, HTTP MCP, stdio MCP, and repository Skill use the same operations contract. They read the operator's SQLite registry and configuration; they do not contain a second hard-coded inventory.

## Install

```bash
git clone https://github.com/DTSFO/service-ops-console.git
cd service-ops-console
npm ci
npm link
service-ops --help
```

`npm link` installs the checked-out CLI on the local PATH. Re-run it after switching to a different checkout or release. The CLI profile follows the XDG base directory: `${XDG_CONFIG_HOME:-$HOME/.config}/service-ops-console/cli.json`. Override it with `OPS_CLI_CONFIG` when a separate protected profile is required. Updates use a same-directory temporary file plus atomic rename; the directory is protected as `0700` and the profile as `0600` where POSIX permissions are available.

Set `OPS_DATA_DIR`, `OPS_DB_PATH`, `OPS_CONFIG_PATH`, `OPS_SSH_HOSTS_PATH`, `OPS_CLOUDFLARE_SERVERS_PATH`, and secret environment variables before starting a local command. For remote use, configure the HTTPS MCP endpoint and write the Agent Token through stdin. `service-ops config show` redacts the stored Authorization value.

```bash
service-ops config set-endpoint https://ops.example.com/mcp
<protected-token-source> | service-ops config set-token --stdin
service-ops config set-mode remote
service-ops config show
```

For the first remote client token, sign in to the web console as an administrator, open the Agent Tokens workspace, create a token with only the required scopes, and capture the secret from its one-time response. Feed it from a password manager, protected prompt, or other non-echoing source; do not replace `<protected-token-source>` with a literal token. Local mode can bootstrap administration directly from the deployment's `.env` and inventory.

MCP and upstream calls accept equivalent inline, file, and stdin JSON inputs:

```bash
service-ops mcp call list_services '{"query":"api"}'
service-ops mcp call create_group --json ./group.json
printf '%s' '{"query":"api"}' | service-ops mcp call list_services -
service-ops cf call cloudflare-api inspect_record --json ./arguments.json
```

## CLI commands

| Command | Purpose | Write gate |
| --- | --- | --- |
| `service-ops config set-endpoint\|set-token --stdin\|set-mode\|show` | Maintain the protected local CLI profile | local file permissions |
| `service-ops services list` | List or search configured services | `services:read` |
| `service-ops services locate <serviceId>` | Resolve configured host and runtime location | `services:locate` |
| `service-ops services status\|health [serviceId]` | Read runtime and health status | `services:status` |
| `service-ops services versions <serviceId>` | Read version metadata | `updates:read` |
| `service-ops services update-check [serviceId]` | Check one configured source, or all services when omitted | `updates:check` |
| `service-ops services update-method\|update-plan <serviceId>` | Show update method and digest-bound plan | `updates:read` |
| `service-ops services update-apply <serviceId> --digest … --confirm` | Apply the unchanged plan | `updates:apply` + confirm |
| `service-ops sync-service <serviceId> --confirm` | Plan and immediately apply that exact returned digest as one guarded CLI workflow | `updates:read` + `updates:apply` + confirm |
| `service-ops services control <serviceId> <start\|stop\|restart> --confirm` | Run structured service control | `services:control` + confirm |
| `service-ops ssh hosts\|probe\|exec` | Inspect or use configured SSH hosts | `ssh:read` / `ssh:execute` + confirm |
| `service-ops cf servers\|tools\|call` | List or call classified upstream tools | `cloudflare:read` / `cloudflare:call` + confirm for write |
| `service-ops registry hosts\|groups\|services` | Administer the SQLite registry | corresponding write scope |
| `service-ops tokens <list\|create\|update\|revoke>` | Administer scoped Agent Tokens without reading token secrets | `tokens:manage` |

Dangerous commands fail closed when authentication, scope, feature flag, allowlist, or confirmation is missing. The CLI never accepts a private key, password, or token as a positional argument; use environment references or protected stdin/configuration.

Execution contexts differ intentionally:

| Context | Registry configuration | Operational access |
| --- | --- | --- |
| Administrator web session | Full host/group/service configuration, tokens, audit, SSH, and upstream MCP | Session + CSRF; privileged operations still require flags and confirmation |
| Local CLI | Full administrator operations against the deployment files and SQLite database | Uses local process permissions and all defined scopes |
| Remote HTTP MCP / CLI | Scoped reads, managed host/group writes, safe display-field service edits, controls, updates, SSH execution, upstream MCP, audit, and token delegation | Deployment-only service fields and administrator-owned SSH/upstream registries are not remotely writable |
| stdio MCP | Same tool filtering as its configured scopes; not an administrator registry channel | Intended for a trusted local integration |

Use the web administrator session or local CLI for `control`, `health`, `update`, SSH mapping, and other deployment-only fields. A remote `services:write` token cannot inject commands, probes, or secrets.

In local mode, pass a complete validated service record or patch as JSON. This example configures structured control, exact-policy command health, and a GitHub update plan; replace every value before use:

```bash
service-ops config set-mode local
service-ops registry services create '{"id":"example-api","name":"Example API","description":"Operator-managed API","host":"app-host","group":"core","category":"app","url":"https://api.example.com/","related":[],"control":{"type":"systemd","name":"example-api"},"health":{"type":"command","command":["service-ops-health-example-api"],"timeoutMs":5000,"expectedExitCode":0},"update":{"current":{"type":"static","version":"1.0.0"},"source":{"type":"github","repo":"owner/project","strategy":"release"},"commandPolicy":{"enabled":true,"prefixes":["service-ops-update-example-api"],"patterns":[]},"steps":[{"type":"control","action":"stop"},{"type":"command","command":"service-ops-update-example-api","allow":true},{"type":"control","action":"start"}]}}'
```

SSH hosts and upstream MCP servers remain administrator-owned JSON registries referenced by `OPS_SSH_HOSTS_PATH` and `OPS_CLOUDFLARE_SERVERS_PATH`; they are not created through a remote registry token. The local administrator CLI can validate and atomically create, update, or delete SSH registry entries with `service-ops ssh plan|create|update|delete`; the SSH registry is reloaded on subsequent operations. Upstream MCP registry changes still require an API/stdio restart. Direct file edits must preserve permissions, environment-variable references, and tool policies.

## HTTP MCP and stdio MCP

The authenticated HTTP MCP endpoint is `/mcp`; the browser/admin REST endpoints remain under `/api/`. It exposes scoped Tools plus read-only Resources and resource templates for services, hosts, groups, status, health, versions, update plans, audit events, SSH host identifiers, and classified upstream tools when the caller holds the corresponding scopes. Use an Agent Token as `Authorization: Bearer …`; grant only the scopes needed by a client. Do not put the token directly in shell history—the example above reads it from an existing protected environment source. The stdio server is started with:

```bash
OPS_CONFIG_PATH=/etc/service-ops-console/inventory.json \
OPS_DATA_DIR=/var/lib/service-ops-console \
OPS_DB_PATH=/var/lib/service-ops-console/service-ops.sqlite \
OPS_STDIO_SCOPES=services:read,services:status,updates:read \
npm run mcp
```

Stdio is intended for a local trusted process. For a desktop client, pass only non-secret paths in its configuration and inject secret values through the process environment. The server filters tools by scope and requires `confirm: true` for controls, SSH execution, update apply, and upstream writes.

Smoke test:

```bash
printf '%s\n%s\n' \
  '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"smoke-test","version":"1.0"}}}' \
  '{"jsonrpc":"2.0","id":2,"method":"tools/list","params":{}}' \
  | npm run --silent mcp
```

## Codex, Claude Desktop, and WSL

Use absolute paths and keep the config file outside the repository. Example Codex registration:

```bash
codex mcp add service-ops-console \
  --env OPS_CONFIG_PATH=/etc/service-ops-console/inventory.json \
  --env OPS_DATA_DIR=/var/lib/service-ops-console \
  --env OPS_DB_PATH=/var/lib/service-ops-console/service-ops.sqlite \
  --env OPS_STDIO_SCOPES=services:read,services:status,updates:read \
  -- node /srv/service-ops-console/mcp/stdio.js
```

For Claude Desktop, configure `command`, `args`, and non-secret `env` values only. WSL clients can launch `wsl.exe -d Ubuntu -- node /srv/service-ops-console/mcp/stdio.js`. Do not put Authorization, SSH private keys, or passwords in JSON/TOML examples.

## Repository Skill

The Skill is at `.agents/skills/service-ops-console-ops/SKILL.md`. It first resolves exact IDs, then reads status/version, groups results by host or service group, and redacts credentials and private topology. It asks for explicit confirmation before high-impact or destructive writes; ordinary schema-validated registry creates/updates remain scoped and audited. It reports the required scope when a call is denied.

Agents that scan repository-local `.agents/skills/` can discover it directly from the checkout. To install it for use outside this repository, copy the whole folder to `${CODEX_HOME:-$HOME/.codex}/skills/service-ops-console-ops`, then restart or refresh the agent client. Update the installed copy from the same tagged checkout as the linked `service-ops` CLI so its commands and safety rules stay version-matched.

Validate the Skill after changes:

```bash
python3 "${CODEX_HOME:-$HOME/.codex}/skills/.system/skill-creator/scripts/quick_validate.py" \
  .agents/skills/service-ops-console-ops
```

Client-only environment variables are `OPS_CLI_CONFIG`, `XDG_CONFIG_HOME`, `OPS_CLI_MODE`, `OPS_MCP_URL`, `OPS_AGENT_TOKEN`, and `OPS_MCP_AUTHORIZATION`. Server/stdio variables remain in `.env.example`; do not save a remote Agent Token in the server environment file unless that process is the intended client.

## Troubleshooting

- **401/403:** check Session/Agent Token, expiry, scope, CSRF (browser), and the privileged feature flag.
- **No services:** verify `OPS_DB_PATH` permissions and the first-run inventory seed.
- **SSH denied:** inspect the configured host ID, backend, allowlist, and single-line command; do not broaden the policy for convenience.
- **Upstream tool denied:** ensure HTTPS, environment-backed authorization, capability, and explicit read/write classification.
- **MCP starts but tools are missing:** inspect `OPS_STDIO_SCOPES`; tools are filtered intentionally.
