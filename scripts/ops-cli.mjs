#!/usr/bin/env node
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { ALL_AGENT_SCOPES } from "../lib/agent-tokens.js";
import { createMcpHttpClient, validateMcpEndpoint } from "../lib/mcp-http-client.js";
import { createMcpServer } from "../mcp/server.js";

const metadata = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));

function expandHome(value) {
  if (value === "~") return homedir();
  if (value?.startsWith("~/")) return path.join(homedir(), value.slice(2));
  return value;
}

export function getCliConfigPath(env = process.env) {
  if (env.OPS_CLI_CONFIG) return path.resolve(expandHome(env.OPS_CLI_CONFIG));
  const base = env.XDG_CONFIG_HOME
    ? path.resolve(expandHome(env.XDG_CONFIG_HOME))
    : path.join(homedir(), ".config");
  return path.join(base, "service-ops-console", "cli.json");
}

export function parseArguments(argv) {
  const positionals = [];
  const flags = {};
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const [rawName, inline] = value.slice(2).split("=", 2);
    if (inline !== undefined) flags[rawName] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith("--")) flags[rawName] = argv[++index];
    else flags[rawName] = true;
  }
  return { positionals, flags };
}

function readJson(value, label = "JSON") {
  try { return JSON.parse(value); } catch { throw new Error(`${label} must be valid JSON`); }
}

export function loadCliConfig(env = process.env) {
  const filePath = getCliConfigPath(env);
  let stored = {};
  try { stored = JSON.parse(readFileSync(filePath, "utf8")); }
  catch (cause) { if (cause.code !== "ENOENT") throw new Error(`Cannot read CLI config: ${cause.message}`); }
  return { filePath, stored };
}

