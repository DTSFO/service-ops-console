import { describe, expect, it, vi } from "vitest";

import { createUpstreamMcp } from "../lib/upstream-mcp.js";

function clientStub() {
  return {
    initialize: vi.fn(async () => ({ protocolVersion: "2024-11-05" })),
    listTools: vi.fn(async () => ({ tools: [
      { name: "records_list", description: "Read records" },
      { name: "records_update", description: "Update records" },
      { name: "unclassified_tool", description: "Must remain hidden" },
    ] })),
    callTool: vi.fn(async (name, args) => ({ name, args })),
  };
}

describe("upstream MCP policy", () => {
  it("lists only explicitly classified tools with their access class", async () => {
    const client = clientStub();
    const upstream = createUpstreamMcp({
      toolPolicy: { records_list: "read", records_update: "write" },
    }, { client });
    await expect(upstream.listTools()).resolves.toEqual({ tools: [
      expect.objectContaining({ name: "records_list", access: "read" }),
      expect.objectContaining({ name: "records_update", access: "write" }),
    ] });
    expect(client.initialize).toHaveBeenCalledTimes(1);
  });

  it("permits classified reads without enabling write capability", async () => {
    const client = clientStub();
    const upstream = createUpstreamMcp({ toolPolicy: { records_list: "read" } }, { client });
    await expect(upstream.callTool("records_list", { limit: 5 })).resolves.toEqual({
      name: "records_list",
      args: { limit: 5 },
    });
  });

  it("requires both explicit write capability and strict confirmation", async () => {
    const client = clientStub();
    const disabled = createUpstreamMcp({ toolPolicy: { records_update: "write" } }, { client });
    await expect(disabled.callTool("records_update", {}, { confirm: true })).rejects.toThrow(/write capability is disabled/);

    const enabled = createUpstreamMcp({
      capabilities: { write: true },
      toolPolicy: { records_update: "write" },
    }, { client });
    await expect(enabled.callTool("records_update", {}, { confirm: "true" })).rejects.toThrow(/confirm=true/);
    await expect(enabled.callTool("records_update", { value: "example" }, { confirm: true })).resolves.toEqual({
      name: "records_update",
      args: { value: "example" },
    });
  });

  it("denies unclassified tools and inline secret values", async () => {
    const client = clientStub();
    const upstream = createUpstreamMcp({ toolPolicy: {} }, { client });
    await expect(upstream.callTool("unclassified_tool")).rejects.toThrow(/not classified/);
    expect(() => createUpstreamMcp({ token: "inline-secret", toolPolicy: {} }, { client })).toThrow(/environment variable/);
    expect(() => createUpstreamMcp({ client: { authorization: "inline-secret" }, toolPolicy: {} }, { client })).toThrow(/environment variable/);
  });

  it("reinitializes once when an upstream MCP session expires", async () => {
    const client = clientStub();
    const expired = Object.assign(new Error("Mcp-Session-Id is invalid"), { status: 404 });
    client.listTools.mockRejectedValueOnce(expired).mockResolvedValueOnce({ tools: [{ name: "records_list" }] });
    client.resetSession = vi.fn();
    const upstream = createUpstreamMcp({ toolPolicy: { records_list: "read" } }, { client });

    await expect(upstream.listTools()).resolves.toEqual({ tools: [expect.objectContaining({ name: "records_list" })] });
    expect(client.resetSession).toHaveBeenCalledOnce();
    expect(client.initialize).toHaveBeenCalledTimes(2);
  });

  it("refreshes OAuth and reinitializes once after an authentication failure", async () => {
    const client = clientStub();
    client.canRefreshAuthentication = true;
    client.refreshAuthentication = vi.fn(async () => "fresh-access");
    client.resetSession = vi.fn();
    client.listTools.mockRejectedValueOnce(Object.assign(new Error("unauthorized"), { status: 401 }))
      .mockResolvedValueOnce({ tools: [{ name: "records_list" }] });
    const upstream = createUpstreamMcp({ toolPolicy: { records_list: "read" } }, { client });

    await expect(upstream.listTools()).resolves.toEqual({ tools: [expect.objectContaining({ name: "records_list" })] });
    expect(client.refreshAuthentication).toHaveBeenCalledOnce();
    expect(client.initialize).toHaveBeenCalledTimes(2);
  });
});
