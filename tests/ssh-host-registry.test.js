import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createSshHostRegistry } from "../lib/ssh-host-registry.js";

const directories = [];
afterEach(() => directories.splice(0).forEach((directory) => fs.rmSync(directory, { recursive: true, force: true })));

describe("SSH host registry", () => {
  it("rejects inline secrets and writes environment references atomically with mode 0600", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "ops-ssh-registry-"));
    directories.push(directory);
    const filePath = path.join(directory, "ssh-hosts.json");
    const registry = createSshHostRegistry({ filePath, env: { OPS_TEST_IDENTITY: "/protected/key" } });

    expect(() => registry.plan({ id: "node-a", backend: "openssh", target: "node-a", identityFile: "/secret" })).toThrow(/identityFileFromEnv/);
    const host = registry.upsert({
      id: "node-a",
      backend: "openssh",
      target: "node-a",
      identityFileFromEnv: "OPS_TEST_IDENTITY",
      commandPolicy: { enabled: true, prefixes: ["systemctl status"] },
    });
    expect(host).toMatchObject({ id: "node-a", backend: "openssh" });
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    expect(fs.readFileSync(filePath, "utf8")).not.toContain("/protected/key");
    expect(fs.readdirSync(directory)).toEqual(["ssh-hosts.json"]);
    expect(registry.delete("node-a")).toEqual({ id: "node-a", deleted: true });
  });
});