export function saveCliConfig(filePath, config) {
  const directory = path.dirname(filePath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  try { chmodSync(directory, 0o700); } catch { /* Best effort on non-POSIX filesystems. */ }
  const temporary = `${filePath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { mode: 0o600 });
    try { chmodSync(temporary, 0o600); } catch { /* Best effort on non-POSIX filesystems. */ }
    renameSync(temporary, filePath);
    try { chmodSync(filePath, 0o600); } catch { /* Best effort on non-POSIX filesystems. */ }
  } catch (cause) {
    rmSync(temporary, { force: true });
    throw cause;
  }
}

async function readStdin() {
  let value = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) value += chunk;
  return value.trim();
}

export async function readCallJson(inline, flags = {}, label = "tool arguments", stdinReader = readStdin) {
  const file = flags.json;
  if (file === true) throw new Error("--json requires a file path or -");
  if (file !== undefined && inline !== undefined) throw new Error("Provide inline JSON or --json <file>, not both");
  const source = file !== undefined ? file : inline;
  if (source === undefined) return {};
  if (source === "-") return readJson(await stdinReader(), `${label} from stdin`);
  if (file !== undefined) {
    let text;
    try { text = readFileSync(path.resolve(expandHome(String(file))), "utf8"); }
    catch (cause) { throw new Error(`Cannot read ${label} file: ${cause.message}`); }
    return readJson(text, `${label} file`);
  }
  return readJson(source, label);
}

export function redactAuthorization(value) {
  if (!value) return undefined;
  const suffix = value.slice(-4);
  return `${value.startsWith("Bearer ") ? "Bearer " : ""}***${suffix}`;
}

function printHelp() {
  console.log(`Service Ops Console CLI

Usage:
  service-ops config set-endpoint <https-url>
  printf '%s' '<agent-token>' | service-ops config set-token --stdin
  service-ops config set-mode <remote|local>
  service-ops config show
  service-ops mcp tools
  service-ops mcp call <tool> [json | --json <file> | -]
  service-ops services list [query]
  service-ops services locate|status|health|versions|update-method|update-plan <serviceId>
  service-ops services update-check [serviceId]
  service-ops services update-apply <serviceId> --digest <planDigest> --confirm
  service-ops sync-service <serviceId> --confirm
  service-ops services control <serviceId> <start|stop|restart> --confirm
  service-ops ssh hosts
  service-ops ssh probe <hostId> --confirm
  service-ops ssh exec <hostId> <command> --confirm
  service-ops ssh plan '<json>'
  service-ops ssh create '<json>'
  service-ops ssh update <hostId> '<json>'
  service-ops ssh delete <hostId> --confirm
  service-ops cf servers
  service-ops cf tools <serverId>
  service-ops cf call <serverId> <toolName> [json | --json <file> | -] [--confirm]
  service-ops registry <hosts|groups|services> <list|create|update|delete|restore|purge> ...
  service-ops tokens <list|create|update|revoke> ...

Safety:
  Privileged operations must be enabled by the deployment and require a matching token scope plus --confirm.
  SSH commands must also match the selected host's administrator-defined allowlist.
`);
}

async function createCaller(env = process.env) {
  const { stored } = loadCliConfig(env);
  const mode = env.OPS_CLI_MODE || stored.mode || (env.OPS_MCP_URL || stored.endpoint ? "remote" : "local");
  if (mode === "local") {
    const { createAppContext } = await import("../lib/app-context.js");
    const context = await createAppContext({ env });
    const config = context.runtime || context.config || {};
    const server = createMcpServer({
      operations: context.operations || context,
      scopes: ALL_AGENT_SCOPES,
      privilegedOperations: config.privilegedOperations === true,
      isAdmin: true,
      actor: { type: "cli", id: env.USER || "local-cli" },
    });
    return { mode, listTools: async () => ({ tools: server.tools }), callTool: server.callTool, close: context.close };
  }
  if (mode !== "remote") throw new Error("CLI mode must be local or remote");

  const endpoint = env.OPS_MCP_URL || stored.endpoint;
  if (!endpoint) throw new Error("Remote mode requires OPS_MCP_URL or `service-ops config set-endpoint`");
  const authorization = env.OPS_MCP_AUTHORIZATION || (env.OPS_AGENT_TOKEN ? `Bearer ${env.OPS_AGENT_TOKEN}` : stored.authorization);
  if (!authorization) throw new Error("Remote mode requires an agent token; use config set-token --stdin or OPS_AGENT_TOKEN");
  const runtimeEnv = { ...env, OPS_CLI_RUNTIME_AUTHORIZATION: authorization };
  const client = createMcpHttpClient(
    { endpoint, authorizationEnv: "OPS_CLI_RUNTIME_AUTHORIZATION" },
    { env: runtimeEnv },
  );
  await client.initialize({ clientInfo: { name: "service-ops-cli", version: metadata.version } });
  return {
    mode,
    listTools: () => client.listTools(),
    callTool: async (name, args) => {
      const result = await client.callTool(name, args);
      if (result?.structuredContent !== undefined) return result.structuredContent;
      const text = result?.content?.find((item) => item.type === "text")?.text;
      if (text) {
        try { return JSON.parse(text); } catch { return { text }; }
      }
      return result;
    },
  };
}

function requireConfirm(flags) {
  if (flags.confirm !== true) throw new Error("This operation requires --confirm");
  return true;
}

export async function syncService(caller, serviceId, flags = {}) {
  requireConfirm(flags);
  if (!serviceId) throw new Error("sync-service requires a serviceId");
  const plan = await caller.callTool("plan_service_update", { serviceId });
  if (!plan?.planDigest) throw new Error("The service did not return an update plan digest");
  return caller.callTool("apply_service_update", {
    serviceId,
    planDigest: plan.planDigest,
    confirm: true,
  });
}

export function commandToTool(positionals, flags) {
  const [area, action, first, second, third] = positionals;
  if (area === "services") {
    if (action === "list") return ["list_services", { query: first }];
    if (action === "locate") return ["locate_service", { serviceId: first }];
    if (action === "status") return ["get_service_status", { serviceId: first }];
    if (action === "health") return ["get_service_health", { serviceId: first }];
    if (action === "versions") return ["get_service_versions", { serviceId: first }];
    if (action === "update-check") return first
      ? ["check_service_update", { serviceId: first }]
      : ["check_service_updates", { serviceIds: [] }];
    if (action === "update-method") return ["get_service_update_method", { serviceId: first }];
    if (action === "update-plan") return ["plan_service_update", { serviceId: first }];
    if (action === "update-apply") return ["apply_service_update", { serviceId: first, planDigest: flags.digest, confirm: requireConfirm(flags) }];
    if (action === "control") return ["control_service", { serviceId: first, action: second, confirm: requireConfirm(flags) }];
  }
  if (area === "ssh") {
    if (action === "hosts") return ["list_ssh_hosts", {}];
    if (action === "probe") return ["probe_ssh_host", { hostId: first, confirm: requireConfirm(flags) }];
    if (action === "exec") return ["ssh_execute", { hostId: first, command: second, confirm: requireConfirm(flags) }];
    if (action === "plan") return ["add_ssh_host_plan", { host: readJson(first, "SSH host") }];
    if (action === "create") return ["create_ssh_host", { host: readJson(first, "SSH host") }];
    if (action === "update") return ["update_ssh_host", { hostId: first, host: readJson(second, "SSH host") }];
    if (action === "delete") return ["delete_ssh_host", { hostId: first, confirm: requireConfirm(flags) }];
  }
  if (area === "cf") {
    if (action === "servers") return ["list_cloudflare_servers", {}];
    if (action === "tools") return ["list_cloudflare_tools", { serverId: first }];
    if (action === "call") return ["call_cloudflare_tool", {
      serverId: first,
      toolName: second,
      arguments: third ? readJson(third, "tool arguments") : {},
      ...(flags.confirm === true ? { confirm: true } : {}),
    }];
  }
  if (area === "registry") {
    const resource = action;
    const operation = first;
    const id = second;
    const payload = third ? readJson(third, `${resource} payload`) : undefined;
    if (resource === "hosts") {
      if (operation === "list") return ["list_hosts", {}];
      if (operation === "create") return ["create_host", { host: readJson(second, "host") }];
      if (operation === "update") return ["update_host", { hostId: id, patch: payload }];
      if (operation === "delete") return ["delete_host", { hostId: id, confirm: requireConfirm(flags) }];
    }
    if (resource === "groups") {
      if (operation === "list") return ["list_groups", {}];
      if (operation === "create") return ["create_group", { group: readJson(second, "group") }];
      if (operation === "update") return ["update_group", { groupId: id, patch: payload }];
      if (operation === "delete") return ["delete_group", { groupId: id, replacementGroupId: flags.replacement, confirm: requireConfirm(flags) }];
    }
    if (resource === "services") {
      if (operation === "list") return ["list_services", {}];
      if (operation === "create") return ["create_service", { service: readJson(second, "service") }];
      if (operation === "update") return ["update_service", { serviceId: id, patch: payload }];
      if (operation === "delete") return ["delete_service", { serviceId: id, confirm: requireConfirm(flags) }];
      if (operation === "restore") return ["restore_service", { serviceId: id }];
      if (operation === "purge") return ["purge_service", { serviceId: id, confirm: requireConfirm(flags) }];
    }
  }
  if (area === "tokens") {
    if (action === "list") return ["list_agent_tokens", {}];
    if (action === "create") return ["create_agent_token", {
      name: first,
      scopes: String(flags.scopes || "").split(",").map((value) => value.trim()).filter(Boolean),
      expiresAt: flags.expires || null,
    }];
    if (action === "update") return ["update_agent_token", { tokenId: first, patch: readJson(second, "token patch") }];
    if (action === "revoke") return ["revoke_agent_token", { tokenId: first, confirm: requireConfirm(flags) }];
  }
  throw new Error("Invalid command. Run service-ops --help for usage.");
}

async function handleConfig(positionals, flags, env = process.env) {
  const [, action, value] = positionals;
  const { filePath, stored } = loadCliConfig(env);
  if (action === "show") {
    console.log(JSON.stringify({
      path: filePath,
      mode: env.OPS_CLI_MODE || stored.mode || "auto",
      endpoint: env.OPS_MCP_URL || stored.endpoint,
      authorization: redactAuthorization(env.OPS_MCP_AUTHORIZATION || (env.OPS_AGENT_TOKEN ? `Bearer ${env.OPS_AGENT_TOKEN}` : stored.authorization)),
    }, null, 2));
    return;
  }
  if (action === "set-endpoint") {
    stored.endpoint = validateMcpEndpoint(value).toString();
  } else if (action === "set-mode") {
    if (!new Set(["local", "remote"]).has(value)) throw new Error("mode must be local or remote");
    stored.mode = value;
  } else if (action === "set-token" && flags.stdin === true) {
    const token = await readStdin();
    if (!token) throw new Error("No token was provided on stdin");
    stored.authorization = token.startsWith("Bearer ") ? token : `Bearer ${token}`;
  } else {
    throw new Error("Use config show, set-endpoint, set-mode, or set-token --stdin");
  }
  saveCliConfig(filePath, stored);
  console.log(`Updated ${filePath}`);
}

async function main() {
  const parsed = parseArguments(process.argv.slice(2));
  const [area, action, first, second, third] = parsed.positionals;
  if (!area || area === "help" || parsed.flags.help || area === "-h") return printHelp();
  if (area === "version" || area === "--version" || area === "-v") return console.log(`service-ops-console ${metadata.version}`);
  if (area === "config") return handleConfig(parsed.positionals, parsed.flags);

  const caller = await createCaller();
  try {
    let result;
    if (area === "mcp" && action === "tools") result = await caller.listTools();
    else if (area === "mcp" && action === "call") {
      if (!first) throw new Error("mcp call requires a tool name");
      result = await caller.callTool(first, await readCallJson(second, parsed.flags));
    }
    else if (area === "cf" && action === "call") {
      if (!first || !second) throw new Error("cf call requires a serverId and toolName");
      result = await caller.callTool("call_cloudflare_tool", {
        serverId: first,
        toolName: second,
        arguments: await readCallJson(third, parsed.flags),
        ...(parsed.flags.confirm === true ? { confirm: true } : {}),
      });
    }
    else if (area === "sync-service") result = await syncService(caller, action, parsed.flags);
    else {
      const [name, args] = commandToTool(parsed.positionals, parsed.flags);
      result = await caller.callTool(name, args);
    }
    console.log(JSON.stringify(result, null, 2));
  } finally {
    caller.close?.();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((cause) => {
    console.error(`service-ops: ${cause.message}`);
    process.exitCode = 1;
  });
}
