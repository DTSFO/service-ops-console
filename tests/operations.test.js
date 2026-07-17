import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { createAppContext } from "../lib/app-context.js";
import { serializeRuntimeCommand } from "../lib/operations.js";

const directories = [];
const contexts = [];
const admin = { isAdmin: true, actor: "admin:test" };

function inventory({ serviceName = "Example API", remote = false, controlName = "example-api" } = {}) {
  return {
    version: 1,
    hosts: [{
      id: "app-host",
      name: "Application Host",
      description: "",
      control: remote ? { mode: "ssh", sshHostId: "ssh-app" } : { mode: "local" },
    }],
    groups: [{ id: "core", name: "Core", description: "" }],
    services: [{
      id: "example-api",
      name: serviceName,
      description: "",
      host: "app-host",
      group: "core",
      category: "app",
      related: [],
      control: { type: "systemd", name: controlName },
      health: { type: "static", value: "active" },
      update: {
        current: { version: "1.0.0" },
        source: { type: "static", version: "1.0.1" },
        commandPolicy: { enabled: true, patterns: ["^service-ops-update-example-api$"] },
        steps: [{ type: "command", command: "service-ops-update-example-api", allow: true }],
      },
      enabled: true,
    }],
    tools: [{ id: "docs", name: "Docs", description: "", url: "https://example.com/" }],
  };
}

function runtime(directory, features = {}) {
  return {
    dataDir: directory,
    dbPath: path.join(directory, "registry.sqlite"),
    sessionPath: path.join(directory, "sessions"),
    configPath: "",
    sshHostsPath: "",
    cloudflareServersPath: "",
    bindHost: "127.0.0.1",
    port: 0,
    publicUrl: "http://127.0.0.1",
    adminUsername: "admin",
    adminPasswordHash: "$argon2id$test",
    sessionSecret: "x".repeat(32),
    privilegedOperations: Object.values(features).some(Boolean),
    features,
    stdioScopes: ["services:read"],
  };
}

function makeContext(options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "service-ops-operations-"));
  directories.push(directory);
  const context = createAppContext({
    runtime: runtime(directory, options.features),
    inventory: options.inventory || inventory(),
    sshHosts: options.sshHosts || [],
    cloudflareServers: [],
    runtimeAdapter: options.runtimeAdapter || {
      execute: vi.fn(async () => ({ ok: true, code: 0, stdout: "", stderr: "" })),
      status: vi.fn(async () => ({ ok: true, status: "active" })),
      control: vi.fn(async () => ({ ok: true })),
    },
    sshExecutor: options.sshExecutor || { execute: vi.fn(async () => ({ ok: true })), probe: vi.fn(async () => ({ ok: true })) },
    upstreamMcps: new Map(),
    fetchImpl: options.fetchImpl,
  });
  contexts.push(context);
  return context;
}

afterEach(() => {
  while (contexts.length) contexts.pop().close();
  while (directories.length) fs.rmSync(directories.pop(), { recursive: true, force: true });
});

