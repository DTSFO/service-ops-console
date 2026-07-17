import { once } from "node:events";

import session from "express-session";
import { afterEach, describe, expect, it, vi } from "vitest";

import { createApiServer } from "../api/server.mjs";

const servers = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => new Promise((resolve) => server.close(resolve))));
});

function fixtureContext({ scopes = ["services:read"], operations = {} } = {}) {
  return {
    runtime: {
      publicUrl: "http://127.0.0.1:8787",
      sessionSecret: "test-session-secret-that-is-longer-than-32-characters",
      adminPasswordHash: "$argon2id$test-placeholder",
      adminUsername: "admin",
      sessionPath: ".test-sessions",
      privilegedOperations: false,
    },
    tokenManager: {
      verify: vi.fn((token) => token === "example-agent-token" ? {
        id: "agent-example",
        scopes,
      } : null),
    },
    operations: {
      publicInventory: () => ({ hosts: [], groups: [], services: [], tools: [] }),
      getServiceStatus: async () => ({ statuses: [] }),
      getServiceHealth: async () => ({ statuses: [] }),
      getServiceVersions: () => ({ statuses: [] }),
      listServices: vi.fn(async () => [{ id: "example-api" }]),
      ...operations,
    },
  };
}

async function start(context) {
  const server = createApiServer({ context, sessionStore: new session.MemoryStore() });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

describe("HTTP MCP endpoint", () => {
  it("requires a Bearer token and filters tools by the token scopes", async () => {
    const context = fixtureContext();
    const base = await start(context);
    const unauthorized = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list", params: {} }),
    });
    expect(unauthorized.status).toBe(401);

    const authorized = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer example-agent-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} }),
    });
    expect(authorized.status).toBe(200);
    const payload = await authorized.json();
    expect(payload.result.tools.map((tool) => tool.name)).toEqual(["list_services", "discover_services"]);
  });

  it("passes the authenticated agent identity and scopes into operations", async () => {
    const context = fixtureContext();
    const base = await start(context);
    const response = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: {
        authorization: "Bearer example-agent-token",
        "content-type": "application/json",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "list_services", arguments: {} },
      }),
    });
    expect(response.status).toBe(200);
    expect((await response.json()).result.structuredContent).toEqual([{ id: "example-api" }]);
    expect(context.operations.listServices).toHaveBeenCalledWith({}, expect.objectContaining({
      actor: "agent:agent-example",
      scopes: ["services:read"],
      isAdmin: false,
    }));
  });

  it("preserves JSON-RPC batch order, omits notification responses, and returns 202 for a single notification", async () => {
    const base = await start(fixtureContext());
    const batch = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer example-agent-token", "content-type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", id: 4, method: "tools/list", params: {} },
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", id: 5, method: "ping" },
      ]),
    });
    expect(batch.status).toBe(200);
    const payload = await batch.json();
    expect(payload.map((entry) => entry.id)).toEqual([4, 5]);
    expect(payload[1].result).toEqual({});

    const notification = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer example-agent-token", "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
    });
    expect(notification.status).toBe(202);
    expect(await notification.text()).toBe("");

    const notificationBatch = await fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer example-agent-token", "content-type": "application/json" },
      body: JSON.stringify([
        { jsonrpc: "2.0", method: "notifications/initialized" },
        { jsonrpc: "2.0", method: "notifications/unknown" },
      ]),
    });
    expect(notificationBatch.status).toBe(202);
    expect(await notificationBatch.text()).toBe("");
  });

  it("allows scoped Agent Tokens to use host and group writes while keeping strict delete confirmation", async () => {
    const createHost = vi.fn((host, access) => ({ ...host, actor: access.actor }));
    const deleteHost = vi.fn((hostId) => ({ deleted: true, hostId }));
    const createGroup = vi.fn((group, access) => ({ ...group, actor: access.actor }));
    const deleteGroup = vi.fn((groupId) => ({ deleted: true, groupId }));
    const context = fixtureContext({
      scopes: ["hosts:write", "groups:write"],
      operations: { createHost, deleteHost, createGroup, deleteGroup },
    });
    const base = await start(context);
    const call = (body) => fetch(`${base}/mcp`, {
      method: "POST",
      headers: { authorization: "Bearer example-agent-token", "content-type": "application/json" },
      body: JSON.stringify(body),
    });

    const listed = await (await call({ jsonrpc: "2.0", id: 6, method: "tools/list" })).json();
    const tools = new Map(listed.result.tools.map((tool) => [tool.name, tool]));
    expect([...tools.keys()]).toEqual(expect.arrayContaining(["create_host", "delete_host", "create_group", "delete_group"]));
    expect(tools.get("delete_host").inputSchema.required).toEqual(["hostId", "confirm"]);
    expect(tools.get("delete_group").inputSchema.required).toEqual(["groupId", "confirm"]);

    const host = await (await call({
      jsonrpc: "2.0", id: 7, method: "tools/call",
      params: { name: "create_host", arguments: { host: { id: "edge-host", name: "Edge Host" } } },
    })).json();
    expect(host.result.structuredContent).toMatchObject({ id: "edge-host", actor: "agent:agent-example" });
    expect(createHost).toHaveBeenCalledWith(expect.any(Object), expect.objectContaining({ isAdmin: false, scopes: ["hosts:write", "groups:write"] }));

    const group = await (await call({
      jsonrpc: "2.0", id: 8, method: "tools/call",
      params: { name: "create_group", arguments: { group: { id: "apps", name: "Apps" } } },
    })).json();
    expect(group.result.structuredContent).toMatchObject({ id: "apps", actor: "agent:agent-example" });

    const denied = await (await call({
      jsonrpc: "2.0", id: 9, method: "tools/call",
      params: { name: "delete_host", arguments: { hostId: "edge-host", confirm: "true" } },
    })).json();
    expect(denied.error.message).toMatch(/confirm=true/);
    expect(deleteHost).not.toHaveBeenCalled();

    const deleted = await (await call({
      jsonrpc: "2.0", id: 10, method: "tools/call",
      params: { name: "delete_group", arguments: { groupId: "apps", confirm: true } },
    })).json();
    expect(deleted.result.structuredContent).toEqual({ deleted: true, groupId: "apps" });
  });
});
