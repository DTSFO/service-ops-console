# SSH and Cloudflare safety

## SSH

List configured host identifiers before a probe or command:

```bash
service-ops ssh hosts
service-ops ssh probe remote-host --confirm
service-ops ssh exec remote-host 'systemctl status example-api' --confirm
```

Run SSH only when the user requested the exact probe or command. The deployment must require privileged operations, `ssh:execute`, strict confirmation, and the selected host's command allowlist. Shell composition, substitution, redirection, and globbing operators are rejected before execution, even when a prefix or regex would otherwise match. Never alter the command to evade a policy rejection. Never ask for or print SSH passwords, private keys, passphrases, usernames, targets, or identity-file paths.

## Cloudflare upstream MCP

Discover configured servers and classified tools first:

```bash
service-ops cf servers
service-ops cf tools docs
service-ops cf call docs search_documentation '{"query":"DNS records API"}'
```

Call only tools returned by `cf tools`. Treat an absent classification as denied. A tool classified as write additionally requires the deployment's privileged feature flag and explicit confirmation:

```bash
service-ops cf call account update_record '{"zone":"example.com"}' --confirm
```

Do not infer read/write status from a tool name. Do not forward arbitrary Authorization values or inline credentials; upstream authentication must come from administrator-controlled environment references.
