import http from "node:http";

import express from "express";
import rateLimit from "express-rate-limit";
import session from "express-session";
import createFileStore from "session-file-store";

import { createAppContext } from "../lib/app-context.js";
import { SCOPE_DEFINITIONS } from "../lib/agent-tokens.js";
import { issueCsrfToken, requireCsrf, requireSameOrigin } from "../lib/csrf.js";
import { OperationError } from "../lib/operations.js";
import { verifyPassword } from "../lib/password.js";
import { createMcpServer } from "../mcp/server.js";

const FileStore = createFileStore(session);
const MAX_BODY = "16kb";
const PUBLIC_ACCESS = Object.freeze({
  actor: "public-dashboard",
  scopes: ["services:read", "services:status", "updates:read"],
});

function loopback(hostname) {
  return new Set(["localhost", "127.0.0.1", "::1", "[::1]"]).has(hostname);
}

function validateSecurityConfiguration(runtime) {
  if (!runtime.sessionSecret || runtime.sessionSecret.length < 32) {
    throw new Error("OPS_SESSION_SECRET must contain at least 32 characters");
  }
  if (!runtime.adminPasswordHash?.startsWith("$argon2")) {
    throw new Error("OPS_ADMIN_PASSWORD_HASH must contain an Argon2 password hash");
  }
  const publicUrl = new URL(runtime.publicUrl);
  if (publicUrl.protocol !== "https:" && !(publicUrl.protocol === "http:" && loopback(publicUrl.hostname))) {
    throw new Error("OPS_PUBLIC_URL must use HTTPS except for loopback development");
  }
  return publicUrl;
}

