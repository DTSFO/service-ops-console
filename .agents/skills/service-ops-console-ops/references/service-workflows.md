# Service and registry workflows

## Inspect services

Resolve identifiers before acting:

```bash
service-ops services list
service-ops services list example
service-ops services locate example-api
service-ops services status example-api
service-ops services health example-api
service-ops services versions example-api
```

Scope map: `list` uses `services:read`; `locate` uses `services:locate`; `status` and `health` use `services:status`; `versions`, `update-method`, and `update-plan` use `updates:read`; `update-check` uses `updates:check`.

Treat an inactive or degraded result as evidence, not a root cause. Check runtime state and the bounded health result separately.

## Control a service

Use only after the user requests the exact action and the service has an administrator-configured runtime adapter:

```bash
service-ops services control example-api restart --confirm
```

Do not retry a failed control with arbitrary shell commands. Report whether the feature flag, scope, confirmation, runtime adapter, or underlying service manager rejected it.

## Add a host and SSH connection

1. Build the public managed-host record, then validate it with `add_host_plan` before `create_host` or `update_host`.
2. Build the separate SSH registry record and call `add_ssh_host_plan`. Never include a password, private key, passphrase, or identity-file path; use only `passwordFromEnv`, `privateKeyFromEnv`, `passphraseFromEnv`, or `identityFileFromEnv`.
3. Persist it with `create_ssh_host` or `update_ssh_host`. Registry writes require administrator context and `ssh:write`, are audited, and write the deployment's `OPS_SSH_HOSTS_PATH` atomically with mode `0600`.
4. Verify discovery with `list_ssh_hosts`, then run `test_ssh_host` only after explicit approval and with `confirm: true` plus `ssh:execute`.
5. Deletion is destructive: call `delete_ssh_host` only after explicit approval and with exact `confirm: true`.

CLI equivalents are `service-ops ssh plan`, `create`, `update`, `hosts`, `probe`, and `delete`. Keep JSON in a protected file or carefully quoted input; environment-variable names are configuration, but their values must never appear in arguments or output.

## Add a service

1. Resolve the exact host and group IDs, and prepare the complete service record.
2. Call `add_service_plan` and correct every validation error.
3. Call `create_service` to persist an approved record, or `create_service_add_request` when the user wants a reviewable request instead of immediate creation.
4. Verify with `list_services`, `locate_service`, status, health, and version tools as applicable.

## Manage the registry

Pass records and patches as JSON. Use operator-approved IDs such as `app-host`, `apps`, and `example-api`:

```bash
service-ops registry hosts list
service-ops registry hosts create '{"id":"app-host","name":"Application host"}'
service-ops registry hosts update app-host '{"description":"Primary application node"}'

service-ops registry groups list
service-ops registry groups create '{"id":"apps","name":"Applications"}'

service-ops registry services list
service-ops registry services create '{"id":"example-api","name":"Example API","host":"app-host","group":"apps"}'
service-ops registry services update example-api '{"description":"Public API"}'
service-ops registry services delete example-api --confirm
service-ops registry services restore example-api
service-ops registry services purge example-api --confirm
```

Delete a host only when no service references it. When deleting a group that still has services, pass an explicit replacement selected by the operator:

```bash
service-ops registry groups delete old-group --replacement apps --confirm
```

Use `list_audit_events` through `service-ops mcp call` when an audit review is requested. Audit payloads must remain redacted.
