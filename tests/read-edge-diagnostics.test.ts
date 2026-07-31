import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import {
  extractSafeDiagnostics,
  firstForbiddenDiagnosticKey,
  FORBIDDEN_DIAGNOSTIC_KEYS,
  formatReadFailureLog,
  isRetryableErrorCode,
  newRequestId,
  publicReadErrorBody,
  type SafeReadDiagnostics,
} from "../supabase/functions/read/diagnostics.js";

const SECRET_TOKEN = "swm_agt_abcdefghijklmnopqrstuvwxyz0123456789ABCDE";
const SECRET_HASH_HEX =
  "deadbeefcafebabe0123456789abcdef0123456789abcdef0123456789abcdef";
const SECRET_QUERY =
  "SELECT * FROM swarm_read.signals WHERE about = 'SECRET_ABOUT_VALUE'";
const SECRET_PARAM = "SECRET_QUERY_VALUE_42";

/** Build a postgres.js-shaped PostgresError without importing Deno-only modules. */
function fakePostgresError(fields: {
  message?: string;
  code?: string;
  severity?: string;
  routine?: string;
  constraint_name?: string;
  detail?: string;
  hint?: string;
  query?: string;
  parameters?: unknown[];
}): Error {
  const error = new Error(
    fields.message ??
      `duplicate key value violates unique constraint "${fields.constraint_name ?? "x"}"`,
  );
  error.name = "PostgresError";
  Object.assign(error, {
    severity: fields.severity ?? "ERROR",
    code: fields.code ?? "23505",
    routine: fields.routine ?? "_bt_check_unique",
    constraint_name: fields.constraint_name ?? "signals_pkey",
    detail: fields.detail ?? `Key (about)=(${SECRET_PARAM}) already exists.`,
    hint: fields.hint ?? "Check the token in Authorization.",
    // Non-enumerable on real postgres.js errors; set both ways to prove we never copy them.
    query: fields.query ?? SECRET_QUERY,
    parameters: fields.parameters ?? [SECRET_PARAM, SECRET_TOKEN],
  });
  Object.defineProperty(error, "query", {
    value: fields.query ?? SECRET_QUERY,
    enumerable: false,
    configurable: true,
  });
  Object.defineProperty(error, "parameters", {
    value: fields.parameters ?? [SECRET_PARAM, SECRET_TOKEN],
    enumerable: false,
    configurable: true,
  });
  return error;
}

function fakeConnectionError(code: string): Error {
  const error = Object.assign(
    new Error(`write ${code} 127.0.0.1:5432`),
    {
      code,
      errno: code,
      address: "127.0.0.1",
      port: 5432,
    },
  );
  return error;
}

function assertNoSecrets(text: string): void {
  assert.equal(text.includes(SECRET_TOKEN), false, "must not leak agent token");
  assert.equal(text.includes(SECRET_HASH_HEX), false, "must not leak hash");
  assert.equal(text.includes(SECRET_QUERY), false, "must not leak SQL query");
  assert.equal(text.includes(SECRET_PARAM), false, "must not leak query values");
  assert.equal(
    text.toLowerCase().includes("authorization"),
    false,
    "must not mention authorization",
  );
  assert.equal(text.includes("Bearer "), false, "must not leak bearer header");
}

test("newRequestId returns a UUID-shaped correlation id", () => {
  const id = newRequestId();
  assert.match(
    id,
    /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i,
  );
  assert.notEqual(newRequestId(), id);
});

test("extractSafeDiagnostics keeps Postgres identity fields and drops secrets", () => {
  const requestId = "11111111-2222-4333-8444-555555555555";
  const error = fakePostgresError({
    message: `token ${SECRET_TOKEN} hash ${SECRET_HASH_HEX}`,
    code: "23505",
    severity: "ERROR",
    routine: "_bt_check_unique",
    constraint_name: "signals_pkey",
  });
  const diag = extractSafeDiagnostics(error, "query", requestId);

  assert.deepEqual(diag, {
    event: "read_request_failure",
    request_id: requestId,
    phase: "query",
    name: "PostgresError",
    code: "23505",
    severity: "ERROR",
    routine: "_bt_check_unique",
    constraint: "signals_pkey",
    retryable: false,
  } satisfies SafeReadDiagnostics);

  assert.equal(firstForbiddenDiagnosticKey(diag as unknown as Record<string, unknown>), null);
  for (const key of FORBIDDEN_DIAGNOSTIC_KEYS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(diag, key),
      false,
      `forbidden key present: ${key}`,
    );
  }

  const logLine = formatReadFailureLog(diag);
  assertNoSecrets(logLine);
  assert.equal(logLine.includes('"phase":"query"'), true);
  assert.equal(logLine.includes('"code":"23505"'), true);
  assert.equal(logLine.includes(requestId), true);
});

