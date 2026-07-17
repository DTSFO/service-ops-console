import { hash, verify } from "@node-rs/argon2";

export async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 12) throw new Error("password must contain at least 12 characters");
  return hash(password, {
    algorithm: 2,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 1,
    outputLen: 32,
  });
}

export async function verifyPassword(encodedHash, password) {
  if (typeof encodedHash !== "string" || !encodedHash.startsWith("$argon2")) return false;
  if (typeof password !== "string" || !password) return false;
  try {
    return await verify(encodedHash, password);
  } catch {
    return false;
  }
}
