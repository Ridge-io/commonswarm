export const ACTIVITY_EVENT = "activity";
export const ACTIVITY_TOPIC_PREFIX = "cswarm-activity:";
export const ACTIVITY_REQUEST_MAX_BYTES = 4_096;
export const ACTIVITY_TOOL_TITLE_MAX = 160;

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const PHASES = new Set([
  "claimed",
  "prompting",
  "tool-running",
  "replying",
  "idle",
]);
const REQUEST_KEYS = new Set([
  "version",
  "workspace_id",
  "stream_id",
  "sequence",
  "phase",
  "signal_id",
  "tool_title",
  "elapsed_ms",
]);

export interface ActivityRequest {
  version: 1;
  workspaceId: string;
  streamId: string;
  sequence: number;
  phase: "claimed" | "prompting" | "tool-running" | "replying" | "idle";
  signalId: string | null;
  toolTitle: string | null;
  elapsedMs: number;
}

/** A topic name derived from the authenticated workspace, never caller text. */
export function activityTopic(workspaceId: string): string {
  if (!UUID_RE.test(workspaceId)) throw new Error("activity workspace id is malformed");
  return `${ACTIVITY_TOPIC_PREFIX}${workspaceId.toLowerCase()}`;
}

/** Accept only the closed status-frame shape; bodies and raw tool data have no key. */
export function parseActivityRequest(value: unknown): ActivityRequest | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (Object.keys(record).some((key) => !REQUEST_KEYS.has(key))) return null;
  if (
    record.version !== 1 ||
    typeof record.workspace_id !== "string" ||
    !UUID_RE.test(record.workspace_id) ||
    typeof record.stream_id !== "string" ||
    !UUID_RE.test(record.stream_id) ||
    !Number.isSafeInteger(record.sequence) ||
    (record.sequence as number) < 1 ||
    typeof record.phase !== "string" ||
    !PHASES.has(record.phase) ||
    !(
      record.signal_id === null ||
      (typeof record.signal_id === "string" && UUID_RE.test(record.signal_id))
    ) ||
    !(
      record.tool_title === null ||
      (typeof record.tool_title === "string" &&
        record.tool_title.length > 0 &&
        record.tool_title.length <= ACTIVITY_TOOL_TITLE_MAX)
    ) ||
    !Number.isSafeInteger(record.elapsed_ms) ||
    (record.elapsed_ms as number) < 0 ||
    (record.elapsed_ms as number) > 7 * 24 * 60 * 60 * 1_000
  ) {
    return null;
  }
  if (
    (record.phase === "idle" &&
      (record.signal_id !== null || record.tool_title !== null || record.elapsed_ms !== 0)) ||
    (record.phase !== "idle" && record.signal_id === null) ||
    (record.phase === "tool-running") !== (record.tool_title !== null)
  ) {
    return null;
  }
  return {
    version: 1,
    workspaceId: record.workspace_id.toLowerCase(),
    streamId: record.stream_id.toLowerCase(),
    sequence: record.sequence as number,
    phase: record.phase as ActivityRequest["phase"],
    signalId: record.signal_id === null ? null : record.signal_id.toLowerCase(),
    toolTitle: record.tool_title as string | null,
    elapsedMs: record.elapsed_ms as number,
  };
}
