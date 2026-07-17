import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

import { createAuditLogger } from "./audit.js";

const require = createRequire(import.meta.url);
const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const CONTROL_TYPES = new Set(["systemd", "docker", "launchd", "none"]);
const HOST_MODES = new Set(["local", "ssh"]);
const PRIVATE_HOST_KEYS = /(?:authorization|credential|password|passphrase|private.?key|secret|token)/i;

const MIGRATIONS = Object.freeze([
  {
    version: 1,
    sql: `
      CREATE TABLE hosts (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        mode TEXT NOT NULL DEFAULT 'local' CHECK (mode IN ('local', 'ssh')),
        target TEXT,
        port INTEGER CHECK (port IS NULL OR (port >= 1 AND port <= 65535)),
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        sort_order INTEGER NOT NULL DEFAULT 0,
        metadata_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE service_groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        sort_order INTEGER NOT NULL DEFAULT 0,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE services (
        id TEXT PRIMARY KEY,
        host_id TEXT NOT NULL REFERENCES hosts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        group_id TEXT NOT NULL REFERENCES service_groups(id) ON UPDATE CASCADE ON DELETE RESTRICT,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        url TEXT,
        category TEXT NOT NULL DEFAULT 'app',
        enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
        sort_order INTEGER NOT NULL DEFAULT 0,
        repository_url TEXT,
        control_json TEXT,
        update_json TEXT,
        location_json TEXT,
        health_json TEXT,
        backup_json TEXT,
        agent_json TEXT,
        extra_json TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        deleted_at TEXT
      );

      CREATE TABLE service_relations (
        service_id TEXT NOT NULL REFERENCES services(id) ON UPDATE CASCADE ON DELETE CASCADE,
        related_service_id TEXT NOT NULL REFERENCES services(id) ON UPDATE CASCADE ON DELETE CASCADE,
        created_at TEXT NOT NULL,
        PRIMARY KEY (service_id, related_service_id),
        CHECK (service_id <> related_service_id)
      );

      CREATE TABLE audit_logs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        actor TEXT NOT NULL,
        action TEXT NOT NULL,
        target_type TEXT,
        target_id TEXT,
        result TEXT NOT NULL DEFAULT 'success',
        payload_json TEXT NOT NULL DEFAULT '{}',
        created_at TEXT NOT NULL
      );

      CREATE TABLE agent_tokens (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        token_prefix TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        expires_at TEXT,
        disabled_at TEXT,
        revoked_at TEXT,
        created_by TEXT,
        last_used_at TEXT,
        last_used_ip TEXT
      );

      CREATE TABLE service_update_cache (
        service_id TEXT PRIMARY KEY REFERENCES services(id) ON UPDATE CASCADE ON DELETE CASCADE,
        status_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX idx_services_host_id ON services(host_id);
      CREATE INDEX idx_services_group_id ON services(group_id);
      CREATE INDEX idx_services_deleted_at ON services(deleted_at);
      CREATE INDEX idx_relations_related_id ON service_relations(related_service_id);
      CREATE INDEX idx_audit_target ON audit_logs(target_type, target_id, id DESC);
      CREATE INDEX idx_agent_tokens_hash ON agent_tokens(token_hash);
    `,
  },
]);

function loadDatabaseConstructor() {
  try {
    return require("better-sqlite3");
  } catch (error) {
    const wrapped = new Error("better-sqlite3 is required to create the service store");
    wrapped.cause = error;
    throw wrapped;
  }
}

function asIso(value) {
  return new Date(value).toISOString();
}