function asyncRoute(handler) {
  return (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
}

function sessionRegenerate(req) {
  return new Promise((resolve, reject) => req.session.regenerate((error) => error ? reject(error) : resolve()));
}

function sessionDestroy(req) {
  return new Promise((resolve, reject) => req.session.destroy((error) => error ? reject(error) : resolve()));
}

function adminAccess(req) {
  return { isAdmin: true, actor: `admin:${req.session.adminUsername}` };
}

function requestIp(req) {
  return req.ip || req.socket?.remoteAddress || null;
}

function accessMiddleware(context) {
  return (req, res, next) => {
    const header = req.get("authorization") || "";
    if (header) {
      const match = header.match(/^Bearer\s+(.+)$/i);
      if (!match) return res.status(401).json({ error: "invalid_authorization", message: "Use a Bearer token" });
      const record = context.tokenManager.verify(match[1], { ip: requestIp(req) });
      if (!record) return res.status(401).json({ error: "invalid_token", message: "Agent token is invalid or expired" });
      req.opsAccess = { actor: `agent:${record.id}`, tokenId: record.id, scopes: record.scopes, isAdmin: false };
      return next();
    }
    if (req.session?.isAdmin === true) {
      req.opsAccess = adminAccess(req);
      return next();
    }
    return res.status(401).json({ error: "authentication_required" });
  };
}

function bearerOnlyMiddleware(context) {
  return (req, res, next) => {
    const match = (req.get("authorization") || "").match(/^Bearer\s+(.+)$/i);
    if (!match) return res.status(401).json({ error: "bearer_token_required" });
    const record = context.tokenManager.verify(match[1], { ip: requestIp(req) });
    if (!record) return res.status(401).json({ error: "invalid_token" });
    req.opsAccess = { actor: `agent:${record.id}`, tokenId: record.id, scopes: record.scopes, isAdmin: false };
    return next();
  };
}

function requireAdminSession(req, res, next) {
  if (req.session?.isAdmin !== true) return res.status(401).json({ error: "administrator_session_required" });
  req.opsAccess = adminAccess(req);
  return next();
}

function adminMutation(publicUrl) {
  return [requireSameOrigin(publicUrl), requireCsrf];
}

function requireCsrfForAdminSession(req, res, next) {
  return req.session?.isAdmin === true ? requireCsrf(req, res, next) : next();
}

function configurationDto(context, access) {
  return {
    ...context.operations.getConfiguration(access),
    storageConfigured: Boolean(context.runtime.dataDir),
    stdioScopes: [...context.runtime.stdioScopes],
  };
}

function dashboardHealthDto(payload) {
  return {
    statuses: (payload?.statuses || []).map((entry) => ({
      id: entry.id,
      status: entry.status,
      healthy: entry.healthy,
      checkedAt: entry.checkedAt,
      runtime: entry.runtime ? {
        ok: entry.runtime.ok,
        status: entry.runtime.status,
      } : null,
      checks: (entry.checks || []).map((check) => ({
        type: check.type,
        ok: check.ok,
        status: check.status,
        ...(Number.isInteger(check.httpStatus) ? { httpStatus: check.httpStatus } : {}),
        ...(Number.isInteger(check.exitCode) ? { exitCode: check.exitCode } : {}),
        ...(check.commandLabel ? { commandLabel: check.commandLabel } : {}),
      })),
    })),
  };
}

export function createExpressApp({
  context = createAppContext(),
  sessionStore,
  verifyPasswordImpl = verifyPassword,
  loginLimiter,
} = {}) {
  const publicUrl = validateSecurityConfiguration(context.runtime);
  const app = express();
  if (publicUrl.protocol === "https:") app.set("trust proxy", 1);
  app.disable("x-powered-by");
  app.use(express.json({ limit: MAX_BODY, strict: true }));
  app.use(session({
    name: "service_ops_session",
    secret: context.runtime.sessionSecret,
    resave: false,
    saveUninitialized: false,
    rolling: context.runtime.sessionRolling !== false,
    store: sessionStore || new FileStore({
      path: context.runtime.sessionPath,
      ttl: context.runtime.sessionTtlSeconds || 30 * 24 * 60 * 60,
      retries: 0,
    }),
    cookie: {
      httpOnly: true,
      sameSite: "strict",
      secure: publicUrl.protocol === "https:",
      maxAge: context.runtime.sessionCookieMaxAgeMs || 30 * 24 * 60 * 60 * 1000,
    },
  }));

  const limitLogin = loginLimiter || rateLimit({
    windowMs: 15 * 60 * 1000,
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    skipSuccessfulRequests: true,
  });
  const sameOrigin = requireSameOrigin(context.runtime.publicUrl);
  const authenticate = accessMiddleware(context);
  const bearerOnly = bearerOnlyMiddleware(context);
  const opsMutation = [sameOrigin, requireCsrfForAdminSession];
  const mcpLimiter = rateLimit({ windowMs: 60_000, limit: 120, standardHeaders: "draft-8", legacyHeaders: false });
  const dashboardRead = context.runtime.dashboardAuthRequired === true
    ? authenticate
    : (_req, _res, next) => next();

  app.get("/api/healthz", (_req, res) => res.json({ ok: true }));
  app.get("/api/inventory", dashboardRead, (_req, res) => res.json(context.operations.publicInventory()));
  app.get("/api/statuses", dashboardRead, asyncRoute(async (_req, res) => res.json(await context.operations.getServiceStatus("", PUBLIC_ACCESS))));
  app.get("/api/health", dashboardRead, asyncRoute(async (_req, res) => {
    const payload = await context.operations.getServiceHealth("", PUBLIC_ACCESS);
    return res.json(dashboardHealthDto(payload));
  }));
  app.get("/api/versions", dashboardRead, (_req, res) => res.json(context.operations.getServiceVersions("", PUBLIC_ACCESS)));
  app.post("/api/versions/check", authenticate, ...opsMutation, asyncRoute(async (req, res) => {
    const serviceIds = Array.isArray(req.body?.serviceIds) ? req.body.serviceIds : [];
    const operation = serviceIds.length && context.operations.checkServiceUpdatesBatch
      ? context.operations.checkServiceUpdatesBatch(serviceIds, req.opsAccess)
      : context.operations.checkServiceUpdates("", req.opsAccess);
    return res.json(await operation);
  }));
  app.post("/api/versions/:id/check", authenticate, ...opsMutation, asyncRoute(async (req, res) => res.json(await context.operations.checkServiceUpdates(req.params.id, req.opsAccess))));
  app.post("/api/services/:id/control", authenticate, ...opsMutation, asyncRoute(async (req, res) => res.json(await context.operations.controlService(req.params.id, req.body?.action, req.body, req.opsAccess))));

  app.get("/api/session", (req, res) => res.json(req.session?.isAdmin === true
    ? { authenticated: true, username: req.session.adminUsername, csrfToken: issueCsrfToken(req.session), dashboardAuthRequired: context.runtime.dashboardAuthRequired === true }
    : { authenticated: false, dashboardAuthRequired: context.runtime.dashboardAuthRequired === true }));
  app.post("/api/login", sameOrigin, limitLogin, asyncRoute(async (req, res) => {
    const username = String(req.body?.username || "");
    const password = String(req.body?.password || "");
    const valid = username === context.runtime.adminUsername
      && await verifyPasswordImpl(context.runtime.adminPasswordHash, password);
    if (!valid) return res.status(401).json({ error: "invalid_credentials" });
    await sessionRegenerate(req);
    req.session.isAdmin = true;
    req.session.adminUsername = context.runtime.adminUsername;
    return res.json({ authenticated: true, username: req.session.adminUsername, csrfToken: issueCsrfToken(req.session) });
  }));
  app.post("/api/logout", requireAdminSession, ...adminMutation(context.runtime.publicUrl), asyncRoute(async (req, res) => {
    await sessionDestroy(req);
    res.clearCookie("service_ops_session");
    return res.status(204).end();
  }));

  app.get("/api/admin/configuration", requireAdminSession, (req, res) => res.json(configurationDto(context, req.opsAccess)));
  app.get("/api/admin/hosts", requireAdminSession, (req, res) => res.json(context.operations.listHosts(req.opsAccess)));
  app.post("/api/admin/hosts", requireAdminSession, ...adminMutation(context.runtime.publicUrl), (req, res) => res.status(201).json(context.operations.createHost(req.body, req.opsAccess)));
  app.patch("/api/admin/hosts/:id", requireAdminSession, ...adminMutation(context.runtime.publicUrl), (req, res) => res.json(context.operations.updateHost(req.params.id, req.body, req.opsAccess)));
  app.delete("/api/admin/hosts/:id", requireAdminSession, ...adminMutation(context.runtime.publicUrl), (req, res) => res.json({ deleted: context.operations.deleteHost(req.params.id, req.body, req.opsAccess) }));

  app.get("/api/admin/groups", requireAdminSession, (req, res) => res.json(context.operations.listGroups(req.opsAccess)));
  app.post("/api/admin/groups", requireAdminSession, ...adminMutation(context.runtime.publicUrl), (req, res) => res.status(201).json(context.operations.createGroup(req.body, req.opsAccess)));
  app.patch("/api/admin/groups/:id", requireAdminSession, ...adminMutation(context.runtime.publicUrl), (req, res) => res.json(context.operations.updateGroup(req.params.id, req.body, req.opsAccess)));
  app.delete("/api/admin/groups/:id", requireAdminSession, ...adminMutation(context.runtime.publicUrl), (req, res) => res.json({ deleted: context.operations.deleteGroup(req.params.id, req.body, req.opsAccess) }));

  app.get("/api/admin/services", requireAdminSession, (req, res) => res.json(context.operations.listServices({ includeDeleted: req.query.includeDeleted === "true" }, req.opsAccess)));
  app.post("/api/admin/services", requireAdminSession, ...adminMutation(context.runtime.publicUrl), (req, res) => res.status(201).json(context.operations.createService(req.body, req.opsAccess)));
  app.patch("/api/admin/services/:id", requireAdminSession, ...adminMutation(context.runtime.publicUrl), (req, res) => res.json(context.operations.updateService(req.params.id, req.body, req.opsAccess)));
  app.delete("/api/admin/services/:id", requireAdminSession, ...adminMutation(context.runtime.publicUrl), (req, res) => res.json(context.operations.deleteService(req.params.id, req.body, req.opsAccess)));
  app.post("/api/admin/services/:id/restore", requireAdminSession, ...adminMutation(context.runtime.publicUrl), (req, res) => res.json(context.operations.restoreService(req.params.id, req.opsAccess)));
  app.post("/api/admin/services/:id/purge", requireAdminSession, ...adminMutation(context.runtime.publicUrl), (req, res) => res.json(context.operations.purgeService(req.params.id, req.body, req.opsAccess)));

  app.get("/api/admin/agent-tokens", requireAdminSession, (req, res) => res.json({
    tokens: context.operations.listAgentTokens(req.opsAccess),
    scopes: SCOPE_DEFINITIONS,
  }));
  app.post("/api/admin/agent-tokens", requireAdminSession, ...adminMutation(context.runtime.publicUrl), (req, res) => res.status(201).json(context.operations.createAgentToken(req.body, req.opsAccess)));
  app.patch("/api/admin/agent-tokens/:id", requireAdminSession, ...adminMutation(context.runtime.publicUrl), (req, res) => res.json(context.operations.updateAgentToken(req.params.id, req.body, req.opsAccess)));
  app.delete("/api/admin/agent-tokens/:id", requireAdminSession, ...adminMutation(context.runtime.publicUrl), (req, res) => res.json(context.operations.revokeAgentToken(req.params.id, req.body, req.opsAccess)));
  app.get("/api/admin/audit", requireAdminSession, (req, res) => res.json(context.operations.listAuditLogs(req.query, req.opsAccess)));
  app.get("/api/admin/ssh-hosts", requireAdminSession, (req, res) => res.json({ hosts: context.operations.listSshHosts(req.opsAccess) }));
  app.post("/api/admin/ssh-hosts/:id/probe", requireAdminSession, ...adminMutation(context.runtime.publicUrl), asyncRoute(async (req, res) => res.json(await context.operations.probeSsh(req.params.id, req.body, req.opsAccess))));
  app.post("/api/admin/ssh-hosts/:id/execute", requireAdminSession, ...adminMutation(context.runtime.publicUrl), asyncRoute(async (req, res) => res.json(await context.operations.executeSsh(req.params.id, req.body?.command, req.body, req.opsAccess))));
  app.get("/api/admin/cloudflare", requireAdminSession, (req, res) => res.json({ servers: context.operations.listCloudflareServers(req.opsAccess) }));
  app.get("/api/admin/cloudflare/:id/tools", requireAdminSession, asyncRoute(async (req, res) => res.json(await context.operations.listCloudflareTools(req.params.id, req.opsAccess))));
  app.post("/api/admin/cloudflare/:id/tools/:tool/call", requireAdminSession, ...adminMutation(context.runtime.publicUrl), asyncRoute(async (req, res) => res.json(await context.operations.callCloudflareTool(req.params.id, req.params.tool, req.body?.arguments || {}, req.body, req.opsAccess))));

  app.post("/mcp", mcpLimiter, bearerOnly, asyncRoute(async (req, res) => {
    const mcp = createMcpServer({
      operations: context.operations,
      scopes: req.opsAccess.scopes,
      privilegedOperations: context.runtime.privilegedOperations === true,
      isAdmin: false,
      actor: req.opsAccess.actor,
    });
    const batch = Array.isArray(req.body);
    const messages = batch ? req.body : [req.body];
    const responses = [];
    for (const message of messages) {
      const response = await mcp.handleRequest(message);
      if (response !== null) responses.push(response);
    }
    if (batch && responses.length === 0) return res.status(202).end();
    if (batch) return res.json(responses);
    if (responses.length === 0) return res.status(202).end();
    return res.json(responses[0]);
  }));

  app.use("/api/ops", authenticate);
  app.get("/api/ops/services", (req, res) => res.json(context.operations.listServices({ query: req.query.query }, req.opsAccess)));
  app.post("/api/ops/services", ...opsMutation, (req, res) => res.status(201).json(context.operations.createService(req.body, req.opsAccess)));
  app.patch("/api/ops/services/:id", ...opsMutation, (req, res) => res.json(context.operations.updateService(req.params.id, req.body, req.opsAccess)));
  app.delete("/api/ops/services/:id", ...opsMutation, (req, res) => res.json(context.operations.deleteService(req.params.id, req.body, req.opsAccess)));
  app.get("/api/ops/services/:id/location", asyncRoute(async (req, res) => res.json(await context.operations.locateService(req.params.id, req.opsAccess))));
  app.get("/api/ops/services/:id/status", asyncRoute(async (req, res) => res.json(await context.operations.getServiceStatus(req.params.id, req.opsAccess))));
  app.get("/api/ops/services/:id/health", asyncRoute(async (req, res) => res.json(await context.operations.getServiceHealth(req.params.id, req.opsAccess))));
  app.get("/api/ops/services/:id/versions", (req, res) => res.json(context.operations.getServiceVersions(req.params.id, req.opsAccess)));
  app.post("/api/ops/services/:id/versions/check", ...opsMutation, asyncRoute(async (req, res) => res.json(await context.operations.checkServiceUpdates(req.params.id, req.opsAccess))));
  app.get("/api/ops/services/:id/update-method", (req, res) => res.json(context.operations.getUpdateMethod(req.params.id, req.opsAccess)));
  app.get("/api/ops/services/:id/update-plan", (req, res) => res.json(context.operations.planServiceUpdate(req.params.id, req.opsAccess)));
  app.post("/api/ops/services/:id/update-apply", ...opsMutation, asyncRoute(async (req, res) => res.json(await context.operations.applyServiceUpdate(req.params.id, req.body, req.opsAccess))));
  app.post("/api/ops/services/:id/control", ...opsMutation, asyncRoute(async (req, res) => res.json(await context.operations.controlService(req.params.id, req.body?.action, req.body, req.opsAccess))));

  app.get("/api/ops/ssh/hosts", (req, res) => res.json(context.operations.listSshHosts(req.opsAccess)));
  app.post("/api/ops/ssh/hosts/:id/probe", ...opsMutation, asyncRoute(async (req, res) => res.json(await context.operations.probeSsh(req.params.id, req.body, req.opsAccess))));
  app.post("/api/ops/ssh/hosts/:id/execute", ...opsMutation, asyncRoute(async (req, res) => res.json(await context.operations.executeSsh(req.params.id, req.body?.command, req.body, req.opsAccess))));
  app.get("/api/ops/cloudflare/servers", (req, res) => res.json(context.operations.listCloudflareServers(req.opsAccess)));
  app.get("/api/ops/cloudflare/servers/:id/tools", asyncRoute(async (req, res) => res.json(await context.operations.listCloudflareTools(req.params.id, req.opsAccess))));
  app.post("/api/ops/cloudflare/servers/:id/tools/:tool", ...opsMutation, asyncRoute(async (req, res) => res.json(await context.operations.callCloudflareTool(req.params.id, req.params.tool, req.body?.arguments || {}, req.body, req.opsAccess))));

  app.use((req, res) => res.status(404).json({ error: "not_found" }));
  app.use((error, _req, res, _next) => {
    if (error?.type === "entity.too.large") return res.status(413).json({ error: "request_too_large" });
    if (error instanceof SyntaxError && Object.hasOwn(error, "body")) return res.status(400).json({ error: "invalid_json" });
    const status = error instanceof OperationError ? error.status : 500;
    const code = error instanceof OperationError ? error.code : "internal_error";
    return res.status(status).json({ error: code, message: status === 500 ? "Internal server error" : error.message });
  });

  app.locals.context = context;
  return app;
}

export function createApiServer(options = {}) {
  return http.createServer(createExpressApp(options));
}

export function getNextDailyCheckAt({ time = "13:00", timezoneOffsetMinutes = 480, now = new Date() } = {}) {
  const [hour, minute] = time.split(":").map(Number);
  const offsetMs = timezoneOffsetMinutes * 60 * 1000;
  const localNow = new Date(now.getTime() + offsetMs);
  let targetMs = Date.UTC(localNow.getUTCFullYear(), localNow.getUTCMonth(), localNow.getUTCDate(), hour, minute) - offsetMs;
  if (targetMs <= now.getTime()) targetMs += 24 * 60 * 60 * 1000;
  return new Date(targetMs);
}

export function startUpdateScheduler(context) {
  const intervalMs = Number(context.runtime.updateCheckIntervalMs || 0);
  const dailyTime = context.runtime.updateCheckDailyTime || "";
  if (!intervalMs && !dailyTime) return () => {};
  let running = false;
  let timer = null;
  let stopped = false;
  const run = async () => {
    if (running) return;
    running = true;
    try {
      await context.operations.checkServiceUpdates("", {
        isAdmin: true,
        actor: "scheduler:update-check",
        scopes: ["updates:check", "updates:read"],
      });
    } catch (error) {
      console.error(`scheduled update check failed: ${error.message}`);
    } finally {
      running = false;
    }
  };
  const scheduleDaily = () => {
    if (stopped) return;
    const target = getNextDailyCheckAt({
      time: dailyTime,
      timezoneOffsetMinutes: context.runtime.updateCheckTimezoneOffsetMinutes ?? 480,
    });
    context.operations.setNextAutoCheckAt?.(target);
    timer = setTimeout(async () => {
      await run();
      scheduleDaily();
    }, Math.max(1000, target.getTime() - Date.now()));
    timer.unref?.();
  };
  if (dailyTime) {
    scheduleDaily();
  } else {
    const target = new Date(Date.now() + intervalMs);
    context.operations.setNextAutoCheckAt?.(target);
    void run();
    timer = setInterval(() => {
      context.operations.setNextAutoCheckAt?.(new Date(Date.now() + intervalMs));
      void run();
    }, intervalMs);
    timer.unref?.();
  }
  return () => {
    stopped = true;
    if (dailyTime) clearTimeout(timer);
    else clearInterval(timer);
    context.operations.setNextAutoCheckAt?.(null);
  };
}

if (process.argv[1]?.endsWith("server.mjs")) {
  const context = createAppContext();
  const server = createApiServer({ context });
  const stopUpdateScheduler = startUpdateScheduler(context);
  server.on("close", stopUpdateScheduler);
  server.listen(context.runtime.port, context.runtime.bindHost, () => {
    console.log(`service-ops-console API listening on ${context.runtime.bindHost}:${context.runtime.port}`);
  });
}
