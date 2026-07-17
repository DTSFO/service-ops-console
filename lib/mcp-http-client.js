import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import path from "node:path";

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const INLINE_CREDENTIAL_KEYS = new Set([
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

export const DEFAULT_MCP_TIMEOUT_MS = 10_000;
export const MAX_MCP_TIMEOUT_MS = 30_000;
export const DEFAULT_MCP_RESPONSE_BYTES = 1_048_576;
export const MAX_MCP_RESPONSE_BYTES = 2_097_152;
const OAUTH_REFRESH_SKEW_MS = 120_000;

function optionalString(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !value.trim()) throw new TypeError(`${label} must be a non-empty string`);
  return value.trim();
}

function boundedInteger(value, fallback, minimum, maximum, label) {
  const candidate = value === undefined ? fallback : value;
  if (!Number.isInteger(candidate) || candidate < minimum || candidate > maximum) {
    throw new TypeError(`${label} must be an integer from ${minimum} to ${maximum}`);
  }
  return candidate;
}

function environmentName(value, label) {
  if (value === undefined) return undefined;
  if (typeof value !== "string" || !ENVIRONMENT_NAME.test(value)) {
    throw new TypeError(`${label} must be an environment variable name`);
  }
  return value;
}

function rejectInlineCredentials(config) {
  for (const key of Object.keys(config)) {
    const normalized = key.toLowerCase();
    const looksSecret = INLINE_CREDENTIAL_KEYS.has(normalized)
      || /(?:authorization|access.?token|refresh.?token|client.?secret|password|api.?key|access.?key)/i.test(key);
    if (looksSecret && !/(?:env|environment)$/i.test(key) && config[key] !== undefined) {
      throw new TypeError(`${key} is not allowed; reference an environment variable instead`);
    }
  }
}

function isLoopbackHostname(hostname) {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

export function validateMcpEndpoint(value) {
  let endpoint;
  try {
    endpoint = new URL(value);
  } catch {
    throw new TypeError("MCP endpoint must be a valid URL");
  }
  if (endpoint.username || endpoint.password) throw new TypeError("MCP endpoint must not contain credentials");
  if (endpoint.hash) throw new TypeError("MCP endpoint must not contain a fragment");
  if (endpoint.protocol !== "https:" && !(endpoint.protocol === "http:" && isLoopbackHostname(endpoint.hostname))) {
    throw new TypeError("MCP endpoint must use HTTPS; HTTP is allowed only for loopback testing");
  }
  return endpoint;
}

function validateAuthenticationConfig(config) {
  const serverId = optionalString(config.serverId, "serverId");
  const serverName = optionalString(config.serverName, "serverName");
  const authorizationEnv = environmentName(config.authorizationEnv, "authorizationEnv");
  const oauthAccessTokenEnv = environmentName(config.oauthAccessTokenEnv, "oauthAccessTokenEnv");
  const oauthRefreshTokenEnv = environmentName(config.oauthRefreshTokenEnv, "oauthRefreshTokenEnv");
  const oauthClientIdEnv = environmentName(config.oauthClientIdEnv, "oauthClientIdEnv");
  const oauthClientSecretEnv = environmentName(config.oauthClientSecretEnv, "oauthClientSecretEnv");
  const credentialsPathEnv = environmentName(config.credentialsPathEnv, "credentialsPathEnv");
  const credentialsPath = optionalString(config.credentialsPath, "credentialsPath");
  const credentialKey = optionalString(config.credentialKey, "credentialKey");
  const credentialNames = config.credentialNames === undefined ? [] : config.credentialNames;
  if (!Array.isArray(credentialNames) || credentialNames.some((value) => typeof value !== "string" || !value.trim())) {
    throw new TypeError("credentialNames must be an array of non-empty strings");
  }
  if (credentialsPath && credentialsPathEnv) {
    throw new TypeError("Configure credentialsPath or credentialsPathEnv, not both");
  }
  const oauthConfigured = oauthAccessTokenEnv || oauthRefreshTokenEnv || oauthClientIdEnv || oauthClientSecretEnv || config.oauthTokenEndpoint;
  if (authorizationEnv && oauthConfigured) {
    throw new TypeError("Configure authorizationEnv or OAuth environment references, not both");
  }
  if ((oauthRefreshTokenEnv || oauthClientIdEnv || oauthClientSecretEnv || config.oauthTokenEndpoint) && (!oauthRefreshTokenEnv || !oauthClientIdEnv)) {
    throw new TypeError("OAuth refresh requires oauthRefreshTokenEnv and oauthClientIdEnv");
  }
  const oauthTokenEndpoint = config.oauthTokenEndpoint ? validateMcpEndpoint(config.oauthTokenEndpoint).toString() : undefined;
  return {
    authorizationEnv,
    oauthAccessTokenEnv,
    oauthRefreshTokenEnv,
    oauthClientIdEnv,
    oauthClientSecretEnv,
    oauthTokenEndpoint,
    credentialsPath,
    credentialsPathEnv,
    credentialKey,
    credentialNames: credentialNames.map((value) => value.trim()),
    serverId,
    serverName,
  };
}

function isCredentialRecord(value) {
  return Boolean(value && typeof value === "object" && !Array.isArray(value)
    && (value.access_token || value.accessToken || value.refresh_token || value.refreshToken)
    && (value.client_id || value.clientId));
}

function credentialNameCandidates(config, endpoint) {
  return new Set([
    config.credentialKey,
    config.serverId,
    config.serverName,
    ...config.credentialNames,
  ].filter(Boolean).map((value) => String(value).trim().toLowerCase()).concat(endpoint.toString().toLowerCase()));
}

function isMatchingCredential(value, candidates, endpoint) {
  if (!isCredentialRecord(value)) return false;
  const names = [value.server_name, value.serverName, value.name, value.id]
    .filter(Boolean)
    .map((item) => String(item).trim().toLowerCase());
  if (names.some((item) => candidates.has(item))) return true;
  const credentialUrl = value.server_url || value.serverUrl || value.url;
  if (!credentialUrl) return false;
  try {
    return new URL(credentialUrl).toString() === endpoint.toString();
  } catch {
    return false;
  }
}

function findCredentialEntry(store, config, endpoint) {
  if (!store || typeof store !== "object" || Array.isArray(store)) return null;
  if (isCredentialRecord(store)) return { key: null, record: store };
  const candidates = credentialNameCandidates(config, endpoint);
  const nested = store.servers && typeof store.servers === "object" && !Array.isArray(store.servers) ? store.servers : {};
  for (const [key, value] of Object.entries(nested)) {
    if (candidates.has(String(key).trim().toLowerCase()) || isMatchingCredential(value, candidates, endpoint)) {
      return { key: `servers.${key}`, record: value };
    }
  }
  for (const [key, value] of Object.entries(store)) {
    if (key === "servers") continue;
    if (candidates.has(String(key).trim().toLowerCase()) || isMatchingCredential(value, candidates, endpoint)) {
      return { key, record: value };
    }
  }
  return null;
}

function assignCredentialRecord(store, entryKey, record) {
  if (!entryKey) return record;
  if (entryKey.startsWith("servers.")) {
    const key = entryKey.slice("servers.".length);
    return { ...store, servers: { ...(store.servers || {}), [key]: record } };
  }
  return { ...store, [entryKey]: record };
}

function writeCredentialStore(filePath, store) {
  const temporaryPath = path.join(path.dirname(filePath), `.${path.basename(filePath)}.${process.pid}.${Date.now()}.tmp`);
  writeFileSync(temporaryPath, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporaryPath, filePath);
  try {
    chmodSync(filePath, 0o600);
  } catch {
    // Permission normalization is best-effort on filesystems without POSIX modes.
  }
}

function credentialExpiryMs(record) {
  const value = Number(record?.expires_at ?? record?.expiresAt ?? 0);
  if (!value) return 0;
  return value < 100_000_000_000 ? value * 1000 : value;
}

function formatAuthorization(value) {
  const text = String(value || "").trim();
  if (!text) return undefined;
  return /^(bearer|basic)\s+/i.test(text) ? text : `Bearer ${text}`;
}

function createAuthenticationManager(config, { endpoint, env, fetchImpl, timeoutMs, maximumResponseBytes }) {
  let accessToken = config.oauthAccessTokenEnv ? env[config.oauthAccessTokenEnv] : undefined;
  let refreshToken = config.oauthRefreshTokenEnv ? env[config.oauthRefreshTokenEnv] : undefined;
  let expiresAt = Number.POSITIVE_INFINITY;
  let tokenEndpoint = config.oauthTokenEndpoint;
  let refreshPromise;

  function configuredCredentialsPath() {
    if (config.credentialsPathEnv) {
      const value = env[config.credentialsPathEnv];
      if (!value) throw new Error(`Missing environment variable: ${config.credentialsPathEnv}`);
      return path.resolve(value);
    }
    return config.credentialsPath ? path.resolve(config.credentialsPath) : undefined;
  }

  function loadCredentialContext() {
    const filePath = configuredCredentialsPath();
    if (!filePath) return null;
    let store;
    try {
      store = parseJson(readFileSync(filePath, "utf8"));
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw new Error(`Failed to read MCP OAuth credentials: ${error.message}`, { cause: error });
    }
    const entry = findCredentialEntry(store, config, endpoint);
    return entry ? { filePath, store, entry } : null;
  }

  async function discoverTokenEndpoint(signal) {
    if (tokenEndpoint) return tokenEndpoint;
    const metadataUrl = new URL("/.well-known/oauth-authorization-server", endpoint);
    try {
      const response = await fetchImpl(metadataUrl, {
        headers: { Accept: "application/json" },
        redirect: "error",
        signal: createRequestSignal(timeoutMs, signal),
      });
      const body = await readBoundedBody(response, maximumResponseBytes);
      if (response.ok) {
        const metadata = parseJson(body);
        if (metadata?.token_endpoint) tokenEndpoint = validateMcpEndpoint(metadata.token_endpoint).toString();
      }
    } catch (error) {
      if (error?.name === "AbortError" || error?.name === "TimeoutError") throw error;
      // Match the deployed client: failed discovery falls back to the conventional origin /token endpoint.
    }
    tokenEndpoint ||= validateMcpEndpoint(new URL("/token", endpoint).toString()).toString();
    return tokenEndpoint;
  }

  async function performRefresh({ signal } = {}) {
    const credentialContext = loadCredentialContext();
    const record = credentialContext?.entry.record || {};
    refreshToken ||= (config.oauthRefreshTokenEnv ? env[config.oauthRefreshTokenEnv] : undefined)
      || record.refresh_token || record.refreshToken;
    const clientId = (config.oauthClientIdEnv ? env[config.oauthClientIdEnv] : undefined)
      || record.client_id || record.clientId;
    const clientSecret = (config.oauthClientSecretEnv ? env[config.oauthClientSecretEnv] : undefined)
      || record.client_secret || record.clientSecret;
    if (!refreshToken) throw new Error("OAuth refresh requires a configured refresh token");
    if (!clientId) throw new Error("OAuth refresh requires a configured client id");
    if (config.oauthClientSecretEnv && !clientSecret) throw new Error(`Missing environment variable: ${config.oauthClientSecretEnv}`);

    const body = new URLSearchParams({ grant_type: "refresh_token", refresh_token: refreshToken, client_id: clientId });
    if (clientSecret) body.set("client_secret", clientSecret);
    const response = await fetchImpl(await discoverTokenEndpoint(signal), {
      method: "POST",
      headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded" },
      body: body.toString(),
      redirect: "error",
      signal: createRequestSignal(timeoutMs, signal),
    });
    const raw = await readBoundedBody(response, maximumResponseBytes);
    if (!response.ok) throw new Error(`OAuth token endpoint returned HTTP ${response.status}`);
    const payload = parseJson(raw);
    if (!payload?.access_token) throw new Error("OAuth token refresh did not return access_token");
    accessToken = payload.access_token;
    refreshToken = payload.refresh_token || refreshToken;
    expiresAt = payload.expires_in ? Date.now() + Number(payload.expires_in) * 1000 : Number.POSITIVE_INFINITY;
    if (credentialContext) {
      const nextRecord = {
        ...record,
        access_token: accessToken,
        refresh_token: refreshToken,
        expires_at: Number.isFinite(expiresAt) ? expiresAt : (record.expires_at ?? record.expiresAt),
        scopes: payload.scope ? String(payload.scope).split(/\s+/).filter(Boolean) : record.scopes,
      };
      writeCredentialStore(
        credentialContext.filePath,
        assignCredentialRecord(credentialContext.store, credentialContext.entry.key, nextRecord),
      );
    }
    return accessToken;
  }

  async function refresh(options) {
    if (!config.oauthRefreshTokenEnv && !configuredCredentialsPath()) throw new Error("OAuth refresh is not configured");
    if (!refreshPromise) refreshPromise = performRefresh(options).finally(() => { refreshPromise = undefined; });
    return refreshPromise;
  }

  async function authorization(options = {}) {
    if (config.authorizationEnv) {
      const value = env[config.authorizationEnv];
      if (!value) throw new Error(`Missing environment variable: ${config.authorizationEnv}`);
      return formatAuthorization(value);
    }
    const usesEnvironmentOAuth = Boolean(config.oauthAccessTokenEnv || config.oauthRefreshTokenEnv || config.oauthClientIdEnv || config.oauthClientSecretEnv);
    let fileCredentialAvailable = false;
    if (!usesEnvironmentOAuth) {
      const credentialContext = loadCredentialContext();
      const record = credentialContext?.entry.record;
      if (record) {
        fileCredentialAvailable = true;
        accessToken = record.access_token || record.accessToken;
        refreshToken = record.refresh_token || record.refreshToken;
        expiresAt = credentialExpiryMs(record) || Number.POSITIVE_INFINITY;
      }
    }
    if ((config.oauthRefreshTokenEnv || fileCredentialAvailable)
      && (!accessToken || expiresAt <= Date.now() + OAUTH_REFRESH_SKEW_MS)) await refresh(options);
    if (!accessToken && config.oauthAccessTokenEnv) accessToken = env[config.oauthAccessTokenEnv];
    if (config.oauthAccessTokenEnv && !accessToken) throw new Error(`Missing environment variable: ${config.oauthAccessTokenEnv}`);
    return accessToken ? `Bearer ${accessToken}` : undefined;
  }

  return { authorization, refresh, canRefresh: Boolean(config.oauthRefreshTokenEnv || config.credentialsPath || config.credentialsPathEnv) };
}

function buildEnvironmentHeaders(mapping, env) {
  if (mapping === undefined) return {};
  if (!mapping || typeof mapping !== "object" || Array.isArray(mapping)) {
    throw new TypeError("headersFromEnv must be an object of header names to environment variable names");
  }
  const headers = {};
  for (const [header, rawName] of Object.entries(mapping)) {
    const name = environmentName(rawName, `headersFromEnv.${header}`);
    try {
      new Headers([[header, "validation"]]);
    } catch {
      throw new TypeError(`Invalid HTTP header name: ${header}`);
    }
    const value = env[name];
    if (!value) throw new Error(`Missing environment variable: ${name}`);
    headers[header] = value;
  }
  return headers;
}

async function readBoundedBody(response, maximumBytes) {
  const contentLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maximumBytes) {
    throw new Error(`MCP response exceeds ${maximumBytes} bytes`);
  }

  if (!response.body) return "";
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
        throw new Error(`MCP response exceeds ${maximumBytes} bytes`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(body);
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error("MCP endpoint returned invalid JSON");
  }
}

function parseResponseBody(response, body) {
  const contentType = response.headers.get("content-type")?.toLowerCase() || "";
  if (!contentType.includes("text/event-stream")) return parseJson(body);

  const payloads = body
    .split(/\r?\n\r?\n/)
    .map((event) => event.split(/\r?\n/)
      .filter((line) => line.startsWith("data:"))
      .map((line) => line.slice(5).replace(/^ /, ""))
      .join("\n")
      .trim())
    .filter((value) => value && value !== "[DONE]");
  if (payloads.length === 0) throw new Error("MCP endpoint returned an empty event stream");
  const messages = payloads.map(parseJson);
  return messages.find((message) => message && (message.result !== undefined || message.error)) || messages[0];
}

function createRequestSignal(timeoutMs, externalSignal) {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  return externalSignal ? AbortSignal.any([timeoutSignal, externalSignal]) : timeoutSignal;
}

export function createMcpHttpClient(config = {}, dependencies = {}) {
  rejectInlineCredentials(config);
  const endpoint = validateMcpEndpoint(config.endpoint);
  const authenticationConfig = validateAuthenticationConfig(config);
  const timeoutMs = boundedInteger(config.timeoutMs, DEFAULT_MCP_TIMEOUT_MS, 100, MAX_MCP_TIMEOUT_MS, "timeoutMs");
  const maximumResponseBytes = boundedInteger(
    config.maximumResponseBytes,
    DEFAULT_MCP_RESPONSE_BYTES,
    1_024,
    MAX_MCP_RESPONSE_BYTES,
    "maximumResponseBytes",
  );
  const fetchImpl = dependencies.fetchImpl || globalThis.fetch;
  const env = dependencies.env || process.env;
  const nextId = dependencies.nextId || (() => crypto.randomUUID());
  if (typeof fetchImpl !== "function") throw new TypeError("fetchImpl must be a function");
  if (typeof nextId !== "function") throw new TypeError("nextId must be a function");
  const authentication = createAuthenticationManager(authenticationConfig, {
    endpoint,
    env,
    fetchImpl,
    timeoutMs,
    maximumResponseBytes,
  });

  let sessionId;
  let protocolVersion;

  async function send(message, { signal } = {}) {
    const headers = new Headers({
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      ...buildEnvironmentHeaders(config.headersFromEnv, env),
    });
    const authorization = await authentication.authorization({ signal });
    if (authorization) headers.set("Authorization", authorization);
    if (sessionId) headers.set("Mcp-Session-Id", sessionId);
    if (protocolVersion) headers.set("MCP-Protocol-Version", protocolVersion);

    let response;
    try {
      response = await fetchImpl(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(message),
        redirect: "error",
        signal: createRequestSignal(timeoutMs, signal),
      });
    } catch (cause) {
      if (cause?.name === "AbortError" || cause?.name === "TimeoutError") {
        throw new Error(`MCP request timed out after ${timeoutMs}ms`, { cause });
      }
      throw new Error("MCP request failed", { cause });
    }

    const responseSessionId = response.headers.get("mcp-session-id");
    if (responseSessionId) sessionId = responseSessionId;
    const body = await readBoundedBody(response, maximumResponseBytes);
    if (!response.ok) {
      const error = new Error(`MCP endpoint returned HTTP ${response.status}`);
      error.status = response.status;
      error.responseBody = body.slice(0, 4_096);
      throw error;
    }
    if (message.id === undefined && !body) return null;
    if (!body) throw new Error("MCP endpoint returned an empty response");
    return parseResponseBody(response, body);
  }

  async function request(method, params, options) {
    if (typeof method !== "string" || !method) throw new TypeError("method must be a non-empty string");
    const id = nextId();
    const response = await send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }, options);
    if (!response || response.jsonrpc !== "2.0" || response.id !== id) {
      throw new Error("MCP endpoint returned a mismatched JSON-RPC response");
    }
    if (response.error) {
      const rpcError = new Error(response.error.message || "MCP JSON-RPC error");
      rpcError.code = response.error.code;
      rpcError.data = response.error.data;
      throw rpcError;
    }
    if (!("result" in response)) throw new Error("MCP endpoint returned a JSON-RPC response without a result");
    return response.result;
  }

  async function notify(method, params, options) {
    if (typeof method !== "string" || !method) throw new TypeError("method must be a non-empty string");
    return send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) }, options);
  }

  async function initialize(options = {}) {
    const requestedProtocolVersion = options.protocolVersion || config.protocolVersion || "2024-11-05";
    const result = await request("initialize", {
      protocolVersion: requestedProtocolVersion,
      capabilities: options.capabilities || {},
      clientInfo: options.clientInfo || { name: "service-ops-console-http-client", version: "1.0.0" },
    }, options);
    protocolVersion = result.protocolVersion || requestedProtocolVersion;
    await notify("notifications/initialized", undefined, options);
    return result;
  }

  return Object.freeze({
    endpoint: endpoint.toString(),
    initialize,
    notify,
    request,
    listTools: (options) => request("tools/list", {}, options),
    callTool: (name, args = {}, options) => request("tools/call", { name, arguments: args }, options),
    getSessionId: () => sessionId,
    resetSession: () => { sessionId = undefined; protocolVersion = undefined; },
    canRefreshAuthentication: authentication.canRefresh,
    refreshAuthentication: (options) => authentication.refresh(options),
  });
}
