import { describe, expect, it } from "vitest";

import { assertCommandAllowed, createCommandPolicy, evaluateCommand } from "../lib/command-policy.js";

describe("command policy", () => {
  it("denies commands by default", () => {
    expect(evaluateCommand({}, "example status")).toMatchObject({ allowed: false });
    expect(() => assertCommandAllowed({}, "example status")).toThrow(/disabled/);
  });

  it("allows only configured prefix boundaries or patterns", () => {
    const policy = createCommandPolicy({ enabled: true, prefixes: ["example status"], patterns: ["^example inspect [a-z-]+$"] });
    expect(evaluateCommand(policy, "example status worker").allowed).toBe(true);
    expect(evaluateCommand(policy, "example status-extra").allowed).toBe(false);
    expect(evaluateCommand(policy, "example inspect sample-service").allowed).toBe(true);
    expect(evaluateCommand(policy, "example inspect sample; unsafe").allowed).toBe(false);
    expect(evaluateCommand(policy, "example status worker\nunsafe").allowed).toBe(false);
  });

  it("rejects shell composition even when an allowlist would otherwise match", () => {
    const policy = createCommandPolicy({ enabled: true, prefixes: ["systemctl status"], patterns: ["^echo .+$"] });
    for (const command of ["systemctl status; id", "systemctl status && id", "echo $(id)", "echo `id`", "echo foo > /tmp/x"]) {
      expect(evaluateCommand(policy, command)).toMatchObject({ allowed: false, reason: "shell control operators are not allowed" });
    }
    expect(evaluateCommand(createCommandPolicy({ enabled: true, prefixes: ["docker inspect"] }), "docker inspect --format '{{.State.Status}}' example").allowed).toBe(true);
  });

  it("rejects invalid policy definitions", () => {
    expect(() => createCommandPolicy({ prefixes: "example" })).toThrow(/array/);
    expect(() => createCommandPolicy({ patterns: ["["] })).toThrow();
  });
});
