# Security

Service Ops Console is designed for operator-owned deployments. The repository contains only invented host names, domains, service IDs, and environment-variable references. Never commit a production inventory, database, session directory, `.env` file, SSH target, private key, Cloudflare authorization, Agent Token, or screenshot containing private topology.

## Deployment requirements

- Terminate TLS at a trusted HTTPS reverse proxy and keep the Node API on loopback.
- Set a long random `OPS_SESSION_SECRET`, an Argon2id `OPS_ADMIN_PASSWORD_HASH`, and restrictive permissions on the data/config directories.
- Run as an unprivileged service account. Limit access to SQLite, secret files, SSH client configuration, and deployment adapters.
- Keep `OPS_ENABLE_PRIVILEGED_OPERATIONS=false` until each control, update, SSH, and upstream write path has been reviewed; the corresponding per-feature flags must also be enabled individually.
- Grant Agent Tokens only the scopes they need; use expiry and revoke tokens after automation changes.
- Back up SQLite and inventory references regularly, and test restoration before upgrades.

## Write safety

All registry and token mutations require authentication, scope authorization, schema validation, and audit logging. High-impact or destructive actions—service controls, update apply, SSH execution, deletes/purges/revocation, and upstream MCP writes—also require their feature/capability gates and exact `confirm: true`. Structured runtime controls use argv; the only shell-facing path is a single-line SSH/update command that must already match an administrator-defined allowlist. Shell composition, substitution, redirection, and globbing operators are rejected before execution. Unknown upstream tools are denied and writes require explicit classification.

## Secret handling

Credentials must be referenced by environment-variable name or a file outside the repository. Inline `password`, `privateKey`, `passphrase`, `token`, `authorization`, and similar fields are rejected. Public and browser DTOs omit probe URLs, header mappings, SSH targets, and secrets. Audit payloads are recursively redacted. Do not paste secret values into issues, chat, screenshots, or logs.

## Reporting

For a vulnerability, do not open a public issue with exploit details. Contact the maintainer privately through the contact address on the maintainer's GitHub profile and include the affected version, deployment mode, reproduction steps without credentials, and a proposed mitigation if available.
