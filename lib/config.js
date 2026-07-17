import { readFileSync } from "node:fs";
import path from "node:path";

const ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,63}$/;
const CONTROL_TYPES = new Set(["none", "systemd", "docker", "launchd"]);
const HOST_MODES = new Set(["local", "ssh"]);
const HTTP_METHODS = new Set(["GET", "HEAD"]);

function requiredString(value, label) {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} is required`);
  return value.trim();
}

function optionalString(value, label) {
  if (value === undefined || value === null || value === "") return undefined;
  return requiredString(value, label);
}

function validateId(value, label) {
  const id = requiredString(value, label);
  if (!ID_PATTERN.test(id)) throw new Error(`${label} must match ${ID_PATTERN}`);
  return id;
}

function validateUnique(items, label) {
  const ids = new Set();
  for (const item of items) {
    const id = validateId(item?.id, `${label}.id`);
    if (ids.has(id)) throw new Error(`${label} id must be unique: ${id}`);
    ids.add(id);
  }
  return ids;
}

function validateEnvName(value, label) {
  const name = requiredString(value, label);
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`${label} must be an environment variable name`);
  return name;
}

function validateUrl(value, label, { httpsOnly = false } = {}) {
  const parsed = new URL(requiredString(value, label));
  if (httpsOnly ? parsed.protocol !== "https:" : !new Set(["http:", "https:"]).has(parsed.protocol)) {
    throw new Error(`${label} must use ${httpsOnly ? "HTTPS" : "HTTP or HTTPS"}`);
  }
  return parsed.toString();
}

function validateArgv(value, label, { maximumItems = 16, allowSingleTokenString = false } = {}) {
  if (allowSingleTokenString && typeof value === "string" && value && !/[\s\r\n\0;&|`$<>*?()[\]{}]/.test(value)) value = [value];
  if (!Array.isArray(value) || value.length === 0 || value.length > maximumItems) {
    throw new Error(`${label} must be a non-empty argv array with at most ${maximumItems} items`);
  }
  return value.map((item, index) => {
    const token = requiredString(item, `${label}[${index}]`);
    if (token.length > 512 || /[\r\n\0]/.test(token)) throw new Error(`${label}[${index}] is invalid`);
    return token;
  });
}

function validateControl(control, serviceId) {
  if (!control) return { type: "none" };
  if (!CONTROL_TYPES.has(control.type)) throw new Error(`service ${serviceId} has an unsupported control type`);
  if (control.type === "none") return { type: "none" };
  const normalized = { ...control, name: requiredString(control.name, `service ${serviceId} control.name`) };
  if (control.command !== undefined) normalized.command = validateArgv(control.command, `service ${serviceId} control.command`);
  if (control.self !== undefined && typeof control.self !== "boolean") throw new Error(`service ${serviceId} control.self must be a boolean`);
  if (control.selfActionCommand !== undefined) {
    if (control.type !== "systemd") throw new Error(`service ${serviceId} control.selfActionCommand is only supported for systemd`);
    normalized.selfActionCommand = validateArgv(control.selfActionCommand, `service ${serviceId} control.selfActionCommand`);
  }
  if (control.selfSystemctlPath !== undefined) {
    if (control.type !== "systemd") throw new Error(`service ${serviceId} control.selfSystemctlPath is only supported for systemd`);
    normalized.selfSystemctlPath = requiredString(control.selfSystemctlPath, `service ${serviceId} control.selfSystemctlPath`);
  }
  if (control.type === "launchd" && control.plist !== undefined) {
    normalized.plist = requiredString(control.plist, `service ${serviceId} control.plist`);
  }
  return normalized;
}

