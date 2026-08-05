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

export const GROK_MEASURED_VERSION = "0.2.117";
/** Measured OpenCode CLI pin for the second ACP host adapter. */
export const OPENCODE_MEASURED_VERSION = "1.18.10";
/** Measured claude-agent-acp bridge pin for the Claude Code adapter. */
export const CLAUDE_ACP_MEASURED_VERSION = "0.64.2";
/** Claude 0.64.2 manual mode emits host-owned permission requests. */
export const CLAUDE_PERMISSION_MODE_ID = "default";
/** Measured codex-acp bridge pin for the Codex adapter. */
export const CODEX_ACP_MEASURED_VERSION = "1.1.9";
/** Codex 1.1.9 read-only mode emits host-owned permission requests. */
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
