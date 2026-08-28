/** Durable, secret-minimising records for command failures that escape a transaction. */

export type CommandFailureReason =
  | "internal_error"
  | "lock_timeout"
  | "test_rollback";

export interface DurableCommandFailure {
  command_kind: string;
  reason: CommandFailureReason;
  db_code: string | null;
  detail: string;
  request_id: string;
}

export interface CommandFailureResult {
  status: 500 | 503;
  body: { error: "internal_error" | "temporarily_unavailable" };
}

export type InsertCommandFailure = (
  failure: DurableCommandFailure,
) => Promise<void>;

const FAILURE_UNSAFE_GLOBAL_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;

function boundedSafeText(value: string, maximum: number): string {
  return value.replace(FAILURE_UNSAFE_GLOBAL_RE, "").slice(0, maximum);
}

/** Read only a stable database/library code from an unknown thrown value. */
export function dbCode(error: unknown): string | null {
  if (error === null || typeof error !== "object") return null;
  const code = (error as Record<string, unknown>).code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

/** Keep the existing bounded error presentation without copying request data. */
export function safeError(error: unknown): string {
  if (error instanceof Error) {
    return boundedSafeText(`${error.name}: ${error.message}`, 512);
  }
  return "unknown error";
}

/** Preserve the current response classification while making it explicit for tests. */
export function classifyCommandFailure(
  isTestRollback: boolean,
  code: string | null,
): CommandFailureReason {
  if (isTestRollback) return "test_rollback";
  return code === "55P03" ? "lock_timeout" : "internal_error";
}

/** Build the allowlisted row; request bodies and credentials are not inputs. */
export function durableCommandFailure(input: {
  commandKind: string;
  reason: CommandFailureReason;
  code: string | null;
  error: unknown;
  requestId: string;
}): DurableCommandFailure {
  const commandKind = boundedSafeText(input.commandKind, 64) || "unknown";
  const code = input.code === null
    ? null
    : boundedSafeText(input.code, 64) || null;
  return {
    command_kind: commandKind,
    reason: input.reason,
    db_code: code,
    detail: safeError(input.error),
    request_id: input.requestId,
  };
}

/** Attempt one diagnostic insert without ever replacing the original response. */
export async function finishCommandFailure(
  failure: DurableCommandFailure,
  insert: InsertCommandFailure,
  onInsertFailure: (error: unknown) => void = () => {},
): Promise<CommandFailureResult> {
  try {
    await insert(failure);
  } catch (error) {
    try {
      onInsertFailure(error);
    } catch {
      // Reporting a diagnostic failure must not mask the command failure either.
    }
  }
  return failure.reason === "lock_timeout"
    ? { status: 503, body: { error: "temporarily_unavailable" } }
    : { status: 500, body: { error: "internal_error" } };
}
