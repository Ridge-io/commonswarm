/**
 * Local permission boundary for agent→client session/request_permission.
 *
 * Default is deny-safe: pick reject_once when offered, otherwise cancel.
 * Never auto-allow because of child or global config — only an injected
 * callback may select allow_*.
 *
 * Ambient Grok hooks (pre_tool_use / stop hooks loaded by the child from the
 * user's environment) sit *outside* this boundary. Passing the host canary
 * proves only that *this* host answers request_permission with deny-by-default;
 * it does not prove hooks will not act independently.
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
