import type { Readable } from "node:stream";

/**
 * Bounded capture of an ACP child's stderr, for the operator's own machine.
 *
 * Why this exists: a claude listener crash-looped on a user's laptop
 * (2026-08-19 — ready six times, dead ~35s after each) and every failure event
 * carried the bare code "error", because all four hosts drained stderr on the
 * grounds that it may contain prompt text or local paths. That privacy concern
 * is real, so the capture stays LOCAL-ONLY: the tail is handed to a callback
 * whose only consumers write the operator's own 0600 listener log. It must
 * never ride an error object — errors travel through retries, replies, and
 * server payloads; the tail must not. That is why AcpChildExitError carries no
 * tail field and never will.
 */

const RING_CAPACITY_BYTES = 4_096;
const TAIL_MAX_CHARS = 2_048;

/* Same classes invite-link.ts strips, minus newline/tab which stderr needs to
 * stay readable: ANSI escapes first, then control/bidi characters. */
const ANSI_ESCAPE_GLOBAL_RE = /\u001b\[[0-?]*[ -\/]*[@-~]/g;
const CONTROL_EXCEPT_NEWLINE_TAB_RE =
  /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/g;

/* Redacted at the producer, not merely rejected at the validator:
 * appendListenerEvent throws on these prefixes, and the supervisor's write
 * chain swallows that throw — so an unredacted token would silently drop the
 * one failure line the tail exists to enrich (the supervisor.ts write-chain
 * scar). */
const CREDENTIAL_PREFIX_RE = /swm_(?:agt|inv|cap)_[A-Za-z0-9_-]*/gi;

export interface StderrTailRing {
  /** Sanitized tail (last TAIL_MAX_CHARS chars) of what the child wrote. */
  read(): string;
}

/** Sanitize captured stderr for a local log line: no ANSI, no control chars. */
export function sanitizeStderrTail(raw: string): string {
  return raw
    .replace(ANSI_ESCAPE_GLOBAL_RE, "")
    .replace(CONTROL_EXCEPT_NEWLINE_TAB_RE, "")
    .replace(CREDENTIAL_PREFIX_RE, "[redacted-credential]")
    .slice(-TAIL_MAX_CHARS)
    .trim();
}

/**
 * Attach a bounded ring to a child's stderr. Consuming the stream replaces the
 * old drain (the 'data' handler keeps the pipe flowing), so backpressure
 * behavior is unchanged; only the last RING_CAPACITY_BYTES are retained, and
 * overflow discards the HEAD — the end of a crash log is the part that names
 * the cause.
 */
export function attachStderrTailRing(stderr: Readable): StderrTailRing {
  const chunks: Buffer[] = [];
  let total = 0;
  stderr.on("data", (chunk: Buffer | string) => {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    chunks.push(buffer);
    total += buffer.length;
    while (total > RING_CAPACITY_BYTES && chunks.length > 0) {
      const head = chunks[0]!;
      const excess = total - RING_CAPACITY_BYTES;
      if (head.length <= excess) {
        chunks.shift();
        total -= head.length;
      } else {
        chunks[0] = head.subarray(excess);
        total -= excess;
      }
    }
  });
  stderr.resume();
  return {
    read(): string {
      return sanitizeStderrTail(Buffer.concat(chunks).toString("utf8"));
    },
  };
}
