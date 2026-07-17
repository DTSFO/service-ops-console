import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import session from "express-session";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiServer } from "../api/server.mjs";
import { createAppContext } from "../lib/app-context.js";

const resources = [];

function inventory() {
  return {
    version: 1,
    hosts: [{ id: "app-host", name: "App Host", description: "", control: { mode: "local" } }],
    groups: [{ id: "core", name: "Core", description: "" }],
    services: [{
      id: "example-api",
      name: "Example API",
      description: "",
      host: "app-host",
      group: "core",
      category: "app",
      related: [],
      url: "https://example.com/",
      control: { type: "systemd", name: "example-api" },
      health: { type: "http", url: "https://health.example.com/", method: "GET", expectedStatus: 200 },
      update: { current: { version: "1.0.0" }, source: { type: "static", version: "1.0.0" } },
      enabled: true,
    }],
    tools: [],
  };
}

async function setup({ dashboardAuthRequired = false } = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "service-ops-api-"));
  const runtime = {
    dataDir: directory,
    dbPath: path.join(directory, "registry.sqlite"),
    sessionPath: path.join(directory, "sessions"),
    configPath: "",
    sshHostsPath: "",
    cloudflareServersPath: "",
    bindHost: "127.0.0.1",
    port: 0,
    publicUrl: "http://127.0.0.1",
    adminUsername: "operator",
    adminPasswordHash: "$argon2id$test-only",
    sessionSecret: "test-session-secret-that-is-at-least-32-characters",
    dashboardAuthRequired,
    privilegedOperations: false,
    features: { serviceControl: false, updateApply: false, sshExecute: false, cloudflareWrite: false },
    stdioScopes: ["services:read"],
  };
  const context = createAppContext({
    runtime,
    inventory: inventory(),
    sshHosts: [],
    cloudflareServers: [],
    upstreamMcps: new Map(),
    runtimeAdapter: { status: vi.fn(async () => ({ ok: true, status: "active", raw: "must-not-leak" })), control: vi.fn() },
    sshExecutor: { execute: vi.fn(), probe: vi.fn() },
    fetchImpl: vi.fn(async () => { throw new Error("PRIVATE_HEALTH_ENV must not leak"); }),
  });
  const server = createApiServer({
    context,
    sessionStore: new session.MemoryStore(),
    verifyPasswordImpl: vi.fn(async (_hash, password) => password === "correct-password"),
    loginLimiter: (_req, _res, next) => next(),
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  resources.push({ server, context, directory });
  return { base, context };
}

async function json(response) {
  const text = await response.text();
  return text ? JSON.parse(text) : null;
}

afterEach(async () => {
  while (resources.length) {
    const { server, context, directory } = resources.pop();
    await new Promise((resolve) => server.close(resolve));
    context.close();
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

describe("secure Express API", () => {
  it("can require authentication before exposing dashboard reads", async () => {
    const { base, context } = await setup({ dashboardAuthRequired: true });
    expect((await fetch(`${base}/api/inventory`)).status).toBe(401);
    const token = context.tokenManager.create({ name: "Dashboard reader", scopes: ["services:read"], createdBy: "test" }).token;
    const authorized = await fetch(`${base}/api/inventory`, { headers: { authorization: `Bearer ${token}` } });
    expect(authorized.status).toBe(200);
    expect((await json(authorized)).services).toHaveLength(1);
  });

  it("serves the configured inventory without execution details or health errors", async () => {
    const { base } = await setup();
    const inventoryResponse = await fetch(`${base}/api/inventory`);
    const payload = await json(inventoryResponse);
    expect(payload.services[0]).toMatchObject({ host: "app-host", group: "core", hasFrontend: true });
    expect(payload.services[0]).not.toHaveProperty("control");
    expect(payload.services[0]).not.toHaveProperty("health");

    const health = await json(await fetch(`${base}/api/health`));
    expect(health).toMatchObject({
      statuses: [{
        id: "example-api",
        status: "degraded",
        healthy: false,
        runtime: { ok: true, status: "active" },
        checks: [{ type: "http", ok: false, status: "inactive" }],
      }],
    });
    expect(JSON.stringify(health)).not.toContain("PRIVATE_HEALTH_ENV");
    expect(JSON.stringify(health)).not.toContain("https://health.example.com/");
    expect(JSON.stringify(health)).not.toContain("must-not-leak");
  });

  it("regenerates login sessions and enforces CSRF on administrator mutations", async () => {
    const { base } = await setup();
    const login = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie: "service_ops_session=fixed" },
      body: JSON.stringify({ username: "operator", password: "correct-password" }),
    });
    expect(login.status).toBe(200);
    const loginPayload = await json(login);
    const cookie = login.headers.get("set-cookie").split(";", 1)[0];
    expect(cookie).not.toContain("fixed");

    const withoutCsrf = await fetch(`${base}/api/admin/groups`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie },
      body: JSON.stringify({ id: "apps", name: "Apps" }),
    });
    expect(withoutCsrf.status).toBe(403);

    const created = await fetch(`${base}/api/admin/groups`, {
      method: "POST",
      headers: { "content-type": "application/json", cookie, "x-csrf-token": loginPayload.csrfToken },
      body: JSON.stringify({ id: "apps", name: "Apps" }),
    });
    expect(created.status).toBe(201);
    expect(await json(created)).toMatchObject({ id: "apps", name: "Apps" });

    const tokenPayload = await json(await fetch(`${base}/api/admin/agent-tokens`, {
      headers: { cookie },
    }));
    expect(tokenPayload.tokens).toEqual([]);
    expect(tokenPayload.scopes).toContainEqual(expect.objectContaining({ id: "updates:apply" }));
  });

  it("authenticates HTTP MCP with scoped Bearer tokens and blocks configuration injection", async () => {
    const { base, context } = await setup();
    const created = context.tokenManager.create({
      name: "Reader and editor",
      scopes: ["services:read", "services:write"],
      createdBy: "test",
    });
    const authorization = `Bearer ${created.token}`;

    const unauthorized = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }),
    });
    expect(unauthorized.status).toBe(401);

    const tools = await json(await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }),
    }));
    expect(tools.result.tools.map((tool) => tool.name)).toContain("list_services");
    expect(tools.result.tools.map((tool) => tool.name)).not.toContain("control_service");

    const injected = await fetch(`${base}/api/ops/services/example-api`, {
      method: "PATCH",
      headers: { "content-type": "application/json", authorization },
      body: JSON.stringify({ update: { steps: [{ type: "command", command: "unsafe", allow: true }] } }),
    });
    expect(injected.status).toBe(400);
    expect(await json(injected)).toMatchObject({ error: "configuration_only_field" });
  });

  it("rejects oversized JSON and keeps privileged controls disabled", async () => {
    const { base, context } = await setup();
    const token = context.tokenManager.create({ name: "Controller", scopes: ["services:control"], createdBy: "test" }).token;
    const oversized = await fetch(`${base}/api/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ username: "operator", password: "x", padding: "x".repeat(17_000) }),
    });
    expect(oversized.status).toBe(413);

    const control = await fetch(`${base}/api/services/example-api/control`, {
      method: "POST",
      headers: { "content-type": "application/json", authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: "restart", confirm: true }),
    });
    expect(control.status).toBe(403);
    expect(await json(control)).toMatchObject({ error: "feature_disabled" });
  });
});
