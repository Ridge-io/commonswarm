/**
 * Safe, structured diagnostics for the read edge function.
 * Surfaces PostgreSQL/connection identity fields and handler phase without
 * logging tokens, Authorization headers, bodies, query values, or hashes.
 */

/** Where the handler was when the failure escaped. */
export type ReadHandlerPhase =
  | "auth"
  | "parse"
  | "session_setup"
  | "credential_lookup"
  | "membership"
  | "query"
  | "top_level";

/** Allowlisted operator-facing failure fields only. */
export interface SafeReadDiagnostics {
  event: "read_request_failure";
  request_id: string;
  phase: ReadHandlerPhase;
  name: string;
  code: string | null;
  severity: string | null;
  routine: string | null;
  constraint: string | null;
  retryable: boolean;
}

/** Client-visible 500 body: generic, correlatable, no secret material. */
export interface PublicReadErrorBody {
  error: "internal_error";
  request_id: string;
  retryable: boolean;
}

/** Keys that must never appear on a logged diagnostics object. */
export const FORBIDDEN_DIAGNOSTIC_KEYS = [
  "message",
  "detail",
  "hint",
  "query",
  "parameters",
  "stack",
  "where",
  "internal_query",
  "internal_position",
  "position",
  "schema_name",
  "table_name",
  "column_name",
  "data",
  "type_name",
  "token",
  "authorization",
  "body",
  "hash",
  "token_hash",
  "address",
  "port",
  "errno",
] as const;

const PHASES = new Set<ReadHandlerPhase>([
  "auth",
  "parse",
  "session_setup",
  "credential_lookup",
  "membership",
  "query",
  "top_level",
]);

const CONNECTION_CODES = new Set([
  "CONNECTION_DESTROYED",
  "CONNECT_TIMEOUT",
  "CONNECTION_CLOSED",
  "CONNECTION_ENDED",
]);

/** Explicit retryable SQLSTATE / library codes (class or full code). */
const RETRYABLE_CODES = new Set([
  ...CONNECTION_CODES,
  "40001", // serialization_failure
  "40P01", // deadlock_detected
  "55P03", // lock_not_available
  "57014", // query_canceled
  "53300", // too_many_connections
  "57P03", // cannot_connect_now
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== "object") return null;
  return value as Record<string, unknown>;
}

function readStringField(
  record: Record<string, unknown>,
  key: string,
): string | null {
  const value = record[key];
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (trimmed.length === 0) return null;
  // Bound length so a runaway string cannot flood logs.
  return trimmed.slice(0, 128);
}

/** True when the code class is connection_exception (08xxx). */
function isConnectionSqlstate(code: string): boolean {
  return code.length >= 2 && code.startsWith("08");
}

/** Classify whether a client may usefully retry the same request. */
export function isRetryableErrorCode(code: string | null): boolean {
  if (code === null) return false;
  if (RETRYABLE_CODES.has(code)) return true;
  if (isConnectionSqlstate(code)) return true;
  return false;
}

/** Generate a request correlation id (Node + Deno crypto.randomUUID). */
export function newRequestId(): string {
  return crypto.randomUUID();
}

/**
 * Extract allowlisted identity fields from an unknown thrown value.
 * Intentionally omits message/detail/query/parameters and similar secret-prone fields.
 */
export function extractSafeDiagnostics(
  error: unknown,
  phase: ReadHandlerPhase,
  requestId: string,
): SafeReadDiagnostics {
  const safePhase = PHASES.has(phase) ? phase : "top_level";
  const record = asRecord(error);
  const name = error instanceof Error
    ? (error.name || "Error").slice(0, 64)
    : "unknown";
  // Prefer PostgresError.constraint_name; also accept a plain `constraint` if present.
  const constraint = record === null
    ? null
    : readStringField(record, "constraint_name") ??
      readStringField(record, "constraint");
  const code = record === null ? null : readStringField(record, "code");
  const severity = record === null ? null : readStringField(record, "severity");
  const routine = record === null ? null : readStringField(record, "routine");

  return {
    event: "read_request_failure",
    request_id: requestId,
    phase: safePhase,
    name,
    code,
    severity,
    routine,
    constraint,
    retryable: isRetryableErrorCode(code),
  };
}

/** Public 500 body: only internal_error + correlation + retry hint. */
export function publicReadErrorBody(
  diagnostics: SafeReadDiagnostics,
): PublicReadErrorBody {
  return {
    error: "internal_error",
    request_id: diagnostics.request_id,
    retryable: diagnostics.retryable,
  };
}

/** Structured operator log line — JSON of allowlisted fields only. */
export function formatReadFailureLog(diagnostics: SafeReadDiagnostics): string {
  return JSON.stringify(diagnostics);
}

/**
 * Assert a diagnostics object has no forbidden keys (for tests and self-checks).
 * Returns the first forbidden key found, or null when clean.
 */
export function firstForbiddenDiagnosticKey(
  diagnostics: Record<string, unknown>,
): string | null {
  for (const key of FORBIDDEN_DIAGNOSTIC_KEYS) {
    if (Object.prototype.hasOwnProperty.call(diagnostics, key)) return key;
  }
  return null;
}
