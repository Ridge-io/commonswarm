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

/** Credential prefixes shared by local diagnostics and outbound activity text. */
export const CREDENTIAL_PREFIX_RE = new RegExp(
  `swm_(?:agt|inv|cap)_[^${SEPARATOR_CLASS_SOURCE}]*`,
  "gi",
);

/** Remove terminal controls and redact CommonSwarm credentials before text leaves a host boundary. */
export function redactCredentialText(value: string): string {
  return value
    .replace(ANSI_ESCAPE_GLOBAL_RE, "")
    .replace(CONTROL_AND_SEPARATOR_STRIP_RE, "")
    .replace(CREDENTIAL_PREFIX_RE, "[redacted-credential]");
}
