import { createHash, randomBytes as cryptoRandomBytes, timingSafeEqual } from "node:crypto";

export const SCOPE_DEFINITIONS = Object.freeze([
  { id: "services:read", description: "Read public service inventory." },
  { id: "services:status", description: "Read service health and runtime status." },
  { id: "services:locate", description: "Read privileged service location metadata." },
  { id: "services:control", description: "Run explicitly configured service controls." },
  { id: "services:write", description: "Create and update service records." },
  { id: "services:delete", description: "Soft-delete, restore, or purge services." },
  { id: "services:audit", description: "Read registry audit events." },
  { id: "hosts:read", description: "Read managed host records." },
  { id: "hosts:write", description: "Create, update, and delete managed hosts." },
  { id: "groups:read", description: "Read service groups." },
  { id: "groups:write", description: "Create, update, and delete service groups." },
  { id: "updates:read", description: "Read update metadata." },
  { id: "updates:check", description: "Run configured update checks." },
  { id: "updates:apply", description: "Run explicitly configured update operations." },
  { id: "ssh:read", description: "Read configured SSH host identifiers." },
  { id: "ssh:write", description: "Create, update, and delete SSH host registry entries." },
  { id: "ssh:execute", description: "Run allowlisted, confirmed SSH commands." },
  { id: "cloudflare:read", description: "Read configured upstream MCP metadata." },
  { id: "cloudflare:call", description: "Call explicitly configured upstream MCP tools." },
  { id: "tokens:manage", description: "Create, update, disable, and revoke agent tokens." },
]);

export const ALL_AGENT_SCOPES = Object.freeze(SCOPE_DEFINITIONS.map(({ id }) => id));
const VALID_SCOPES = new Set(ALL_AGENT_SCOPES);

export function hashAgentToken(token) {
  return createHash("sha256").update(String(token || ""), "utf8").digest("hex");
}

function hashesEqual(left, right) {
  if (!/^[a-f0-9]{64}$/i.test(left || "") || !/^[a-f0-9]{64}$/i.test(right || "")) return false;
  const a = Buffer.from(left, "hex");
  const b = Buffer.from(right, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}

export function normalizeAgentScopes(scopes) {
  if (!Array.isArray(scopes)) return [];
  return [...new Set(scopes.filter((scope) => VALID_SCOPES.has(scope)))].sort();
}

export function hasAgentScopes(record, requiredScopes) {
  const required = Array.isArray(requiredScopes) ? requiredScopes : [requiredScopes].filter(Boolean);
  if (!required.length) return true;
  const granted = new Set(record?.scopes || []);
  return required.every((scope) => granted.has(scope));
}

function safeRecord(record) {
  if (!record) return null;
  return {
    id: record.id,
    name: record.name,
    tokenPrefix: record.tokenPrefix,
    scopes: normalizeAgentScopes(record.scopes),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    expiresAt: record.expiresAt || null,
    disabledAt: record.disabledAt || null,
    revokedAt: record.revokedAt || null,
    createdBy: record.createdBy || null,
    lastUsedAt: record.lastUsedAt || null,
  };
}

function normalizeExpiry(value) {
  if (value === undefined || value === null || value === "") return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new TypeError("expiresAt must be a valid date");
  return date.toISOString();
}

export function createAgentTokenManager({ store, clock = Date.now, randomBytes = cryptoRandomBytes } = {}) {
  if (!store) throw new TypeError("store is required");
  const timestamp = () => new Date(clock()).toISOString();

  function list() {
    return store.listAgentTokenRecords().map(safeRecord);
  }

  function create({ name, scopes, expiresAt = null, createdBy = "system" } = {}) {
    const normalizedName = String(name || "").trim();
    const normalizedScopes = normalizeAgentScopes(scopes);
    if (!normalizedName) throw new TypeError("token name is required");
    if (!normalizedScopes.length) throw new TypeError("at least one valid scope is required");
    const token = `soc_${randomBytes(32).toString("base64url")}`;
    const now = timestamp();
    const record = store.createAgentTokenRecord({
      id: `agt_${randomBytes(12).toString("hex")}`,
      name: normalizedName,
      tokenHash: hashAgentToken(token),
      tokenPrefix: `${token.slice(0, 8)}…${token.slice(-4)}`,
      scopes: normalizedScopes,
      createdAt: now,
      updatedAt: now,
      expiresAt: normalizeExpiry(expiresAt),
      disabledAt: null,
      revokedAt: null,
      createdBy: String(createdBy || "system"),
      lastUsedAt: null,
      lastUsedIp: null,
    });
    store.writeAudit?.({
      actor: createdBy,
      action: "agent-token.create",
      targetType: "agent-token",
      targetId: record.id,
      payload: { name: record.name, scopes: record.scopes, expiresAt: record.expiresAt, tokenPrefix: record.tokenPrefix },
    });
    return { token, record: safeRecord(record) };
  }

  function update(id, input = {}, { actor = "system" } = {}) {
    const current = store.getAgentTokenRecord(id);
    if (!current || current.revokedAt) return null;
    const name = input.name === undefined ? current.name : String(input.name || "").trim();
    const scopes = input.scopes === undefined ? current.scopes : normalizeAgentScopes(input.scopes);
    if (!name) throw new TypeError("token name is required");
    if (!scopes.length) throw new TypeError("at least one valid scope is required");
    const disabledAt = input.disabled === undefined
      ? current.disabledAt
      : input.disabled ? current.disabledAt || timestamp() : null;
    const updated = store.updateAgentTokenRecord(id, {
      name,
      scopes,
      expiresAt: input.expiresAt === undefined ? current.expiresAt : normalizeExpiry(input.expiresAt),
      disabledAt,
      updatedAt: timestamp(),
    });
    store.writeAudit?.({
      actor,
      action: "agent-token.update",
      targetType: "agent-token",
      targetId: id,
      payload: { name: updated.name, scopes: updated.scopes, expiresAt: updated.expiresAt, disabledAt: updated.disabledAt },
    });
    return safeRecord(updated);
  }

  function revoke(id, { actor = "system" } = {}) {
    const current = store.getAgentTokenRecord(id);
    if (!current) return null;
    if (current.revokedAt) return safeRecord(current);
    const revoked = store.updateAgentTokenRecord(id, {
      revokedAt: timestamp(),
      disabledAt: current.disabledAt || timestamp(),
      updatedAt: timestamp(),
    });
    store.writeAudit?.({ actor, action: "agent-token.revoke", targetType: "agent-token", targetId: id });
    return safeRecord(revoked);
  }

  function verify(token, metadata = {}) {
    if (!token) return null;
    const candidateHash = hashAgentToken(token);
    const record = store.findAgentTokenByHash(candidateHash);
    if (!record || !hashesEqual(candidateHash, record.tokenHash)) return null;
    const now = new Date(clock());
    if (record.revokedAt || record.disabledAt || (record.expiresAt && new Date(record.expiresAt) <= now)) return null;
    return safeRecord(store.touchAgentTokenRecord(record.id, {
      lastUsedAt: now.toISOString(),
      lastUsedIp: metadata.ip || null,
      updatedAt: now.toISOString(),
    }));
  }

  return Object.freeze({ list, create, update, revoke, verify, hasScopes: hasAgentScopes });
}