function validateSingleHealth(health, serviceId, label = `service ${serviceId} health`) {
  if (!health) return undefined;
  if (health.type === "static") return { type: "static", value: optionalString(health.value, `${label}.value`) || "unknown" };
  if (health.type === "command") {
    const timeoutMs = health.timeoutMs === undefined ? 5000 : Number(health.timeoutMs);
    const expectedExitCode = health.expectedExitCode === undefined ? 0 : Number(health.expectedExitCode);
    if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) {
      throw new Error(`${label}.timeoutMs must be between 100 and 30000`);
    }
    if (!Number.isInteger(expectedExitCode) || expectedExitCode < 0 || expectedExitCode > 255) {
      throw new Error(`${label}.expectedExitCode must be between 0 and 255`);
    }
    return {
      type: "command",
      command: validateArgv(health.command, `${label}.command`, { maximumItems: 32, allowSingleTokenString: true }),
      timeoutMs,
      expectedExitCode,
    };
  }
  if (health.type !== "http") throw new Error(`${label}.type must be static, http, or command`);
  const method = String(health.method || "GET").toUpperCase();
  if (!HTTP_METHODS.has(method)) throw new Error(`${label}.method must be GET or HEAD`);
  const timeoutMs = health.timeoutMs === undefined ? 5000 : Number(health.timeoutMs);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30000) {
    throw new Error(`${label}.timeoutMs must be between 100 and 30000`);
  }
  const expectedStatuses = (Array.isArray(health.expectedStatus) ? health.expectedStatus : [health.expectedStatus ?? 200]).map(Number);
  if (!expectedStatuses.length || expectedStatuses.some((status) => !Number.isInteger(status) || status < 100 || status > 599)) {
    throw new Error(`${label}.expectedStatus must be an HTTP status code or array of status codes`);
  }
  const headersFromEnv = {};
  for (const [header, envName] of Object.entries(health.headersFromEnv || {})) {
    new Headers([[header, "validation"]]);
    headersFromEnv[header] = validateEnvName(envName, `${label} header ${header}`);
  }
  return {
    type: "http",
    url: validateUrl(health.url, `${label}.url`),
    method,
    timeoutMs,
    expectedStatus: Array.isArray(health.expectedStatus) ? expectedStatuses : expectedStatuses[0],
    headersFromEnv,
  };
}

function validateHealth(health, serviceId) {
  if (!health) return undefined;
  if (health.type !== "composite") return validateSingleHealth(health, serviceId);
  if (!Array.isArray(health.checks) || health.checks.length === 0 || health.checks.length > 8) {
    throw new Error(`service ${serviceId} composite health requires 1 to 8 checks`);
  }
  return {
    type: "composite",
    includeRuntime: health.includeRuntime !== false,
    checks: health.checks.map((check, index) => validateSingleHealth(check, serviceId, `service ${serviceId} health.checks[${index}]`)),
  };
}

