import { createHash } from "node:crypto";
import https from "node:https";
import path from "node:path";

import { hasAgentScopes } from "./agent-tokens.js";
import { validateInventory } from "./config.js";
import { buildRuntimeCommand } from "./runtime-adapters.js";

const ACTIONS = new Set(["start", "stop", "restart"]);
const RESTRICTED_SERVICE_FIELDS = new Set(["control", "health", "status", "update", "location", "backup", "agent", "extra"]);

export class OperationError extends Error {
  constructor(message, { code = "operation_failed", status = 400 } = {}) {
    super(message);
    this.name = "OperationError";
    this.code = code;
    this.status = status;
  }
}

function deny(message, code = "forbidden", status = 403) {
  throw new OperationError(message, { code, status });
}

function accessActor(access = {}) {
  return String(access.actor || (access.isAdmin ? "administrator" : "agent"));
}

function requireScope(access, scope) {
  if (access?.isAdmin === true) return;
  if (!hasAgentScopes(access, scope)) deny(`Required scope: ${scope}`, "insufficient_scope");
}

function requireAdmin(access) {
  if (access?.isAdmin !== true) deny("Administrator session required", "admin_required", 401);
}

function requireFeature(features, name) {
  if (features?.[name] !== true) deny(`Feature is disabled: ${name}`, "feature_disabled");
}

function requireConfirmation(confirm, message) {
  if (confirm !== true) throw new OperationError(message, { code: "confirmation_required", status: 400 });
}

function getOrThrow(value, label) {
  if (!value) throw new OperationError(`Unknown ${label}`, { code: "not_found", status: 404 });
  return value;
}

function quotePosix(value) {
  const text = String(value);
  return `'${text.replaceAll("'", `'\"'\"'`)}'`;
}

export function serializeRuntimeCommand(spec) {
  if (!spec?.file || !Array.isArray(spec.args)) throw new TypeError("runtime command spec is invalid");
  return [spec.file, ...spec.args].map(quotePosix).join(" ");
}

function exactCommandPolicy(command) {
  const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return { enabled: true, patterns: [`^${escaped}$`] };
}

function safeServiceInput(input = {}, { creating = false } = {}) {
  for (const field of RESTRICTED_SERVICE_FIELDS) {
    if (Object.hasOwn(input, field)) {
      throw new OperationError(`${field} is deployment configuration and cannot be changed through the API`, {
        code: "configuration_only_field",
        status: 400,
      });
    }
  }
  const allowed = ["hostId", "host", "groupId", "group", "name", "description", "url", "category", "enabled", "sortOrder", "repositoryUrl", "related"];
  const result = creating ? { id: input.id } : {};
  for (const key of allowed) if (Object.hasOwn(input, key)) result[key] = input[key];
  return result;
}

function rejectInlineSecrets(value, path = "service") {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    if (/(?:authorization|credential|password|passphrase|private.?key|secret|token)/i.test(key) && !/(?:env|environment)$/i.test(key)) {
      throw new OperationError(`${path}.${key} must reference a secret through an environment variable`, {
        code: "inline_secret",
        status: 400,
      });
    }
    rejectInlineSecrets(nested, `${path}.${key}`);
  }
}

function currentVersion(update) {
  if (!update) return "unknown";
  if (typeof update.current === "string") return update.current;
  return update.current?.version || update.current?.label || update.currentVersion || "unknown";
}

function configuredCurrent(service) {
  const current = service.update?.current;
  if (!current) return null;
  return cleanOutput(current.version) || cleanOutput(current.label) || null;
}

function sourceLabel(source) {
  if (!source) return "Not configured";
  if (source.type === "github") return `GitHub ${source.repo}`;
  return source.label || "Configured inventory";
}

function latestVersion(update, cache) {
  return cache?.status?.latestVersion
    || update?.source?.version
    || update?.latest?.version
    || update?.latestVersion
    || currentVersion(update);
}

function compareVersion(current, latest) {
  if (!current || current === "unknown" || !latest || latest === "unknown") return "unknown";
  const normalize = (value) => String(value).trim().toLowerCase().replace(/^refs\/tags\//, "").replace(/^v(?=\d)/, "");
  if (/^(latest|main|master|release|stable|canary|edge)$/.test(normalize(current))) return "unknown";
  return normalize(current) === normalize(latest) ? "current" : "outdated";
}

function revisionsMatch(currentRevision, latestRevision) {
  const current = cleanOutput(currentRevision);
  const latest = cleanOutput(latestRevision);
  return Boolean(current && latest && (current.startsWith(latest) || latest.startsWith(current)));
}

function computeUpdateState(source, current, latest) {
  if (!source || source.type !== "github") return { updateStatus: "static", updateAvailable: false };
  if (latest.error) return { updateStatus: "error", updateAvailable: false, error: latest.error };
  if (current.error && !current.version && !current.revision) return { updateStatus: "error", updateAvailable: false, error: current.error };
  if (!current.version && !current.revision) return { updateStatus: "unknown", updateAvailable: false };
  if (current.comparable === false) return { updateStatus: "unknown", updateAvailable: false };
  if (current.revision && latest.revision) {
    const isCurrent = revisionsMatch(current.revision, latest.revision);
    return { updateStatus: isCurrent ? "current" : "outdated", updateAvailable: !isCurrent };
  }
  const status = compareVersion(current.version, latest.version);
  return { updateStatus: status, updateAvailable: status === "outdated" };
}

function preservePreviousOnError(status, previousStatus) {
  if (!previousStatus || status.updateStatus !== "error" || previousStatus.updateStatus === "error") return status;
  return {
    ...previousStatus,
    currentVersion: status.currentVersion || previousStatus.currentVersion,
    currentRevision: status.currentRevision || previousStatus.currentRevision,
    checkedAt: status.checkedAt,
    trigger: status.trigger,
    stale: true,
    error: status.error || previousStatus.error,
  };
}

function commandSpec(argv, label = "command") {
  if (!Array.isArray(argv) || !argv.length || argv.some((item) => typeof item !== "string" || !item)) {
    throw new OperationError(`${label} must be a non-empty argv array`, { code: "invalid_configuration" });
  }
  return { file: argv[0], args: argv.slice(1) };
}

function dockerCommand(service, args) {
  const prefix = service.control?.command || ["docker"];
  const spec = commandSpec(prefix, "docker control.command");
  return { file: spec.file, args: [...spec.args, ...args] };
}

function cleanOutput(value) {
  const text = String(value || "").trim();
  return !text || text === "<no value>" || text === "null" || text === "undefined" ? null : text;
}

function parseKeyValueLines(value) {
  const result = {};
  for (const line of String(value || "").split(/\r?\n/)) {
    const index = line.indexOf("=");
    if (index > 0) result[line.slice(0, index)] = cleanOutput(line.slice(index + 1));
  }
  return result;
}

function shortRevision(value) {
  const revision = cleanOutput(value);
  return revision ? revision.slice(0, 12) : null;
}

function safeRepositoryUrl(value) {
  const text = cleanOutput(value);
  if (!text) return null;
  try {
    const parsed = new URL(text);
    parsed.username = "";
    parsed.password = "";
    return parsed.toString();
  } catch {
    return text;
  }
}

async function boundedJson(response, maximumBytes = 1_048_576) {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maximumBytes) throw new Error("Update source response is too large");
  if (!response.body) return {};
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximumBytes) {
        await reader.cancel("response too large");
        throw new Error("Update source response is too large");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString("utf8"));
}

