#!/usr/bin/env node
import readline from "node:readline";
import { pathToFileURL } from "node:url";

import { runtimeConfig } from "../lib/config.js";
import { createMcpServer, MINIMAL_DEFAULT_SCOPES } from "./server.js";

async function loadContext(env = process.env) {
  const moduleUrl = env.OPS_STDIO_CONTEXT_MODULE
    ? pathToFileURL(env.OPS_STDIO_CONTEXT_MODULE).href
    : new URL("../lib/app-context.js", import.meta.url).href;
  const loaded = await import(moduleUrl);
  if (typeof loaded.createAppContext === "function") return loaded.createAppContext({ env });
  if (typeof loaded.createTestContext === "function") return loaded.createTestContext({ env });
  if (loaded.default) return loaded.default;
  throw new Error("stdio context module must export createAppContext, createTestContext, or default");
}

export async function runStdio({ input = process.stdin, output = process.stdout, env = process.env } = {}) {
  const context = await loadContext(env);
  const config = context.runtime || context.config || runtimeConfig(env);
  const scopes = config.stdioScopes?.length ? config.stdioScopes : MINIMAL_DEFAULT_SCOPES;
  const server = createMcpServer({
    operations: context.operations || context,
    scopes,
    privilegedOperations: config.privilegedOperations === true,
    actor: { type: "stdio", id: env.OPS_STDIO_ACTOR || "stdio" },
  });
  const lines = readline.createInterface({ input, crlfDelay: Infinity });

  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let response;
      try {
        response = await server.handleRequest(JSON.parse(line));
      } catch (cause) {
        response = { jsonrpc: "2.0", id: null, error: { code: -32700, message: cause.message } };
      }
      if (response) output.write(`${JSON.stringify(response)}\n`);
    }
  } finally {
    context.close?.();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  runStdio().catch((cause) => {
    process.stderr.write(`service-ops-mcp: ${cause.message}\n`);
    process.exitCode = 1;
  });
}
