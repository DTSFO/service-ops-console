import { ALL_AGENT_SCOPES } from "../lib/agent-tokens.js";

const PROTOCOL_VERSION = "2024-11-05";
const MINIMAL_DEFAULT_SCOPES = Object.freeze([
  "services:read",
  "services:status",
  "updates:read",
]);

const objectSchema = (properties = {}, required = []) => ({
  type: "object",
  properties,
  ...(required.length ? { required } : {}),
  additionalProperties: false,
});

const serviceId = { type: "string", minLength: 1 };
const confirm = { type: "boolean", description: "Must be exactly true for a privileged operation." };

const TOOL_DEFINITIONS = Object.freeze([
  {
    name: "list_services",
    description: "List or search the configured service inventory.",
    scopes: ["services:read"],
    inputSchema: objectSchema({ query: { type: "string" }, q: { type: "string", description: "Compatibility alias for query." } }),
    methods: ["listServices", "discoverServices"],
    args: ({ query, q }, context) => [(query || q) ? { query: query || q } : {}, context],
  },
  {
    name: "discover_services",
    description: "Compatibility alias for list_services.",
    scopes: ["services:read"],
    inputSchema: objectSchema({ query: { type: "string" }, q: { type: "string", description: "Compatibility alias for query." } }),
    methods: ["discoverServices", "listServices"],
    args: ({ query, q }, context) => [(query || q) ? { query: query || q } : {}, context],
  },
  {
    name: "locate_service",
    description: "Return operator-approved host, group, runtime, and repository location metadata for one service.",
    scopes: ["services:locate"],
    inputSchema: objectSchema({ serviceId }, ["serviceId"]),
    methods: ["locateService"],
    args: ({ serviceId: id }, context) => [id, context],
  },
  {
    name: "get_service_status",
    description: "Read runtime status for one service or all configured services.",
    scopes: ["services:status"],
    inputSchema: objectSchema({ serviceId }),
    methods: ["getServiceStatus", "getStatuses"],
    args: ({ serviceId: id }, context) => [id || "", context],
  },
  {
    name: "get_service_health",
    description: "Run configured, bounded health checks for one service or all configured services.",
    scopes: ["services:status"],
    inputSchema: objectSchema({ serviceId }),
    methods: ["getServiceHealth", "getHealth"],
    args: ({ serviceId: id }, context) => [id || "", context],
  },
  {
    name: "check_service_health",
    description: "Compatibility alias for get_service_health.",
    scopes: ["services:status"],
    inputSchema: objectSchema({ serviceId }),
    methods: ["checkServiceHealth", "getServiceHealth", "getHealth"],
    args: ({ serviceId: id }, context) => [id || "", context],
  },
  {
    name: "get_service_versions",
    description: "Read current and configured source version metadata.",
    scopes: ["updates:read"],
    inputSchema: objectSchema({ serviceId }),
    methods: ["getServiceVersions", "getVersions"],
    args: ({ serviceId: id }, context) => [id || "", context],
  },
  {
    name: "check_service_update",
    description: "Check the configured release, tag, or revision source for an available update.",
    scopes: ["updates:check"],
    inputSchema: objectSchema({ serviceId }, ["serviceId"]),
    methods: ["checkServiceUpdate", "checkServiceUpdates", "checkUpdate"],
    args: ({ serviceId: id }, context) => [id, context],
  },
  {
    name: "check_service_updates",
    description: "Check selected services or all configured services for updates.",
    scopes: ["updates:check"],
    inputSchema: objectSchema({ serviceIds: { type: "array", items: { type: "string" } } }),
    methods: ["checkServiceUpdatesBatch"],
    args: ({ serviceIds }, context) => [serviceIds || [], context],
  },
  {
    name: "get_service_update_method",
    description: "Describe the configured update mechanism without executing it.",
    scopes: ["updates:read"],
    inputSchema: objectSchema({ serviceId }, ["serviceId"]),
    methods: ["getServiceUpdateMethod", "getUpdateMethod"],
    args: ({ serviceId: id }, context) => [id, context],
  },
  {
    name: "plan_service_update",
    description: "Build an immutable update plan and digest without changing the service.",
    scopes: ["updates:read"],
    inputSchema: objectSchema({ serviceId }, ["serviceId"]),
    methods: ["planServiceUpdate", "getUpdatePlan"],
    args: ({ serviceId: id }, context) => [id, context],
  },
  {
    name: "apply_service_update",
    description: "Apply a previously generated update plan. Requires privileged operations, updates:apply, the exact plan digest, and confirm=true.",
    scopes: ["updates:apply"],
    privileged: true,
    inputSchema: objectSchema({ serviceId, planDigest: { type: "string", minLength: 1 }, confirm }, ["serviceId", "planDigest", "confirm"]),
    methods: ["applyServiceUpdate", "applyUpdate"],
    args: ({ serviceId: id, planDigest, confirm: confirmed }, context) => [id, { planDigest, confirm: confirmed }, context],
  },
  {
    name: "add_service_plan",
    description: "Validate a new service record without writing it.",
    scopes: ["services:write"],
    adminOnly: true,
    inputSchema: objectSchema({ service: { type: "object" } }, ["service"]),
    methods: ["buildAddServicePlan"],
    args: ({ service }, context) => [service, context],
  },
  {
    name: "create_service_add_request",
    description: "Validate and record a pending service-add request without creating the service.",
    scopes: ["services:write"],
    adminOnly: true,
    inputSchema: objectSchema({ service: { type: "object" } }, ["service"]),
    methods: ["createServiceAddRequest"],
    args: ({ service }, context) => [service, context],
  },
  {
    name: "control_service",
    description: "Start, stop, or restart a configured runtime. Requires privileged operations, services:control, and confirm=true.",
    scopes: ["services:control"],
    privileged: true,
    inputSchema: objectSchema({ serviceId, action: { type: "string", enum: ["start", "stop", "restart"] }, confirm }, ["serviceId", "action", "confirm"]),
    methods: ["controlService", "runControl"],
    args: ({ serviceId: id, action, confirm: confirmed }, context) => [id, action, { confirm: confirmed }, context],
  },
  {
    name: "list_ssh_hosts",
    description: "List configured SSH host identifiers and non-secret metadata.",
    scopes: ["ssh:read"],
    inputSchema: objectSchema(),
    methods: ["listSshHosts"],
    args: (_input, context) => [context],
  },
  {
    name: "probe_ssh_host",
    description: "Run the fixed SSH connectivity probe. Requires privileged operations, ssh:execute, and confirm=true.",
    scopes: ["ssh:execute"],
    privileged: true,
    inputSchema: objectSchema({ hostId: serviceId, confirm }, ["hostId", "confirm"]),
    methods: ["probeSshHost", "probeSsh"],
    args: ({ hostId, confirm: confirmed }, context) => [hostId, { confirm: confirmed }, context],
  },
  {
    name: "ssh_execute",
    description: "Run a command allowed by the selected SSH host policy. Requires privileged operations, ssh:execute, and confirm=true.",
    scopes: ["ssh:execute"],
    privileged: true,
    inputSchema: objectSchema({ hostId: serviceId, command: { type: "string", minLength: 1, maxLength: 4096 }, confirm }, ["hostId", "command", "confirm"]),
    methods: ["executeSsh", "sshExecute"],
    args: ({ hostId, command, confirm: confirmed }, context) => [hostId, command, { confirm: confirmed }, context],
  },
  {
    name: "test_ssh_host",
    description: "Run the fixed SSH connectivity probe or an explicitly requested allowlisted probe command.",
    scopes: ["ssh:execute"],
    privileged: true,
    inputSchema: objectSchema({ hostId: serviceId, command: { type: "string" }, confirm }, ["hostId", "confirm"]),
    methods: ["testSshHost"],
    args: ({ hostId, command, confirm: confirmed }, context) => [hostId, { ...(command ? { command } : {}), confirm: confirmed }, context],
  },
  {
    name: "add_ssh_host_plan",
    description: "Validate an SSH host registry entry without writing it. Secret values are forbidden; use environment-variable references.",
    scopes: ["ssh:write"],
    adminOnly: true,
    inputSchema: objectSchema({ host: { type: "object" } }, ["host"]),
    methods: ["planSshHost"],
    args: ({ host }, context) => [host, context],
  },
  {
    name: "create_ssh_host",
    description: "Create or replace an SSH host registry entry using environment-variable secret references.",
    scopes: ["ssh:write"],
    adminOnly: true,
    inputSchema: objectSchema({ host: { type: "object" } }, ["host"]),
    methods: ["upsertSshHost"],
    args: ({ host }, context) => [host, context],
  },
  {
    name: "update_ssh_host",
    description: "Replace an SSH host registry entry using environment-variable secret references.",
    scopes: ["ssh:write"],
    adminOnly: true,
    inputSchema: objectSchema({ hostId: serviceId, host: { type: "object" } }, ["hostId", "host"]),
    methods: ["upsertSshHost"],
    args: ({ hostId, host }, context) => [{ ...host, id: hostId }, context],
  },
  {
    name: "delete_ssh_host",
    description: "Delete an SSH host registry entry. Requires strict confirm=true.",
    scopes: ["ssh:write"],
    adminOnly: true,
    confirm: true,
    inputSchema: objectSchema({ hostId: serviceId, confirm }, ["hostId", "confirm"]),
    methods: ["deleteSshHost"],
    args: ({ hostId, confirm: confirmed }, context) => [hostId, { confirm: confirmed }, context],
  },
  {
    name: "list_cloudflare_servers",
    description: "List configured Cloudflare upstream MCP server identifiers and capabilities.",
    scopes: ["cloudflare:read"],
    inputSchema: objectSchema(),
    methods: ["listCloudflareServers"],
    args: (_input, context) => [context],
  },
  {
    name: "list_cloudflare_tools",
    description: "List explicitly classified tools exposed by one Cloudflare upstream MCP server.",
    scopes: ["cloudflare:read"],
    inputSchema: objectSchema({ serverId: serviceId }, ["serverId"]),
    methods: ["listCloudflareTools"],
    args: ({ serverId }, context) => [serverId, context],
  },
  {
    name: "call_cloudflare_tool",
    description: "Call an explicitly classified Cloudflare upstream MCP tool. Write tools additionally require privileged operations and confirm=true.",
    scopes: ["cloudflare:call"],
    inputSchema: objectSchema({ serverId: serviceId, toolName: serviceId, arguments: { type: "object" }, confirm }, ["serverId", "toolName"]),
    methods: ["callCloudflareTool"],
    args: ({ serverId, toolName, arguments: args = {}, confirm: confirmed }, context) => [serverId, toolName, args, { confirm: confirmed }, context],
  },
  {
    name: "cf_list_servers",
    description: "Compatibility alias for list_cloudflare_servers.",
    scopes: ["cloudflare:read"],
    inputSchema: objectSchema(),
    methods: ["cfListServers", "listCloudflareServers"],
    args: (_input, context) => [context],
  },
  {
    name: "cf_list_tools",
    description: "Compatibility alias for list_cloudflare_tools.",
    scopes: ["cloudflare:read"],
    inputSchema: objectSchema({ server: serviceId }, ["server"]),
    methods: ["cfListTools", "listCloudflareTools"],
    args: ({ server }, context) => [server, context],
  },
  {
    name: "cf_call_tool",
    description: "Compatibility alias for call_cloudflare_tool.",
    scopes: ["cloudflare:call"],
    inputSchema: objectSchema({ server: serviceId, toolName: serviceId, arguments: { type: "object" }, confirm }, ["server", "toolName"]),
    methods: ["cfCallTool", "callCloudflareTool"],
    args: ({ server, toolName, arguments: args = {}, confirm: confirmed }, context) => [server, toolName, args, { confirm: confirmed }, context],
  },
  {
    name: "list_hosts",
    description: "List managed host records.",
    scopes: ["hosts:read"],
    inputSchema: objectSchema(),
    methods: ["listHosts"],
    args: (_input, context) => [context],
  },
  {
    name: "create_host",
    description: "Create a managed host record.",
    scopes: ["hosts:write"],
    inputSchema: objectSchema({ host: { type: "object" } }, ["host"]),
    methods: ["createHost"],
    args: ({ host }, context) => [host, context],
  },
  {
    name: "add_host_plan",
    description: "Validate a new managed host without writing it.",
    scopes: ["hosts:write"],
    inputSchema: objectSchema({ host: { type: "object" } }, ["host"]),
    methods: ["buildAddHostPlan"],
    args: ({ host }, context) => [host, context],
  },
  {
    name: "update_host",
    description: "Update a managed host record.",
    scopes: ["hosts:write"],
    inputSchema: objectSchema({ hostId: serviceId, patch: { type: "object" } }, ["hostId", "patch"]),
    methods: ["updateHost"],
    args: ({ hostId, patch }, context) => [hostId, patch, context],
  },
  {
    name: "delete_host",
    description: "Delete an unused managed host record. Requires confirm=true.",
    scopes: ["hosts:write"],
    confirm: true,
    inputSchema: objectSchema({ hostId: serviceId, confirm }, ["hostId", "confirm"]),
    methods: ["deleteHost"],
    args: ({ hostId, confirm: confirmed }, context) => [hostId, { confirm: confirmed }, context],
  },
  {
    name: "list_groups",
    description: "List service group records.",
    scopes: ["groups:read"],
    inputSchema: objectSchema(),
    methods: ["listGroups"],
    args: (_input, context) => [context],
  },
  {
    name: "list_service_groups",
    description: "Compatibility alias for list_groups.",
    scopes: ["groups:read"],
    inputSchema: objectSchema(),
    methods: ["listServiceGroups", "listGroups"],
    args: (_input, context) => [context],
  },
  {
    name: "create_group",
    description: "Create a service group record.",
    scopes: ["groups:write"],
    inputSchema: objectSchema({ group: { type: "object" } }, ["group"]),
    methods: ["createGroup"],
    args: ({ group }, context) => [group, context],
  },
  {
    name: "create_service_group",
    description: "Compatibility alias for create_group.",
    scopes: ["groups:write"],
    inputSchema: objectSchema({ group: { type: "object" } }, ["group"]),
    methods: ["createServiceGroup", "createGroup"],
    args: ({ group }, context) => [group, context],
  },
  {
    name: "update_group",
    description: "Update a service group record.",
    scopes: ["groups:write"],
    inputSchema: objectSchema({ groupId: serviceId, patch: { type: "object" } }, ["groupId", "patch"]),
    methods: ["updateGroup"],
    args: ({ groupId, patch }, context) => [groupId, patch, context],
  },
  {
    name: "update_service_group",
    description: "Compatibility alias for update_group.",
    scopes: ["groups:write"],
    inputSchema: objectSchema({ groupId: serviceId, group: { type: "object" } }, ["groupId", "group"]),
    methods: ["updateServiceGroup", "updateGroup"],
    args: ({ groupId, group }, context) => [groupId, group, context],
  },
  {
    name: "delete_group",
    description: "Delete or replace a service group. Requires confirm=true.",
    scopes: ["groups:write"],
    confirm: true,
    inputSchema: objectSchema({ groupId: serviceId, replacementGroupId: serviceId, confirm }, ["groupId", "confirm"]),
    methods: ["deleteGroup"],
    args: ({ groupId, replacementGroupId, confirm: confirmed }, context) => [groupId, { replacementGroup: replacementGroupId, confirm: confirmed }, context],
  },
  {
    name: "delete_service_group",
    description: "Compatibility alias for delete_group.",
    scopes: ["groups:write"],
    confirm: true,
    inputSchema: objectSchema({ groupId: serviceId, replacementGroup: serviceId, confirm }, ["groupId", "confirm"]),
    methods: ["deleteServiceGroup", "deleteGroup"],
    args: ({ groupId, replacementGroup, confirm: confirmed }, context) => [groupId, { replacementGroup, confirm: confirmed }, context],
  },
  {
    name: "create_service",
    description: "Create a service registry record.",
    scopes: ["services:write"],
    inputSchema: objectSchema({ service: { type: "object" } }, ["service"]),
    methods: ["createService"],
    args: ({ service }, context) => [service, context],
  },
  {
    name: "update_service",
    description: "Update a service registry record.",
    scopes: ["services:write"],
    inputSchema: objectSchema({ serviceId, patch: { type: "object" } }, ["serviceId", "patch"]),
    methods: ["updateService"],
    args: ({ serviceId: id, patch }, context) => [id, patch, context],
  },
  {
    name: "delete_service",
    description: "Soft-delete a service registry record. Requires confirm=true.",
    scopes: ["services:delete"],
    confirm: true,
    inputSchema: objectSchema({ serviceId, confirm }, ["serviceId", "confirm"]),
    methods: ["deleteService", "softDeleteService"],
    args: ({ serviceId: id, confirm: confirmed }, context) => [id, { confirm: confirmed }, context],
  },
  {
    name: "restore_service",
    description: "Restore a soft-deleted service registry record.",
    scopes: ["services:delete"],
    inputSchema: objectSchema({ serviceId }, ["serviceId"]),
    methods: ["restoreService"],
    args: ({ serviceId: id }, context) => [id, context],
  },
  {
    name: "purge_service",
    description: "Permanently delete a soft-deleted service record. Requires confirm=true.",
    scopes: ["services:delete"],
    confirm: true,
    inputSchema: objectSchema({ serviceId, confirm }, ["serviceId", "confirm"]),
    methods: ["purgeService"],
    args: ({ serviceId: id, confirm: confirmed }, context) => [id, { confirm: confirmed }, context],
  },
  {
    name: "list_audit_events",
    description: "List redacted registry and privileged-operation audit events.",
    scopes: ["services:audit"],
    inputSchema: objectSchema({ limit: { type: "integer", minimum: 1, maximum: 200 } }),
    methods: ["listAuditEvents", "listAuditLogs"],
    args: ({ limit = 50 }, context) => [{ limit }, context],
  },
  {
    name: "list_service_audit_logs",
    description: "Compatibility alias for list_audit_events.",
    scopes: ["services:audit"],
    inputSchema: objectSchema({ limit: { type: "integer", minimum: 1, maximum: 200 } }),
    methods: ["listServiceAuditLogs", "listAuditLogs", "listAuditEvents"],
    args: ({ limit = 50 }, context) => [{ limit }, context],
  },
  {
    name: "list_agent_tokens",
    description: "List agent token metadata. Token secrets are never returned.",
    scopes: ["tokens:manage"],
    inputSchema: objectSchema(),
    methods: ["listAgentTokens"],
    args: (_input, context) => [context],
  },
  {
    name: "create_agent_token",
    description: "Create a scoped agent token. The secret is returned once.",
    scopes: ["tokens:manage"],
    inputSchema: objectSchema({ name: { type: "string", minLength: 1 }, scopes: { type: "array", items: { type: "string", enum: ALL_AGENT_SCOPES } }, expiresAt: { type: ["string", "null"] } }, ["name", "scopes"]),
    methods: ["createAgentToken"],
    args: (args, context) => [args, context],
  },
  {
    name: "update_agent_token",
    description: "Update scopes, expiry, name, or disabled state for an agent token.",
    scopes: ["tokens:manage"],
    inputSchema: objectSchema({ tokenId: serviceId, patch: { type: "object" } }, ["tokenId", "patch"]),
    methods: ["updateAgentToken"],
    args: ({ tokenId, patch }, context) => [tokenId, patch, context],
  },
  {
    name: "revoke_agent_token",
    description: "Revoke an agent token. Requires confirm=true.",
    scopes: ["tokens:manage"],
    confirm: true,
    inputSchema: objectSchema({ tokenId: serviceId, confirm }, ["tokenId", "confirm"]),
    methods: ["revokeAgentToken"],
    args: ({ tokenId, confirm: confirmed }, context) => [tokenId, { confirm: confirmed }, context],
  },
]);

