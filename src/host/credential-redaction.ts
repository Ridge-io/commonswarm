/* ONE definition of "a character that ends a token or a line", so every
 * outbound host surface agrees with the local stderr tail. JavaScript \s omits
 * zero-width joiners. The explicit set covers non-ASCII spaces, line and
 * paragraph separators, joiners, the BOM, and bidi controls. */
const EXOTIC_SEPARATORS =
  "\\u00a0\\u1680\\u2000-\\u200d\\u2028\\u2029\\u202a-\\u202e\\u2060\\u2066-\\u2069\\u202f\\u205f\\u3000\\ufeff";
const SEPARATOR_CLASS_SOURCE = "\\t\\n\\x0b\\f\\r " + EXOTIC_SEPARATORS;

const ANSI_ESCAPE_GLOBAL_RE = new RegExp("\\u001b\\[[0-?]*[ -\\/]*[@-~]", "g");
/* Delete control characters except tab, newline, and space. Deleting exotic
 * separators reassembles a credential laced with zero-width joiners before the
 * prefix match runs. The order in redactCredentialText is load-bearing. */
const CONTROL_AND_SEPARATOR_STRIP_RE = new RegExp(
  "[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f" + EXOTIC_SEPARATORS + "]",
  "g",
);

/**
 * Token prefixes and wake-topic names that must not leave a host boundary.
 * The wake topic `cswarm-wake:` plus 43 base64url characters is the credential
 * (docs/design/2026-09-06-PUSH-DELIVERY.md §2.2 W1). Flags are `i` only: a
 * shared `/g` regex leaves lastIndex set after a match, so the next .test()
 * on another string can miss. Replace sites compile `gi` from this source.
 */
export const SECRET_SHAPE_RE = new RegExp(
  `swm_(?:agt|inv|cap)_[^${SEPARATOR_CLASS_SOURCE}]*|cswarm-wake:[A-Za-z0-9_-]{43}`,
  "i",
);

const SECRET_SHAPE_GLOBAL_RE = new RegExp(SECRET_SHAPE_RE.source, "gi");

/** Remove terminal controls and redact CommonSwarm credentials before text leaves a host boundary. */
export function redactCredentialText(value: string): string {
  return value
    .replace(ANSI_ESCAPE_GLOBAL_RE, "")
    .replace(CONTROL_AND_SEPARATOR_STRIP_RE, "")
    .replace(SECRET_SHAPE_GLOBAL_RE, "[redacted-credential]");
}
