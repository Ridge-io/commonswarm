import {
  ACTIVITY_TOOL_TITLE_MAX,
  activityTopic,
} from "../../../supabase/functions/activity/core.js";

export const AGENT_ACTIVITY_STALE_MS = 30_000;
export const AGENT_ACTIVITY_INSTRUMENTATION_GRACE_MS = 17_000;
export const AGENT_ACTIVITY_ELAPSED_MAX_MS = 7 * 24 * 60 * 60 * 1_000;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHASES = new Set([
  "claimed",
  "prompting",
  "tool-running",
  "replying",
  "idle",
]);
const FRAME_KEYS = new Set([
  "version",
  "workspaceId",
  "principalId",
  "streamId",
  "sequence",
  "phase",
  "signalId",
  "toolTitle",
  "elapsedMs",
  "emittedAt",
]);

export type AgentActivityConnectionState =
  | "connecting"
  | "subscribed"
  | "unavailable";

export type AgentListenerPresence = "present" | "absent" | "unknown";

export interface AgentActivityFrame {
  version: 1;
  workspaceId: string;
  principalId: string;
  streamId: string;
  sequence: number;
  phase: "claimed" | "prompting" | "tool-running" | "replying" | "idle";
  signalId: string | null;
  toolTitle: string | null;
  elapsedMs: number;
  emittedAt: string;
}

export interface AgentActivityPanelView {
  state:
    | "fresh"
    | "stale"
    | "no-frames"
    | "not-instrumented"
    | "connecting"
    | "unavailable";
  ageLabel: string;
  phaseLabel: string | null;
  signalLabel: string | null;
  toolTitle: string | null;
  elapsedLabel: string | null;
  emptyMessage: string | null;
}

/** The private Realtime topic carries workspace scope, never a user-entered label. */
export const agentActivityTopic = activityTopic;

/** Reject malformed or expanded frames before they can become panel copy. */
export function parseAgentActivityFrame(
  value: unknown,
  expectedWorkspaceId: string,
): AgentActivityFrame | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !FRAME_KEYS.has(key))) return null;
  if (
    record.version !== 1 ||
    typeof record.workspaceId !== "string" ||
    record.workspaceId.toLowerCase() !== expectedWorkspaceId.toLowerCase() ||
    !UUID_RE.test(record.workspaceId) ||
    typeof record.principalId !== "string" ||
    !UUID_RE.test(record.principalId) ||
    typeof record.streamId !== "string" ||
    !UUID_RE.test(record.streamId) ||
    !Number.isSafeInteger(record.sequence) ||
    (record.sequence as number) < 1 ||
    typeof record.phase !== "string" ||
    !PHASES.has(record.phase) ||
    !(
      record.signalId === null ||
      (typeof record.signalId === "string" && UUID_RE.test(record.signalId))
    ) ||
    !(
      record.toolTitle === null ||
      (typeof record.toolTitle === "string" &&
        record.toolTitle.length > 0 &&
        record.toolTitle.length <= ACTIVITY_TOOL_TITLE_MAX)
    ) ||
    !Number.isSafeInteger(record.elapsedMs) ||
    (record.elapsedMs as number) < 0 ||
    (record.elapsedMs as number) > AGENT_ACTIVITY_ELAPSED_MAX_MS ||
    typeof record.emittedAt !== "string" ||
    !Number.isFinite(Date.parse(record.emittedAt))
  ) {
    return null;
  }
  if (
    (record.phase === "idle" &&
      (record.signalId !== null || record.toolTitle !== null || record.elapsedMs !== 0)) ||
    (record.phase !== "idle" && record.signalId === null) ||
    (record.phase === "tool-running") !== (record.toolTitle !== null)
  ) {
    return null;
  }
  return {
    version: 1,
    workspaceId: record.workspaceId.toLowerCase(),
    principalId: record.principalId.toLowerCase(),
    streamId: record.streamId.toLowerCase(),
    sequence: record.sequence as number,
    phase: record.phase as AgentActivityFrame["phase"],
    signalId: record.signalId === null ? null : record.signalId.toLowerCase(),
    toolTitle: record.toolTitle as string | null,
    elapsedMs: record.elapsedMs as number,
    emittedAt: record.emittedAt,
  };
}

/** Keep the newest self-contained frame and ignore reconnect replay or reordering. */
export function agentActivityFrameIsNewer(
  current: AgentActivityFrame | undefined,
  next: AgentActivityFrame,
): boolean {
  if (!current) return true;
  if (current.streamId === next.streamId) return next.sequence > current.sequence;
  return Date.parse(next.emittedAt) >= Date.parse(current.emittedAt);
}

function durationLabel(milliseconds: number): string {
  const seconds = Math.max(0, Math.floor(milliseconds / 1_000));
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  const remaining = seconds % 60;
  if (minutes < 60) return `${minutes}m ${remaining}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

function phaseLabel(phase: AgentActivityFrame["phase"]): string {
  if (phase === "tool-running") return "Tool running";
  return phase.charAt(0).toUpperCase() + phase.slice(1);
}

/** Project one frame into the fresh, stale, and honest empty panel states. */
export function agentActivityPanelView(
  frame: AgentActivityFrame | undefined,
  connection: AgentActivityConnectionState,
  now: number,
  listenerPresence: AgentListenerPresence = "unknown",
): AgentActivityPanelView {
  if (!frame) {
    if (connection === "connecting") {
      return {
        state: "connecting",
        ageLabel: "Connecting",
        phaseLabel: null,
        signalLabel: null,
        toolTitle: null,
        elapsedLabel: null,
        emptyMessage: "Checking for live listener activity…",
      };
    }
    if (connection === "unavailable") {
      return {
        state: "unavailable",
        ageLabel: "Unavailable",
        phaseLabel: null,
        signalLabel: null,
        toolTitle: null,
        elapsedLabel: null,
        emptyMessage: "Live activity is unavailable. The saved agent details are unchanged.",
      };
    }
    if (listenerPresence === "absent") {
      return {
        state: "not-instrumented",
        ageLabel: "Not instrumented",
        phaseLabel: null,
        signalLabel: null,
        toolTitle: null,
        elapsedLabel: null,
        emptyMessage: "Not instrumented — this agent has no listener",
      };
    }
    return {
      state: "no-frames",
      ageLabel: "No frames received",
      phaseLabel: null,
      signalLabel: null,
      toolTitle: null,
      elapsedLabel: null,
      emptyMessage: "No activity frames received",
    };
  }
  const ageMs = Math.max(0, now - Date.parse(frame.emittedAt));
  const stale = ageMs > AGENT_ACTIVITY_STALE_MS;
  return {
    state: stale ? "stale" : "fresh",
    ageLabel: stale
      ? `last seen ${Math.floor(ageMs / 1_000)} s ago`
      : "Live now",
    phaseLabel: phaseLabel(frame.phase),
    signalLabel: frame.signalId,
    toolTitle: frame.toolTitle,
    elapsedLabel: stale
      ? "stale"
      : durationLabel(
        frame.phase === "idle"
          ? 0
          : Math.min(
            AGENT_ACTIVITY_ELAPSED_MAX_MS,
            frame.elapsedMs + ageMs,
          ),
      ),
    emptyMessage: null,
  };
}
