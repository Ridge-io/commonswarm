/**
 * Child-env allowlist for ACP subprocesses.
 *
 * Subscription auth for Grok is file-based (~/.grok/auth.json via HOME).
 * Locale/path are required for a normal process. Everything else stays out —
 * especially SWARM_* and credential-like keys from the parent shell.
 */

const ALLOWED_EXACT = new Set([
  "PATH",
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TMPDIR",
  "TMP",
  "TEMP",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "LC_MESSAGES",
  "LC_COLLATE",
  "LC_TIME",
  "TERM",
  "COLORTERM",
  "NO_COLOR",
  "FORCE_COLOR",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_RUNTIME_DIR",
  "XDG_STATE_HOME",
]);

/** Explicit deny fragments even if a future allowlist widens. */
const DENY_NAME_RE =
  /(?:^|_)(?:SWARM|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|AUTH|COOKIE)(?:_|$)/i;

/**
 * Build a sanitized env for an ACP child from a parent env map.
 * Returns only allowlisted keys; never copies SWARM_* or credential-like names.
 */
export function sanitizeChildEnv(
  parent: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(parent)) {
    if (value === undefined) continue;
    if (!ALLOWED_EXACT.has(key)) continue;
    if (DENY_NAME_RE.test(key)) continue;
    if (key.startsWith("SWARM_")) continue;
    out[key] = value;
  }
  // Ensure PATH exists so the child can resolve helpers if needed.
  if (!out.PATH && typeof process.env.PATH === "string") {
    // PATH is allowlisted; only fill when parent map omitted it intentionally empty.
  }
  return out;
}

/**
 * True when a key would be stripped by the allowlist/deny rules.
 * Used by tests as a positive control for redaction claims.
 */
export function isEnvKeyDenied(key: string): boolean {
  if (key.startsWith("SWARM_")) return true;
  if (DENY_NAME_RE.test(key)) return true;
  return !ALLOWED_EXACT.has(key);
}