test("extractSafeDiagnostics classifies connection failures as retryable", () => {
  const requestId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  for (
    const code of [
      "CONNECT_TIMEOUT",
      "CONNECTION_CLOSED",
      "CONNECTION_ENDED",
      "CONNECTION_DESTROYED",
    ]
  ) {
    const diag = extractSafeDiagnostics(
      fakeConnectionError(code),
      "session_setup",
      requestId,
    );
    assert.equal(diag.code, code);
    assert.equal(diag.retryable, true, code);
    assert.equal(diag.phase, "session_setup");
    assert.equal(diag.severity, null);
    assert.equal(diag.routine, null);
    assert.equal(diag.constraint, null);
    assertNoSecrets(formatReadFailureLog(diag));
    // Connection address/port must not be copied into diagnostics.
    assert.equal(formatReadFailureLog(diag).includes("127.0.0.1"), false);
    assert.equal(formatReadFailureLog(diag).includes("5432"), false);
  }
});

test("isRetryableErrorCode covers SQLSTATE connection class and known codes", () => {
  assert.equal(isRetryableErrorCode("08006"), true);
  assert.equal(isRetryableErrorCode("40001"), true);
  assert.equal(isRetryableErrorCode("40P01"), true);
  assert.equal(isRetryableErrorCode("55P03"), true);
  assert.equal(isRetryableErrorCode("57014"), true);
  assert.equal(isRetryableErrorCode("23505"), false);
  assert.equal(isRetryableErrorCode("42P01"), false);
  assert.equal(isRetryableErrorCode(null), false);
});

test("publicReadErrorBody stays generic with request_id and retryable only", () => {
  const diag = extractSafeDiagnostics(
    fakePostgresError({ code: "08006", severity: "FATAL", routine: "auth_failed" }),
    "credential_lookup",
    "99999999-aaaa-4bbb-8ccc-dddddddddddd",
  );
  const body = publicReadErrorBody(diag);
  assert.deepEqual(body, {
    error: "internal_error",
    request_id: "99999999-aaaa-4bbb-8ccc-dddddddddddd",
    retryable: true,
  });
  assert.equal(Object.keys(body).sort().join(","), "error,request_id,retryable");
  assertNoSecrets(JSON.stringify(body));
  // Public body must not leak Postgres identity fields.
  assert.equal(JSON.stringify(body).includes("08006"), false);
  assert.equal(JSON.stringify(body).includes("FATAL"), false);
  assert.equal(JSON.stringify(body).includes("auth_failed"), false);
});

test("handler phase is preserved across phases including top_level fallback", () => {
  const phases = [
    "auth",
    "parse",
    "session_setup",
    "credential_lookup",
    "membership",
    "query",
    "top_level",
  ] as const;
  for (const phase of phases) {
    const diag = extractSafeDiagnostics(new Error("boom"), phase, "id");
    assert.equal(diag.phase, phase);
    assert.equal(diag.name, "Error");
    assert.equal(diag.code, null);
  }
  // Unknown phase collapses to top_level rather than inventing a free-form string.
  const collapsed = extractSafeDiagnostics(
    new Error("boom"),
    "invented" as "query",
    "id",
  );
  assert.equal(collapsed.phase, "top_level");
});

test("non-Error throws produce name unknown and no secrets", () => {
  const diag = extractSafeDiagnostics(
    { code: "57014", token: SECRET_TOKEN, authorization: "Bearer x", body: { a: 1 } },
    "query",
    "corr-1",
  );
  assert.equal(diag.name, "unknown");
  assert.equal(diag.code, "57014");
  assert.equal(diag.retryable, true);
  // Input object may carry secrets; diagnostics object must not.
  assert.equal(firstForbiddenDiagnosticKey(diag as unknown as Record<string, unknown>), null);
  assertNoSecrets(formatReadFailureLog(diag));
});

test("read/index.ts wires structured diagnostics (source contract)", () => {
  const source = readFileSync(
    join(process.cwd(), "supabase/functions/read/index.ts"),
    "utf8",
  );
  assert.match(source, /from "\.\/diagnostics\.ts"/);
  assert.match(source, /extractSafeDiagnostics/);
  assert.match(source, /publicReadErrorBody/);
  assert.match(source, /formatReadFailureLog/);
  assert.match(source, /newRequestId/);
  // Old unstructured log must be gone.
  assert.equal(source.includes('"read function failure"'), false);
  // Phase markers for the main handler steps (setPhase("…") call sites).
  for (
    const phase of [
      "auth",
      "parse",
      "session_setup",
      "credential_lookup",
      "membership",
      "query",
    ]
  ) {
    assert.match(
      source,
      new RegExp(`setPhase\\("${phase}"\\)`),
      `missing phase marker: ${phase}`,
    );
  }
  assert.match(source, /let phase: ReadHandlerPhase = "top_level"/);
});
