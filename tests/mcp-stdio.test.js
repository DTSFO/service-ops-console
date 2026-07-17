import { once } from "node:events";
import path from "node:path";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

const root = path.resolve(import.meta.dirname, "..");

function readLine(stream) {
  return new Promise((resolve, reject) => {
    let buffer = "";
    const onData = (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf("\n");
      if (newline < 0) return;
      cleanup();
      resolve(buffer.slice(0, newline));
    };
    const onEnd = () => { cleanup(); reject(new Error("MCP server closed before returning a line")); };
    const cleanup = () => { stream.off("data", onData); stream.off("end", onEnd); };
    stream.on("data", onData);
    stream.on("end", onEnd);
  });
}

describe("MCP stdio transport", () => {
  it("accepts newline-delimited JSON-RPC used by stdio MCP clients", async () => {
    const child = spawn(process.execPath, ["mcp/stdio.js"], {
      cwd: root,
      env: { ...process.env, OPS_STDIO_CONTEXT_MODULE: path.join(root, "tests/fixtures/stdio-context.mjs") },
      stdio: ["pipe", "pipe", "pipe"],
    });
    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: {} })}\n`);
    const initialized = JSON.parse(await readLine(child.stdout));
    expect(initialized).toMatchObject({ id: 1, result: { serverInfo: { name: "service-ops-console" } } });

    child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list", params: {} })}\n`);
    const listed = JSON.parse(await readLine(child.stdout));
    expect(listed.result.tools.map((tool) => tool.name)).toEqual(["list_services", "discover_services"]);

    child.stdin.end();
    await once(child, "exit");
    expect(child.exitCode).toBe(0);
  });
});
