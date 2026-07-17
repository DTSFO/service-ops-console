import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { describe, expect, it, vi } from "vitest";

import {
  commandToTool,
  getCliConfigPath,
  loadCliConfig,
  parseArguments,
  readCallJson,
  redactAuthorization,
  saveCliConfig,
  syncService,
} from "../scripts/ops-cli.mjs";

describe("service-ops CLI routing", () => {
  it("routes read commands to MCP tools", () => {
    expect(commandToTool(["services", "status", "example-api"], {})).toEqual([
      "get_service_status",
      { serviceId: "example-api" },
    ]);
    expect(commandToTool(["cf", "tools", "docs"], {})).toEqual([
      "list_cloudflare_tools",
      { serverId: "docs" },
    ]);
    expect(commandToTool(["services", "update-check"], {})).toEqual([
      "check_service_updates",
      { serviceIds: [] },
    ]);
  });

  it("requires an explicit --confirm for privileged commands", () => {
    expect(() => commandToTool(["ssh", "exec", "remote-host", "uptime"], {})).toThrow(/--confirm/);
    expect(commandToTool(["ssh", "exec", "remote-host", "uptime"], { confirm: true })).toEqual([
      "ssh_execute",
      { hostId: "remote-host", command: "uptime", confirm: true },
    ]);
  });

  it("parses equals and boolean flags without evaluating shell content", () => {
    expect(parseArguments(["services", "update-apply", "example-api", "--digest=abc", "--confirm"])).toEqual({
      positionals: ["services", "update-apply", "example-api"],
      flags: { digest: "abc", confirm: true },
    });
  });

  it("loads MCP and Cloudflare arguments from inline JSON, files, or stdin", async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "service-ops-cli-json-"));
    const file = path.join(directory, "arguments.json");
    fs.writeFileSync(file, '{"serviceId":"example-api"}\n');
    try {
      await expect(readCallJson('{"query":"api"}')).resolves.toEqual({ query: "api" });
      await expect(readCallJson(undefined, { json: file })).resolves.toEqual({ serviceId: "example-api" });
      await expect(readCallJson("-", {}, "tool arguments", async () => '{"confirm":true}'))
        .resolves.toEqual({ confirm: true });
      await expect(readCallJson(undefined, { json: "-" }, "tool arguments", async () => '{"source":"stdin"}'))
        .resolves.toEqual({ source: "stdin" });
      await expect(readCallJson("{}", { json: file })).rejects.toThrow(/not both/);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("uses the XDG profile path, atomically writes mode 0600, and redacts Authorization", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "service-ops-cli-profile-"));
    try {
      const env = { XDG_CONFIG_HOME: directory };
      const file = getCliConfigPath(env);
      expect(file).toBe(path.join(directory, "service-ops-console", "cli.json"));
      saveCliConfig(file, { endpoint: "https://ops.example.com/mcp", authorization: "Bearer example-secret-token" });
      expect(loadCliConfig(env).stored).toMatchObject({ authorization: "Bearer example-secret-token" });
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.readdirSync(path.dirname(file))).toEqual(["cli.json"]);
      expect(redactAuthorization("Bearer example-secret-token")).not.toContain("example-secret-token");
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("syncs only the exact digest returned by the reviewed update plan", async () => {
    const callTool = vi.fn()
      .mockResolvedValueOnce({ planDigest: "fresh-digest" })
      .mockResolvedValueOnce({ serviceId: "example-api", applied: true });

    await expect(syncService({ callTool }, "example-api", { confirm: true }))
      .resolves.toEqual({ serviceId: "example-api", applied: true });
    expect(callTool).toHaveBeenNthCalledWith(1, "plan_service_update", { serviceId: "example-api" });
    expect(callTool).toHaveBeenNthCalledWith(2, "apply_service_update", {
      serviceId: "example-api",
      planDigest: "fresh-digest",
      confirm: true,
    });
  });
});
