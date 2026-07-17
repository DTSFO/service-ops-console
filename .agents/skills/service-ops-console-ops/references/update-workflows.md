# Update workflows

Never apply an update directly from a version check. Resolve the service and complete the full non-mutating inspection sequence first:

```bash
service-ops services locate example-api
service-ops services versions example-api
service-ops services update-check example-api
service-ops services update-method example-api
service-ops services update-plan example-api
```

Review the returned steps, target version or revision, configured runtime, and plan digest. Apply only the exact reviewed digest after the user explicitly requests execution:

```bash
service-ops services update-apply example-api --digest '<plan-digest>' --confirm
```

When the user explicitly asks for the combined deployment workflow, `service-ops sync-service example-api --confirm` requests a fresh plan and applies only that exact returned digest. Do not use it when the user asked only to inspect or plan an update.

The deployment must reject application when privileged operations are disabled, the token lacks `updates:apply`, confirmation is absent, or the digest no longer matches a current plan. Do not recompute, weaken, or bypass a rejected digest.

After application, verify:

```bash
service-ops services status example-api
service-ops services health example-api
service-ops services versions example-api
service-ops services update-check example-api
```

Stop instead of cloning, overwriting, or guessing a repository checkout or deployment path. Use only administrator-configured update steps and command policies.
