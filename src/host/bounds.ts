/**
 * Hard size ceilings for ACP NDJSON framing and in-flight state.
 * Bound every untrusted child frame so a runaway agent cannot OOM the host.
 */

export const ACP_MAX_LINE_BYTES = 1_048_576;
export const ACP_MAX_FRAME_BYTES = ACP_MAX_LINE_BYTES;
export const ACP_MAX_PENDING_REQUESTS = 32;
export const ACP_MAX_ACCUMULATED_TEXT_CHARS = 4_194_304;
export const ACP_DEFAULT_REQUEST_TIMEOUT_MS = 120_000;
export const ACP_VERSION_CHECK_TIMEOUT_MS = 5_000;
export const ACP_CANARY_TIMEOUT_MS = 30_000;

/** Oldest Grok version allowed to reach the runtime permission canary. */
export const GROK_MIN_VERSION = "0.2.117";
/** Newest Grok version whose complete adapter behavior was measured. */
export const GROK_LAST_MEASURED_VERSION = "0.2.117";
/** Oldest OpenCode version allowed to reach the runtime permission canary. */
export const OPENCODE_MIN_VERSION = "1.18.10";
/** Newest OpenCode version whose complete adapter behavior was measured. */
export const OPENCODE_LAST_MEASURED_VERSION = "1.18.10";
/** Oldest claude-agent-acp version allowed to reach the runtime permission canary. */
export const CLAUDE_ACP_MIN_VERSION = "0.64.2";
/** Newest claude-agent-acp version whose complete adapter behavior was measured. */
export const CLAUDE_ACP_LAST_MEASURED_VERSION = "0.64.2";
/** Claude 0.64.2 manual mode emits host-owned permission requests. */
export const CLAUDE_PERMISSION_MODE_ID = "default";
/** Oldest codex-acp version allowed to reach the runtime permission canary. */
export const CODEX_ACP_MIN_VERSION = "1.1.9";
/** Newest codex-acp version whose complete adapter behavior was measured. */
export const CODEX_ACP_LAST_MEASURED_VERSION = "1.8.0";
/** Codex 1.8.0 read-only mode asks for HOME writes but permits cwd/TMPDIR writes. */
export const CODEX_PERMISSION_MODE_ID = "read-only";
export const ACP_PROTOCOL_VERSION = 1;

/**
 * Every OpenCode 1.18.10 tool name the host forces through ask/deny config.
 *
 * Project-level allow merging is stopped by OPENCODE_DISABLE_PROJECT_CONFIG
 * (verified via `debug config --pure`), not by this list or by a private home.
 * The wildcard is a secondary belt: once project merge is disabled, `*` keeps
 * unknown tool names on the ask path so ambient/global allow cannot soft-open
 * new tools without an ACP permission request.
 */
export const OPENCODE_FORCED_PERMISSION_TOOLS = [
  "bash",
  "glob",
  "read",
  "grep",
  "webfetch",
  "websearch",
  "write",
  "edit",
  "task",
  "apply_patch",
  "todowrite",
  "question",
  "skill",
  "execute",
  "external_directory",
  "*",
] as const;
