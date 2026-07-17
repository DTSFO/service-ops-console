import { describe, expect, it, vi } from "vitest";

import { CONNECTIVITY_PROBE_COMMAND, createSshExecutor } from "../lib/ssh-executor.js";

function successfulExecFile(file, args, options, callback) {
  callback(null, "ok\n", "");
}

describe("SSH executor", () => {
  it("requires strict confirmation and an enabled allowlist", async () => {
    const executor = createSshExecutor({ execFile: successfulExecFile });
    const request = { host: { id: "example-host", backend: "local" }, command: "example status", policy: { enabled: true, prefixes: ["example"] } };
    await expect(executor.execute({ ...request, confirm: "true" })).rejects.toThrow(/confirm=true/);
    await expect(executor.execute({ ...request, confirm: true, policy: {} })).rejects.toThrow(/disabled/);
  });

  it("uses structured OpenSSH argv and limits output", async () => {
    const execFile = vi.fn((file, args, options, callback) => callback(null, "x".repeat(3000), ""));
    const executor = createSshExecutor({ execFile });
    const result = await executor.execute({
      host: { id: "example-host", backend: "openssh", target: "example-alias" },
      command: "example status",
      confirm: true,
      policy: { enabled: true, prefixes: ["example status"] },
      maximumOutputBytes: 1024,
    });
    expect(execFile).toHaveBeenCalledWith("ssh", expect.arrayContaining(["example-alias", "example status"]), expect.any(Object), expect.any(Function));
    expect(result).toMatchObject({ ok: true, stdoutTruncated: true, host: { id: "example-host", backend: "openssh" } });
  });

  it("runs a fixed connectivity probe", async () => {
    const execFile = vi.fn(successfulExecFile);
    const executor = createSshExecutor({ execFile });
    await executor.probe({ host: { id: "example-host", backend: "local" }, confirm: true });
    expect(execFile.mock.calls[0][1]).toEqual(["-lc", CONNECTIVITY_PROBE_COMMAND]);
  });

  it("loads ssh2 lazily", async () => {
    const stream = { stderr: { on: vi.fn() }, on: vi.fn(), once: vi.fn((event, callback) => event === "close" && callback(0, null)) };
    class Client {
      once(event, callback) { if (event === "ready") this.ready = callback; return this; }
      connect() { this.ready(); }
      exec(command, callback) { callback(null, stream); }
      end() {}
    }
    const loadSsh2 = vi.fn(async () => ({ Client }));
    const executor = createSshExecutor({ loadSsh2 });
    const result = await executor.execute({
      host: { id: "example-host", backend: "ssh2", host: "example.invalid", username: "operator" },
      command: "example status",
      confirm: true,
      policy: { enabled: true, prefixes: ["example status"] },
    });
    expect(loadSsh2).toHaveBeenCalledOnce();
    expect(result.ok).toBe(true);
  });
});