function parseJson(value, fallback = null) {
  if (!value) return fallback;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function json(value) {
  return value === undefined || value === null ? null : JSON.stringify(value);
}

function integer(value, fallback = 0) {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : fallback;
}

function optionalPort(value) {
  if (value === undefined || value === null || value === "") return null;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new TypeError("host port must be an integer from 1 to 65535");
  return port;
}

function requiredId(value, label) {
  const id = String(value || "").trim();
  if (!ID_PATTERN.test(id)) throw new TypeError(`${label} must match ${ID_PATTERN}`);
  return id;
}

function requiredText(value, label, maximum = 160) {
  const text = String(value || "").trim();
  if (!text) throw new TypeError(`${label} is required`);
  if (text.length > maximum) throw new TypeError(`${label} must be at most ${maximum} characters`);
  return text;
}

function optionalText(value, maximum = 2_000) {
  const text = String(value || "").trim();
  if (text.length > maximum) throw new TypeError(`text must be at most ${maximum} characters`);
  return text;
}

function optionalHttpUrl(value, label) {
  if (value === undefined || value === null || value === "") return null;
  let url;
  try {
    url = new URL(String(value));
  } catch {
    throw new TypeError(`${label} must be a valid URL`);
  }
  if (!new Set(["http:", "https:"]).has(url.protocol)) throw new TypeError(`${label} must use http or https`);
  if (url.username || url.password) throw new TypeError(`${label} must not contain credentials`);
  return url.toString();
}

function rejectHostSecrets(value, trail = "host") {
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (PRIVATE_HOST_KEYS.test(key)) throw new TypeError(`${trail}.${key} must not store credentials`);
    rejectHostSecrets(child, `${trail}.${key}`);
  }
}

