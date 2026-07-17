const MAX_COMMAND_LENGTH = 16_384;
const MAX_PATTERN_LENGTH = 1_024;
// Commands are ultimately interpreted by a local or remote shell. Reject
// composition, substitution, redirection, and globbing operators before the
// configured allowlist is evaluated.
const SHELL_CONTROL = /[;&|<>`$(){}[\]*?!]/;

function containsUnquotedShellControl(command) {
  let quote = null;
  let escaped = false;
  for (const character of command) {
    if (escaped) {
      escaped = false;
      continue;
    }
    if (quote === "'") {
      if (character === "'") quote = null;
      continue;
    }
    if (quote === '"') {
      if (character === '"') quote = null;
      else if (character === "$" || character === "`") return true;
      else if (character === "\\") escaped = true;
      continue;
    }
    if (character === "'") {
      quote = "'";
      continue;
    }
    if (character === '"') {
      quote = '"';
      continue;
    }
    if (SHELL_CONTROL.test(character)) return true;
  }
  return false;
}

function normalizePrefixes(prefixes) {
  if (!Array.isArray(prefixes)) throw new TypeError("command policy prefixes must be an array");
  return prefixes.map((prefix) => {
    if (typeof prefix !== "string" || !prefix.trim()) throw new TypeError("command policy prefixes must be non-empty strings");
    return prefix.trim();
  });
}

function normalizePatterns(patterns) {
  if (!Array.isArray(patterns)) throw new TypeError("command policy patterns must be an array");
  return patterns.map((pattern) => {
    if (pattern instanceof RegExp) return new RegExp(pattern.source, pattern.flags.replace(/[gy]/g, ""));
    if (typeof pattern !== "string" || !pattern || pattern.length > MAX_PATTERN_LENGTH) {
      throw new TypeError("command policy patterns must be non-empty regular expressions up to 1024 characters");
    }
    return new RegExp(pattern);
  });
}

export function createCommandPolicy(config = {}) {
  const enabled = config.enabled === true;
  const prefixes = normalizePrefixes(config.prefixes || []);
  const patterns = normalizePatterns(config.patterns || []);

  return Object.freeze({ enabled, prefixes: Object.freeze(prefixes), patterns: Object.freeze(patterns) });
}

export function evaluateCommand(policyConfig, command) {
  const policy = createCommandPolicy(policyConfig);
  const candidate = typeof command === "string" ? command.trim() : "";
  if (!candidate) return { allowed: false, reason: "command is required" };
  if (candidate.length > MAX_COMMAND_LENGTH) return { allowed: false, reason: "command is too long" };
  if (/[\0\r\n]/.test(candidate)) return { allowed: false, reason: "command must be a single line" };
  if (containsUnquotedShellControl(candidate)) return { allowed: false, reason: "shell control operators are not allowed" };
  if (!policy.enabled) return { allowed: false, reason: "arbitrary command execution is disabled" };

  const prefix = policy.prefixes.find((value) => candidate === value || candidate.startsWith(`${value} `));
  if (prefix) return { allowed: true, reason: "allowed by prefix", rule: { type: "prefix", value: prefix } };

  const pattern = policy.patterns.find((value) => value.test(candidate));
  if (pattern) return { allowed: true, reason: "allowed by pattern", rule: { type: "pattern", value: pattern.source } };

  return { allowed: false, reason: "command does not match the configured allowlist" };
}

export function assertCommandAllowed(policy, command) {
  const result = evaluateCommand(policy, command);
  if (!result.allowed) throw new Error(result.reason);
  return result;
}
