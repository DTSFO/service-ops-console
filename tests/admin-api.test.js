import { afterEach, describe, expect, it, vi } from "vitest";

function response(payload = {}) {
  return {
    ok: true,
    status: 200,
    headers: { get: () => "application/json" },
    json: vi.fn().mockResolvedValue(payload),
  };
}

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetModules();
});

describe("authenticated dashboard client", () => {
  it("sends credentials, CSRF, and strict confirmation for service control", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ success: true }));
    const api = await import("../src/api/dashboard.js");
    api.setCsrfTokenForTests("csrf-test");

    await api.runServiceControl("example-api", "restart");

    const [, options] = fetchMock.mock.calls[0];
    expect(options.credentials).toBe("include");
    expect(options.headers.get("x-csrf-token")).toBe("csrf-test");
    expect(JSON.parse(options.body)).toEqual({ action: "restart", confirm: true });
  });

  it("uses protected admin registry and Agent Token endpoints", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({}));
    const api = await import("../src/api/dashboard.js");

    await api.createAdminRecord("services", { id: "example-api" });
    await api.updateAdminRecord("services", "example-api", { name: "Example API" });
    await api.deleteAdminRecord("services", "example-api");
    await api.revokeAgentToken("agt_example");

    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      "/api/admin/services",
      "/api/admin/services/example-api",
      "/api/admin/services/example-api",
      "/api/admin/agent-tokens/agt_example",
    ]);
    expect(JSON.parse(fetchMock.mock.calls[2][1].body).confirm).toBe(true);
    expect(JSON.parse(fetchMock.mock.calls[3][1].body).confirm).toBe(true);
  });

  it("uses token scope definitions returned by the server", async () => {
    vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({ tokens: [], scopes: [{ id: "services:read", description: "Read services" }] }))
      .mockResolvedValueOnce(response([]))
      .mockResolvedValueOnce(response({}))
      .mockResolvedValueOnce(response({ hosts: [] }))
      .mockResolvedValueOnce(response({ servers: [] }));
    const api = await import("../src/api/dashboard.js");

    await expect(api.fetchAdminOverview()).resolves.toMatchObject({
      tokens: [],
      tokenScopes: [{ id: "services:read", description: "Read services" }],
    });
  });

  it("passes an explicit service selection to batch version checks", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({ statuses: [] }));
    const api = await import("../src/api/dashboard.js");
    api.setCsrfTokenForTests("csrf-test");

    await api.checkVersions("", ["api", "worker"]);

    expect(fetchMock.mock.calls[0][0]).toBe("/api/versions/check");
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      confirm: true,
      serviceIds: ["api", "worker"],
    });
  });
});
