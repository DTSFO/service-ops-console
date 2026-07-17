import { execFile as nodeExecFile } from "node:child_process";

const ACTIONS = new Set(["start", "stop", "restart"]);
const TYPES = new Set(["systemd", "docker", "launchd"]);

function commandPrefix(control, fallback) {
  const prefix = control.command || [fallback];
  if (!Array.isArray(prefix) || prefix.length === 0 || prefix.some((item) => typeof item !== "string" || !item)) {
    throw new Error(`${control.type} control.command must be a non-empty argv array`);
  }
  return prefix;
}

function prefixedCommand(prefix, args) {
  return { file: prefix[0], args: [...prefix.slice(1), ...args] };
}

function requireControl(service = {}) {
  const control = service.control;
  if (!control || !TYPES.has(control.type)) throw new Error("service control must use systemd, docker, or launchd");
  if (!control.name || typeof control.name !== "string") throw new Error("service control name is required");
  return control;
}

export function buildRuntimeCommand(service, operation) {
  const control = requireControl(service);
  if (operation !== "status" && !ACTIONS.has(operation)) throw new Error(`Unsupported runtime operation: ${operation}`);

  if (control.type === "systemd") {
    const prefix = commandPrefix(control, "systemctl");
    if (control.self === true && ["stop", "restart"].includes(operation)) {
      const scheduler = commandPrefix({ type: "systemd self action", command: control.selfActionCommand }, "systemd-run");
      const systemctlPath = control.selfSystemctlPath || "/bin/systemctl";
      return prefixedCommand(scheduler, [
        "--quiet",
        "--on-active=1",
        `--unit=service-ops-${operation}-${Date.now()}`,
        systemctlPath,
        operation,
        control.name,
      ]);
    }
    return operation === "status"
      ? prefixedCommand(prefix, ["is-active", control.name])
      : prefixedCommand(prefix, [operation, control.name]);
  }
  if (control.type === "docker") {
    const prefix = commandPrefix(control, "docker");
    if (operation === "status") return prefixedCommand(prefix, ["inspect", "--format", "{{.State.Status}}", control.name]);
    return prefixedCommand(prefix, [operation, control.name]);
  }

  const domain = control.domain || "gui/current";
  const target = `${domain}/${control.name}`;
  const prefix = commandPrefix(control, "launchctl");
  if (operation === "status") return prefixedCommand(prefix, ["print", target]);
  if (operation === "start") {
    if (!control.plist) throw new Error("launchd start requires control.plist");
    return prefixedCommand(prefix, ["bootstrap", domain, control.plist]);
  }
  if (operation === "stop") return prefixedCommand(prefix, ["bootout", target]);
  return prefixedCommand(prefix, ["kickstart", "-k", target]);
}

function execute(execFile, spec, timeoutMs) {
  return new Promise((resolve) => execFile(spec.file, spec.args, { timeout: timeoutMs, windowsHide: true }, (error, stdout, stderr) => resolve({
    ok: !error,
    code: error && typeof error.code !== "undefined" ? error.code : 0,
    signal: error?.signal || null,
    stdout: String(stdout || "").trim(),
    stderr: String(stderr || "").trim(),
  })));
}

export function normalizeRuntimeStatus(type, result) {
  const raw = result.stdout || result.stderr;
  if (type === "docker") {
    if (raw === "running") return { status: "active", ok: true };
    if (["created", "exited", "dead"].includes(raw)) return { status: "inactive", ok: true };
  }
  if (type === "systemd") {
    if (raw === "active") return { status: "active", ok: true };
    if (raw === "inactive") return { status: "inactive", ok: true };
    return { status: result.ok ? raw || "unknown" : "error", ok: result.ok };
  }
  if (type === "launchd") {
    if (result.ok || /^active\b/.test(raw) || /"PID"\s*=\s*[0-9]+/.test(raw)) return { status: "active", ok: true };
    if (/could not find service|service not found|no such process/i.test(raw)) return { status: "inactive", ok: true };
    return { status: "error", ok: false };
  }
  return { status: "unknown", ok: result.ok };
}

export function createRuntimeAdapters({ execFile = nodeExecFile, timeoutMs = 20_000 } = {}) {
  return {
    async execute(spec, options = {}) {
      if (!spec?.file || !Array.isArray(spec.args) || spec.args.some((item) => typeof item !== "string")) {
        throw new Error("runtime command must use a file and string argv array");
      }
      return execute(execFile, spec, options.timeoutMs || timeoutMs);
    },
    async status(service) {
      const control = requireControl(service);
      const result = await execute(execFile, buildRuntimeCommand(service, "status"), timeoutMs);
      const normalized = normalizeRuntimeStatus(control.type, result);
      return { id: service.id, status: normalized.status, raw: result.stdout || result.stderr, ok: normalized.ok };
    },
    async control(service, action, { confirm } = {}) {
      if (confirm !== true) throw new Error("confirm=true is required before service control");
      const result = await execute(execFile, buildRuntimeCommand(service, action), timeoutMs);
      return { id: service.id, action, ...result, scheduled: service.control?.self === true && ["stop", "restart"].includes(action) };
    },
  };
}