function validateUpdate(update, serviceId) {
  if (!update) return undefined;
  const normalized = structuredClone(update);
  if (normalized.current) {
    const current = normalized.current;
    const type = current.type || "static";
    if (!new Set(["static", "docker-label", "command", "git"]).has(type)) {
      throw new Error(`service ${serviceId} update.current.type must be static, docker-label, command, or git`);
    }
    current.type = type;
    if (type === "docker-label" && current.container !== undefined) current.container = requiredString(current.container, `service ${serviceId} update.current.container`);
    if (type === "command") {
      current.command = validateArgv(current.command, `service ${serviceId} update.current.command`, { maximumItems: 32, allowSingleTokenString: true });
      if (current.timeoutMs !== undefined) {
        current.timeoutMs = Number(current.timeoutMs);
        if (!Number.isInteger(current.timeoutMs) || current.timeoutMs < 100 || current.timeoutMs > 30000) throw new Error(`service ${serviceId} update.current.timeoutMs must be between 100 and 30000`);
      }
      if (current.pattern !== undefined) {
        current.pattern = requiredString(current.pattern, `service ${serviceId} update.current.pattern`);
        if (current.pattern.length > 256) throw new Error(`service ${serviceId} update.current.pattern is too long`);
        new RegExp(current.pattern);
      }
    }
    if (type === "git") {
      current.path = requiredString(current.path, `service ${serviceId} update.current.path`);
      if (current.packagePath !== undefined) current.packagePath = requiredString(current.packagePath, `service ${serviceId} update.current.packagePath`);
    }
  }
  if (normalized.source?.type === "github") {
    normalized.source.repo = requiredString(normalized.source.repo, `service ${serviceId} update.source.repo`);
    if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized.source.repo)) {
      throw new Error(`service ${serviceId} GitHub repo must use owner/repository`);
    }
    const strategy = normalized.source.strategy || "release";
    if (!new Set(["release", "tag", "commit"]).has(strategy)) throw new Error(`service ${serviceId} GitHub strategy must be release, tag, or commit`);
    normalized.source.strategy = strategy;
    if (normalized.source.ref !== undefined) normalized.source.ref = requiredString(normalized.source.ref, `service ${serviceId} update.source.ref`);
    if (normalized.source.branch !== undefined) normalized.source.branch = requiredString(normalized.source.branch, `service ${serviceId} update.source.branch`);
    if (normalized.source.tokenEnv !== undefined) normalized.source.tokenEnv = validateEnvName(normalized.source.tokenEnv, `service ${serviceId} update.source.tokenEnv`);
    if (normalized.source.tagPattern !== undefined) {
      const pattern = requiredString(normalized.source.tagPattern, `service ${serviceId} update.source.tagPattern`);
      if (pattern.length > 256) throw new Error(`service ${serviceId} update.source.tagPattern is too long`);
      new RegExp(pattern);
      normalized.source.tagPattern = pattern;
    }
  }
  if (Array.isArray(normalized.steps)) {
    normalized.steps = normalized.steps.map((step, index) => {
      if (!new Set(["control", "command"]).has(step.type)) throw new Error(`service ${serviceId} update step ${index} has an unsupported type`);
      if (step.type === "control" && !new Set(["start", "stop", "restart"]).has(step.action)) {
        throw new Error(`service ${serviceId} update step ${index} has an invalid control action`);
      }
      if (step.type === "command") {
        requiredString(step.command, `service ${serviceId} update step ${index} command`);
        if (step.allow !== true) throw new Error(`service ${serviceId} command update step ${index} must set allow=true`);
      }
      return step;
    });
  }
  return normalized;
}

export function validateInventory(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new Error("inventory must be an object");
  for (const key of ["hosts", "groups", "services"]) {
    if (!Array.isArray(input[key])) throw new Error(`inventory.${key} must be an array`);
  }
  const hostIds = validateUnique(input.hosts, "host");
  const groupIds = validateUnique(input.groups, "group");
  validateUnique(input.services, "service");

  const hosts = input.hosts.map((host) => {
    const mode = host.control?.mode || "local";
    if (!HOST_MODES.has(mode)) throw new Error(`host ${host.id} control.mode must be local or ssh`);
    if (mode === "ssh" && !host.control?.sshHostId) throw new Error(`host ${host.id} control.sshHostId is required`);
    return {
      id: host.id,
      name: requiredString(host.name, `host ${host.id} name`),
      description: optionalString(host.description, `host ${host.id} description`) || "",
      control: mode === "ssh" ? { mode, sshHostId: validateId(host.control.sshHostId, `host ${host.id} control.sshHostId`) } : { mode },
    };
  });
  const groups = input.groups.map((group) => ({
    id: group.id,
    name: requiredString(group.name, `group ${group.id} name`),
    description: optionalString(group.description, `group ${group.id} description`) || "",
  }));
  const services = input.services.map((service) => {
    if (!hostIds.has(service.host)) throw new Error(`service ${service.id} references unknown host ${service.host}`);
    if (!groupIds.has(service.group)) throw new Error(`service ${service.id} references unknown group ${service.group}`);
    return {
      ...structuredClone(service),
      id: service.id,
      name: requiredString(service.name, `service ${service.id} name`),
      description: optionalString(service.description, `service ${service.id} description`) || "",
      category: optionalString(service.category, `service ${service.id} category`) || "app",
      related: Array.isArray(service.related) ? [...new Set(service.related.map((id) => validateId(id, `service ${service.id} related id`)))] : [],
      control: validateControl(service.control, service.id),
      health: validateHealth(service.health || service.status, service.id),
      update: validateUpdate(service.update, service.id),
      enabled: service.enabled !== false,
    };
  });
  const serviceIds = new Set(services.map((service) => service.id));
  for (const service of services) {
    for (const relatedId of service.related) if (!serviceIds.has(relatedId)) throw new Error(`service ${service.id} references unknown related service ${relatedId}`);
  }
  const tools = Array.isArray(input.tools) ? input.tools.map((tool) => ({
    id: validateId(tool.id, "tool.id"),
    name: requiredString(tool.name, `tool ${tool.id} name`),
    description: optionalString(tool.description, `tool ${tool.id} description`) || "",
    url: tool.url ? validateUrl(tool.url, `tool ${tool.id} url`) : undefined,
  })) : [];
  return { version: Number(input.version || 1), hosts, groups, services, tools };
}