function requestJsonWithHttps(url, headers, timeoutMs = 12_000, maximumBytes = 1_048_576) {
  return new Promise((resolve, reject) => {
    const request = https.get(url, { headers, timeout: timeoutMs }, (response) => {
      const chunks = [];
      let size = 0;
      response.on("data", (chunk) => {
        size += chunk.length;
        if (size > maximumBytes) {
          request.destroy(new Error("Update source response is too large"));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        let payload = null;
        try {
          payload = chunks.length ? JSON.parse(Buffer.concat(chunks).toString("utf8")) : null;
        } catch (error) {
          reject(new Error(`Invalid JSON from GitHub: ${error.message}`));
          return;
        }
        if ((response.statusCode || 500) < 200 || (response.statusCode || 500) >= 300) {
          const error = new Error(payload?.message || `HTTP ${response.statusCode}`);
          error.status = response.statusCode;
          reject(error);
          return;
        }
        resolve(payload);
      });
    });
    request.on("timeout", () => request.destroy(new Error("GitHub request timed out")));
    request.on("error", reject);
  });
}

function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${stableStringify(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function makePlanDigest(plan) {
  return createHash("sha256").update(stableStringify(plan)).digest("hex");
}

function healthHeaders(mapping = {}, env = process.env) {
  return Object.fromEntries(Object.entries(mapping).map(([header, envName]) => {
    const value = env[envName];
    if (!value) throw new Error(`Missing environment variable: ${envName}`);
    return [header, value];
  }));
}

async function mapWithConcurrency(items, limit, mapper) {
  const results = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(Math.max(1, limit), items.length) }, async () => {
    while (cursor < items.length) {
      const index = cursor++;
      results[index] = await mapper(items[index]);
    }
  });
  await Promise.all(workers);
  return results;
}

export function createOperations({
  store,
  tokenManager,
  runtimeAdapter,
  sshExecutor,
  sshHosts = [],
  sshHostRegistry,
  cloudflareServers = [],
  tools = [],
  upstreamMcps = new Map(),
  features = {},
  fetchImpl = globalThis.fetch,
  env = process.env,
  clock = Date.now,
} = {}) {
  if (!store) throw new TypeError("store is required");
  if (!runtimeAdapter) throw new TypeError("runtimeAdapter is required");
  if (!sshExecutor) throw new TypeError("sshExecutor is required");
  const currentSshHosts = () => sshHostRegistry?.list?.() || sshHosts;
  const sshById = () => new Map(currentSshHosts().map((host) => [host.id, host]));
  const requestedConcurrency = Number(env.OPS_PROBE_CONCURRENCY || 8);
  const probeConcurrency = Number.isInteger(requestedConcurrency) ? Math.min(Math.max(requestedConcurrency, 1), 32) : 8;
  let runningUpdateCheck = null;
  let nextAutoCheckAt = null;

  const serviceHost = (service) => getOrThrow(store.getHost(service.hostId), `host: ${service.hostId}`);
  const remoteSshHost = (host) => getOrThrow(sshById().get(host.metadata?.sshHostId || host.target), `SSH host configuration: ${host.id}`);

  function configuredLocation(service) {
    const host = serviceHost(service);
    const control = service.control || {};
    const current = service.update?.current;
    const configured = {
      hostId: host.id,
      hostMode: host.mode,
      controlType: control.type || "none",
      controlName: control.name || null,
    };
    if (control.type === "docker") {
      configured.container = control.name;
      configured.dockerCommand = structuredClone(control.command || ["docker"]);
    } else if (control.type === "systemd") {
      configured.unit = control.name;
    } else if (control.type === "launchd") {
      configured.label = control.name;
      configured.domain = control.domain || "gui/current";
      configured.plist = control.plist || null;
    }
    configured.path = service.location?.path
      || (current?.type === "git" ? current.path : null)
      || (current?.packagePath ? path.posix.dirname(current.packagePath) : null);
    if (current?.packagePath) configured.packagePath = current.packagePath;
    return { ...configured, ...structuredClone(service.location || {}) };
  }

  function asInventoryService(service) {
    return {
      ...structuredClone(service),
      host: service.hostId,
      group: service.groupId,
    };
  }

  function adminServiceInput(id, input, { creating = false } = {}) {
    rejectInlineSecrets(input);
    const current = creating ? null : getOrThrow(store.getService(id, { includeDeleted: true }), `service: ${id}`);
    const candidate = {
      ...(current ? asInventoryService(current) : {}),
      ...structuredClone(input),
      id: creating ? input.id : current.id,
      host: input.host ?? input.hostId ?? current?.hostId,
      group: input.group ?? input.groupId ?? current?.groupId,
    };
    const otherServices = store.listServices({ includeDeleted: true })
      .filter((service) => service.id !== candidate.id)
      .map(asInventoryService);
    const validated = validateInventory({
      version: 1,
      hosts: store.listHosts().map((host) => ({
        id: host.id,
        name: host.name,
        description: host.description,
        control: host.mode === "ssh"
          ? { mode: "ssh", sshHostId: host.metadata?.sshHostId || host.target }
          : { mode: "local" },
      })),
      groups: store.listGroups().map(({ id: groupId, name, description }) => ({ id: groupId, name, description })),
      services: [...otherServices, candidate],
      tools: [],
    }).services.find((service) => service.id === candidate.id);
    return {
      ...validated,
      hostId: validated.host,
      groupId: validated.group,
    };
  }

  function adminHostInput(input, current = null) {
    rejectInlineSecrets(input, "host");
    const mode = input.control?.mode ?? input.mode ?? current?.mode ?? "local";
    const sshHostId = input.control?.sshHostId ?? input.sshHostId ?? current?.metadata?.sshHostId ?? current?.target;
    if (mode === "ssh" && !sshById().has(sshHostId)) {
      throw new OperationError(`Unknown SSH host configuration: ${sshHostId || "missing"}`, { code: "not_found", status: 404 });
    }
    return {
      ...input,
      mode,
      target: mode === "ssh" ? sshHostId : null,
      metadata: mode === "ssh" ? { ...(current?.metadata || {}), sshHostId } : {},
    };
  }

  async function executeRuntime(service, operation, { confirm = true } = {}) {
    const host = serviceHost(service);
    if (host.mode === "local") {
      return operation === "status"
        ? runtimeAdapter.status(service)
        : runtimeAdapter.control(service, operation, { confirm });
    }
    const command = serializeRuntimeCommand(buildRuntimeCommand(service, operation));
    return sshExecutor.execute({
      host: remoteSshHost(host),
      command,
      confirm,
      policy: exactCommandPolicy(command),
    });
  }

  async function executeStructured(service, spec, { timeoutMs } = {}) {
    const host = serviceHost(service);
    if (host.mode === "local") {
      if (typeof runtimeAdapter.execute !== "function") throw new Error("Structured runtime execution is unavailable");
      return runtimeAdapter.execute(spec, { timeoutMs });
    }
    const command = serializeRuntimeCommand(spec);
    return sshExecutor.execute({
      host: remoteSshHost(host),
      command,
      confirm: true,
      policy: exactCommandPolicy(command),
      timeoutMs,
    });
  }

  async function locateRuntime(service) {
    const control = service.control || {};
    if (control.type === "docker") {
      const template = [
        "{{.Name}}", "{{.Config.Image}}", "{{.State.Status}}",
        "{{index .Config.Labels \"com.docker.compose.project\"}}",
        "{{index .Config.Labels \"com.docker.compose.service\"}}",
        "{{index .Config.Labels \"com.docker.compose.project.working_dir\"}}",
        "{{index .Config.Labels \"com.docker.compose.project.config_files\"}}",
        "{{range .Mounts}}{{.Source}}:{{.Destination}};{{end}}",
      ].join("\\t");
      const result = await executeStructured(service, dockerCommand(service, ["inspect", "--format", template, control.name]), { timeoutMs: 15_000 });
      const parts = String(result.stdout || "").split("\t");
      return {
        ok: result.ok, source: "docker inspect", container: cleanOutput(parts[0]?.replace(/^\//, "")) || control.name,
        image: cleanOutput(parts[1]), state: cleanOutput(parts[2]), composeProject: cleanOutput(parts[3]),
        composeService: cleanOutput(parts[4]), composeWorkingDir: cleanOutput(parts[5]), composeFiles: cleanOutput(parts[6]),
        mounts: cleanOutput(parts[7]) ? parts[7].split(";").filter(Boolean) : [],
        raw: cleanOutput(result.stdout || result.stderr),
        error: result.ok ? null : cleanOutput(result.stderr || result.stdout),
      };
    }
    if (control.type === "systemd") {
      const fields = ["Id", "LoadState", "ActiveState", "SubState", "FragmentPath", "DropInPaths", "WorkingDirectory", "ExecStart", "MainPID"].join(",");
      const result = await executeStructured(service, { file: "systemctl", args: ["show", control.name, `--property=${fields}`, "--no-pager"] }, { timeoutMs: 15_000 });
      const values = parseKeyValueLines(result.stdout);
      return {
        ok: result.ok, source: "systemctl show", unit: control.name, loadState: values.LoadState || null,
        activeState: values.ActiveState || null, subState: values.SubState || null, fragmentPath: values.FragmentPath || null,
        dropInPaths: values.DropInPaths || null, workingDirectory: values.WorkingDirectory || null,
        execStart: values.ExecStart || null, mainPid: values.MainPID || null, raw: cleanOutput(result.stdout || result.stderr),
        error: result.ok ? null : cleanOutput(result.stderr || result.stdout),
      };
    }
    if (control.type === "launchd") {
      const domain = control.domain || "gui/current";
      const target = `${domain}/${control.name}`;
      const result = await executeStructured(service, { file: "launchctl", args: ["print", target] }, { timeoutMs: 15_000 });
      let plistExists = null;
      if (control.plist) {
        const plistResult = await executeStructured(service, { file: "test", args: ["-f", control.plist] }, { timeoutMs: 5_000 });
        plistExists = plistResult.ok;
      }
      return {
        ok: result.ok || plistExists !== null,
        source: "launchctl print",
        label: control.name,
        domain,
        target,
        plist: control.plist || null,
        plistExists,
        raw: cleanOutput(result.stdout || result.stderr),
        error: result.ok ? null : cleanOutput(result.stderr || result.stdout),
      };
    }
    return null;
  }

  async function locateRepository(service) {
    const repositoryPath = configuredLocation(service).path;
    if (!repositoryPath) return null;
    const pathProbe = await executeStructured(service, { file: "test", args: ["-d", repositoryPath] }, { timeoutMs: 5_000 });
    if (!pathProbe.ok) {
      return {
        ok: false,
        source: "filesystem/git argv probes",
        path: repositoryPath,
        pathExists: false,
        gitRoot: null,
        gitOrigin: null,
        gitBranch: null,
        gitRevision: null,
        error: cleanOutput(pathProbe.stderr || pathProbe.stdout) || "Configured repository path does not exist",
      };
    }
    const probes = {
      root: ["rev-parse", "--show-toplevel"],
      origin: ["remote", "get-url", "origin"],
      branch: ["rev-parse", "--abbrev-ref", "HEAD"],
      revision: ["rev-parse", "--short=12", "HEAD"],
    };
    const output = {};
    for (const [key, args] of Object.entries(probes)) {
      const result = await executeStructured(service, { file: "git", args: ["-C", repositoryPath, ...args] }, { timeoutMs: 12_000 });
      output[key] = result.ok ? cleanOutput(result.stdout) : null;
      if (key === "root") output.error = result.ok ? null : cleanOutput(result.stderr || result.stdout);
    }
    return {
      ok: Boolean(output.root), source: "filesystem/git argv probes", path: repositoryPath, pathExists: true,
      gitRoot: output.root, gitOrigin: safeRepositoryUrl(output.origin), gitBranch: output.branch, gitRevision: output.revision, error: output.error,
    };
  }

  function publicInventory() {
    const services = store.listServices({ visibility: "public" }).filter((service) => service.enabled).map((service) => ({
      ...service,
      host: service.hostId,
      group: service.groupId,
      hasFrontend: Boolean(service.url),
    }));
    return {
      hosts: store.listHosts({ visibility: "public" }),
      groups: store.listGroups(),
      services,
      tools: structuredClone(tools),
      capabilities: {
        control: features.serviceControl === true,
        serviceControl: features.serviceControl === true,
        updateApply: features.updateApply === true,
        sshExecute: features.sshExecute === true,
        cloudflareWrite: features.cloudflareWrite === true,
      },
    };
  }

  function getConfiguration(access = {}) {
    requireAdmin(access);
    return {
      privilegedOperations: Object.values(features).some(Boolean),
      features: { ...features },
      sshHosts: currentSshHosts().map(({ id, description = "", backend = "openssh" }) => ({ id, description, backend })),
      cloudflareServers: cloudflareServers.map(({ id, name, capabilities }) => ({ id, name, capabilities })),
    };
  }

  function listServices(options = {}, access = {}) {
    requireScope(access, "services:read");
    const visibility = access.isAdmin ? "admin" : "public";
    const query = String(options.query || "").trim().toLowerCase();
    const services = store.listServices({ includeDeleted: Boolean(access.isAdmin && options.includeDeleted), visibility });
    if (!query) return services;
    return services.filter((service) => [service.id, service.name, service.description, service.hostId, service.groupId]
      .some((value) => String(value || "").toLowerCase().includes(query)));
  }

  async function locateService(serviceId, access = {}) {
    requireScope(access, "services:locate");
    const service = getOrThrow(store.getService(serviceId), `service: ${serviceId}`);
    const host = serviceHost(service);
    const configured = configuredLocation(service);
    let runtime = null;
    let repository = null;
    try { runtime = await locateRuntime(service); } catch (error) { runtime = { ok: false, error: error.message }; }
    try { repository = await locateRepository(service); } catch (error) { repository = { ok: false, error: error.message }; }
    const confidence = Math.min(1, Number(((runtime?.ok ? 0.55 : 0) + (repository?.pathExists ? 0.25 : 0) + (service.location || service.control?.name ? 0.2 : 0)).toFixed(2)));
    return {
      serviceId: service.id,
      ...configured,
      configured,
      runtime,
      repository,
      confidence,
    };
  }

  async function getServiceStatus(serviceId = "", access = {}) {
    requireScope(access, "services:status");
    const services = serviceId ? [getOrThrow(store.getService(serviceId), `service: ${serviceId}`)] : store.listServices();
    const statuses = await mapWithConcurrency(services, probeConcurrency, async (service) => {
      if (!service.control || service.control.type === "none") return { id: service.id, status: "unknown", ok: null };
      try {
        const result = await executeRuntime(service, "status");
        return { id: service.id, status: result.status || (result.ok ? "active" : "inactive"), ok: result.ok };
      } catch (error) {
        return { id: service.id, status: "error", ok: false };
      }
    });
    return { statuses };
  }

  async function runHealthCheck(service, health) {
    if (health.type === "static") return { type: "static", ok: health.value === "active", status: health.value || "unknown" };
    if (health.type === "command") {
      try {
        const result = await executeStructured(service, commandSpec(health.command, "health.command"), { timeoutMs: health.timeoutMs });
        const expectedExitCode = health.expectedExitCode ?? 0;
        return {
          type: "command",
          ok: result.code === expectedExitCode,
          status: result.code === expectedExitCode ? "active" : "degraded",
          exitCode: result.code,
          commandLabel: health.label || "configured command",
          stdout: cleanOutput(result.stdout),
          stderr: cleanOutput(result.stderr),
        };
      } catch (error) {
        return { type: "command", ok: false, status: "inactive", error: error.message };
      }
    }
    if (health.type !== "http") return { type: health.type, ok: false, status: "unknown" };
    try {
      const response = await fetchImpl(health.url, {
        method: health.method || "GET",
        headers: healthHeaders(health.headersFromEnv, env),
        redirect: "manual",
        signal: AbortSignal.timeout(health.timeoutMs || 5_000),
      });
      const expected = Array.isArray(health.expectedStatus) ? health.expectedStatus : [health.expectedStatus || 200];
      const ok = expected.includes(response.status);
      return { type: "http", ok, status: ok ? "active" : "degraded", url: health.url, httpStatus: response.status, statusText: response.statusText || "" };
    } catch (error) {
      return { type: "http", ok: false, status: "inactive", url: health.url, error: error.message };
    }
  }

  async function getServiceHealth(serviceId = "", access = {}) {
    requireScope(access, "services:status");
    const services = serviceId ? [getOrThrow(store.getService(serviceId), `service: ${serviceId}`)] : store.listServices();
    const statuses = await mapWithConcurrency(services, probeConcurrency, async (service) => {
      const health = service.health;
      let runtime = null;
      if (!health || health.type !== "composite" || health.includeRuntime !== false) {
        try {
          const result = await executeRuntime(service, "status");
          runtime = { id: service.id, ok: result.ok, status: result.status || (result.ok ? "active" : "inactive"), raw: cleanOutput(result.raw) };
        } catch (error) {
          runtime = { id: service.id, ok: false, status: "error", error: error.message };
        }
      }
      const configuredChecks = !health ? [] : health.type === "composite" ? health.checks : [health];
      const checks = await mapWithConcurrency(configuredChecks, Math.min(probeConcurrency, Math.max(1, configuredChecks.length)), (check) => runHealthCheck(service, check));
      const all = [...(runtime ? [runtime] : []), ...checks];
      const healthy = all.length > 0 && all.every((check) => check.ok !== false);
      return {
        id: service.id,
        status: all.length === 0 ? "unknown" : healthy ? "active" : "degraded",
        healthy,
        runtime,
        checks,
        http: checks.find((check) => check.type === "http") || null,
        command: checks.find((check) => check.type === "command") || null,
        checkedAt: new Date(clock()).toISOString(),
      };
    });
    return { statuses };
  }

  async function resolveCurrentVersion(service) {
    const current = service.update?.current || {};
    const type = current.type || "static";
    try {
      if (type === "static") return { version: cleanOutput(current.version) || cleanOutput(current.label), revision: shortRevision(current.revision), comparable: current.comparable !== false };
      if (type === "docker-label") {
        const template = ["{{ index .Config.Labels \"org.opencontainers.image.version\" }}", "{{ index .Config.Labels \"org.opencontainers.image.revision\" }}", "{{ index .Config.Labels \"org.opencontainers.image.source\" }}"].join("\t");
        const result = await executeStructured(service, dockerCommand(service, ["inspect", "--format", template, current.container || service.control?.name]), { timeoutMs: 12_000 });
        const parts = String(result.stdout || "").split("\t");
        return {
          version: cleanOutput(parts[0]) || configuredCurrent(service), revision: shortRevision(parts[1]), sourceUrl: cleanOutput(parts[2]),
          raw: cleanOutput(result.stdout || result.stderr), error: result.ok ? null : cleanOutput(result.stderr) || "Docker label inspection failed",
        };
      }
      if (type === "command") {
        const result = await executeStructured(service, commandSpec(current.command, "update.current.command"), { timeoutMs: current.timeoutMs || 12_000 });
        const raw = String(result.stdout || result.stderr || "").trim();
        const match = current.pattern ? raw.match(new RegExp(current.pattern, "m")) : null;
        return {
          version: result.ok ? cleanOutput(match ? match[1] : raw.split(/\r?\n/)[0]) : configuredCurrent(service), revision: null, raw,
          error: result.ok ? null : cleanOutput(result.stderr) || "Version command failed",
        };
      }
      if (type === "git") {
        const revisionResult = await executeStructured(service, { file: "git", args: ["-C", current.path, "rev-parse", "--short=12", "HEAD"] }, { timeoutMs: 12_000 });
        if (!revisionResult.ok) return { version: configuredCurrent(service), revision: null, raw: cleanOutput(revisionResult.stdout || revisionResult.stderr), error: cleanOutput(revisionResult.stderr) || "Git version check failed" };
        const revision = shortRevision(revisionResult.stdout);
        let version = revision ? `git@${revision}` : null;
        if (current.packagePath) {
          const script = "const p=require(process.argv[1]); process.stdout.write(String(p.version||''))";
          const packageResult = await executeStructured(service, { file: "node", args: ["-e", script, current.packagePath] }, { timeoutMs: 12_000 });
          if (packageResult.ok && cleanOutput(packageResult.stdout)) version = cleanOutput(packageResult.stdout);
        }
        const originResult = await executeStructured(service, { file: "git", args: ["-C", current.path, "remote", "get-url", "origin"] }, { timeoutMs: 12_000 });
        return { version, revision, sourceUrl: originResult.ok ? safeRepositoryUrl(originResult.stdout) : null, raw: cleanOutput(revisionResult.stdout), error: null };
      }
      return { version: null, revision: null, error: `Unsupported current version type: ${type}` };
    } catch (error) {
      return { version: configuredCurrent(service), revision: null, error: error.message };
    }
  }

  function githubHeaders(source) {
    const headers = { Accept: "application/vnd.github+json", "User-Agent": "service-ops-console" };
    if (source.tokenEnv) {
      if (!env[source.tokenEnv]) throw new Error(`Missing environment variable: ${source.tokenEnv}`);
      headers.Authorization = `Bearer ${env[source.tokenEnv]}`;
    }
    return headers;
  }

  async function requestGithubJson(url, source) {
    const headers = githubHeaders(source);
    if (typeof fetchImpl !== "function") return requestJsonWithHttps(url, headers);
    const response = await fetchImpl(url, { headers, redirect: "error", signal: AbortSignal.timeout(12_000) });
    const payload = await boundedJson(response);
    if (!response.ok) {
      const error = new Error(payload?.message || `Update source returned HTTP ${response.status}`);
      error.status = response.status;
      throw error;
    }
    return payload;
  }

  async function fetchLatestTag(source) {
    const tags = await requestGithubJson(`https://api.github.com/repos/${source.repo}/tags?per_page=100`, source);
    if (!Array.isArray(tags) || tags.length === 0) throw new Error("No GitHub tags found");
    const pattern = source.tagPattern ? new RegExp(source.tagPattern) : null;
    const tag = pattern ? tags.find((item) => pattern.test(item.name || "")) : tags[0];
    if (!tag) throw new Error(`No GitHub tags matched ${source.tagPattern}`);
    return {
      version: cleanOutput(tag.name),
      revision: shortRevision(tag.commit?.sha),
      url: `https://github.com/${source.repo}/releases/tag/${encodeURIComponent(tag.name)}`,
    };
  }

  async function fetchLatestVersion(source) {
    if (!source || source.type !== "github") return { version: null, revision: null, url: null };
    const strategy = source.strategy || "release";
    if (strategy === "tag") return fetchLatestTag(source);
    if (strategy === "commit") {
      const ref = source.ref || source.branch || "main";
      const commit = await requestGithubJson(`https://api.github.com/repos/${source.repo}/commits/${encodeURIComponent(ref)}`, source);
      const revision = shortRevision(commit.sha);
      return { version: revision ? `${ref}@${revision}` : ref, revision, url: commit.html_url || `https://github.com/${source.repo}/commits/${encodeURIComponent(ref)}` };
    }
    try {
      const release = await requestGithubJson(`https://api.github.com/repos/${source.repo}/releases/latest`, source);
      return { version: cleanOutput(release.tag_name) || cleanOutput(release.name), revision: null, url: release.html_url || `https://github.com/${source.repo}/releases` };
    } catch (error) {
      if (error.status === 404 || /not found/i.test(error.message)) return fetchLatestTag(source);
      throw error;
    }
  }

  async function checkOneService(service, trigger = "manual") {
    const checkedAt = new Date(clock()).toISOString();
    const source = service.update?.source;
    const current = await resolveCurrentVersion(service);
    let latest = { version: source?.version || service.update?.latest?.version || current.version, revision: null, url: null };
    if (source?.type === "github") {
      try { latest = await fetchLatestVersion(source); } catch (error) { latest = { ...latest, error: error.message }; }
    }
    const state = computeUpdateState(source, current, latest);
    return {
      id: service.id,
      name: service.name,
      host: service.hostId,
      sourceType: source?.type || "none",
      sourceLabel: sourceLabel(source),
      repo: source?.type === "github" ? source.repo : null,
      strategy: source?.strategy || null,
      currentVersion: current.version || configuredCurrent(service),
      currentRevision: current.revision || null,
      currentSourceUrl: current.sourceUrl || null,
      latestVersion: latest.version || null,
      latestRevision: latest.revision || null,
      latestUrl: latest.url || null,
      updateStatus: state.updateStatus,
      updateAvailable: state.updateAvailable,
      checkedAt,
      trigger,
      stale: false,
      error: current.error || state.error || null,
    };
  }

  function getServiceVersions(serviceId = "", access = {}) {
    requireScope(access, "updates:read");
    const services = serviceId ? [getOrThrow(store.getService(serviceId), `service: ${serviceId}`)] : store.listServices();
    const cacheRows = services.map((service) => [service, store.readUpdateCache(service.id)]);
    const checkedAt = cacheRows.map(([, cache]) => cache?.status?.checkedAt || cache?.updatedAt).filter(Boolean).sort().at(-1) || null;
    return {
      checkedAt,
      nextAutoCheckAt,
      statuses: cacheRows.map(([service, cache]) => {
        const current = cache?.status?.currentVersion || currentVersion(service.update);
        const latest = latestVersion(service.update, cache);
        return {
          id: service.id,
          currentVersion: current,
          currentRevision: cache?.status?.currentRevision || null,
          latestVersion: latest,
          latestRevision: cache?.status?.latestRevision || null,
          latestUrl: cache?.status?.latestUrl || null,
          sourceType: service.update?.source?.type || "static",
          sourceLabel: service.update?.source?.label || "Configured inventory",
          updateStatus: cache?.status?.updateStatus || compareVersion(current, latest),
          updateAvailable: cache?.status?.updateAvailable ?? (compareVersion(current, latest) === "outdated"),
          checkedAt: cache?.status?.checkedAt || cache?.updatedAt || null,
          trigger: cache?.status?.trigger || null,
          stale: cache?.status?.stale === true,
          error: cache?.status?.error || null,
        };
      }),
    };
  }

  async function checkServiceUpdates(serviceId = "", access = {}) {
    requireScope(access, "updates:check");
    if (!serviceId) {
      if (runningUpdateCheck) return runningUpdateCheck;
      runningUpdateCheck = (async () => {
        const services = store.listServices();
        const statuses = await mapWithConcurrency(services, probeConcurrency, async (service) => {
          const previous = store.readUpdateCache(service.id)?.status;
          const status = preservePreviousOnError(await checkOneService(service, "manual-batch"), previous);
          store.writeUpdateCache(service.id, status);
          return status;
        });
        const payload = getServiceVersions("", { ...access, scopes: [...new Set([...(access.scopes || []), "updates:read"])] });
        return { ...payload, checkedServiceIds: statuses.map((status) => status.id), checkedCount: statuses.length };
      })();
      try { return await runningUpdateCheck; } finally { runningUpdateCheck = null; }
    }
    const service = getOrThrow(store.getService(serviceId), `service: ${serviceId}`);
    const previous = store.readUpdateCache(service.id)?.status;
    const status = preservePreviousOnError(await checkOneService(service, "manual"), previous);
    store.writeUpdateCache(service.id, status);
    const payload = getServiceVersions(service.id, { ...access, scopes: [...new Set([...(access.scopes || []), "updates:read"])] });
    return { ...payload, checkedServiceIds: [service.id], checkedCount: 1 };
  }

  async function checkServiceUpdatesBatch(serviceIds = [], access = {}) {
    const ids = Array.isArray(serviceIds)
      ? [...new Set(serviceIds.map((id) => String(id || "").trim()).filter(Boolean))]
      : [];
    if (!ids.length) return checkServiceUpdates("", access);
    const results = await mapWithConcurrency(ids, probeConcurrency, (id) => checkServiceUpdates(id, access));
    return { statuses: results.flatMap((result) => result.statuses || []), checkedServiceIds: ids, checkedCount: ids.length, checkedAt: new Date(clock()).toISOString(), nextAutoCheckAt };
  }

  function getUpdateMethod(serviceId, access = {}) {
    requireScope(access, "updates:read");
    const service = getOrThrow(store.getService(serviceId), `service: ${serviceId}`);
    return {
      serviceId: service.id,
      available: Array.isArray(service.update?.steps) && service.update.steps.length > 0,
      stepTypes: (service.update?.steps || []).map((step) => step.type),
      requiresConfirmation: true,
    };
  }

  function internalUpdatePlan(serviceId) {
    const service = getOrThrow(store.getService(serviceId), `service: ${serviceId}`);
    const steps = structuredClone(service.update?.steps || []);
    if (!steps.length) throw new OperationError("No update steps are configured", { code: "update_not_configured" });
    const basis = { serviceId: service.id, serviceUpdatedAt: service.updatedAt, steps };
    return { ...basis, planDigest: makePlanDigest(basis) };
  }

  function planServiceUpdate(serviceId, access = {}) {
    requireScope(access, "updates:read");
    const plan = internalUpdatePlan(serviceId);
    const service = getOrThrow(store.getService(serviceId), `service: ${serviceId}`);
    const host = serviceHost(service);
    const version = getServiceVersions(serviceId, access).statuses[0];
    return {
      serviceId: plan.serviceId,
      serviceUpdatedAt: plan.serviceUpdatedAt,
      planDigest: plan.planDigest,
      currentVersion: version.currentVersion,
      targetVersion: version.latestVersion,
      updateStatus: version.updateStatus,
      runtime: { hostMode: host.mode, controlType: service.control?.type || "none" },
      steps: plan.steps.map((step, index) => ({ index, type: step.type, ...(step.type === "control" ? { action: step.action } : {}) })),
      requiresConfirmation: true,
    };
  }

  async function controlService(serviceId, action, options = {}, access = {}) {
    requireScope(access, "services:control");
    requireFeature(features, "serviceControl");
    requireConfirmation(options.confirm, "confirm=true is required before service control");
    if (!ACTIONS.has(action)) throw new OperationError("action must be start, stop, or restart");
    const service = getOrThrow(store.getService(serviceId), `service: ${serviceId}`);
    const actor = accessActor(access);
    try {
      const result = await executeRuntime(service, action, { confirm: true });
      store.writeAudit({ actor, action: `service.control.${action}`, targetType: "service", targetId: service.id, result: result.ok === false ? "failed" : "success" });
      return { serviceId: service.id, action, ...result };
    } catch (error) {
      store.writeAudit({ actor, action: `service.control.${action}`, targetType: "service", targetId: service.id, result: "failed", payload: { error: error.message } });
      throw error;
    }
  }

  async function applyServiceUpdate(serviceId, options = {}, access = {}) {
    requireScope(access, "updates:apply");
    requireFeature(features, "updateApply");
    requireConfirmation(options.confirm, "confirm=true is required before applying an update");
    const plan = internalUpdatePlan(serviceId);
    if (!options.planDigest || options.planDigest !== plan.planDigest) {
      throw new OperationError("Update plan changed; request a new plan", { code: "stale_update_plan", status: 409 });
    }
    const service = getOrThrow(store.getService(serviceId), `service: ${serviceId}`);
    const host = serviceHost(service);
    const actor = accessActor(access);
    const results = [];
    try {
      for (const step of service.update.steps) {
        let result;
        if (step.type === "control") {
          if (!ACTIONS.has(step.action)) throw new Error("Configured update control action is invalid");
          result = await executeRuntime(service, step.action, { confirm: true });
        } else {
          if (step.type !== "command" || step.allow !== true) throw new Error("Configured update step is not allowed");
          const executionHost = host.mode === "local" ? { id: host.id, backend: "local" } : remoteSshHost(host);
          const policy = service.update.commandPolicy || executionHost.commandPolicy;
          result = await sshExecutor.execute({ host: executionHost, command: step.command, confirm: true, policy, timeoutMs: step.timeoutMs });
        }
        results.push(result);
        if (result.ok === false && result.scheduled !== true && step.required !== false) break;
      }
      const verificationAccess = {
        ...access,
        scopes: [...new Set([...(access.scopes || []), "services:status", "updates:read", "updates:check"])],
      };
      const verification = {
        runtime: await getServiceStatus(service.id, verificationAccess),
        health: await getServiceHealth(service.id, verificationAccess),
        versions: await checkServiceUpdates(service.id, verificationAccess),
      };
      store.writeAudit({ actor, action: "service.update.apply", targetType: "service", targetId: service.id, payload: { planDigest: plan.planDigest, stepCount: results.length } });
      return { serviceId: service.id, planDigest: plan.planDigest, success: results.every((result) => result.ok !== false), results, verification };
    } catch (error) {
      store.writeAudit({ actor, action: "service.update.apply", targetType: "service", targetId: service.id, result: "failed", payload: { planDigest: plan.planDigest, error: error.message } });
      throw error;
    }
  }

  function listSshHosts(access = {}) {
    requireScope(access, "ssh:read");
    return currentSshHosts().map(({ id, description = "", backend = "openssh" }) => ({ id, description, backend }));
  }

  async function probeSsh(hostId, options = {}, access = {}) {
    requireScope(access, "ssh:execute");
    requireFeature(features, "sshExecute");
    requireConfirmation(options.confirm, "confirm=true is required before an SSH probe");
    const host = getOrThrow(sshById().get(hostId), `SSH host: ${hostId}`);
    const actor = accessActor(access);
    try {
      const result = await sshExecutor.probe({ host, confirm: true });
      store.writeAudit({ actor, action: "ssh.probe", targetType: "ssh-host", targetId: hostId, result: result.ok ? "success" : "failed" });
      return result;
    } catch (error) {
      store.writeAudit({ actor, action: "ssh.probe", targetType: "ssh-host", targetId: hostId, result: "failed", payload: { error: error.message } });
      throw error;
    }
  }

  async function executeSsh(hostId, command, options = {}, access = {}) {
    requireScope(access, "ssh:execute");
    requireFeature(features, "sshExecute");
    requireConfirmation(options.confirm, "confirm=true is required before SSH execution");
    const host = getOrThrow(sshById().get(hostId), `SSH host: ${hostId}`);
    const actor = accessActor(access);
    try {
      const result = await sshExecutor.execute({ host, command, confirm: true, policy: host.commandPolicy, timeoutMs: options.timeoutMs });
      store.writeAudit({ actor, action: "ssh.execute", targetType: "ssh-host", targetId: hostId, result: result.ok ? "success" : "failed", payload: { command } });
      return result;
    } catch (error) {
      store.writeAudit({ actor, action: "ssh.execute", targetType: "ssh-host", targetId: hostId, result: "failed", payload: { command, error: error.message } });
      throw error;
    }
  }

  async function testSshHost(hostId, options = {}, access = {}) {
    if (options.command) return executeSsh(hostId, options.command, options, access);
    return probeSsh(hostId, options, access);
  }

  function planSshHost(input = {}, access = {}) {
    requireScope(access, "ssh:write");
    admin(access);
    if (!sshHostRegistry) throw new OperationError("SSH host registry is unavailable", { code: "not_configured", status: 503 });
    try { return sshHostRegistry.plan(input); }
    catch (error) { return { valid: false, error: error.message }; }
  }

  function upsertSshHost(input = {}, access = {}) {
    requireScope(access, "ssh:write");
    admin(access);
    if (!sshHostRegistry) throw new OperationError("SSH host registry is unavailable", { code: "not_configured", status: 503 });
    const actor = accessActor(access);
    const existed = currentSshHosts().some((host) => host.id === input.id);
    try {
      const host = sshHostRegistry.upsert(input);
      store.writeAudit({ actor, action: existed ? "ssh-host.update" : "ssh-host.create", targetType: "ssh-host", targetId: host.id, payload: { backend: host.backend } });
      return host;
    } catch (error) {
      store.writeAudit({ actor, action: existed ? "ssh-host.update" : "ssh-host.create", targetType: "ssh-host", targetId: input.id, result: "failed", payload: { error: error.message } });
      throw error;
    }
  }

  function deleteSshHost(hostId, options = {}, access = {}) {
    requireScope(access, "ssh:write");
    admin(access);
    requireConfirmation(options.confirm, "confirm=true is required before deleting an SSH host");
    if (!sshHostRegistry) throw new OperationError("SSH host registry is unavailable", { code: "not_configured", status: 503 });
    const result = sshHostRegistry.delete(hostId);
    store.writeAudit({ actor: accessActor(access), action: "ssh-host.delete", targetType: "ssh-host", targetId: hostId, result: result.deleted ? "success" : "not-found" });
    return result;
  }

  function listCloudflareServers(access = {}) {
    requireScope(access, "cloudflare:read");
    return cloudflareServers.map(({ id, name, capabilities }) => ({ id, name, capabilities }));
  }

  function classifyCloudflareTool(serverId, toolName) {
    const upstream = getOrThrow(upstreamMcps.get(serverId), `Cloudflare MCP server: ${serverId}`);
    return upstream.classifyTool(toolName);
  }

  async function listCloudflareTools(serverId, access = {}) {
    requireScope(access, "cloudflare:read");
    return getOrThrow(upstreamMcps.get(serverId), `Cloudflare MCP server: ${serverId}`).listTools();
  }

  async function callCloudflareTool(serverId, toolName, args = {}, options = {}, access = {}) {
    requireScope(access, "cloudflare:call");
    const upstream = getOrThrow(upstreamMcps.get(serverId), `Cloudflare MCP server: ${serverId}`);
    const classification = upstream.classifyTool(toolName);
    if (classification === "write") {
      requireFeature(features, "cloudflareWrite");
      requireConfirmation(options.confirm, "confirm=true is required before an upstream write tool");
    }
    const actor = accessActor(access);
    try {
      const result = await upstream.callTool(toolName, args, { confirm: options.confirm });
      store.writeAudit({ actor, action: `cloudflare.${classification}.call`, targetType: "cloudflare-server", targetId: serverId, payload: { toolName } });
      return result;
    } catch (error) {
      store.writeAudit({ actor, action: `cloudflare.${classification}.call`, targetType: "cloudflare-server", targetId: serverId, result: "failed", payload: { toolName, error: error.message } });
      throw error;
    }
  }

  const admin = (access) => requireAdmin(access);
  const listHosts = (access = {}) => { requireScope(access, "hosts:read"); return store.listHosts(); };
  const createHost = (input, access = {}) => { requireScope(access, "hosts:write"); return store.createHost(adminHostInput(input), { actor: accessActor(access) }); };
  const updateHost = (id, input, access = {}) => { requireScope(access, "hosts:write"); const current = getOrThrow(store.getHost(id), `host: ${id}`); return getOrThrow(store.updateHost(id, adminHostInput(input, current), { actor: accessActor(access) }), `host: ${id}`); };
  const deleteHost = (id, options = {}, access = {}) => { requireScope(access, "hosts:write"); requireConfirmation(options.confirm, "confirm=true is required before deleting a host"); return store.deleteHost(id, { actor: accessActor(access) }); };
  const listGroups = (access = {}) => { requireScope(access, "groups:read"); return store.listGroups(); };
  const createGroup = (input, access = {}) => { requireScope(access, "groups:write"); return store.createGroup(input, { actor: accessActor(access) }); };
  const updateGroup = (id, input, access = {}) => { requireScope(access, "groups:write"); return getOrThrow(store.updateGroup(id, input, { actor: accessActor(access) }), `group: ${id}`); };
  const deleteGroup = (id, options = {}, access = {}) => { requireScope(access, "groups:write"); requireConfirmation(options.confirm, "confirm=true is required before deleting a group"); return store.deleteGroup(id, { replacementGroup: options.replacementGroup, actor: accessActor(access) }); };
  const createService = (input, access = {}) => {
    requireScope(access, "services:write");
    const prepared = access.isAdmin ? adminServiceInput(input.id, input, { creating: true }) : safeServiceInput(input, { creating: true });
    return store.createService(prepared, { actor: accessActor(access) });
  };
  const updateService = (id, input, access = {}) => {
    requireScope(access, "services:write");
    const prepared = access.isAdmin ? adminServiceInput(id, input) : safeServiceInput(input);
    return getOrThrow(store.updateService(id, prepared, { actor: accessActor(access) }), `service: ${id}`);
  };
  const deleteService = (id, options = {}, access = {}) => { requireScope(access, "services:delete"); requireConfirmation(options.confirm, "confirm=true is required before deleting a service"); return getOrThrow(store.softDeleteService(id, { actor: accessActor(access) }), `service: ${id}`); };
  const restoreService = (id, access = {}) => { requireScope(access, "services:delete"); return getOrThrow(store.restoreService(id, { actor: accessActor(access) }), `service: ${id}`); };
  const purgeService = (id, options = {}, access = {}) => { requireScope(access, "services:delete"); requireConfirmation(options.confirm, "confirm=true is required before permanent deletion"); return getOrThrow(store.purgeService(id, { actor: accessActor(access) }), `service: ${id}`); };
  const listAuditLogs = (options = {}, access = {}) => { requireScope(access, "services:audit"); return store.listAuditLogs(options); };

  function buildAddServicePlan(input = {}, access = {}) {
    requireScope(access, "services:write");
    admin(access);
    try {
      return { valid: true, service: adminServiceInput(input.id, input, { creating: true }) };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  function createServiceAddRequest(input = {}, access = {}) {
    const plan = buildAddServicePlan(input, access);
    if (!plan.valid) return { created: false, plan };
    const request = {
      id: `service-add-${clock()}-${Math.random().toString(36).slice(2, 8)}`,
      actor: accessActor(access),
      createdAt: new Date(clock()).toISOString(),
      service: plan.service,
    };
    store.writeAudit?.({
      actor: request.actor,
      action: "service.add.request",
      targetType: "service-request",
      targetId: request.id,
      payload: { service: request.service },
    });
    return { created: true, request };
  }

  function setNextAutoCheckAt(value) {
    nextAutoCheckAt = value ? new Date(value).toISOString() : null;
    return nextAutoCheckAt;
  }

  function buildAddHostPlan(input = {}, access = {}) {
    requireScope(access, "hosts:write");
    try {
      return { valid: true, host: adminHostInput(input) };
    } catch (error) {
      return { valid: false, error: error.message };
    }
  }

  function requireTokenDelegation(input, access) {
    requireScope(access, "tokens:manage");
    if (access.isAdmin) return;
    const granted = new Set(access.scopes || []);
    for (const scope of input.scopes || []) {
      if (!granted.has(scope)) deny(`Cannot grant a scope the caller does not hold: ${scope}`, "scope_escalation");
    }
  }

  const listAgentTokens = (access = {}) => {
    requireScope(access, "tokens:manage");
    if (!tokenManager) throw new OperationError("Agent token manager is unavailable", { code: "not_configured", status: 503 });
    return tokenManager.list();
  };
  const createAgentToken = (input, access = {}) => {
    if (!tokenManager) throw new OperationError("Agent token manager is unavailable", { code: "not_configured", status: 503 });
    requireTokenDelegation(input || {}, access);
    return tokenManager.create({ ...input, createdBy: accessActor(access) });
  };
  const updateAgentToken = (id, input, access = {}) => {
    if (!tokenManager) throw new OperationError("Agent token manager is unavailable", { code: "not_configured", status: 503 });
    requireTokenDelegation(input || {}, access);
    return getOrThrow(tokenManager.update(id, input, { actor: accessActor(access) }), `agent token: ${id}`);
  };
  const revokeAgentToken = (id, options = {}, access = {}) => {
    if (!tokenManager) throw new OperationError("Agent token manager is unavailable", { code: "not_configured", status: 503 });
    requireScope(access, "tokens:manage");
    requireConfirmation(options.confirm, "confirm=true is required before token revocation");
    return getOrThrow(tokenManager.revoke(id, { actor: accessActor(access) }), `agent token: ${id}`);
  };

  return Object.freeze({
    publicInventory,
    getConfiguration,
    listServices,
    locateService,
    getServiceStatus,
    getServiceHealth,
    getServiceVersions,
    checkServiceUpdates,
    checkServiceUpdatesBatch,
    setNextAutoCheckAt,
    getUpdateMethod,
    planServiceUpdate,
    applyServiceUpdate,
    controlService,
    listSshHosts,
    probeSsh,
    executeSsh,
    testSshHost,
    planSshHost,
    upsertSshHost,
    deleteSshHost,
    listCloudflareServers,
    classifyCloudflareTool,
    listCloudflareTools,
    callCloudflareTool,
    listHosts,
    createHost,
    updateHost,
    deleteHost,
    listGroups,
    createGroup,
    updateGroup,
    deleteGroup,
    createService,
    updateService,
    deleteService,
    restoreService,
    purgeService,
    listAuditLogs,
    buildAddServicePlan,
    createServiceAddRequest,
    buildAddHostPlan,
    listAgentTokens,
    createAgentToken,
    updateAgentToken,
    revokeAgentToken,
    discoverServices: listServices,
    checkServiceHealth: getServiceHealth,
    listServiceGroups: listGroups,
    createServiceGroup: createGroup,
    updateServiceGroup: updateGroup,
    deleteServiceGroup: deleteGroup,
    listServiceAuditLogs: listAuditLogs,
    cfListServers: listCloudflareServers,
    cfListTools: listCloudflareTools,
    cfCallTool: callCloudflareTool,
    getStatuses: getServiceStatus,
    getHealth: getServiceHealth,
    getVersions: getServiceVersions,
    checkServiceUpdate: checkServiceUpdates,
    getServiceUpdateMethod: getUpdateMethod,
    probeSshHost: probeSsh,
    now: () => new Date(clock()).toISOString(),
  });
}
