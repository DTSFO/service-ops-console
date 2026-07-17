---
name: service-ops-console-ops
description: Operate a self-hosted Service Ops Console through its CLI or scoped MCP endpoint. Use for service discovery, location, status, health, version and update workflows, confirmed service control, allowlisted SSH commands, classified Cloudflare upstream MCP tools, registry administration, audit review, and agent token scope management.
---

# Service Ops Console Ops

Use the deployment's configured inventory, credentials, and policies. Never guess host IDs, service IDs, deployment paths, commands, or upstream tool classifications.

## Connect

Prefer the linked `service-ops` CLI. Install it from the checked-out release with `npm ci && npm link`; after switching releases, run `npm link` again. From a checkout, use `npm run cli --` before the same arguments. The CLI stores its profile at `~/.config/service-ops-console/cli.json` with mode `0600`; override that path only with the protected `OPS_CLI_CONFIG` environment variable.

For a remote deployment:

```bash
service-ops config set-endpoint https://ops.example.com/mcp
<protected-token-source> | service-ops config set-token --stdin
service-ops config set-mode remote
service-ops config show
```

Confirm that `config show` redacts Authorization. Keep CLI configuration outside the repository and never request that a user paste a token into chat.

Bootstrap a remote token by signing in to the administrator web console, creating a least-privilege Agent Token, and capturing its one-time secret. Read it from a password manager, protected prompt, or another non-echoing source; never replace `<protected-token-source>` with a literal secret.

For repository-local administration, set `service-ops config set-mode local` and configure the deployment environment before running commands.

## Core workflow

1. Run `service-ops services list [query]` and resolve the exact service ID.
2. Run `service-ops services locate <serviceId>` before host-specific or update work.
3. Read status and health before making changes.
4. Read the relevant reference before using updates, SSH, Cloudflare, registry, or token commands.
5. Pass `--confirm` only when the user explicitly requested that exact state-changing action.
6. Re-run status, health, and version checks after a change.

Use these references as needed:

- Read [service-workflows.md](references/service-workflows.md) for discovery, status, health, control, and registry operations.
- Read [update-workflows.md](references/update-workflows.md) before checking, planning, or applying updates.
- Read [ssh-cloudflare-safety.md](references/ssh-cloudflare-safety.md) before any SSH or Cloudflare upstream call.
- Read [tokens-and-scopes.md](references/tokens-and-scopes.md) before creating or changing agent tokens or stdio scopes.

## Safety rules

- Require all three gates for privileged work: deployment feature flag, matching agent scope, and exact `confirm=true`/`--confirm`.
- Treat service control, update application, SSH probes and commands, and classified upstream write tools as privileged.
- Allow only administrator-configured runtime commands, update steps, SSH allowlists, and upstream tool classifications.
- Stop if an update plan digest changed, a deployment checkout cannot be located, a tool is unclassified, or a command is outside the allowlist.
- Never expose tokens, passwords, private keys, passphrases, `.env` values, probe headers, Authorization headers, database contents, or private inventory fields.
- Never bypass missing scopes with direct credentials or an ad hoc SSH connection.