function migrate(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      applied_at TEXT NOT NULL
    );
  `);
  const current = db.prepare("SELECT COALESCE(MAX(version), 0) AS version FROM schema_migrations").get().version;
  for (const migration of MIGRATIONS) {
    if (migration.version <= current) continue;
    db.transaction(() => {
      db.exec(migration.sql);
      db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)")
        .run(migration.version, new Date().toISOString());
      db.pragma(`user_version = ${migration.version}`);
    })();
  }
}

function normalizeHost(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    mode: row.mode,
    target: row.target || null,
    port: row.port || null,
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    metadata: parseJson(row.metadata_json, {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeGroup(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    description: row.description || "",
    sortOrder: row.sort_order,
    serviceCount: Number(row.service_count || 0),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function normalizeService(row, relations = []) {
  if (!row) return null;
  return {
    id: row.id,
    hostId: row.host_id,
    groupId: row.group_id,
    name: row.name,
    description: row.description || "",
    url: row.url || null,
    category: row.category,
    enabled: row.enabled === 1,
    sortOrder: row.sort_order,
    repositoryUrl: row.repository_url || null,
    control: parseJson(row.control_json),
    update: parseJson(row.update_json),
    location: parseJson(row.location_json),
    health: parseJson(row.health_json),
    backup: parseJson(row.backup_json),
    agent: parseJson(row.agent_json),
    extra: parseJson(row.extra_json),
    related: relations,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    deletedAt: row.deleted_at || null,
  };
}

export function toAdminHostDto(host) {
  return host ? { ...host, metadata: structuredClone(host.metadata || {}) } : null;
}

export function toPublicHostDto(host) {
  if (!host) return null;
  const { id, name, description, enabled, sortOrder } = host;
  return { id, name, description, enabled, sortOrder };
}

export function toAdminServiceDto(service) {
  return service ? structuredClone(service) : null;
}

function publicUpdate(update) {
  if (!update || typeof update !== "object") return null;
  const result = {};
  if (update.current && typeof update.current === "object") {
    result.current = {
      version: update.current.version || null,
      checkedAt: update.current.checkedAt || null,
    };
  }
  if (update.latest && typeof update.latest === "object") result.latest = { version: update.latest.version || null };
  if (update.source && typeof update.source === "object") {
    result.source = { type: update.source.type || null, label: update.source.label || null };
  }
  return Object.keys(result).length ? result : null;
}

export function toPublicServiceDto(service) {
  if (!service) return null;
  return {
    id: service.id,
    hostId: service.hostId,
    groupId: service.groupId,
    name: service.name,
    description: service.description,
    url: service.url,
    category: service.category,
    enabled: service.enabled,
    sortOrder: service.sortOrder,
    repositoryUrl: service.repositoryUrl,
    update: publicUpdate(service.update),
    related: [...service.related],
    deletedAt: service.deletedAt,
  };
}

function normalizeToken(row) {
  if (!row) return null;
  return {
    id: row.id,
    name: row.name,
    tokenHash: row.token_hash,
    tokenPrefix: row.token_prefix,
    scopes: parseJson(row.scopes_json, []),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    expiresAt: row.expires_at || null,
    disabledAt: row.disabled_at || null,
    revokedAt: row.revoked_at || null,
    createdBy: row.created_by || null,
    lastUsedAt: row.last_used_at || null,
    lastUsedIp: row.last_used_ip || null,
  };
}

export function createServiceStore({ dbPath = ":memory:", Database, clock = Date.now } = {}) {
  if (dbPath !== ":memory:") fs.mkdirSync(path.dirname(path.resolve(dbPath)), { recursive: true });
  const DatabaseConstructor = Database || loadDatabaseConstructor();
  const db = typeof DatabaseConstructor === "function" ? new DatabaseConstructor(dbPath) : DatabaseConstructor;
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  migrate(db);
  const audit = createAuditLogger(db, { clock });
  const timestamp = () => asIso(clock());

  const groupSelect = `
    SELECT g.*, COUNT(s.id) AS service_count
    FROM service_groups g
    LEFT JOIN services s ON s.group_id = g.id
    GROUP BY g.id
  `;

  function listHosts({ visibility = "admin" } = {}) {
    const mapper = visibility === "public" ? toPublicHostDto : toAdminHostDto;
    return db.prepare("SELECT * FROM hosts ORDER BY sort_order, id").all().map(normalizeHost).map(mapper);
  }

  function getHost(id, { visibility = "admin" } = {}) {
    const host = normalizeHost(db.prepare("SELECT * FROM hosts WHERE id = ?").get(String(id || "")));
    return visibility === "public" ? toPublicHostDto(host) : toAdminHostDto(host);
  }

  function createHost(input = {}, { actor = "system" } = {}) {
    rejectHostSecrets(input);
    const id = requiredId(input.id, "host id");
    const mode = input.mode || "local";
    if (!HOST_MODES.has(mode)) throw new TypeError("host mode must be local or ssh");
    const target = input.target ? String(input.target).trim() : null;
    if (mode === "ssh" && !target) throw new TypeError("SSH host target is required");
    const now = timestamp();
    db.prepare(`
      INSERT INTO hosts (id, name, description, mode, target, port, enabled, sort_order, metadata_json, created_at, updated_at)
      VALUES (@id, @name, @description, @mode, @target, @port, @enabled, @sort_order, @metadata_json, @created_at, @updated_at)
    `).run({
      id,
      name: requiredText(input.name, "host name"),
      description: optionalText(input.description),
      mode,
      target,
      port: optionalPort(input.port),
      enabled: input.enabled === false ? 0 : 1,
      sort_order: integer(input.sortOrder),
      metadata_json: json(input.metadata || {}),
      created_at: now,
      updated_at: now,
    });
    audit.write({ actor, action: "host.create", targetType: "host", targetId: id, payload: { host: input } });
    return getHost(id);
  }

  function updateHost(id, input = {}, { actor = "system" } = {}) {
    const current = getHost(id);
    if (!current) return null;
    rejectHostSecrets(input);
    const nextId = input.id === undefined ? current.id : requiredId(input.id, "host id");
    const mode = input.mode === undefined ? current.mode : input.mode;
    if (!HOST_MODES.has(mode)) throw new TypeError("host mode must be local or ssh");
    const target = input.target === undefined ? current.target : String(input.target || "").trim() || null;
    if (mode === "ssh" && !target) throw new TypeError("SSH host target is required");
    db.prepare(`
      UPDATE hosts SET id=@next_id, name=@name, description=@description, mode=@mode, target=@target,
        port=@port, enabled=@enabled, sort_order=@sort_order, metadata_json=@metadata_json, updated_at=@updated_at
      WHERE id=@current_id
    `).run({
      current_id: current.id,
      next_id: nextId,
      name: input.name === undefined ? current.name : requiredText(input.name, "host name"),
      description: input.description === undefined ? current.description : optionalText(input.description),
      mode,
      target,
      port: input.port === undefined ? current.port : optionalPort(input.port),
      enabled: (input.enabled === undefined ? current.enabled : input.enabled) ? 1 : 0,
      sort_order: input.sortOrder === undefined ? current.sortOrder : integer(input.sortOrder),
      metadata_json: json(input.metadata === undefined ? current.metadata : input.metadata),
      updated_at: timestamp(),
    });
    audit.write({ actor, action: nextId === current.id ? "host.update" : "host.rename", targetType: "host", targetId: nextId, payload: { from: current.id, host: input } });
    return getHost(nextId);
  }

  function deleteHost(id, { actor = "system" } = {}) {
    const current = getHost(id);
    if (!current) return false;
    const count = db.prepare("SELECT COUNT(*) AS count FROM services WHERE host_id = ?").get(current.id).count;
    if (count) throw new Error("host is still referenced by services");
    db.prepare("DELETE FROM hosts WHERE id = ?").run(current.id);
    audit.write({ actor, action: "host.delete", targetType: "host", targetId: current.id, payload: { name: current.name } });
    return true;
  }

  function listGroups() {
    return db.prepare(`${groupSelect} ORDER BY g.sort_order, g.id`).all().map(normalizeGroup);
  }

  function getGroup(id) {
    return normalizeGroup(db.prepare(`${groupSelect} HAVING g.id = ?`).get(String(id || "")));
  }

  function createGroup(input = {}, { actor = "system" } = {}) {
    const id = requiredId(input.id, "group id");
    const now = timestamp();
    db.prepare("INSERT INTO service_groups (id, name, description, sort_order, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
      .run(id, requiredText(input.name, "group name"), optionalText(input.description), integer(input.sortOrder), now, now);
    audit.write({ actor, action: "group.create", targetType: "group", targetId: id, payload: { group: input } });
    return getGroup(id);
  }

  function updateGroup(id, input = {}, { actor = "system" } = {}) {
    const current = getGroup(id);
    if (!current) return null;
    const nextId = input.id === undefined ? current.id : requiredId(input.id, "group id");
    db.prepare(`
      UPDATE service_groups SET id=?, name=?, description=?, sort_order=?, updated_at=? WHERE id=?
    `).run(
      nextId,
      input.name === undefined ? current.name : requiredText(input.name, "group name"),
      input.description === undefined ? current.description : optionalText(input.description),
      input.sortOrder === undefined ? current.sortOrder : integer(input.sortOrder),
      timestamp(),
      current.id,
    );
    audit.write({ actor, action: nextId === current.id ? "group.update" : "group.rename", targetType: "group", targetId: nextId, payload: { from: current.id, group: input } });
    return getGroup(nextId);
  }

  function deleteGroup(id, { replacementGroup, actor = "system" } = {}) {
    const current = getGroup(id);
    if (!current) return false;
    if (current.serviceCount) {
      if (!replacementGroup || replacementGroup === current.id || !getGroup(replacementGroup)) {
        throw new Error("a different existing replacementGroup is required for a non-empty group");
      }
    }
    db.transaction(() => {
      if (current.serviceCount) db.prepare("UPDATE services SET group_id = ?, updated_at = ? WHERE group_id = ?").run(replacementGroup, timestamp(), current.id);
      db.prepare("DELETE FROM service_groups WHERE id = ?").run(current.id);
      audit.write({ actor, action: "group.delete", targetType: "group", targetId: current.id, payload: { replacementGroup: replacementGroup || null } });
    })();
    return true;
  }

  function relationIds(serviceId) {
    return db.prepare("SELECT related_service_id FROM service_relations WHERE service_id = ? ORDER BY related_service_id")
      .all(serviceId).map((row) => row.related_service_id);
  }

  function rawService(id, { includeDeleted = false } = {}) {
    const row = db.prepare(`SELECT * FROM services WHERE id = ? ${includeDeleted ? "" : "AND deleted_at IS NULL"}`).get(String(id || ""));
    return row ? normalizeService(row, relationIds(row.id)) : null;
  }

  function getService(id, { includeDeleted = false, visibility = "admin" } = {}) {
    const service = rawService(id, { includeDeleted });
    return visibility === "public" ? toPublicServiceDto(service) : toAdminServiceDto(service);
  }

  function listServices({ includeDeleted = false, visibility = "admin" } = {}) {
    const rows = db.prepare(`SELECT * FROM services ${includeDeleted ? "" : "WHERE deleted_at IS NULL"} ORDER BY sort_order, id`).all();
    const mapper = visibility === "public" ? toPublicServiceDto : toAdminServiceDto;
    return rows.map((row) => normalizeService(row, relationIds(row.id))).map(mapper);
  }

  function validateRelations(serviceId, related = []) {
    if (!Array.isArray(related)) throw new TypeError("related must be an array");
    const unique = [...new Set(related.map((id) => requiredId(id, "related service id")))];
    if (unique.includes(serviceId)) throw new TypeError("a service cannot relate to itself");
    for (const id of unique) {
      if (!rawService(id)) throw new Error(`related service does not exist or is deleted: ${id}`);
    }
    return unique;
  }

  function serviceInput(input, current = null) {
    const id = current?.id || requiredId(input.id, "service id");
    const hostId = requiredId(input.hostId ?? input.host ?? current?.hostId, "service host id");
    const groupId = requiredId(input.groupId ?? input.group ?? current?.groupId, "service group id");
    if (!getHost(hostId)) throw new Error(`unknown host: ${hostId}`);
    if (!getGroup(groupId)) throw new Error(`unknown group: ${groupId}`);
    const control = input.control === undefined ? current?.control ?? null : input.control;
    if (control?.type && !CONTROL_TYPES.has(control.type)) throw new TypeError("unsupported control type");
    if (control?.type && control.type !== "none" && !control.name) throw new TypeError("control.name is required");
    return {
      id,
      host_id: hostId,
      group_id: groupId,
      name: input.name === undefined && current ? current.name : requiredText(input.name, "service name"),
      description: input.description === undefined && current ? current.description : optionalText(input.description),
      url: input.url === undefined && current ? current.url : optionalHttpUrl(input.url, "service url"),
      category: input.category === undefined && current ? current.category : requiredText(input.category || "app", "service category", 80),
      enabled: (input.enabled === undefined && current ? current.enabled : input.enabled !== false) ? 1 : 0,
      sort_order: input.sortOrder === undefined && current ? current.sortOrder : integer(input.sortOrder),
      repository_url: input.repositoryUrl === undefined && current ? current.repositoryUrl : optionalHttpUrl(input.repositoryUrl, "repository URL"),
      control_json: json(control),
      update_json: json(input.update === undefined ? current?.update : input.update),
      location_json: json(input.location === undefined ? current?.location : input.location),
      health_json: json(input.health === undefined ? current?.health : input.health),
      backup_json: json(input.backup === undefined ? current?.backup : input.backup),
      agent_json: json(input.agent === undefined ? current?.agent : input.agent),
      extra_json: json(input.extra === undefined ? current?.extra : input.extra),
    };
  }

  function replaceRelations(serviceId, related) {
    db.prepare("DELETE FROM service_relations WHERE service_id = ?").run(serviceId);
    const insert = db.prepare("INSERT INTO service_relations (service_id, related_service_id, created_at) VALUES (?, ?, ?)");
    for (const relatedId of related) insert.run(serviceId, relatedId, timestamp());
  }

  function createService(input = {}, { actor = "system" } = {}) {
    const record = serviceInput(input);
    if (rawService(record.id, { includeDeleted: true })) throw new Error("service id already exists, including soft-deleted records");
    const related = validateRelations(record.id, input.related || []);
    const now = timestamp();
    db.transaction(() => {
      db.prepare(`
        INSERT INTO services (
          id, host_id, group_id, name, description, url, category, enabled, sort_order, repository_url,
          control_json, update_json, location_json, health_json, backup_json, agent_json, extra_json,
          created_at, updated_at, deleted_at
        ) VALUES (
          @id, @host_id, @group_id, @name, @description, @url, @category, @enabled, @sort_order, @repository_url,
          @control_json, @update_json, @location_json, @health_json, @backup_json, @agent_json, @extra_json,
          @created_at, @updated_at, NULL
        )
      `).run({ ...record, created_at: now, updated_at: now });
      replaceRelations(record.id, related);
      audit.write({ actor, action: "service.create", targetType: "service", targetId: record.id, payload: { service: input } });
    })();
    return getService(record.id, { includeDeleted: true });
  }

  function updateService(id, input = {}, { actor = "system" } = {}) {
    const current = rawService(id, { includeDeleted: true });
    if (!current) return null;
    if (input.id !== undefined && input.id !== current.id) throw new TypeError("service id cannot be changed");
    const record = serviceInput(input, current);
    const related = validateRelations(current.id, input.related === undefined ? current.related : input.related);
    db.transaction(() => {
      db.prepare(`
        UPDATE services SET host_id=@host_id, group_id=@group_id, name=@name, description=@description,
          url=@url, category=@category, enabled=@enabled, sort_order=@sort_order, repository_url=@repository_url,
          control_json=@control_json, update_json=@update_json, location_json=@location_json, health_json=@health_json,
          backup_json=@backup_json, agent_json=@agent_json, extra_json=@extra_json, updated_at=@updated_at
        WHERE id=@id
      `).run({ ...record, updated_at: timestamp() });
      replaceRelations(current.id, related);
      audit.write({ actor, action: "service.update", targetType: "service", targetId: current.id, payload: { service: input } });
    })();
    return getService(current.id, { includeDeleted: true });
  }

  function softDeleteService(id, { actor = "system" } = {}) {
    const current = rawService(id, { includeDeleted: true });
    if (!current) return null;
    if (!current.deletedAt) {
      const now = timestamp();
      db.prepare("UPDATE services SET deleted_at = ?, updated_at = ? WHERE id = ?").run(now, now, current.id);
      audit.write({ actor, action: "service.delete", targetType: "service", targetId: current.id, payload: { hard: false } });
    }
    return getService(current.id, { includeDeleted: true });
  }

  function restoreService(id, { actor = "system" } = {}) {
    const current = rawService(id, { includeDeleted: true });
    if (!current) return null;
    db.prepare("UPDATE services SET deleted_at = NULL, enabled = 1, updated_at = ? WHERE id = ?").run(timestamp(), current.id);
    audit.write({ actor, action: "service.restore", targetType: "service", targetId: current.id });
    return getService(current.id, { includeDeleted: true });
  }

  function purgeService(id, { actor = "system" } = {}) {
    const current = rawService(id, { includeDeleted: true });
    if (!current) return null;
    db.transaction(() => {
      db.prepare("DELETE FROM services WHERE id = ?").run(current.id);
      audit.write({ actor, action: "service.purge", targetType: "service", targetId: current.id, payload: { hard: true } });
    })();
    return toAdminServiceDto(current);
  }

  function listAgentTokenRecords() {
    return db.prepare("SELECT * FROM agent_tokens ORDER BY created_at DESC, id DESC").all().map(normalizeToken);
  }

  function getAgentTokenRecord(id) {
    return normalizeToken(db.prepare("SELECT * FROM agent_tokens WHERE id = ?").get(String(id || "")));
  }

  function findAgentTokenByHash(tokenHash) {
    return normalizeToken(db.prepare("SELECT * FROM agent_tokens WHERE token_hash = ?").get(String(tokenHash || "")));
  }

  function createAgentTokenRecord(record) {
    db.prepare(`
      INSERT INTO agent_tokens (
        id, name, token_hash, token_prefix, scopes_json, created_at, updated_at, expires_at,
        disabled_at, revoked_at, created_by, last_used_at, last_used_ip
      ) VALUES (
        @id, @name, @token_hash, @token_prefix, @scopes_json, @created_at, @updated_at, @expires_at,
        @disabled_at, @revoked_at, @created_by, @last_used_at, @last_used_ip
      )
    `).run({
      id: record.id,
      name: requiredText(record.name, "token name"),
      token_hash: record.tokenHash,
      token_prefix: record.tokenPrefix,
      scopes_json: json(record.scopes || []),
      created_at: record.createdAt || timestamp(),
      updated_at: record.updatedAt || record.createdAt || timestamp(),
      expires_at: record.expiresAt || null,
      disabled_at: record.disabledAt || null,
      revoked_at: record.revokedAt || null,
      created_by: record.createdBy || null,
      last_used_at: record.lastUsedAt || null,
      last_used_ip: record.lastUsedIp || null,
    });
    return getAgentTokenRecord(record.id);
  }

  function updateAgentTokenRecord(id, input = {}) {
    const current = getAgentTokenRecord(id);
    if (!current) return null;
    const next = { ...current, ...input };
    db.prepare(`
      UPDATE agent_tokens SET name=@name, scopes_json=@scopes_json, updated_at=@updated_at, expires_at=@expires_at,
        disabled_at=@disabled_at, revoked_at=@revoked_at, last_used_at=@last_used_at, last_used_ip=@last_used_ip
      WHERE id=@id
    `).run({
      id: current.id,
      name: next.name,
      scopes_json: json(next.scopes || []),
      updated_at: next.updatedAt || timestamp(),
      expires_at: next.expiresAt || null,
      disabled_at: next.disabledAt || null,
      revoked_at: next.revokedAt || null,
      last_used_at: next.lastUsedAt || null,
      last_used_ip: next.lastUsedIp || null,
    });
    return getAgentTokenRecord(current.id);
  }

  function touchAgentTokenRecord(id, metadata = {}) {
    return updateAgentTokenRecord(id, metadata);
  }

  function readUpdateCache(serviceId) {
    if (serviceId) {
      const row = db.prepare("SELECT status_json, updated_at FROM service_update_cache WHERE service_id = ?").get(serviceId);
      return row ? { serviceId, status: parseJson(row.status_json, {}), updatedAt: row.updated_at } : null;
    }
    return db.prepare("SELECT service_id, status_json, updated_at FROM service_update_cache ORDER BY service_id").all()
      .map((row) => ({ serviceId: row.service_id, status: parseJson(row.status_json, {}), updatedAt: row.updated_at }));
  }

  function writeUpdateCache(serviceId, status) {
    if (!rawService(serviceId, { includeDeleted: true })) throw new Error(`unknown service: ${serviceId}`);
    db.prepare(`
      INSERT INTO service_update_cache (service_id, status_json, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(service_id) DO UPDATE SET status_json=excluded.status_json, updated_at=excluded.updated_at
    `).run(serviceId, json(status || {}), timestamp());
    return readUpdateCache(serviceId);
  }

  return Object.freeze({
    db,
    schemaVersion: MIGRATIONS.at(-1).version,
    listHosts,
    getHost,
    createHost,
    updateHost,
    deleteHost,
    listGroups,
    getGroup,
    createGroup,
    updateGroup,
    deleteGroup,
    listServices,
    getService,
    createService,
    updateService,
    softDeleteService,
    restoreService,
    purgeService,
    listAuditLogs: audit.list,
    writeAudit: audit.write,
    listAgentTokenRecords,
    getAgentTokenRecord,
    findAgentTokenByHash,
    createAgentTokenRecord,
    updateAgentTokenRecord,
    touchAgentTokenRecord,
    readUpdateCache,
    writeUpdateCache,
    close: () => db.close(),
  });
}
