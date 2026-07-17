import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

import { createServiceStore } from "../lib/service-store.js";

const require = createRequire(import.meta.url);
let Database;
try {
  Database = require("better-sqlite3");
} catch {
  Database = null;
}

const sqliteDescribe = Database ? describe : describe.skip;
const stores = [];
const temporaryDirectories = [];

function store(options = {}) {
  const instance = createServiceStore({ Database, ...options });
  stores.push(instance);
  return instance;
}

function seedRegistry(instance) {
  instance.createHost({ id: "node-a", name: "Node A", mode: "ssh", target: "ssh-alias" });
  instance.createGroup({ id: "core", name: "Core" });
}

afterEach(() => {
  while (stores.length) stores.pop().close();
  while (temporaryDirectories.length) fs.rmSync(temporaryDirectories.pop(), { recursive: true, force: true });
});

sqliteDescribe("service store", () => {
  it("runs versioned migrations idempotently and enables foreign keys", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "service-ops-store-"));
    temporaryDirectories.push(directory);
    const dbPath = path.join(directory, "registry.sqlite");
    const first = store({ dbPath });
    expect(first.db.pragma("user_version", { simple: true })).toBe(1);
    expect(first.db.pragma("foreign_keys", { simple: true })).toBe(1);
    expect(first.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count).toBe(1);
    first.close();
    stores.pop();

    const second = store({ dbPath });
    expect(second.db.prepare("SELECT COUNT(*) AS count FROM schema_migrations").get().count).toBe(1);
    expect(second.schemaVersion).toBe(1);
  });

  it("enforces safe hosts, host references, group rename, and replacement", () => {
    const instance = store();
    expect(() => instance.createHost({ id: "unsafe", name: "Unsafe", password: "not-allowed" }))
      .toThrow(/must not store credentials/);
    seedRegistry(instance);
    instance.createService({
      id: "web-app",
      hostId: "node-a",
      groupId: "core",
      name: "Web App",
      url: "https://app.example.com/",
      control: { type: "systemd", name: "web-app" },
      location: { path: "/srv/app" },
      health: { type: "http", url: "https://internal.example/health", headersFromEnv: { Authorization: "HEALTH_TOKEN" } },
      update: { current: { version: "1.0.0" }, source: { type: "static", label: "Operator" }, command: "unsafe" },
    });

    expect(() => instance.deleteHost("node-a")).toThrow(/still referenced/);
    expect(instance.updateGroup("core", { id: "platform" })).toMatchObject({ id: "platform" });
    expect(instance.getService("web-app")).toMatchObject({ groupId: "platform", hostId: "node-a" });

    instance.createGroup({ id: "archive", name: "Archive" });
    expect(instance.deleteGroup("platform", { replacementGroup: "archive" })).toBe(true);
    expect(instance.getService("web-app")).toMatchObject({ groupId: "archive" });

    const publicService = instance.getService("web-app", { visibility: "public" });
    expect(publicService).not.toHaveProperty("control");
    expect(publicService).not.toHaveProperty("location");
    expect(publicService).not.toHaveProperty("health");
    expect(publicService.update).toEqual({
      current: { version: "1.0.0", checkedAt: null },
      source: { type: "static", label: "Operator" },
    });
    expect(instance.getHost("node-a", { visibility: "public" })).not.toHaveProperty("target");
  });

  it("validates relations and supports soft delete, restore, purge, and update cache", () => {
    const instance = store();
    seedRegistry(instance);
    instance.createService({ id: "database", hostId: "node-a", groupId: "core", name: "Database" });
    instance.createService({ id: "web-app", hostId: "node-a", groupId: "core", name: "Web App", related: ["database"] });
    expect(() => instance.updateService("web-app", { related: ["missing-service"] })).toThrow(/does not exist/);
    expect(() => instance.updateService("web-app", { related: ["web-app"] })).toThrow(/cannot relate to itself/);

    expect(instance.softDeleteService("web-app")).toMatchObject({ deletedAt: expect.any(String) });
    expect(instance.getService("web-app")).toBeNull();
    expect(instance.restoreService("web-app")).toMatchObject({ deletedAt: null, enabled: true });

    expect(instance.writeUpdateCache("database", { current: "17" })).toMatchObject({ status: { current: "17" } });
    expect(instance.purgeService("database")).toMatchObject({ id: "database" });
    expect(instance.getService("database", { includeDeleted: true })).toBeNull();
    expect(instance.getService("web-app").related).toEqual([]);
    expect(instance.readUpdateCache("database")).toBeNull();
  });

  it("redacts infrastructure and credential fields before audit persistence", () => {
    const instance = store();
    seedRegistry(instance);
    instance.createService({
      id: "web-app",
      hostId: "node-a",
      groupId: "core",
      name: "Web App",
      health: { url: "https://private.example/health", headers: { Authorization: "secret" } },
      location: { path: "/private/path" },
      agent: { token: "secret-token" },
    }, { actor: "operator" });

    const event = instance.listAuditLogs({ targetType: "service", targetId: "web-app" })[0];
    expect(event).toMatchObject({ actor: "operator", action: "service.create" });
    expect(event.payload.service.hostId).toBe("[REDACTED]");
    expect(event.payload.service.health.url).toBe("[REDACTED]");
    expect(event.payload.service.health.headers).toBe("[REDACTED]");
    expect(event.payload.service.location.path).toBe("[REDACTED]");
    expect(event.payload.service.agent.token).toBe("[REDACTED]");
  });
});