export function loadJsonFile(filePath, { required = true } = {}) {
  if (!filePath) {
    if (required) throw new Error("configuration path is required");
    return null;
  }
  try {
    return JSON.parse(readFileSync(path.resolve(filePath), "utf8"));
  } catch (error) {
    if (!required && error.code === "ENOENT") return null;
    throw error;
  }
}

export function loadInventory(filePath = process.env.OPS_CONFIG_PATH) {
  return validateInventory(loadJsonFile(filePath));
}

function resolveSecretReferences(record, env = process.env) {
  for (const field of ["password", "passphrase", "privateKey", "authorization", "token", "identityFile"]) {
    if (record[field] !== undefined) throw new Error(`${record.id}.${field} must be provided through an environment reference`);
  }
  const resolved = { ...record };
  for (const [field, envField] of [
    ["password", "passwordFromEnv"],
    ["passphrase", "passphraseFromEnv"],
    ["privateKey", "privateKeyFromEnv"],
    ["identityFile", "identityFileFromEnv"],
  ]) {
    if (!record[envField]) continue;
    const envName = validateEnvName(record[envField], `${record.id}.${envField}`);
    if (!env[envName]) throw new Error(`Missing environment variable: ${envName}`);
    resolved[field] = env[envName];
  }
  return resolved;
}

export function loadSshHosts(filePath = process.env.OPS_SSH_HOSTS_PATH, env = process.env) {
  const parsed = loadJsonFile(filePath, { required: false }) || { hosts: [] };
  if (!Array.isArray(parsed.hosts)) throw new Error("SSH configuration must contain a hosts array");
  validateUnique(parsed.hosts, "SSH host");
  return parsed.hosts.map((rawHost) => {
    const host = resolveSecretReferences({ ...rawHost, id: validateId(rawHost.id, "SSH host.id") }, env);
    const backend = host.backend || "openssh";
    if (!new Set(["local", "openssh", "ssh2"]).has(backend)) throw new Error(`${host.id}.backend is unsupported`);
    if (backend === "openssh") host.target = requiredString(host.target, `${host.id}.target`);
    if (backend === "ssh2") {
      host.host = requiredString(host.host, `${host.id}.host`);
      host.username = requiredString(host.username, `${host.id}.username`);
    }
    if (host.port !== undefined) {
      host.port = Number(host.port);
      if (!Number.isInteger(host.port) || host.port < 1 || host.port > 65535) throw new Error(`${host.id}.port must be between 1 and 65535`);
    }
    const commandPolicy = host.commandPolicy || { enabled: false };
    if (commandPolicy.enabled !== true && commandPolicy.enabled !== false) throw new Error(`${host.id}.commandPolicy.enabled must be a boolean`);
    for (const key of ["prefixes", "patterns"]) {
      if (commandPolicy[key] !== undefined && !Array.isArray(commandPolicy[key])) throw new Error(`${host.id}.commandPolicy.${key} must be an array`);
      for (const [index, value] of (commandPolicy[key] || []).entries()) requiredString(value, `${host.id}.commandPolicy.${key}[${index}]`);
    }
    return { ...host, backend, commandPolicy };
  });
}

