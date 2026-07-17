# Tokens and scopes

Use the smallest scopes needed for the intended workflow. List token metadata without exposing token hashes or secrets:

```bash
service-ops tokens list
service-ops tokens create observer --scopes services:read,services:status,updates:read
service-ops tokens update <tokenId> '{"disabled":true}'
service-ops tokens revoke <tokenId> --confirm
```

Capture a newly created token only from the command's one-time output and place it in the intended client credential store. Never add it to the repository, notes, screenshots, shell-history exports, or chat.

Important scopes:

- `services:read`, `services:status`, `services:locate`: inventory and diagnostics.
- `services:control`: confirmed runtime control.
- `updates:read`, `updates:check`, `updates:apply`: update inspection and execution.
- `ssh:read`, `ssh:write`, `ssh:execute`: host discovery, audited registry administration, and confirmed allowlisted commands.
- `cloudflare:read`, `cloudflare:call`: upstream discovery and classified tool calls.
- `hosts:write`, `groups:write`, `services:write`, `services:delete`: registry administration.
- `tokens:manage`: agent token lifecycle administration.

The stdio MCP transport reads `OPS_STDIO_SCOPES`. Keep its default minimal inspection scopes unless a local, trusted integration needs more. Enabling `OPS_ENABLE_PRIVILEGED_OPERATIONS=true` does not grant scopes and must never replace confirmation.