describe("application context and operations", () => {
  it("permits audited host and group writes with explicit Agent Token scopes", () => {
    const context = makeContext();
    const access = { actor: "agent:registry-writer", scopes: ["hosts:write", "groups:write"] };

    expect(context.operations.buildAddHostPlan({ id: "edge-host", name: "Edge Host", mode: "local" }, access))
      .toMatchObject({ valid: true, host: { id: "edge-host", mode: "local" } });
    expect(context.operations.createHost({ id: "edge-host", name: "Edge Host", mode: "local" }, access))
      .toMatchObject({ id: "edge-host", name: "Edge Host" });
    expect(context.operations.createGroup({ id: "apps", name: "Applications" }, access))
      .toMatchObject({ id: "apps", name: "Applications" });

    expect(() => context.operations.deleteHost("edge-host", { confirm: "true" }, access))
      .toThrow(/confirm=true/);
    expect(() => context.operations.deleteGroup("apps", { confirm: false }, access))
      .toThrow(/confirm=true/);
    expect(context.operations.deleteHost("edge-host", { confirm: true }, access)).toBe(true);
    expect(context.operations.deleteGroup("apps", { confirm: true }, access)).toBe(true);

    const audit = context.operations.listAuditLogs({}, admin);
    expect(audit).toEqual(expect.arrayContaining([
      expect.objectContaining({ actor: "agent:registry-writer", action: "host.create", targetId: "edge-host" }),
      expect.objectContaining({ actor: "agent:registry-writer", action: "group.create", targetId: "apps" }),
      expect.objectContaining({ actor: "agent:registry-writer", action: "host.delete", targetId: "edge-host" }),
      expect.objectContaining({ actor: "agent:registry-writer", action: "group.delete", targetId: "apps" }),
    ]));
  });

  it("seeds SQLite only when the registry is empty and preserves operator changes", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "service-ops-seed-"));
    directories.push(directory);
    const first = createAppContext({ runtime: runtime(directory), inventory: inventory(), sshHosts: [], cloudflareServers: [], upstreamMcps: new Map() });
    expect(first.seeded).toBe(true);
    first.operations.updateService("example-api", { name: "Operator Name" }, admin);
    first.close();

    const second = createAppContext({ runtime: runtime(directory), inventory: inventory({ serviceName: "Replacement Seed" }), sshHosts: [], cloudflareServers: [], upstreamMcps: new Map() });
    contexts.push(second);
    expect(second.seeded).toBe(false);
    expect(second.store.getService("example-api").name).toBe("Operator Name");
  });

  it("quotes every remote runtime argv token and permits only the exact generated command", async () => {
    const execute = vi.fn(async () => ({ ok: true }));
    const context = makeContext({
      inventory: inventory({ remote: true, controlName: "example; touch /tmp/not-run" }),
      sshHosts: [{ id: "ssh-app", backend: "openssh", target: "example-alias", commandPolicy: { enabled: true, prefixes: ["systemctl"] } }],
      sshExecutor: { execute, probe: vi.fn() },
    });
    await context.operations.getServiceStatus("example-api", { scopes: ["services:status"] });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({
      command: "'systemctl' 'is-active' 'example; touch /tmp/not-run'",
      confirm: true,
      policy: { enabled: true, patterns: [expect.stringMatching(/^\^/)] },
    }));
    expect(serializeRuntimeCommand({ file: "tool", args: ["a'b"] })).toBe("'tool' 'a'\"'\"'b'");
  });

  it("requires feature flags, exact confirmation, and a fresh digest for writes", async () => {
    const disabled = makeContext();
    await expect(disabled.operations.controlService("example-api", "restart", { confirm: true }, { scopes: ["services:control"] }))
      .rejects.toMatchObject({ code: "feature_disabled" });

    const enabled = makeContext({ features: { serviceControl: true, updateApply: true } });
    await expect(enabled.operations.controlService("example-api", "restart", { confirm: "true" }, { scopes: ["services:control"] }))
      .rejects.toMatchObject({ code: "confirmation_required" });
    const plan = enabled.operations.planServiceUpdate("example-api", { scopes: ["updates:read"] });
    expect(plan.steps[0]).toEqual({ index: 0, type: "command" });
    expect(plan).toMatchObject({ currentVersion: "1.0.0", targetVersion: "1.0.1", runtime: { hostMode: "local", controlType: "systemd" } });
    expect(JSON.stringify(plan)).not.toContain("service-ops-update-example-api");
    await expect(enabled.operations.applyServiceUpdate("example-api", { confirm: true, planDigest: "stale" }, { scopes: ["updates:apply"] }))
      .rejects.toMatchObject({ code: "stale_update_plan" });
  });

  it("runs command health through an exact configured policy", async () => {
    const input = inventory();
    input.services[0].health = { type: "command", command: ["example-health-check"], timeoutMs: 2000, expectedExitCode: 0 };
    const execute = vi.fn(async () => ({ ok: true, code: 0, stdout: "", stderr: "" }));
    const context = makeContext({ inventory: input, runtimeAdapter: { execute, status: vi.fn(async () => ({ ok: true, status: "active" })), control: vi.fn() } });
    await expect(context.operations.getServiceHealth("example-api", { scopes: ["services:status"] }))
      .resolves.toMatchObject({ statuses: [{ id: "example-api", status: "active", healthy: true, runtime: { ok: true, status: "active" }, command: { ok: true, exitCode: 0 } }] });
    expect(execute).toHaveBeenCalledWith({ file: "example-health-check", args: [] }, { timeoutMs: 2000 });
  });

  it("locates runtime and Git metadata through structured argv probes", async () => {
    const input = inventory();
    input.services[0].location = { path: "/srv/example-api" };
    const execute = vi.fn(async (spec) => {
      const joined = [spec.file, ...spec.args].join(" ");
      if (joined.includes("systemctl show")) return { ok: true, stdout: "Id=example-api.service\nActiveState=active\nWorkingDirectory=/srv/example-api" };
      if (joined.includes("--show-toplevel")) return { ok: true, stdout: "/srv/example-api" };
      if (joined.includes("remote get-url")) return { ok: true, stdout: "https://example.invalid/repo.git" };
      if (joined.includes("--abbrev-ref")) return { ok: true, stdout: "main" };
      return { ok: true, stdout: "abc123def456" };
    });
    const context = makeContext({ inventory: input, runtimeAdapter: { execute, status: vi.fn(), control: vi.fn() } });
    const located = await context.operations.locateService("example-api", { scopes: ["services:locate"] });
    expect(located).toMatchObject({
      runtime: { ok: true, source: "systemctl show", activeState: "active", workingDirectory: "/srv/example-api" },
      repository: { ok: true, pathExists: true, gitRoot: "/srv/example-api", gitBranch: "main", gitRevision: "abc123def456" },
    });
    expect(execute).toHaveBeenCalledWith(expect.objectContaining({ file: "git", args: ["-C", "/srv/example-api", "rev-parse", "--show-toplevel"] }), { timeoutMs: 12000 });
  });

  it("combines runtime, HTTP, and command health checks", async () => {
    const input = inventory();
    input.services[0].health = {
      type: "composite",
      checks: [
        { type: "http", url: "https://example.invalid/health", expectedStatus: [200, 204] },
        { type: "command", command: ["example-health", "--quiet"], expectedExitCode: 0 },
      ],
    };
    const runtimeAdapter = {
      status: vi.fn(async () => ({ ok: true, status: "active" })),
      control: vi.fn(),
      execute: vi.fn(async () => ({ ok: true, code: 0, stdout: "" })),
    };
    const context = makeContext({ inventory: input, runtimeAdapter, fetchImpl: vi.fn(async () => ({ status: 204 })) });
    await expect(context.operations.getServiceHealth("example-api", { scopes: ["services:status"] })).resolves.toMatchObject({
      statuses: [{ id: "example-api", status: "active", healthy: true, runtime: { ok: true, status: "active" }, checks: [{ type: "http", ok: true }, { type: "command", ok: true }] }],
    });
  });

  it("resolves current versions and preserves the last successful cache on failure", async () => {
    const input = inventory();
    input.services[0].update.current = { type: "command", command: ["example-version", "--short"], pattern: "version=(\\S+)" };
    input.services[0].update.source = { type: "github", repo: "example/project", strategy: "release" };
    const execute = vi.fn(async () => ({ ok: true, code: 0, stdout: "version=1.0.0" }));
    const fetchImpl = vi.fn()
      .mockResolvedValueOnce({ ok: true, headers: new Headers({ "content-type": "application/json" }), body: new Response(JSON.stringify({ tag_name: "v1.1.0", html_url: "https://example.invalid/release" })).body })
      .mockRejectedValueOnce(new Error("network down"));
    const context = makeContext({ inventory: input, runtimeAdapter: { execute, status: vi.fn(), control: vi.fn() }, fetchImpl });
    const access = { scopes: ["updates:check", "updates:read"] };
    await expect(context.operations.checkServiceUpdates("example-api", access)).resolves.toMatchObject({ statuses: [{ currentVersion: "1.0.0", latestVersion: "v1.1.0", updateStatus: "outdated", stale: false }] });
    await expect(context.operations.checkServiceUpdates("example-api", access)).resolves.toMatchObject({ statuses: [{ currentVersion: "1.0.0", latestVersion: "v1.1.0", updateStatus: "outdated", stale: true, error: "network down" }] });
  });

  it("falls back from a missing GitHub release to tags and exposes scheduler metadata", async () => {
    const input = inventory();
    input.services[0].update.current = { type: "static", version: "1.0.0" };
    input.services[0].update.source = { type: "github", repo: "example/project", strategy: "release", tagPattern: "^v1\\." };
    const notFound = new Response(JSON.stringify({ message: "Not Found" }), { status: 404, headers: { "content-type": "application/json" } });
    const tags = new Response(JSON.stringify([{ name: "v1.2.0", commit: { sha: "abcdef1234567890" } }]), { status: 200, headers: { "content-type": "application/json" } });
    const context = makeContext({ inventory: input, fetchImpl: vi.fn().mockResolvedValueOnce(notFound).mockResolvedValueOnce(tags) });
    context.operations.setNextAutoCheckAt("2026-07-18T05:00:00.000Z");
    await expect(context.operations.checkServiceUpdates("example-api", { scopes: ["updates:check", "updates:read"] })).resolves.toMatchObject({
      nextAutoCheckAt: "2026-07-18T05:00:00.000Z",
      statuses: [{ latestVersion: "v1.2.0", latestRevision: "abcdef123456", updateStatus: "outdated" }],
    });
  });

  it("prevents bearer service configuration injection and token scope escalation", () => {
    const context = makeContext();
    const writer = { actor: "agent:writer", scopes: ["services:write"] };
    expect(() => context.operations.updateService("example-api", {
      update: { steps: [{ type: "command", command: "unsafe", allow: true }] },
    }, writer)).toThrow(/deployment configuration/);
    expect(() => context.operations.updateService("example-api", { agent: { token: "inline" } }, admin)).toThrow(/environment variable/);

    const manager = context.operations.createAgentToken({ name: "delegator", scopes: ["tokens:manage", "services:read"] }, admin);
    const delegated = context.tokenManager.verify(manager.token);
    expect(() => context.operations.createAgentToken({ name: "escalated", scopes: ["services:control"] }, { actor: "agent:delegator", scopes: delegated.scopes }))
      .toThrow(/does not hold/);
    expect(context.operations.createAgentToken({ name: "reader", scopes: ["services:read"] }, { actor: "agent:delegator", scopes: delegated.scopes }).record.scopes)
      .toEqual(["services:read"]);
  });
});
