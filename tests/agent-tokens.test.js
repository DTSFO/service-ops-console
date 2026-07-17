import { createRequire } from "node:module";

import { afterEach, describe, expect, it } from "vitest";

import {
  createAgentTokenManager,
  hashAgentToken,
  hasAgentScopes,
} from "../lib/agent-tokens.js";
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

function deterministicRandomBytes() {
  let value = 1;
  return (length) => Buffer.alloc(length, value++);
}

afterEach(() => {
  while (stores.length) stores.pop().close();
});

sqliteDescribe("agent tokens", () => {
  it("returns plaintext once, persists only a hash, and verifies scopes", () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const store = createServiceStore({ Database, clock: () => now });
    stores.push(store);
    const manager = createAgentTokenManager({ store, clock: () => now, randomBytes: deterministicRandomBytes() });

    const created = manager.create({
      name: "Read-only agent",
      scopes: ["services:status", "services:read", "services:read", "invalid"],
      createdBy: "operator",
    });
    expect(created.token).toMatch(/^soc_/);
    expect(created.record).not.toHaveProperty("tokenHash");
    expect(manager.list()[0]).not.toHaveProperty("token");

    const stored = store.getAgentTokenRecord(created.record.id);
    expect(stored.tokenHash).toBe(hashAgentToken(created.token));
    expect(stored.tokenHash).not.toContain(created.token);
    expect(stored.scopes).toEqual(["services:read", "services:status"]);

    now += 1_000;
    const verified = manager.verify(created.token, { ip: "127.0.0.2" });
    expect(verified).toMatchObject({ id: created.record.id, lastUsedAt: "2026-01-01T00:00:01.000Z" });
    expect(hasAgentScopes(verified, ["services:read", "services:status"])).toBe(true);
    expect(hasAgentScopes(verified, "services:control")).toBe(false);
    expect(manager.verify(`${created.token}x`)).toBeNull();
  });

  it("supports disable, re-enable, expiry, and irreversible revocation", () => {
    let now = Date.parse("2026-01-01T00:00:00.000Z");
    const store = createServiceStore({ Database, clock: () => now });
    stores.push(store);
    const manager = createAgentTokenManager({ store, clock: () => now, randomBytes: deterministicRandomBytes() });
    const created = manager.create({
      name: "Temporary agent",
      scopes: ["services:read"],
      expiresAt: "2026-01-01T01:00:00.000Z",
    });

    expect(manager.verify(created.token)).not.toBeNull();
    expect(manager.update(created.record.id, { disabled: true })).toMatchObject({ disabledAt: expect.any(String) });
    expect(manager.verify(created.token)).toBeNull();
    expect(manager.update(created.record.id, { disabled: false })).toMatchObject({ disabledAt: null });
    expect(manager.verify(created.token)).not.toBeNull();

    now = Date.parse("2026-01-01T01:00:00.000Z");
    expect(manager.verify(created.token)).toBeNull();
    expect(manager.update(created.record.id, { expiresAt: "2026-01-02T00:00:00.000Z" })).not.toBeNull();
    expect(manager.verify(created.token)).not.toBeNull();

    expect(manager.revoke(created.record.id)).toMatchObject({ revokedAt: expect.any(String), disabledAt: expect.any(String) });
    expect(manager.verify(created.token)).toBeNull();
    expect(manager.update(created.record.id, { disabled: false })).toBeNull();
    expect(manager.revoke(created.record.id)).toMatchObject({ revokedAt: expect.any(String) });
  });

  it("rejects empty names, empty permissions, and invalid expiry values", () => {
    const store = createServiceStore({ Database });
    stores.push(store);
    const manager = createAgentTokenManager({ store, randomBytes: deterministicRandomBytes() });
    expect(() => manager.create({ name: "", scopes: ["services:read"] })).toThrow(/name/);
    expect(() => manager.create({ name: "Agent", scopes: ["invalid"] })).toThrow(/valid scope/);
    expect(() => manager.create({ name: "Agent", scopes: ["services:read"], expiresAt: "not-a-date" })).toThrow(/valid date/);
  });
});