export function loadCloudflareServers(filePath = process.env.OPS_CLOUDFLARE_SERVERS_PATH) {
  const parsed = loadJsonFile(filePath, { required: false }) || { servers: [] };
  const configDirectory = filePath ? path.dirname(path.resolve(filePath)) : process.cwd();
  if (!Array.isArray(parsed.servers)) throw new Error("Cloudflare configuration must contain a servers array");
  validateUnique(parsed.servers, "Cloudflare server");
  return parsed.servers.map((server) => {
    if (["authorization", "token", "accessToken", "refreshToken", "clientSecret"].some((key) => server[key] !== undefined)) {
      throw new Error(`${server.id} credentials must be provided through authorizationEnv`);
    }
    const oauthConfigured = server.oauthAccessTokenEnv || server.oauthRefreshTokenEnv || server.oauthClientIdEnv || server.oauthClientSecretEnv || server.oauthTokenEndpoint;
    if (server.authorizationEnv && oauthConfigured) throw new Error(`${server.id} must use authorizationEnv or OAuth environment references, not both`);
    if ((server.oauthRefreshTokenEnv || server.oauthClientIdEnv || server.oauthClientSecretEnv || server.oauthTokenEndpoint)
      && (!server.oauthRefreshTokenEnv || !server.oauthClientIdEnv)) {
      throw new Error(`${server.id} OAuth refresh requires oauthRefreshTokenEnv and oauthClientIdEnv`);
    }
    if (server.credentialsPath && server.credentialsPathEnv) {
      throw new Error(`${server.id} must use credentialsPath or credentialsPathEnv, not both`);
    }
    if (server.credentialNames !== undefined && (!Array.isArray(server.credentialNames)
      || server.credentialNames.some((name) => typeof name !== "string" || !name.trim()))) {
      throw new Error(`${server.id}.credentialNames must be an array of non-empty strings`);
    }
    const timeoutMs = server.timeoutMs === undefined ? undefined : Number(server.timeoutMs);
    if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs < 100 || timeoutMs > 30_000)) {
      throw new Error(`${server.id}.timeoutMs must be between 100 and 30000`);
    }
    const maximumResponseBytes = server.maximumResponseBytes === undefined ? undefined : Number(server.maximumResponseBytes);
    if (maximumResponseBytes !== undefined
      && (!Number.isInteger(maximumResponseBytes) || maximumResponseBytes < 1_024 || maximumResponseBytes > 2_097_152)) {
      throw new Error(`${server.id}.maximumResponseBytes must be between 1024 and 2097152`);
    }
    const toolPolicy = {};
    for (const [toolName, access] of Object.entries(server.toolPolicy || {})) {
      if (!toolName || !new Set(["read", "write"]).has(access)) throw new Error(`${server.id}.toolPolicy must classify tools as read or write`);
      toolPolicy[toolName] = access;
    }
    return {
      id: validateId(server.id, "Cloudflare server.id"),
      name: requiredString(server.name, `Cloudflare server ${server.id} name`),
      url: validateUrl(server.url, `Cloudflare server ${server.id} url`, { httpsOnly: true }),
      authorizationEnv: server.authorizationEnv ? validateEnvName(server.authorizationEnv, `${server.id}.authorizationEnv`) : undefined,
      oauthAccessTokenEnv: server.oauthAccessTokenEnv ? validateEnvName(server.oauthAccessTokenEnv, `${server.id}.oauthAccessTokenEnv`) : undefined,
      oauthRefreshTokenEnv: server.oauthRefreshTokenEnv ? validateEnvName(server.oauthRefreshTokenEnv, `${server.id}.oauthRefreshTokenEnv`) : undefined,
      oauthClientIdEnv: server.oauthClientIdEnv ? validateEnvName(server.oauthClientIdEnv, `${server.id}.oauthClientIdEnv`) : undefined,
      oauthClientSecretEnv: server.oauthClientSecretEnv ? validateEnvName(server.oauthClientSecretEnv, `${server.id}.oauthClientSecretEnv`) : undefined,
      oauthTokenEndpoint: server.oauthTokenEndpoint ? validateUrl(server.oauthTokenEndpoint, `${server.id}.oauthTokenEndpoint`, { httpsOnly: true }) : undefined,
      credentialsPath: server.credentialsPath
        ? path.resolve(configDirectory, requiredString(server.credentialsPath, `${server.id}.credentialsPath`))
        : undefined,
      credentialsPathEnv: server.credentialsPathEnv ? validateEnvName(server.credentialsPathEnv, `${server.id}.credentialsPathEnv`) : undefined,
      credentialKey: server.credentialKey ? requiredString(server.credentialKey, `${server.id}.credentialKey`) : undefined,
      credentialNames: (server.credentialNames || []).map((name) => name.trim()),
      protocolVersion: server.protocolVersion ? requiredString(server.protocolVersion, `${server.id}.protocolVersion`) : undefined,
      timeoutMs,
      maximumResponseBytes,
      headersFromEnv: Object.fromEntries(Object.entries(server.headersFromEnv || {}).map(([header, envName]) => {
        new Headers([[header, "validation"]]);
        return [header, validateEnvName(envName, `${server.id}.headersFromEnv.${header}`)];
      })),
      capabilities: { read: server.capabilities?.read !== false, write: server.capabilities?.write === true },
      toolPolicy,
    };
  });
}

