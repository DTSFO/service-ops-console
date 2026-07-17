import fs from "node:fs";

import "dotenv/config";

import { createAgentTokenManager } from "./agent-tokens.js";
import {
  loadCloudflareServers,
  loadInventory,
  loadSshHosts,
  runtimeConfig,
} from "./config.js";
import { createOperations } from "./operations.js";
import { createRuntimeAdapters } from "./runtime-adapters.js";
import { createServiceStore } from "./service-store.js";
import { createSshExecutor } from "./ssh-executor.js";
import { createSshHostRegistry } from "./ssh-host-registry.js";
import { createUpstreamMcp } from "./upstream-mcp.js";

function seedStore(store, inventory) {
  const hasData = store.listHosts().length || store.listGroups().length || store.listServices({ includeDeleted: true }).length;
  if (hasData) return false;

  const seed = store.db.transaction(() => {
    for (const host of inventory.hosts) {
      const sshHostId = host.control.mode === "ssh" ? host.control.sshHostId : null;
      store.createHost({
        id: host.id,
        name: host.name,
        description: host.description,
        mode: host.control.mode,
        target: sshHostId,
        metadata: sshHostId ? { sshHostId } : {},
      }, { actor: "configuration-seed" });
    }
    for (const group of inventory.groups) {
      store.createGroup(group, { actor: "configuration-seed" });
    }
    for (const service of inventory.services) {
      store.createService({
        id: service.id,
        hostId: service.host,
        groupId: service.group,
        name: service.name,
        description: service.description,
        url: service.url,
        category: service.category,
        enabled: service.enabled,
        sortOrder: service.sortOrder,
        repositoryUrl: service.repositoryUrl,
        control: service.control,
        update: service.update,
        location: service.location,
        health: service.health,
        backup: service.backup,
        agent: service.agent,
        extra: service.extra,
        related: [],
      }, { actor: "configuration-seed" });
    }
    for (const service of inventory.services) {
      if (service.related?.length) {
        store.updateService(service.id, { related: service.related }, { actor: "configuration-seed" });
      }
    }
  });
  seed();
  return true;
}

function buildUpstreamMap(servers, createUpstream, dependencies) {
  return new Map(servers.map((server) => [server.id, createUpstream({
    capabilities: server.capabilities,
    toolPolicy: server.toolPolicy,
    client: {
      serverId: server.id,
      serverName: server.name,
      endpoint: server.url,
      authorizationEnv: server.authorizationEnv,
      oauthAccessTokenEnv: server.oauthAccessTokenEnv,
      oauthRefreshTokenEnv: server.oauthRefreshTokenEnv,
      oauthClientIdEnv: server.oauthClientIdEnv,
      oauthClientSecretEnv: server.oauthClientSecretEnv,
      oauthTokenEndpoint: server.oauthTokenEndpoint,
      credentialsPath: server.credentialsPath,
      credentialsPathEnv: server.credentialsPathEnv,
      credentialKey: server.credentialKey,
      credentialNames: server.credentialNames,
      protocolVersion: server.protocolVersion,
      timeoutMs: server.timeoutMs,
      maximumResponseBytes: server.maximumResponseBytes,
      headersFromEnv: server.headersFromEnv,
    },
  }, dependencies)]));
}

export function createAppContext(options = {}) {
  const env = options.env || process.env;
  const runtime = options.runtime || runtimeConfig(env);
  const inventory = options.inventory || loadInventory(runtime.configPath || env.OPS_CONFIG_PATH);
  const sshHosts = options.sshHosts || loadSshHosts(runtime.sshHostsPath || env.OPS_SSH_HOSTS_PATH);
  const cloudflareServers = options.cloudflareServers || loadCloudflareServers(runtime.cloudflareServersPath || env.OPS_CLOUDFLARE_SERVERS_PATH);

  fs.mkdirSync(runtime.dataDir, { recursive: true, mode: 0o700 });
  fs.mkdirSync(runtime.sessionPath, { recursive: true, mode: 0o700 });

  const ownsStore = !options.store;
  const store = options.store || createServiceStore({ dbPath: runtime.dbPath, Database: options.Database, clock: options.clock });
  const seeded = seedStore(store, inventory);
  const tokenManager = options.tokenManager || createAgentTokenManager({ store, clock: options.clock });
  const runtimeAdapter = options.runtimeAdapter || createRuntimeAdapters(options.runtimeDependencies);
  const sshExecutor = options.sshExecutor || createSshExecutor(options.sshDependencies);
  const sshHostRegistry = options.sshHostRegistry || (runtime.sshHostsPath ? createSshHostRegistry({ filePath: runtime.sshHostsPath, env }) : undefined);
  const upstreamMcps = options.upstreamMcps || buildUpstreamMap(
    cloudflareServers,
    options.createUpstreamMcp || createUpstreamMcp,
    options.mcpDependencies,
  );
  const operations = options.operations || createOperations({
    store,
    tokenManager,
    runtimeAdapter,
    sshExecutor,
    sshHosts,
    sshHostRegistry,
    cloudflareServers,
    upstreamMcps,
    tools: inventory.tools,
    features: runtime.features || {},
    fetchImpl: options.fetchImpl,
    env,
    clock: options.clock,
  });

  return Object.freeze({
    runtime,
    config: runtime,
    inventory,
    sshHosts,
    cloudflareServers,
    store,
    tokenManager,
    operations,
    seeded,
    close: () => { if (ownsStore) store.close(); },
  });
}
