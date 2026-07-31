/**
 * Redact secret-like material from session updates exposed to host callers.
 * Tool rawInput/rawOutput may contain commands, tokens, or env dumps — never
 * leak them through the host's public update surface.
 */

const SECRET_VALUE_RE =
  /(?:(?:api[_-]?key|token|secret|password|authorization|bearer)\s*[:=]\s*)(["']?)([^\s"'\\]{8,})\1/gi;

const JWT_RE = /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g;

function redactString(value: string): string {
  return value
    .replace(SECRET_VALUE_RE, (_m, q: string) => `redacted=${q}***${q}`)
    .replace(JWT_RE, "[redacted-jwt]");
}

function redactUnknown(value: unknown, depth = 0): unknown {
  if (depth > 6) return "[truncated]";
  if (typeof value === "string") {
    if (value.length > 4_096) {
      return redactString(value.slice(0, 4_096)) + "…";
    }
    return redactString(value);
  }
  if (Array.isArray(value)) {
    return value.slice(0, 32).map((item) => redactUnknown(item, depth + 1));
  }
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (/secret|token|password|authorization|api[_-]?key|credential/i.test(k)) {
        out[k] = "[redacted]";
        continue;
      }
      // Drop raw tool payloads that are most likely to carry secrets.
      if (k === "rawInput" || k === "rawOutput" || k === "env") {
        out[k] = "[redacted]";
        continue;
      }
      out[k] = redactUnknown(v, depth + 1);
    }
    return out;
  }
  return value;
}

export function sanitizeUpdateDetail(
  detail: Record<string, unknown> | undefined,
): Record<string, unknown> | undefined {
  if (!detail) return undefined;
  return redactUnknown(detail) as Record<string, unknown>;
}

export function sanitizeText(text: string): string {
  return redactString(text);
}
