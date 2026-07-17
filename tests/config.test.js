import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { loadCloudflareServers, loadSshHosts, publicInventory, runtimeConfig, validateInventory } from "../lib/config.js";

function inventory(overrides = {}) {
  return {
    hosts: [{ id: "app-host", name: "Application Host", control: { mode: "local" } }],
    groups: [{ id: "core", name: "Core" }],
    services: [{
      id: "example-web",
      name: "Example Web",
      host: "app-host",
      group: "core",
      control: { type: "systemd", name: "example-web" },
      health: { type: "http", url: "https://example.com/health" },
    }],
    tools: [],
    ...overrides,
  };
}

function jsonFile(value) {
  const directory = mkdtempSync(path.join(tmpdir(), "service-ops-config-"));
  const file = path.join(directory, "config.json");
  writeFileSync(file, JSON.stringify(value));
  return file;
}

describe("operations configuration", () => {
  it("validates runtime inventory and returns a safe public projection", () => {
    const parsed = validateInventory(inventory());
    const projected = publicInventory(parsed);
    expect(projected.services[0]).toMatchObject({ id: "example-web", control: { type: "systemd" } });
    expect(projected.services[0]).not.toHaveProperty("health");
    expect(projected.hosts[0]).toEqual(expect.objectContaining({ id: "app-host", mode: "local" }));
  });

  it("rejects unknown references and active health methods", () => {
    expect(() => validateInventory(inventory({
      services: [{ id: "example-web", name: "Example", host: "missing", group: "core" }],
    }))).toThrow(/unknown host/);
    expect(() => validateInventory(inventory({
      services: [{
        id: "example-web", name: "Example", host: "app-host", group: "core",
        health: { type: "http", url: "https://example.com", method: "POST" },
      }],
    }))).toThrow(/GET or HEAD/);
  });

  it("accepts bounded command health and validates GitHub update strategies", () => {
    const input = inventory();
    input.services[0].health = { type: "command", command: "example-health-check", timeoutMs: 2000, expectedExitCode: 0 };
    input.services[0].update = {
      current: { type: "command", command: ["example-version", "--json"], pattern: "version=(\\S+)" },
      source: { type: "github", repo: "example/project", strategy: "commit", ref: "main", tokenEnv: "EXAMPLE_GITHUB_TOKEN" },
    };
    expect(validateInventory(input).services[0]).toMatchObject({
      health: { type: "command", command: ["example-health-check"], timeoutMs: 2000, expectedExitCode: 0 },
      update: { current: { command: ["example-version", "--json"] }, source: { strategy: "commit", ref: "main", tokenEnv: "EXAMPLE_GITHUB_TOKEN" } },
    });
    input.services[0].update.source.strategy = "branch";
    expect(() => validateInventory(input)).toThrow(/release, tag, or commit/);
  });

  it("accepts composite health and rejects shell-style command strings", () => {
    const input = inventory();
    input.services[0].health = {
      type: "composite",
      includeRuntime: true,
      checks: [
        { type: "http", url: "https://example.com/health", expectedStatus: [200, 204] },
        { type: "command", command: ["example-health", "--quiet"] },
      ],
    };
    expect(validateInventory(input).services[0].health).toMatchObject({ type: "composite", checks: [{ type: "http", expectedStatus: [200, 204] }, { type: "command", command: ["example-health", "--quiet"] }] });
    input.services[0].health = { type: "command", command: "example-health && touch /tmp/no" };
    expect(() => validateInventory(input)).toThrow(/argv array/);
  });

  it("validates Docker command prefixes as argv", () => {
    const input = inventory();
    input.services[0].control = { type: "docker", name: "example", command: ["sudo", "-n", "docker"] };
    expect(validateInventory(input).services[0].control.command).toEqual(["sudo", "-n", "docker"]);
    input.services[0].control.command = "sudo docker";
    expect(() => validateInventory(input)).toThrow(/argv array/);
  });

  it("validates self-service scheduling commands and daily update schedules", () => {
    const input = inventory();
    input.services[0].control = {
      type: "systemd",
      name: "example-web",
      self: true,
      selfActionCommand: ["sudo", "-n", "systemd-run"],
      selfSystemctlPath: "/bin/systemctl",
    };
    expect(validateInventory(input).services[0].control.selfActionCommand).toEqual(["sudo", "-n", "systemd-run"]);
    expect(runtimeConfig({ OPS_DATA_DIR: "/tmp/service-ops-test", OPS_UPDATE_CHECK_DAILY_TIME: "13:00" })).toMatchObject({
      updateCheckDailyTime: "13:00",
      updateCheckTimezoneOffsetMinutes: 480,
      sessionTtlDays: 30,
      sessionTtlSeconds: 30 * 24 * 60 * 60,
      sessionRolling: true,
    });
    expect(runtimeConfig({ OPS_DATA_DIR: "/tmp/service-ops-test", OPS_SESSION_TTL_DAYS: "0.5", OPS_SESSION_ROLLING: "false" })).toMatchObject({
      sessionTtlDays: 0.5,
      sessionTtlSeconds: 12 * 60 * 60,
      sessionCookieMaxAgeMs: 12 * 60 * 60 * 1000,
      sessionRolling: false,
    });
    expect(() => runtimeConfig({ OPS_SESSION_TTL_DAYS: "0" })).toThrow(/positive number/);
    expect(() => runtimeConfig({ OPS_SESSION_ROLLING: "yes" })).toThrow(/true or false/);
    expect(() => runtimeConfig({ OPS_DATA_DIR: "/tmp/service-ops-test", OPS_UPDATE_CHECK_DAILY_TIME: "25:00" })).toThrow(/HH:MM/);
  });

  it("resolves SSH secrets only through named environment variables", () => {
    const inline = jsonFile({ hosts: [{ id: "app-host", backend: "ssh2", host: "example.invalid", username: "ops", password: "secret" }] });
    expect(() => loadSshHosts(inline)).toThrow(/environment reference/);
    const referenced = jsonFile({ hosts: [{ id: "app-host", backend: "ssh2", host: "example.invalid", username: "ops", passwordFromEnv: "OPS_TEST_PASSWORD" }] });
    process.env.OPS_TEST_PASSWORD = "local-test-value";
    try {
      expect(loadSshHosts(referenced)[0]).toMatchObject({ id: "app-host", password: "local-test-value" });
    } finally {
      delete process.env.OPS_TEST_PASSWORD;
    }
  });

  it("validates SSH backends, ports, identity paths, and command policies", () => {
    expect(() => loadSshHosts(jsonFile({ hosts: [{ id: "app-host", backend: "openssh", target: "example", identityFile: "/tmp/id" }] }))).toThrow(/environment reference/);
    expect(() => loadSshHosts(jsonFile({ hosts: [{ id: "app-host", backend: "ssh2", host: "example.invalid", username: "ops", port: 70000 }] }))).toThrow(/between 1 and 65535/);
    expect(() => loadSshHosts(jsonFile({ hosts: [{ id: "app-host", backend: "unknown" }] }))).toThrow(/unsupported/);
    expect(() => loadSshHosts(jsonFile({ hosts: [{ id: "app-host", backend: "openssh", target: "example", commandPolicy: { enabled: true, prefixes: "systemctl" } }] }))).toThrow(/must be an array/);
  });

  it("rejects inline Cloudflare credentials and non-HTTPS upstreams", () => {
    const inline = jsonFile({ servers: [{ id: "cloudflare-api", name: "API", url: "https://mcp.example.com/mcp", authorization: "Bearer secret" }] });
    expect(() => loadCloudflareServers(inline)).toThrow(/authorizationEnv/);
    const insecure = jsonFile({ servers: [{ id: "cloudflare-api", name: "API", url: "http://mcp.example.com/mcp" }] });
    expect(() => loadCloudflareServers(insecure)).toThrow(/HTTPS/);
  });

  it("validates every Cloudflare header environment reference", () => {
    const invalid = jsonFile({ servers: [{
      id: "cloudflare-api",
      name: "API",
      url: "https://mcp.example.com/mcp",
      headersFromEnv: { "X-Account": "not-an-env-name" },
    }] });
    expect(() => loadCloudflareServers(invalid)).toThrow(/environment variable name/);
  });

  it("validates environment-backed OAuth refresh configuration", () => {
    const valid = jsonFile({ servers: [{
      id: "cloudflare-api",
      name: "API",
      url: "https://mcp.example.com/mcp",
      oauthAccessTokenEnv: "EXAMPLE_ACCESS_TOKEN",
      oauthRefreshTokenEnv: "EXAMPLE_REFRESH_TOKEN",
      oauthClientIdEnv: "EXAMPLE_CLIENT_ID",
      oauthTokenEndpoint: "https://auth.example.com/token",
    }] });
    expect(loadCloudflareServers(valid)[0]).toMatchObject({ oauthRefreshTokenEnv: "EXAMPLE_REFRESH_TOKEN" });

    const incomplete = jsonFile({ servers: [{
      id: "cloudflare-api",
      name: "API",
      url: "https://mcp.example.com/mcp",
      oauthRefreshTokenEnv: "EXAMPLE_REFRESH_TOKEN",
    }] });
    expect(() => loadCloudflareServers(incomplete)).toThrow(/oauthClientIdEnv/);
  });

  it("loads operator-owned OAuth credential stores and bounded MCP transport settings", () => {
    const file = jsonFile({ servers: [{
      id: "cloudflare-api",
      name: "API",
      url: "https://mcp.example.com/mcp",
      credentialsPath: "./oauth-credentials.json",
      credentialKey: "operator-profile",
      credentialNames: ["legacy-profile"],
      protocolVersion: "2025-06-18",
      timeoutMs: 20_000,
      maximumResponseBytes: 1_500_000,
    }] });
    expect(loadCloudflareServers(file)[0]).toMatchObject({
      credentialsPath: path.join(path.dirname(file), "oauth-credentials.json"),
      credentialKey: "operator-profile",
      credentialNames: ["legacy-profile"],
      protocolVersion: "2025-06-18",
      timeoutMs: 20_000,
      maximumResponseBytes: 1_500_000,
    });
  });
});
