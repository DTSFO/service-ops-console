import { describe, expect, it, vi } from "vitest";

import { createMcpServer } from "../mcp/server.js";

describe("scoped MCP server", () => {
  it("lists only operations authorized by the granted scopes", async () => {
    const server = createMcpServer({
      operations: {
        listServices: vi.fn(),
        getServiceStatus: vi.fn(),
        controlService: vi.fn(),
        executeSsh: vi.fn(),
      },
      scopes: ["services:read", "services:status", "services:control", "ssh:execute"],
      privilegedOperations: false,
    });
    const response = await server.handleRequest({ jsonrpc: "2.0", id: 1, method: "tools/list" });
    expect(response.result.tools.map((tool) => tool.name)).toEqual(["list_services", "discover_services", "get_service_status"]);
  });

  it("requires confirm=true and forwards actor, scopes, and feature state", async () => {
    const controlService = vi.fn(async () => ({ ok: true }));
    const server = createMcpServer({
      operations: { controlService },
      scopes: ["services:control"],
      privilegedOperations: true,
      actor: { type: "agent", id: "example-agent" },
    });
    const denied = await server.handleRequest({
      jsonrpc: "2.0",
      id: 2,
      method: "tools/call",
      params: { name: "control_service", arguments: { serviceId: "example-api", action: "restart" } },
    });
    expect(denied.error.message).toMatch(/confirm=true/);
    expect(controlService).not.toHaveBeenCalled();

    const allowed = await server.handleRequest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "control_service", arguments: { serviceId: "example-api", action: "restart", confirm: true } },
    });
    expect(allowed.result.structuredContent).toEqual({ ok: true });
    expect(controlService).toHaveBeenCalledWith("example-api", "restart", { confirm: true }, expect.objectContaining({
      privilegedOperations: true,
      actor: "example-agent",
      actorType: "agent",
      isAdmin: false,
    }));
  });

  it("does not expose token administration without tokens:manage", async () => {
    const operations = { listAgentTokens: vi.fn(), listServices: vi.fn() };
    const server = createMcpServer({ operations, scopes: ["services:read"] });
    expect(server.tools.map((tool) => tool.name)).toEqual(["list_services", "discover_services"]);
    await expect(server.callTool("list_agent_tokens", {})).rejects.toThrow(/unavailable or not authorized/);
  });

  it("exposes scoped MCP resources and templates through the same operations contract", async () => {
    const listServices = vi.fn(async () => [{ id: "example-api" }]);
    const getServiceStatus = vi.fn(async (id) => ({ statuses: [{ id, status: "active" }] }));
    const server = createMcpServer({
      operations: { listServices, getServiceStatus },
      scopes: ["services:read", "services:status"],
    });
    const listed = await server.handleRequest({ jsonrpc: "2.0", id: 10, method: "resources/list" });
    expect(listed.result.resources.map((resource) => resource.uri)).toContain("service-ops://services");
    const templates = await server.handleRequest({ jsonrpc: "2.0", id: 11, method: "resources/templates/list" });
    expect(templates.result.resourceTemplates.map((resource) => resource.uriTemplate)).toContain("service-ops://services/{serviceId}/status");
    expect(templates.result.resourceTemplates.map((resource) => resource.uriTemplate)).toContain("service-ops://services/{serviceId}");
    const service = await server.handleRequest({ jsonrpc: "2.0", id: 13, method: "resources/read", params: { uri: "service-ops://services/example-api" } });
    expect(JSON.parse(service.result.contents[0].text)).toEqual({ service: { id: "example-api" } });
    const read = await server.handleRequest({ jsonrpc: "2.0", id: 12, method: "resources/read", params: { uri: "service-ops://services/example-api/status" } });
    expect(JSON.parse(read.result.contents[0].text)).toEqual({ statuses: [{ id: "example-api", status: "active" }] });
  });

  it("exposes managed host writes to scoped agents as well as local administrators", () => {
    const operations = { createHost: vi.fn() };
    const agent = createMcpServer({ operations, scopes: ["hosts:write"], isAdmin: false });
    const admin = createMcpServer({ operations, scopes: ["hosts:write"], isAdmin: true });
    expect(agent.tools.map((tool) => tool.name)).toEqual(["create_host"]);
    expect(admin.tools.map((tool) => tool.name)).toEqual(["create_host"]);
  });

  it("passes destructive registry confirmation as options before access", async () => {
    const deleteHost = vi.fn(async () => ({ deleted: true }));
    const server = createMcpServer({
      operations: { deleteHost },
      scopes: ["hosts:write"],
      isAdmin: true,
      actor: "local-cli",
    });
    await server.callTool("delete_host", { hostId: "old-host", confirm: true });
    expect(deleteHost).toHaveBeenCalledWith(
      "old-host",
      { confirm: true },
      expect.objectContaining({ actor: "local-cli", isAdmin: true }),
    );
  });

  it("requires explicit Cloudflare tool classification and gates writes", async () => {
    const callCloudflareTool = vi.fn(async () => ({ ok: true }));
    const operations = {
      callCloudflareTool,
      classifyCloudflareTool: vi.fn(async (_serverId, toolName) => toolName === "write_record" ? "write" : "read"),
    };
    const inspection = createMcpServer({ operations, scopes: ["cloudflare:call"], privilegedOperations: false });
    await expect(inspection.callTool("call_cloudflare_tool", {
      serverId: "account",
      toolName: "write_record",
      arguments: {},
      confirm: true,
    })).rejects.toThrow(/Privileged operations are disabled/);
    await expect(inspection.callTool("call_cloudflare_tool", {
      serverId: "docs",
      toolName: "search_docs",
      arguments: {},
    })).resolves.toEqual({ ok: true });
    await expect(inspection.callTool("cf_call_tool", {
      server: "docs",
      toolName: "search_docs",
      arguments: {},
    })).resolves.toEqual({ ok: true });
    expect(operations.classifyCloudflareTool).toHaveBeenLastCalledWith("docs", "search_docs");
  });

  it("accepts q as the deployed ddhweb search compatibility parameter", async () => {
    const listServices = vi.fn(async () => []);
    const server = createMcpServer({ operations: { listServices }, scopes: ["services:read"] });
    await server.callTool("list_services", { q: "reader" });
    expect(listServices).toHaveBeenCalledWith({ query: "reader" }, expect.any(Object));
  });
});
