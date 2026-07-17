import fs from "node:fs";
import path from "node:path";

import { loadSshHosts } from "./config.js";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SECRET_FIELDS = new Set(["password", "privateKey", "passphrase", "identityFile"]);
const ENV_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

function validateDraft(input = {}) {
  const draft = structuredClone(input);
  const id = String(draft.id || "").trim();
  if (!ID_PATTERN.test(id)) throw new TypeError(`SSH host.id must match ${ID_PATTERN}`);
  draft.id = id;
  draft.backend = draft.backend || "openssh";
  if (!new Set(["local", "openssh", "ssh2"]).has(draft.backend)) throw new TypeError("SSH host.backend is unsupported");
  for (const field of SECRET_FIELDS) {
    if (draft[field] !== undefined) throw new TypeError(`SSH host.${field} must use ${field}FromEnv`);
    const reference = draft[`${field}FromEnv`];
    if (reference !== undefined && !ENV_PATTERN.test(String(reference))) throw new TypeError(`SSH host.${field}FromEnv must be an environment variable name`);
  }
  if (draft.backend === "openssh" && !String(draft.target || "").trim()) throw new TypeError("SSH host.target is required");
  if (draft.backend === "ssh2" && (!String(draft.host || "").trim() || !String(draft.username || "").trim())) {
    throw new TypeError("SSH host.host and SSH host.username are required");
  }
  if (draft.port !== undefined) {
    draft.port = Number(draft.port);
    if (!Number.isInteger(draft.port) || draft.port < 1 || draft.port > 65_535) throw new TypeError("SSH host.port must be between 1 and 65535");
  }
  const policy = draft.commandPolicy || { enabled: false };
  if (typeof policy.enabled !== "boolean") throw new TypeError("SSH host.commandPolicy.enabled must be a boolean");
  for (const key of ["prefixes", "patterns"]) {
    if (policy[key] !== undefined && (!Array.isArray(policy[key]) || policy[key].some((item) => typeof item !== "string" || !item.trim()))) {
      throw new TypeError(`SSH host.commandPolicy.${key} must be an array of non-empty strings`);
    }
  }
  draft.commandPolicy = policy;
  return draft;
}

function safeHost(host) {
  return {
    id: host.id,
    description: host.description || "",
    backend: host.backend || "openssh",
    target: host.backend === "openssh" ? host.target : undefined,
    host: host.backend === "ssh2" ? host.host : undefined,
    port: host.port,
    username: host.backend === "ssh2" ? host.username : undefined,
    credentialReferences: Object.fromEntries([...SECRET_FIELDS].flatMap((field) => host[`${field}FromEnv`] ? [[field, host[`${field}FromEnv`]]] : [])),
    commandPolicy: host.commandPolicy,
  };
}

function readDocument(filePath) {
  try {
    const value = JSON.parse(fs.readFileSync(filePath, "utf8"));
    if (!value || typeof value !== "object" || !Array.isArray(value.hosts)) throw new TypeError("SSH configuration must contain a hosts array");
    return value;
  } catch (error) {
    if (error.code === "ENOENT") return { hosts: [] };
    throw error;
  }
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600, flag: "wx" });
    fs.chmodSync(temporary, 0o600);
    fs.renameSync(temporary, filePath);
    fs.chmodSync(filePath, 0o600);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) { if (error.code !== "ENOENT") throw error; }
  }
}

export function createSshHostRegistry({ filePath, env = process.env } = {}) {
  const resolvedPath = filePath ? path.resolve(filePath) : "";
  const requirePath = () => {
    if (!resolvedPath) throw new Error("OPS_SSH_HOSTS_PATH is required for SSH host registry writes");
    return resolvedPath;
  };
  const list = () => resolvedPath ? loadSshHosts(resolvedPath, env) : [];
  return Object.freeze({
    path: resolvedPath,
    list,
    safeList: () => list().map(safeHost),
    plan: (input) => ({ valid: true, host: safeHost(validateDraft(input)) }),
    upsert(input) {
      const draft = validateDraft(input);
      for (const field of SECRET_FIELDS) {
        const reference = draft[`${field}FromEnv`];
        if (reference && !env[reference]) throw new Error(`Missing environment variable: ${reference}`);
      }
      const document = readDocument(requirePath());
      const index = document.hosts.findIndex((host) => host.id === draft.id);
      if (index === -1) document.hosts.push(draft); else document.hosts[index] = draft;
      document.hosts.sort((left, right) => left.id.localeCompare(right.id));
      atomicWrite(resolvedPath, document);
      return safeHost(list().find((host) => host.id === draft.id));
    },
    delete(id) {
      const hostId = String(id || "").trim();
      if (!ID_PATTERN.test(hostId)) throw new TypeError(`SSH host.id must match ${ID_PATTERN}`);
      const document = readDocument(requirePath());
      const before = document.hosts.length;
      document.hosts = document.hosts.filter((host) => host.id !== hostId);
      atomicWrite(resolvedPath, document);
      return { id: hostId, deleted: document.hosts.length !== before };
    },
  });
}
