/**
 * The edge functions answer a failure with a machine-readable envelope —
 * `supabase/functions/read/diagnostics.ts` builds it as `PublicReadErrorBody`
 * (`{ error, request_id, retryable }`). D-051: the client read only the status
 * line, so `retryable: false` — the server telling us to stop — was discarded
 * and the failure retried, turning rejections at a saturated ceiling into more
 * concurrency. Parsing this envelope is what makes that instruction reachable.
 */

/**
 * Server-supplied failure detail. Every field is nullable because a failure may
 * arrive without a body at all; `retryable: null` means the server said nothing
 * and the caller keeps its own status-based classification.
 */
export interface ServerErrorEnvelope {
  readonly error: string | null;
  readonly requestId: string | null;
  readonly retryable: boolean | null;
}

/** The envelope of a failure that carried no readable body. */
export const EMPTY_SERVER_ERROR_ENVELOPE: ServerErrorEnvelope = {
  error: null,
  requestId: null,
  retryable: null,
};

/**
 * Both fields are machine tokens in the server contract — a slug like
 * `internal_error` and a `crypto.randomUUID()`. Accepting only that shape keeps
 * server-controlled text out of the error messages that this client's own
 * classifiers match on: `isFollowCredentialFailure` tests for the phrase
 * "secret is absent", so free-form prose in an error body would otherwise let a
 * server steer client-side classification. Anything else is dropped, not
 * truncated — a mangled token is worse than no token.
 */
const ERROR_SLUG_RE = /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/;
const REQUEST_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,63}$/;

function tokenField(value: unknown, shape: RegExp): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return shape.test(trimmed) ? trimmed : null;
}

/**
 * Read the envelope out of an already-parsed body. Total by construction: an
 * absent, non-object, or malformed body yields nulls rather than throwing, so
 * adding this to an error path cannot itself break the error path.
 */
export function parseServerErrorEnvelope(body: unknown): ServerErrorEnvelope {
  if (body === null || typeof body !== "object" || Array.isArray(body)) {
    return EMPTY_SERVER_ERROR_ENVELOPE;
  }
  const record = body as Record<string, unknown>;
  return {
    error: tokenField(record.error, ERROR_SLUG_RE),
    requestId: tokenField(record.request_id, REQUEST_ID_RE),
    // Only a literal boolean is an instruction. A string "false" is a
    // malformed server, and inferring intent from it is how a client talks
    // itself back into the retry it was told not to make.
    retryable: typeof record.retryable === "boolean" ? record.retryable : null,
  };
}

/**
 * True only when the server explicitly refused a retry. Silence is not refusal,
 * so an absent field leaves the caller's status classification in charge.
 */
export function serverRefusedRetry(envelope: ServerErrorEnvelope): boolean {
  return envelope.retryable === false;
}

/**
 * Append the server's own words to a status message. `request_id` is the only
 * handle anyone has on server-side detail, so it goes in front of the operator
 * rather than staying in a discarded body.
 */
export function describeServerError(
  prefix: string,
  envelope: ServerErrorEnvelope,
): string {
  const parts: string[] = [];
  if (envelope.error !== null) parts.push(envelope.error);
  if (envelope.requestId !== null) parts.push(`request_id ${envelope.requestId}`);
  if (parts.length === 0) return prefix;
  return `${prefix}: ${parts.join(", ")}`;
}
