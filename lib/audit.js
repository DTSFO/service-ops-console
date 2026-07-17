const DEFAULT_ACTOR = "system";
const MAX_DEPTH = 8;
const MAX_ARRAY_ITEMS = 100;
const MAX_STRING_LENGTH = 4_096;

const SECRET_KEY = /(?:authorization|cookie|credential|password|passphrase|private.?key|session|secret|token)/i;
const INFRASTRUCTURE_KEY = /(?:command|header|host(?:name)?|identity.?file|path|target|url)/i;

function nowIso(clock) {
  return new Date(clock()).toISOString();
}

function redact(value, key, depth, seen) {
  if (SECRET_KEY.test(key) || INFRASTRUCTURE_KEY.test(key)) return "[REDACTED]";
  if (value === null || value === undefined || typeof value === "boolean" || typeof value === "number") return value;
  if (typeof value === "string") return value.length <= MAX_STRING_LENGTH ? value : `${value.slice(0, MAX_STRING_LENGTH)}…`;
  if (typeof value === "bigint") return value.toString();
  if (typeof value !== "object") return String(value);
  if (depth >= MAX_DEPTH) return "[MAX_DEPTH]";
  if (seen.has(value)) return "[CIRCULAR]";

  seen.add(value);
  if (Array.isArray(value)) {
    const result = value.slice(0, MAX_ARRAY_ITEMS).map((item) => redact(item, "", depth + 1, seen));
    if (value.length > MAX_ARRAY_ITEMS) result.push(`[${value.length - MAX_ARRAY_ITEMS} MORE ITEMS]`);
    seen.delete(value);
    return result;
  }

  const result = {};
  for (const [childKey, childValue] of Object.entries(value)) {
    result[childKey] = redact(childValue, childKey, depth + 1, seen);
  }
  seen.delete(value);
  return result;
}

export function redactAuditPayload(payload) {
  return redact(payload ?? {}, "", 0, new WeakSet());
}

function parsePayload(value) {
  if (!value) return {};
  try {
    return JSON.parse(value);
  } catch {
    return {};
  }
}

export function createAuditLogger(db, { clock = Date.now } = {}) {
  const insert = db.prepare(`
    INSERT INTO audit_logs (
      actor, action, target_type, target_id, result, payload_json, created_at
    ) VALUES (
      @actor, @action, @target_type, @target_id, @result, @payload_json, @created_at
    )
  `);

  function write({ actor = DEFAULT_ACTOR, action, targetType = null, targetId = null, result = "success", payload = {} }) {
    if (!action || typeof action !== "string") throw new TypeError("audit action is required");
    const record = {
      actor: String(actor || DEFAULT_ACTOR).slice(0, 160),
      action: action.slice(0, 160),
      target_type: targetType ? String(targetType).slice(0, 80) : null,
      target_id: targetId ? String(targetId).slice(0, 160) : null,
      result: String(result || "success").slice(0, 40),
      payload_json: JSON.stringify(redactAuditPayload(payload)),
      created_at: nowIso(clock),
    };
    const info = insert.run(record);
    return { id: Number(info.lastInsertRowid), ...record, payload: parsePayload(record.payload_json) };
  }

  function list({ limit = 100, targetType, targetId } = {}) {
    const boundedLimit = Math.max(1, Math.min(Number(limit) || 100, 500));
    const clauses = [];
    const parameters = {};
    if (targetType) {
      clauses.push("target_type = @target_type");
      parameters.target_type = String(targetType);
    }
    if (targetId) {
      clauses.push("target_id = @target_id");
      parameters.target_id = String(targetId);
    }
    parameters.limit = boundedLimit;
    const rows = db.prepare(`
      SELECT id, actor, action, target_type, target_id, result, payload_json, created_at
      FROM audit_logs
      ${clauses.length ? `WHERE ${clauses.join(" AND ")}` : ""}
      ORDER BY id DESC
      LIMIT @limit
    `).all(parameters);
    return rows.map((row) => ({
      id: row.id,
      actor: row.actor,
      action: row.action,
      targetType: row.target_type,
      targetId: row.target_id,
      result: row.result,
      payload: parsePayload(row.payload_json),
      createdAt: row.created_at,
    }));
  }

  return Object.freeze({ write, list });
}
