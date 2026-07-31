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