export function runtimeConfig(env = process.env) {
  const dataDir = path.resolve(env.OPS_DATA_DIR || ".service-ops-data");
  const privilegedOperations = env.OPS_ENABLE_PRIVILEGED_OPERATIONS === "true";
  const sessionTtlDays = env.OPS_SESSION_TTL_DAYS === undefined ? 30 : Number(env.OPS_SESSION_TTL_DAYS);
  if (!Number.isFinite(sessionTtlDays) || sessionTtlDays <= 0) {
    throw new Error("OPS_SESSION_TTL_DAYS must be a positive number");
  }
  const sessionTtlSeconds = Math.max(1, Math.round(sessionTtlDays * 24 * 60 * 60));
  const sessionRollingValue = String(env.OPS_SESSION_ROLLING ?? "true").trim().toLowerCase();
  if (!new Set(["true", "false"]).has(sessionRollingValue)) {
    throw new Error("OPS_SESSION_ROLLING must be true or false");
  }
  const updateCheckIntervalMs = env.OPS_UPDATE_CHECK_INTERVAL_MS === undefined ? 0 : Number(env.OPS_UPDATE_CHECK_INTERVAL_MS);
  if (!Number.isInteger(updateCheckIntervalMs) || (updateCheckIntervalMs !== 0 && (updateCheckIntervalMs < 60_000 || updateCheckIntervalMs > 7 * 24 * 60 * 60 * 1000))) {
    throw new Error("OPS_UPDATE_CHECK_INTERVAL_MS must be 0 or an integer from 60000 to 604800000");
  }
  const updateCheckDailyTime = String(env.OPS_UPDATE_CHECK_DAILY_TIME || "").trim();
  if (updateCheckDailyTime && !/^(?:[01]\d|2[0-3]):[0-5]\d$/.test(updateCheckDailyTime)) {
    throw new Error("OPS_UPDATE_CHECK_DAILY_TIME must use 24-hour HH:MM format");
  }
  const updateCheckTimezoneOffsetMinutes = env.OPS_UPDATE_CHECK_TIMEZONE_OFFSET_MINUTES === undefined
    ? 480
    : Number(env.OPS_UPDATE_CHECK_TIMEZONE_OFFSET_MINUTES);
  if (!Number.isInteger(updateCheckTimezoneOffsetMinutes) || updateCheckTimezoneOffsetMinutes < -720 || updateCheckTimezoneOffsetMinutes > 840) {
    throw new Error("OPS_UPDATE_CHECK_TIMEZONE_OFFSET_MINUTES must be an integer from -720 to 840");
  }
  if (updateCheckIntervalMs && updateCheckDailyTime) throw new Error("Configure either OPS_UPDATE_CHECK_INTERVAL_MS or OPS_UPDATE_CHECK_DAILY_TIME, not both");
  return Object.freeze({
    dataDir,
    configPath: env.OPS_CONFIG_PATH ? path.resolve(env.OPS_CONFIG_PATH) : "",
    sshHostsPath: env.OPS_SSH_HOSTS_PATH ? path.resolve(env.OPS_SSH_HOSTS_PATH) : "",
    cloudflareServersPath: env.OPS_CLOUDFLARE_SERVERS_PATH ? path.resolve(env.OPS_CLOUDFLARE_SERVERS_PATH) : "",
    dbPath: path.resolve(env.OPS_DB_PATH || path.join(dataDir, "service-ops.sqlite")),
    sessionPath: path.resolve(env.OPS_SESSION_PATH || path.join(dataDir, "sessions")),
    bindHost: env.OPS_BIND_HOST || "127.0.0.1",
    port: Number(env.PORT || 8787),
    publicUrl: env.OPS_PUBLIC_URL || "http://localhost:8787",
    adminUsername: env.OPS_ADMIN_USERNAME || "admin",
    adminPasswordHash: env.OPS_ADMIN_PASSWORD_HASH || "",
    sessionSecret: env.OPS_SESSION_SECRET || "",
    sessionTtlDays,
    sessionTtlSeconds,
    sessionCookieMaxAgeMs: sessionTtlSeconds * 1000,
    sessionRolling: sessionRollingValue === "true",
    dashboardAuthRequired: env.OPS_REQUIRE_DASHBOARD_AUTH === "true",
    updateCheckIntervalMs,
    updateCheckDailyTime,
    updateCheckTimezoneOffsetMinutes,
    privilegedOperations,
    features: Object.freeze({
      serviceControl: privilegedOperations && env.OPS_ENABLE_SERVICE_CONTROL === "true",
      updateApply: privilegedOperations && env.OPS_ENABLE_UPDATE_APPLY === "true",
      sshExecute: privilegedOperations && (env.OPS_ENABLE_SSH_EXECUTION === "true" || env.OPS_ENABLE_SSH_EXECUTE === "true"),
      cloudflareWrite: privilegedOperations && env.OPS_ENABLE_CLOUDFLARE_WRITE === "true",
    }),
    stdioScopes: String(env.OPS_STDIO_SCOPES || "services:read,services:status,updates:read").split(",").map((scope) => scope.trim()).filter(Boolean),
  });
}

export function publicInventory(inventory) {
  return {
    hosts: inventory.hosts.map(({ id, name, description, control }) => ({ id, name, description, mode: control.mode })),
    groups: inventory.groups.map(({ id, name, description }) => ({ id, name, description })),
    tools: inventory.tools.map(({ id, name, description, url }) => ({ id, name, description, url })),
    services: inventory.services.filter((service) => service.enabled).map((service) => ({
      id: service.id,
      name: service.name,
      description: service.description,
      host: service.host,
      group: service.group,
      category: service.category,
      url: service.url,
      hasFrontend: Boolean(service.url || service.hasFrontend),
      related: service.related,
      repositoryUrl: service.repositoryUrl,
      control: { type: service.control.type },
      update: service.update ? { source: service.update.source ? { type: service.update.source.type, label: service.update.source.label, repo: service.update.source.repo } : undefined } : undefined,
    })),
  };
}
