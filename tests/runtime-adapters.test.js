import { describe, expect, it, vi } from "vitest";

import { buildRuntimeCommand, createRuntimeAdapters } from "../lib/runtime-adapters.js";

describe("runtime adapters", () => {
  it("builds structured argv for supported runtimes", () => {
    expect(buildRuntimeCommand({ control: { type: "systemd", name: "example-service" } }, "restart"))
      .toEqual({ file: "systemctl", args: ["restart", "example-service"] });
    expect(buildRuntimeCommand({ control: { type: "systemd", name: "example-service", command: ["sudo", "-n", "systemctl"] } }, "restart"))
      .toEqual({ file: "sudo", args: ["-n", "systemctl", "restart", "example-service"] });
    expect(buildRuntimeCommand({ control: { type: "docker", name: "example-container" } }, "status"))
      .toEqual({ file: "docker", args: ["inspect", "--format", "{{.State.Status}}", "example-container"] });
    expect(buildRuntimeCommand({ control: { type: "docker", name: "example-container", command: ["sudo", "-n", "docker"] } }, "restart"))
      .toEqual({ file: "sudo", args: ["-n", "docker", "restart", "example-container"] });
    expect(buildRuntimeCommand({ control: { type: "launchd", name: "com.example.worker" } }, "restart"))
      .toEqual({ file: "launchctl", args: ["kickstart", "-k", "gui/current/com.example.worker"] });
    const selfRestart = buildRuntimeCommand({ control: { type: "systemd", name: "service-ops", self: true, selfActionCommand: ["sudo", "-n", "systemd-run"] } }, "restart");
    expect(selfRestart).toMatchObject({ file: "sudo", args: ["-n", "systemd-run", "--quiet", "--on-active=1", expect.stringMatching(/^--unit=service-ops-restart-/), "/bin/systemctl", "restart", "service-ops"] });
  });

  it("requires strict confirmation before control", async () => {
    const execFile = vi.fn();
    const adapters = createRuntimeAdapters({ execFile });
    const service = { id: "example", control: { type: "systemd", name: "example-service" } };
    await expect(adapters.control(service, "restart", { confirm: "true" })).rejects.toThrow(/confirm=true/);
    expect(execFile).not.toHaveBeenCalled();
  });

  it("executes without a shell and normalizes status", async () => {
    const execFile = vi.fn((file, args, options, callback) => callback(null, "running\n", ""));
    const adapters = createRuntimeAdapters({ execFile });
    const service = { id: "example", control: { type: "docker", name: "example-container" } };
    await expect(adapters.status(service)).resolves.toMatchObject({ id: "example", status: "active", ok: true });
    expect(execFile).toHaveBeenCalledWith("docker", ["inspect", "--format", "{{.State.Status}}", "example-container"], expect.any(Object), expect.any(Function));
  });

  it("treats expected inactive runtime states as successful probes", async () => {
    const execFile = vi.fn((file, args, options, callback) => callback(Object.assign(new Error("inactive"), { code: 3 }), "inactive\n", ""));
    const adapters = createRuntimeAdapters({ execFile });
    await expect(adapters.status({ id: "example", control: { type: "systemd", name: "example" } }))
      .resolves.toMatchObject({ status: "inactive", ok: true });
  });

  it("executes generic structured probes without a shell", async () => {
    const execFile = vi.fn((file, args, options, callback) => callback(null, "/srv/example\n", ""));
    const adapters = createRuntimeAdapters({ execFile });
    await expect(adapters.execute({ file: "git", args: ["-C", "/srv/example", "rev-parse", "--show-toplevel"] }))
      .resolves.toMatchObject({ ok: true, stdout: "/srv/example" });
    expect(execFile).toHaveBeenCalledWith("git", ["-C", "/srv/example", "rev-parse", "--show-toplevel"], expect.any(Object), expect.any(Function));
  });

  it("rejects unsupported actions and incomplete launchd starts", () => {
    expect(() => buildRuntimeCommand({ control: { type: "systemd", name: "example" } }, "reload")).toThrow(/Unsupported/);
    expect(() => buildRuntimeCommand({ control: { type: "launchd", name: "com.example.worker" } }, "start")).toThrow(/plist/);
  });
});
