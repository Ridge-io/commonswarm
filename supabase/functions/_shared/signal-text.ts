/** The signal-body bound duplicated across the edge, clients, and database constraint. */
export const SIGNAL_BODY_MAX = 8_000;

/** At most one blank line survives, so a hostile body cannot flood a terminal with whitespace. */
export const SIGNAL_BODY_MAX_CONSECUTIVE_NEWLINES = 2;

export const SIGNAL_UNSAFE_GLOBAL_RE =
  /[\u0000-\u001f\u007f-\u009f\u061c\u200b-\u200f\u2028-\u202e\u2060\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;
export const ANSI_ESCAPE_GLOBAL_RE = /\u001b\[[0-?]*[ -/]*[@-~]/g;
const SIGNAL_NEUTRALISED_WHITESPACE_GLOBAL_RE = /[\v\f\u0085\u2028\u2029]+/gu;

/** Preserve useful Markdown layout without allowing terminal redraw or unbounded blank space. */
export function sanitizeSignalText(value: string): string {
  return value
    .replace(ANSI_ESCAPE_GLOBAL_RE, "")
    .replace(/\r\n?/gu, "\n")
    .replace(SIGNAL_NEUTRALISED_WHITESPACE_GLOBAL_RE, " ")
    .replace(
      SIGNAL_UNSAFE_GLOBAL_RE,
      (character) => character === "\n" || character === "\t" ? character : "",
    )
    .replace(/\n{3,}/gu, "\n\n");
}
