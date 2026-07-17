import { afterEach, describe, expect, it, vi } from "vitest";

afterEach(() => {
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
});

describe("dashboard API base configuration", () => {
  it("uses same-origin API paths when VITE_API_BASE is '/'", async () => {
    vi.resetModules();
    vi.stubEnv("VITE_API_BASE", "/");
    const response = { ok: true, json: vi.fn().mockResolvedValue({ hosts: [], groups: [], services: [] }) };
    const fetchMock = vi.spyOn(globalThis, "fetch").mockResolvedValue(response);
    const { fetchDashboardBootstrap } = await import("../src/api/dashboard.js");

    await fetchDashboardBootstrap();

    expect(fetchMock).toHaveBeenCalledWith("/api/inventory", expect.objectContaining({ credentials: "include", method: "GET" }));
  });
});
