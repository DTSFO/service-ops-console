import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";

import {
  MAX_MCP_RESPONSE_BYTES,
  MAX_MCP_TIMEOUT_MS,
  createMcpHttpClient,
  validateMcpEndpoint,
} from "../lib/mcp-http-client.js";

function jsonResponse(payload, init = {}) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { "content-type": "application/json", ...(init.headers || {}) },
    ...init,
  });
}

describe("MCP HTTP client", () => {
  it("requires HTTPS except for loopback test endpoints", () => {
    expect(validateMcpEndpoint("https://mcp.example.test/rpc").protocol).toBe("https:");
    expect(validateMcpEndpoint("http://127.0.0.1:3000/mcp").protocol).toBe("http:");
    expect(() => validateMcpEndpoint("http://mcp.example.test/rpc")).toThrow(/HTTPS/);
    expect(() => validateMcpEndpoint("https://user:secret@mcp.example.test/rpc")).toThrow(/credentials/);
  });

  it("injects authorization from an environment variable and validates JSON-RPC IDs", async () => {
    const fetchImpl = vi.fn(async (_url, init) => {
      expect(init.headers.get("Authorization")).toBe("Bearer example-access-token");
      const request = JSON.parse(init.body);
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { tools: [] } });
    });
    const client = createMcpHttpClient(
      { endpoint: "https://mcp.example.test/rpc", oauthAccessTokenEnv: "EXAMPLE_MCP_TOKEN" },
      { fetchImpl, env: { EXAMPLE_MCP_TOKEN: "example-access-token" }, nextId: () => "request-1" },
    );
    await expect(client.listTools()).resolves.toEqual({ tools: [] });
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it("initializes a session and sends the negotiated protocol version", async () => {
    let call = 0;
    const fetchImpl = vi.fn(async (_url, init) => {
      call += 1;
      const request = JSON.parse(init.body);
      if (call === 1) {
        return jsonResponse(
          { jsonrpc: "2.0", id: request.id, result: { protocolVersion: "2024-11-05", capabilities: {} } },
          { headers: { "mcp-session-id": "session-example" } },
        );
      }
      expect(request.method).toBe("notifications/initialized");
      expect(init.headers.get("Mcp-Session-Id")).toBe("session-example");
      expect(init.headers.get("MCP-Protocol-Version")).toBe("2024-11-05");
      return new Response(null, { status: 202 });
    });
    const client = createMcpHttpClient(
      { endpoint: "https://mcp.example.test/rpc" },
      { fetchImpl, nextId: () => "initialize-1" },
    );
    await client.initialize();
    expect(client.getSessionId()).toBe("session-example");
  });

  it("parses bounded MCP event-stream responses", async () => {
    const fetchImpl = async (_url, init) => {
      const request = JSON.parse(init.body);
      return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [] } })}\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const client = createMcpHttpClient(
      { endpoint: "https://mcp.example.test" },
      { fetchImpl, nextId: () => "sse-1" },
    );
    await expect(client.listTools()).resolves.toEqual({ tools: [] });
  });

  it("enforces timeout and response-size configuration ceilings", () => {
    expect(() => createMcpHttpClient({ endpoint: "https://mcp.example.test", timeoutMs: MAX_MCP_TIMEOUT_MS + 1 })).toThrow(/timeoutMs/);
    expect(() => createMcpHttpClient({ endpoint: "https://mcp.example.test", maximumResponseBytes: MAX_MCP_RESPONSE_BYTES + 1 })).toThrow(/maximumResponseBytes/);
  });

  it("rejects oversized response streams", async () => {
    const fetchImpl = async (_url, init) => jsonResponse(
      { jsonrpc: "2.0", id: JSON.parse(init.body).id, result: { value: "x".repeat(2_000) } },
    );
    const client = createMcpHttpClient(
      { endpoint: "https://mcp.example.test", maximumResponseBytes: 1_024 },
      { fetchImpl, nextId: () => 1 },
    );
    await expect(client.request("example/read", {})).rejects.toThrow(/exceeds 1024 bytes/);
  });

  it("does not accept inline credentials in authentication configuration", () => {
    expect(() => createMcpHttpClient({ endpoint: "https://mcp.example.test", authorizationEnv: "Bearer secret" })).toThrow(/environment variable name/);
    expect(() => createMcpHttpClient({ endpoint: "https://mcp.example.test", apiKey: "inline-secret" })).toThrow(/environment variable/);
    expect(() => createMcpHttpClient({ endpoint: "https://mcp.example.test", oauthClientSecret: "inline-secret" })).toThrow(/environment variable/);
  });

  it("refreshes OAuth credentials through environment-backed client settings", async () => {
    const fetchImpl = vi.fn(async (url, init) => {
      if (String(url) === "https://auth.example.test/token") {
        expect(init.body).toContain("refresh_token=refresh-example");
        expect(init.body).toContain("client_id=client-example");
        return jsonResponse({ access_token: "fresh-access", refresh_token: "rotated-refresh", expires_in: 3600 });
      }
      expect(init.headers.get("Authorization")).toBe("Bearer fresh-access");
      const request = JSON.parse(init.body);
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { tools: [] } });
    });
    const client = createMcpHttpClient({
      endpoint: "https://mcp.example.test/rpc",
      oauthRefreshTokenEnv: "EXAMPLE_REFRESH_TOKEN",
      oauthClientIdEnv: "EXAMPLE_CLIENT_ID",
      oauthTokenEndpoint: "https://auth.example.test/token",
    }, {
      fetchImpl,
      env: { EXAMPLE_REFRESH_TOKEN: "refresh-example", EXAMPLE_CLIENT_ID: "client-example" },
      nextId: () => "oauth-request",
    });

    await expect(client.listTools()).resolves.toEqual({ tools: [] });
    expect(client.canRefreshAuthentication).toBe(true);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("loads, refreshes, and atomically persists an operator-owned credential store", async () => {
    const directory = mkdtempSync(path.join(tmpdir(), "service-ops-oauth-"));
    const credentialsPath = path.join(directory, "credentials.json");
    writeFileSync(credentialsPath, JSON.stringify({
      servers: {
        "example-upstream": {
          server_url: "https://mcp.example.test/rpc",
          access_token: "expired-access",
          refresh_token: "refresh-example",
          client_id: "client-example",
          expires_at: Date.now() - 60_000,
        },
      },
    }), { mode: 0o600 });

    const fetchImpl = vi.fn(async (url, init) => {
      if (String(url) === "https://mcp.example.test/.well-known/oauth-authorization-server") {
        return jsonResponse({ error: "not found" }, { status: 404 });
      }
      if (String(url) === "https://mcp.example.test/token") {
        expect(init.body).toContain("refresh_token=refresh-example");
        return jsonResponse({ access_token: "fresh-access", refresh_token: "rotated-refresh", expires_in: 3600, scope: "read write" });
      }
      expect(init.headers.get("Authorization")).toBe("Bearer fresh-access");
      const request = JSON.parse(init.body);
      return jsonResponse({ jsonrpc: "2.0", id: request.id, result: { tools: [] } });
    });
    const client = createMcpHttpClient({
      serverId: "example-upstream",
      endpoint: "https://mcp.example.test/rpc",
      credentialsPath,
    }, { fetchImpl, nextId: () => "file-oauth-request" });

    await expect(client.listTools()).resolves.toEqual({ tools: [] });
    const persisted = JSON.parse(readFileSync(credentialsPath, "utf8"));
    expect(persisted.servers["example-upstream"]).toMatchObject({
      access_token: "fresh-access",
      refresh_token: "rotated-refresh",
      scopes: ["read", "write"],
    });
    if (process.platform !== "win32") expect(statSync(credentialsPath).mode & 0o777).toBe(0o600);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("selects the JSON-RPC result from a multi-event MCP stream", async () => {
    const fetchImpl = async (_url, init) => {
      const request = JSON.parse(init.body);
      const progress = JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progress: 1 } });
      const result = JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { tools: [] } });
      return new Response(`data: ${progress}\n\ndata: ${result}\n\ndata: [DONE]\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    };
    const client = createMcpHttpClient(
      { endpoint: "https://mcp.example.test" },
      { fetchImpl, nextId: () => "multi-event" },
    );
    await expect(client.listTools()).resolves.toEqual({ tools: [] });
  });
});
