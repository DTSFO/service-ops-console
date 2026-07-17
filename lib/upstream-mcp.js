import { createMcpHttpClient } from "./mcp-http-client.js";

const SECRET_CONFIG_KEYS = new Set([
  "authorization",
  "accesstoken",
  "bearertoken",
  "token",
  "secret",
  "clientsecret",
  "password",
  "apikey",
  "accesskey",
]);

function rejectInlineSecrets(value, path = "config") {
  if (!value || typeof value !== "object") return;
  for (const [key, nested] of Object.entries(value)) {
    const looksSecret = SECRET_CONFIG_KEYS.has(key.toLowerCase())
      || /(?:authorization|access.?token|refresh.?token|client.?secret|password|api.?key|access.?key)/i.test(key);
    if (looksSecret && !/(?:env|environment)$/i.test(key) && nested !== undefined) {
      throw new TypeError(`${path}.${key} is not allowed; reference an environment variable instead`);
    }
    rejectInlineSecrets(nested, `${path}.${key}`);
  }
}

function normalizeToolPolicy(policy = {}) {
  if (!policy || typeof policy !== "object" || Array.isArray(policy)) {
    throw new TypeError("toolPolicy must be an object mapping tool names to read or write");
  }
  const normalized = new Map();
  for (const [name, access] of Object.entries(policy)) {
    if (!name || (access !== "read" && access !== "write")) {
      throw new TypeError("toolPolicy values must be read or write");
    }
    normalized.set(name, access);
  }
  return normalized;
}

function requireCapability(capabilities, access) {
  if (access === "read" && capabilities.read === false) throw new Error("Upstream MCP read capability is disabled");
  if (access === "write" && capabilities.write !== true) throw new Error("Upstream MCP write capability is disabled");
}

function isSessionError(error) {
  const message = `${error?.message || ""} ${error?.responseBody || ""}`;
  return [400, 404].includes(error?.status)
    && /mcp-session-id|session/i.test(message)
    && /required|invalid|expired|not found|missing/i.test(message);
}

function isAuthenticationError(error) {
  if (error?.status === 401) return true;
  const message = `${error?.message || ""} ${error?.responseBody || ""}`;
  return /\b(invalid[_ -]?token|expired|unauthorized|unauthenticated)\b/i.test(message);
}

export function createUpstreamMcp(config = {}, dependencies = {}) {
  rejectInlineSecrets(config);
  const toolPolicy = normalizeToolPolicy(config.toolPolicy);
  const capabilities = Object.freeze({ read: config.capabilities?.read !== false, write: config.capabilities?.write === true });
  const client = dependencies.client || createMcpHttpClient(config.client || {}, dependencies);
  if (!client || typeof client.listTools !== "function" || typeof client.callTool !== "function") {
    throw new TypeError("client must provide listTools and callTool functions");
  }
  let initialization;

  async function ensureInitialized(options) {
    if (typeof client.initialize !== "function") return;
    if (!initialization) {
      initialization = Promise.resolve(client.initialize({
        ...options,
        clientInfo: { name: "service-ops-console-upstream", version: "1.0.0" },
      })).catch((error) => {
        initialization = undefined;
        throw error;
      });
    }
    await initialization;
  }

  async function recoverAndRetry(operation, options, retried = false) {
    try {
      await ensureInitialized(options);
      return await operation();
    } catch (error) {
      if (retried) throw error;
      if (isAuthenticationError(error) && client.canRefreshAuthentication === true && typeof client.refreshAuthentication === "function") {
        await client.refreshAuthentication(options);
      } else if (!isSessionError(error)) {
        throw error;
      }
      client.resetSession?.();
      initialization = undefined;
      return recoverAndRetry(operation, options, true);
    }
  }

  function classifyTool(name) {
    if (typeof name !== "string" || !name) throw new TypeError("tool name must be a non-empty string");
    const access = toolPolicy.get(name);
    if (!access) throw new Error(`Upstream MCP tool is not classified: ${name}`);
    return access;
  }

  async function listTools(options) {
    requireCapability(capabilities, "read");
    const result = await recoverAndRetry(() => client.listTools(options), options);
    const tools = Array.isArray(result?.tools) ? result.tools : [];
    return {
      ...result,
      tools: tools.filter((tool) => toolPolicy.has(tool.name)).map((tool) => ({
        ...tool,
        access: toolPolicy.get(tool.name),
      })),
    };
  }

  async function callTool(name, args = {}, options = {}) {
    const access = classifyTool(name);
    requireCapability(capabilities, access);
    if (access === "write" && options.confirm !== true) {
      throw new Error("confirm=true is required before calling an upstream write tool");
    }
    return recoverAndRetry(() => client.callTool(name, args, options), options);
  }

  return Object.freeze({ capabilities, classifyTool, listTools, callTool });
}
