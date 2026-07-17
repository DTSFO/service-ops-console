import { execFile as nodeExecFile } from "node:child_process";

import { assertCommandAllowed } from "./command-policy.js";

const DEFAULT_TIMEOUT_MS = 30_000;
const MAX_TIMEOUT_MS = 300_000;
const DEFAULT_OUTPUT_BYTES = 256_000;
export const CONNECTIVITY_PROBE_COMMAND = "printf '%s\\n' service-ops-connectivity-ok";

function boundedInteger(value, fallback, minimum, maximum) {
  const parsed = Number(value);
  return Number.isInteger(parsed) ? Math.min(Math.max(parsed, minimum), maximum) : fallback;
}

function truncate(value, maximumBytes) {
  const source = Buffer.from(String(value || ""), "utf8");
  if (source.length <= maximumBytes) return { text: source.toString("utf8"), truncated: false };
  return { text: source.subarray(0, maximumBytes).toString("utf8"), truncated: true };
}

function runExecFile(execFile, file, args, { timeoutMs, maximumOutputBytes }) {
  return new Promise((resolve) => {
    execFile(file, args, { timeout: timeoutMs, maxBuffer: maximumOutputBytes * 2, windowsHide: true }, (error, stdout, stderr) => {
      const out = truncate(stdout, maximumOutputBytes);
      const err = truncate(stderr, maximumOutputBytes);
      resolve({
        ok: !error,
        code: error && typeof error.code !== "undefined" ? error.code : 0,
        signal: error?.signal || null,
        timedOut: Boolean(error?.killed),
        stdout: out.text.trimEnd(),
        stderr: err.text.trimEnd(),
        stdoutTruncated: out.truncated,
        stderrTruncated: err.truncated,
      });
    });
  });
}

function safeHost(host) {
  return { id: host.id, backend: host.backend || "openssh" };
}

function validateHost(host = {}) {
  if (!host.id || typeof host.id !== "string") throw new Error("SSH host id is required");
  const backend = host.backend || "openssh";
  if (!new Set(["local", "openssh", "ssh2"]).has(backend)) throw new Error(`Unsupported SSH backend: ${backend}`);
  if (backend === "openssh" && !host.target) throw new Error("OpenSSH target is required");
  if (backend === "ssh2" && (!host.host || !host.username)) throw new Error("ssh2 host and username are required");
  return { ...host, backend };
}

async function executeSsh2(host, command, options, loadSsh2) {
  const imported = await loadSsh2();
  const Client = imported.Client || imported.default?.Client;
  if (!Client) throw new Error("ssh2 Client export is unavailable");
  const client = new Client();
  const maximumOutputBytes = options.maximumOutputBytes;
  let stdout = "";
  let stderr = "";

  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      client.end();
      resolve(payload);
    };
    const timer = setTimeout(() => finish({ ok: false, code: null, signal: null, timedOut: true }), options.timeoutMs);
    client.once("error", (error) => finish({ ok: false, code: null, signal: null, timedOut: false, stderr: error.message }));
    client.once("ready", () => client.exec(command, (error, stream) => {
      if (error) return finish({ ok: false, code: null, signal: null, timedOut: false, stderr: error.message });
      stream.on("data", (chunk) => { stdout += chunk; });
      stream.stderr?.on("data", (chunk) => { stderr += chunk; });
      stream.once("close", (code, signal) => finish({ ok: code === 0, code, signal: signal || null, timedOut: false }));
    }));
    client.connect({
      host: host.host,
      port: host.port || 22,
      username: host.username,
      password: host.password,
      privateKey: host.privateKey,
      passphrase: host.passphrase,
      readyTimeout: options.timeoutMs,
    });
  }).then((result) => {
    const out = truncate(stdout, maximumOutputBytes);
    const err = truncate(result.stderr || stderr, maximumOutputBytes);
    return { ...result, stdout: out.text.trimEnd(), stderr: err.text.trimEnd(), stdoutTruncated: out.truncated, stderrTruncated: err.truncated };
  });
}

export function createSshExecutor({ execFile = nodeExecFile, loadSsh2 = () => import("ssh2") } = {}) {
  async function execute({ host: rawHost, command, confirm, policy, timeoutMs, maximumOutputBytes } = {}) {
    if (confirm !== true) throw new Error("confirm=true is required before command execution");
    const host = validateHost(rawHost);
    assertCommandAllowed(policy, command);
    const limits = {
      timeoutMs: boundedInteger(timeoutMs, DEFAULT_TIMEOUT_MS, 1_000, MAX_TIMEOUT_MS),
      maximumOutputBytes: boundedInteger(maximumOutputBytes, DEFAULT_OUTPUT_BYTES, 1_024, 1_000_000),
    };
    const startedAt = new Date().toISOString();
    let result;
    if (host.backend === "local") result = await runExecFile(execFile, "sh", ["-lc", command], limits);
    else if (host.backend === "openssh") {
      const args = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10"];
      if (host.port) args.push("-p", String(host.port));
      if (host.identityFile) args.push("-i", host.identityFile);
      args.push(host.target, command);
      result = await runExecFile(execFile, "ssh", args, limits);
    } else result = await executeSsh2(host, command, limits, loadSsh2);
    return { host: safeHost(host), command, ...result, startedAt, finishedAt: new Date().toISOString() };
  }

  const probe = ({ host, confirm, timeoutMs, maximumOutputBytes } = {}) => execute({
    host,
    confirm,
    timeoutMs,
    maximumOutputBytes,
    command: CONNECTIVITY_PROBE_COMMAND,
    policy: { enabled: true, patterns: [`^${CONNECTIVITY_PROBE_COMMAND.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`] },
  });

  return { execute, probe };
}