function normalizeScopes(scopes) {
  const requested = Array.isArray(scopes) ? scopes : String(scopes || "").split(",");
  return new Set(requested.map((scope) => String(scope).trim()).filter((scope) => ALL_AGENT_SCOPES.includes(scope)));
}

function hasScopes(granted, required) {
  return required.every((scope) => granted.has(scope));
}

function findOperation(operations, candidates) {
  for (const name of candidates) {
    if (typeof operations?.[name] === "function") return operations[name].bind(operations);
  }
  return null;
}

function publicTool(definition) {
  const { scopes: _scopes, privileged: _privileged, confirm: _confirm, adminOnly: _adminOnly, methods: _methods, args: _args, ...tool } = definition;
  return tool;
}

export function createMcpServer({
  operations,
  scopes = MINIMAL_DEFAULT_SCOPES,
  privilegedOperations = false,
  isAdmin = false,
  actor = { type: "stdio", id: "stdio" },
} = {}) {
  if (!operations || typeof operations !== "object") throw new TypeError("operations is required");
  const grantedScopes = normalizeScopes(scopes);
  const available = TOOL_DEFINITIONS.filter((definition) => {
    if (!hasScopes(grantedScopes, definition.scopes)) return false;
    if (definition.adminOnly && !isAdmin) return false;
    if (!findOperation(operations, definition.methods)) return false;
    return !definition.privileged || privilegedOperations === true;
  });
  const availableByName = new Map(available.map((definition) => [definition.name, definition]));

  const operationContext = () => Object.freeze({
    actor: typeof actor === "string" ? actor : actor?.id || "agent",
    actorType: typeof actor === "object" ? actor.type : undefined,
    scopes: [...grantedScopes],
    privilegedOperations,
    isAdmin,
  });

  const resourceDefinitions = [
    { uri: "service-ops://services", name: "Configured services", scope: "services:read", methods: ["listServices", "discoverServices"], args: (context) => [{}, context] },
    { uri: "service-ops://hosts", name: "Managed hosts", scope: "hosts:read", methods: ["listHosts"], args: (context) => [context] },
    { uri: "service-ops://groups", name: "Service groups", scope: "groups:read", methods: ["listGroups", "listServiceGroups"], args: (context) => [context] },
    { uri: "service-ops://audit", name: "Redacted audit events", scope: "services:audit", methods: ["listAuditLogs", "listServiceAuditLogs"], args: (context) => [{ limit: 50 }, context] },
    { uri: "service-ops://ssh-hosts", name: "Configured SSH host identifiers", scope: "ssh:read", methods: ["listSshHosts"], args: (context) => [context] },
    { uri: "service-ops://cloudflare", name: "Configured upstream MCP servers", scope: "cloudflare:read", methods: ["listCloudflareServers", "cfListServers"], args: (context) => [context] },
  ].filter((resource) => grantedScopes.has(resource.scope) && findOperation(operations, resource.methods));

  const resourceTemplates = [
    { uriTemplate: "service-ops://services/{serviceId}", name: "Configured service", scope: "services:read", methods: ["listServices", "discoverServices"] },
    { uriTemplate: "service-ops://services/{serviceId}/location", name: "Service location", scope: "services:locate", methods: ["locateService"] },
    { uriTemplate: "service-ops://services/{serviceId}/status", name: "Service runtime status", scope: "services:status", methods: ["getServiceStatus", "getStatuses"] },
    { uriTemplate: "service-ops://services/{serviceId}/health", name: "Service health", scope: "services:status", methods: ["getServiceHealth", "checkServiceHealth", "getHealth"] },
    { uriTemplate: "service-ops://services/{serviceId}/versions", name: "Service versions", scope: "updates:read", methods: ["getServiceVersions", "getVersions"] },
    { uriTemplate: "service-ops://services/{serviceId}/update-plan", name: "Service update plan", scope: "updates:read", methods: ["planServiceUpdate", "getUpdatePlan"] },
    { uriTemplate: "service-ops://cloudflare/{serverId}/tools", name: "Classified upstream MCP tools", scope: "cloudflare:read", methods: ["listCloudflareTools", "cfListTools"] },
  ].filter((resource) => grantedScopes.has(resource.scope) && findOperation(operations, resource.methods));

  async function readResource(uri) {
    const exact = resourceDefinitions.find((resource) => resource.uri === uri);
    let payload;
    if (exact) {
      payload = await findOperation(operations, exact.methods)(...exact.args(operationContext()));
    } else {
      const service = /^service-ops:\/\/services\/([^/]+)$/.exec(uri);
      const match = /^service-ops:\/\/services\/([^/]+)\/(location|status|health|versions|update-plan)$/.exec(uri);
      const cloudflare = /^service-ops:\/\/cloudflare\/([^/]+)\/tools$/.exec(uri);
      if (service) {
        const template = resourceTemplates.find((resource) => resource.uriTemplate === "service-ops://services/{serviceId}");
        if (!template) throw new Error(`Resource is unavailable or not authorized: ${uri}`);
        const id = decodeURIComponent(service[1]);
        const collection = await findOperation(operations, template.methods)({}, operationContext());
        const items = Array.isArray(collection) ? collection : collection?.services || collection?.items || [];
        const item = items.find((candidate) => candidate?.id === id);
        if (!item) throw new Error(`Unknown service: ${id}`);
        payload = { service: item };
      } else if (match) {
        const [, id, kind] = match;
        const template = resourceTemplates.find((resource) => resource.uriTemplate.endsWith(`/${kind}`));
        if (!template) throw new Error(`Resource is unavailable or not authorized: ${uri}`);
        payload = await findOperation(operations, template.methods)(decodeURIComponent(id), operationContext());
      } else if (cloudflare) {
        const template = resourceTemplates.find((resource) => resource.uriTemplate.includes("cloudflare/{serverId}"));
        if (!template) throw new Error(`Resource is unavailable or not authorized: ${uri}`);
        payload = await findOperation(operations, template.methods)(decodeURIComponent(cloudflare[1]), operationContext());
      } else {
        throw new Error(`Unknown resource: ${uri}`);
      }
    }
    return { contents: [{ uri, mimeType: "application/json", text: JSON.stringify(payload, null, 2) }] };
  }

  async function callTool(name, input = {}) {
    const definition = availableByName.get(name);
    if (!definition) throw new Error(`Tool is unavailable or not authorized: ${name}`);
    if ((definition.privileged || definition.confirm) && input.confirm !== true) {
      throw new Error("confirm=true is required for this operation");
    }
    if (name === "call_cloudflare_tool" || name === "cf_call_tool") {
      const classify = findOperation(operations, ["classifyCloudflareTool"]);
      const access = classify ? await classify(input.serverId || input.server, input.toolName) : undefined;
      if (access !== "read" && access !== "write") {
        throw new Error("Cloudflare upstream tool must be explicitly classified as read or write");
      }
      if (access === "write" && privilegedOperations !== true) {
        throw new Error("Privileged operations are disabled for this Cloudflare write tool");
      }
      if (access === "write" && input.confirm !== true) {
        throw new Error("confirm=true is required for this Cloudflare write tool");
      }
    }
    const operation = findOperation(operations, definition.methods);
    const context = operationContext();
    return operation(...(definition.args ? definition.args(input, context) : [context]));
  }

  const result = (id, value) => ({ jsonrpc: "2.0", id, result: value });
  const error = (id, code, message) => ({ jsonrpc: "2.0", id: id ?? null, error: { code, message } });

  async function handleRequest(message) {
    if (!message || typeof message !== "object" || !message.method) return error(message?.id, -32600, "Invalid Request");
    if (message.method === "initialize") {
      return result(message.id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {}, resources: { subscribe: false, listChanged: false } },
        serverInfo: { name: "service-ops-console", version: "1.0.0" },
      });
    }
    if (message.method === "ping") return result(message.id, {});
    if (message.method === "notifications/initialized") return null;
    if (message.method === "tools/list") return result(message.id, { tools: available.map(publicTool) });
    if (message.method === "resources/list") return result(message.id, { resources: resourceDefinitions.map(({ uri, name }) => ({ uri, name, mimeType: "application/json" })) });
    if (message.method === "resources/templates/list") return result(message.id, { resourceTemplates: resourceTemplates.map(({ uriTemplate, name }) => ({ uriTemplate, name, mimeType: "application/json" })) });
    if (message.method === "resources/read") {
      try {
        return result(message.id, await readResource(message.params?.uri));
      } catch (cause) {
        return error(message.id, -32602, cause.message);
      }
    }
    if (message.method === "tools/call") {
      try {
        const payload = await callTool(message.params?.name, message.params?.arguments || {});
        return result(message.id, {
          content: [{ type: "text", text: JSON.stringify(payload, null, 2) }],
          structuredContent: payload,
        });
      } catch (cause) {
        return error(message.id, -32602, cause.message);
      }
    }
    if (typeof message.id === "undefined") return null;
    return error(message.id, -32601, `Unsupported method: ${message.method}`);
  }

  return Object.freeze({ tools: available.map(publicTool), callTool, handleRequest });
}

let defaultServerPromise;

async function loadDefaultServer() {
  if (!defaultServerPromise) {
    defaultServerPromise = import("../lib/app-context.js").then(async ({ createAppContext }) => {
      const context = await createAppContext();
      const config = context.runtime || context.config || {};
      return createMcpServer({
        operations: context.operations || context,
        scopes: config.stdioScopes || MINIMAL_DEFAULT_SCOPES,
        privilegedOperations: config.privilegedOperations === true,
      });
    });
  }
  return defaultServerPromise;
}

export async function handleMcpRequest(message, options) {
  const server = options ? createMcpServer(options) : await loadDefaultServer();
  return server.handleRequest(message);
}

export { MINIMAL_DEFAULT_SCOPES, TOOL_DEFINITIONS };
