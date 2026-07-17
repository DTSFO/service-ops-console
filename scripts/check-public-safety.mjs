import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const ignored = new Set([".git", "node_modules", "dist", "coverage"]);
const patterns = {
  "private-key": /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
  "api-token": /(?:sk-|gh[pousr]_)[A-Za-z0-9_-]{20,}/,
  "private-home": /\/home\/[A-Za-z0-9._-]+\//,
  "wsl-path": /\\\\wsl\.localhost\\[^\s"']+/i,
  "inline-credential": /"(?:authorization|password|passphrase|privateKey|token)"\s*:\s*"(?!\s*\$?\{?[A-Z_][A-Z0-9_]*\}?\s*")[^"]+"/i,
  "public-ip": /\b(?!(?:127|10|169\.254|192\.168)\.)(?!172\.(?:1[6-9]|2\d|3[01])\.)(?!(?:192\.0\.2|198\.51\.100|203\.0\.113)\.)(?:\d{1,3}\.){3}\d{1,3}\b/,
};

async function walk(directory) {
  const files = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    if (ignored.has(entry.name)) continue;
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) files.push(...await walk(target));
    else files.push(target);
  }
  return files;
}

const findings = [];
let checked = 0;
for (const file of await walk(root)) {
  let text;
  try { text = await readFile(file, "utf8"); } catch { continue; }
  checked += 1;
  for (const [name, pattern] of Object.entries(patterns)) {
    if (pattern.test(text)) findings.push(`${path.relative(root, file)}: ${name}`);
  }
}

if (findings.length) {
  console.error(`Public safety scan failed:\n${findings.join("\n")}`);
  process.exit(1);
}
console.log(`Public safety scan passed (${checked} text files checked).`);
