import crypto from "node:crypto";

export function issueCsrfToken(session) {
  if (!session) throw new Error("session is required");
  if (!session.csrfToken) session.csrfToken = crypto.randomBytes(32).toString("base64url");
  return session.csrfToken;
}

function equal(left, right) {
  const a = Buffer.from(String(left || ""));
  const b = Buffer.from(String(right || ""));
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

export function requireCsrf(req, res, next) {
  const expected = req.session?.csrfToken;
  const supplied = req.get("x-csrf-token") || req.body?._csrf;
  if (!expected || !supplied || !equal(expected, supplied)) return res.status(403).json({ error: "Invalid CSRF token" });
  return next();
}

export function requireSameOrigin(publicUrl) {
  const expectedOrigin = new URL(publicUrl).origin;
  return (req, res, next) => {
    const origin = req.get("origin");
    if (origin && origin !== expectedOrigin) return res.status(403).json({ error: "Origin is not allowed" });
    return next();
  };
}
