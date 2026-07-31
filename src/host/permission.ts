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
 * `OPENCODE_DISABLE_PROJECT_CONFIG` is set and verified. Steady-state
 * `--permissions allow` is a separate local opt-in after the deny canary —
 * the canary does not prove allow_once behaviour.
 */

import type {
  PermissionCallback,
  PermissionDecision,
  PermissionOption,
  PermissionRequest,
} from "./types.js";

/** Default callback: reject_once if available, else cancel. Never allow. */
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

export function parsePermissionOptions(raw: unknown): PermissionOption[] {
  if (!Array.isArray(raw)) return [];
  const options: PermissionOption[] = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const rec = item as Record<string, unknown>;
    const optionId = rec.optionId;
    const name = rec.name;
    const kind = rec.kind;
    if (typeof optionId !== "string" || !optionId) continue;
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
