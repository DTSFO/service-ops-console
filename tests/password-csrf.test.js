import { describe, expect, it, vi } from "vitest";

import { issueCsrfToken, requireCsrf, requireSameOrigin } from "../lib/csrf.js";
import { hashPassword, verifyPassword } from "../lib/password.js";

describe("administrator authentication helpers", () => {
  it("hashes and verifies passwords without storing plaintext", async () => {
    const encoded = await hashPassword("correct-horse-battery-staple");
    expect(encoded).toMatch(/^\$argon2/);
    expect(encoded).not.toContain("correct-horse");
    await expect(verifyPassword(encoded, "correct-horse-battery-staple")).resolves.toBe(true);
    await expect(verifyPassword(encoded, "wrong-password")).resolves.toBe(false);
  });

  it("issues one CSRF token per session and requires an exact match", () => {
    const session = {};
    const token = issueCsrfToken(session);
    expect(issueCsrfToken(session)).toBe(token);
    const next = vi.fn();
    const status = vi.fn(() => ({ json: vi.fn() }));
    requireCsrf({ session, get: () => token, body: {} }, { status }, next);
    expect(next).toHaveBeenCalledOnce();
    requireCsrf({ session, get: () => "wrong", body: {} }, { status }, vi.fn());
    expect(status).toHaveBeenCalledWith(403);
  });

  it("rejects cross-origin mutation requests", () => {
    const middleware = requireSameOrigin("https://ops.example.com");
    const status = vi.fn(() => ({ json: vi.fn() }));
    middleware({ get: () => "https://evil.example" }, { status }, vi.fn());
    expect(status).toHaveBeenCalledWith(403);
  });
});
