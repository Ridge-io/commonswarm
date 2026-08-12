/**
 * Local permission boundary for agent→client session/request_permission.
 *
 * Default is deny-safe: pick reject_once when offered, otherwise cancel.
 * Never auto-allow because of child or global config — only an injected
 * callback may select allow_*.
 *
 * Ambient provider hooks/rules that the child loads from a user environment
 * sit *outside* this ACP boundary. The host canary proves only that *this*
 * host answers request_permission with deny-by-default and then observes a
 * correlated structured deny update for that toolCallId.
 *
 * A private HOME alone does **not** defeat project-level OpenCode config;
 * OpenCode 1.18.10 still merges project permissions unless
 * `OPENCODE_DISABLE_PROJECT_CONFIG` is set and verified.
 *
 * ~~"Steady-state `--permissions allow` is a separate local opt-in after the
 * deny canary"~~ Dead 2026-08-11: allow is the DEFAULT, selected by omitting
 * the flag. The rest of that sentence stands and is why it matters — **the
 * canary does not prove allow_once behaviour**, so the mode now reached by
 * default is the one the canary does not cover.
 */

import type {
  PermissionCallback,
  PermissionDecision,
  PermissionOption,
  PermissionRequest,
} from "./types.js";

/** Default callback: reject_once if available, else cancel. Never allow. */
/**
 * Steady-state `--permissions allow`: take a ONE-TIME approval when the host offers one, and defer
 * to the deny-safe default otherwise.
 *
 * It never selects `allow_always` or `allow_session`. "Allow" means one tool call, decided again
 * next time — the same thing a person does clicking through a prompt.
 *
 * Lived as four byte-identical private copies in the model adapters until 2026-08-11, which meant
 * the fallback branch could not be tested against the real code: a test could only re-implement it
 * and assert its own copy. Extracted so tests/host-permission-session-scope.test.ts exercises what
 * ships. Verified identical across all four before the move.
 */
export function allowOnceOrDeny(request: PermissionRequest): PermissionDecision {
  const allowOnce = request.options.find((option) => option.kind === "allow_once");
  return allowOnce
    ? { outcome: "selected", optionId: allowOnce.optionId }
    : defaultPermissionCallback(request);
}

export function defaultPermissionCallback(
  request: PermissionRequest,
): PermissionDecision {
  const rejectOnce = request.options.find((opt) => opt.kind === "reject_once");
  if (rejectOnce) {
    return { outcome: "selected", optionId: rejectOnce.optionId };
  }
  const rejectAlways = request.options.find((opt) => opt.kind === "reject_always");
  if (rejectAlways) {
    return { outcome: "selected", optionId: rejectAlways.optionId };
  }
  return { outcome: "cancelled" };
}

export function resolvePermissionCallback(
  callback: PermissionCallback | undefined,
): PermissionCallback {
  return callback ?? defaultPermissionCallback;
}

/**
 * Parse the child's permission options, dropping any whose optionId is not uniquely ours to name.
 *
 * D-086 round 6. A duplicate optionId makes our answer AMBIGUOUS ON THE WIRE: a child can attach
 * the same id to `reject_once` and `allow_always`, we select "reject", and the response carries only
 * the shared id — which the child is free to read as the approval. That also makes the deny canary
 * vacuous for such input, because the canary's whole job is to prove our refusal was understood.
 *
 * Dropping duplicates rather than rejecting the whole request keeps a well-formed subset usable: if
 * what remains contains a reject, deny still works normally; if nothing remains, the default
 * callback cancels. Fail-closed either way.
 *
 * Found by the exact-review arm on da8d045. The point is not that the child might lie — it runs as
 * the operator and needs no permission from us to act. It is that a BUGGY provider can pass a canary
 * that proves nothing, and we would report `ready` while unable to restrain it.
 */
export function parsePermissionOptions(raw: unknown): PermissionOption[] {
  if (!Array.isArray(raw)) return [];
  const seen = new Map<string, number>();
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const id = (item as Record<string, unknown>).optionId;
    if (typeof id === "string" && id) seen.set(id, (seen.get(id) ?? 0) + 1);
  }
  const options: PermissionOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const optionId = rec.optionId;
    const name = rec.name;
    const kind = rec.kind;
    if (typeof optionId !== "string" || !optionId) continue;
    // An id that appears twice cannot identify our answer; see the note above.
    if ((seen.get(optionId) ?? 0) > 1) continue;
    if (typeof name !== "string") continue;
    if (
      kind !== "allow_once" &&
      kind !== "allow_always" &&
      kind !== "reject_once" &&
      kind !== "reject_always"
    ) {
      continue;
    }
    options.push({ optionId, name, kind });
  }
  return options;
}

export function permissionDecisionToResult(
  decision: PermissionDecision,
): { outcome: Record<string, unknown> } {
  if (decision.outcome === "cancelled") {
    return { outcome: { outcome: "cancelled" } };
  }
  return {
    outcome: {
      outcome: "selected",
      optionId: decision.optionId,
    },
  };
}
