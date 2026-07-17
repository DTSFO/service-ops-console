import { describe, expect, it, vi } from "vitest";

import { createOperations } from "../lib/operations.js";
import { createMcpServer } from "../mcp/server.js";

function fixture() {
  const service = {
    id: "example-api",
    hostId: "app-host",
    groupId: "apps",
    name: "Example API",
    enabled: true,
    control: { type: "systemd", name: "example-api" },
  };
  const host = { id: "app-host", mode: "local" };
  const store = {
    listServices: vi.fn(() => [service]),
    getService: vi.fn((id) => id === service.id ? service : null),
    getHost: vi.fn((id) => id === host.id ? host : null),
    writeAudit: vi.fn(),
  };
  const runtimeAdapter = {
    status: vi.fn(async () => ({ ok: true, status: "active" })),
    control: vi.fn(async () => ({ ok: true })),
  };
  const operations = createOperations({
    store,
    runtimeAdapter,
    sshExecutor: { execute: vi.fn(), probe: vi.fn() },
    features: { serviceControl: true },
  });
  return { operations, runtimeAdapter, store };
}

describe("MCP integration with createOperations", () => {
  it("passes scoped access to inventory and status operations", async () => {
    const { operations, runtimeAdapter } = fixture();
    const server = createMcpServer({
      operations,
      scopes: ["services:read", "services:status"],
    });
    await expect(server.callTool("list_services", {})).resolves.toEqual([
      expect.objectContaining({ id: "example-api" }),
    ]);
    await expect(server.callTool("get_service_status", { serviceId: "example-api" })).resolves.toEqual({
      statuses: [{ id: "example-api", status: "active", ok: true }],
    });
    expect(runtimeAdapter.status).toHaveBeenCalledOnce();
  });

  it("passes confirmation and access separately for service control", async () => {
    const { operations, runtimeAdapter, store } = fixture();
    const server = createMcpServer({
      operations,
      scopes: ["services:control"],
      privilegedOperations: true,
      actor: { type: "agent", id: "automation" },
    });
    await expect(server.callTool("control_service", {
      serviceId: "example-api",
      action: "restart",
      confirm: true,
    })).resolves.toMatchObject({ serviceId: "example-api", action: "restart", ok: true });
    expect(runtimeAdapter.control).toHaveBeenCalledWith(expect.anything(), "restart", { confirm: true });
    expect(store.writeAudit).toHaveBeenCalledWith(expect.objectContaining({ actor: "automation" }));
  });
});
