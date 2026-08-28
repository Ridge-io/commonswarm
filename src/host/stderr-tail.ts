import type { ChildProcessWithoutNullStreams } from "node:child_process";
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

/** Hard bound between child exit and delivery of its final stderr tail. */
export const STDERR_EXIT_GRACE_MS = 100;
/** Keep stdout EOF from winning the bounded stderr-exit observation. */
export const STDERR_READABLE_END_GRACE_MS = STDERR_EXIT_GRACE_MS + 50;

/* ONE definition of "a character that ends a token or a line", so the eviction
 * boundary and the redactor's terminator can never disagree about where a token
 * ends — a divergence between them (JS \s omits the zero-width joiners) let a
 * bisected credential leak its suffix. EXOTIC covers every non-ASCII space, the
 * line/paragraph separators, the zero-width joiners, the word joiner, the BOM,
 * and the bidi controls. Built from \uXXXX source strings via `new RegExp` on
 * purpose: no raw control byte ever sits in a literal here. */
const EXOTIC_SEPARATORS =
  "\\u00a0\\u1680\\u2000-\\u200d\\u2028\\u2029\\u202a-\\u202e\\u2060\\u2066-\\u2069\\u202f\\u205f\\u3000\\ufeff";
/* Token terminator / line boundary: ASCII whitespace plus every EXOTIC one. */
const SEPARATOR_CLASS_SOURCE = "\\t\\n\\x0b\\f\\r " + EXOTIC_SEPARATORS;

const ANSI_ESCAPE_GLOBAL_RE = new RegExp("\\u001b\\[[0-?]*[ -\\/]*[@-~]", "g");
/* Delete control characters (except tab, newline, and space, which stderr
 * needs to stay readable) AND every EXOTIC separator. Deleting the exotics is
 * what lets a token laced with NBSP or a zero-width joiner REASSEMBLE into its
 * plain spelling before the redactor runs — otherwise the redactor would
 * terminate the token mid-secret and leave the remainder. */
const CONTROL_AND_SEPARATOR_STRIP_RE = new RegExp(
  "[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f" + EXOTIC_SEPARATORS + "]",
  "g",
);

/* Redacted at the producer, not merely rejected at the validator:
 * appendListenerEvent throws on these prefixes, and the supervisor's write
 * chain swallows that throw — so an unredacted token would silently drop the
 * one failure line the tail exists to enrich (the supervisor.ts write-chain
 * scar). The terminator is the shared separator class (not the token's own
 * charset), so an unexpected character inside a leaked secret cannot split it
 * into a redacted head and a surviving tail.
 *
 * POSTURE (bounded, and deliberately not grown further): this is a LOCAL 0600
 * diagnostic log, and redaction is defense-in-depth, not the containment
 * boundary. Two mechanisms cover the two places a secret can appear, and
 * together they are the whole posture — do not keep adding code points:
 *   1. WITHIN a surviving complete line, a credential fragment separated by
 *      whitespace from other text is redacted per token by this greedy match;
 *      the strip first deletes exotic separators so a laced token reassembles.
 *   2. AT the eviction boundary, the structural whole-line drop in read()
 *      removes any bisected partial line before redaction ever runs, so no
 *      straddle-at-the-cut fragment reaches this regex regardless of the
 *      separator at the byte boundary. */
const CREDENTIAL_PREFIX_RE = new RegExp(
  `swm_(?:agt|inv|cap)_[^${SEPARATOR_CLASS_SOURCE}]*`,
  "gi",
);

export interface StderrTailRing {
  /** Sanitized tail (last TAIL_MAX_CHARS chars) of what the child wrote. */
  read(): string;
}

/**
 * Sanitize captured stderr for a local log line: no ANSI, no control chars,
 * no credential-shaped substrings.
 *
 * Order is load-bearing. Strips run BEFORE the redactor so a token laced with
 * ANSI or zero-width characters reassembles into its plain spelling and is
 * then caught; and the redactor runs BEFORE the final char slice so the slice
 * can never bisect a token into an unrecognizable suffix — by then the token
 * is already the redaction marker.
 */
export function sanitizeStderrTail(raw: string): string {
  return raw
    .replace(ANSI_ESCAPE_GLOBAL_RE, "")
    .replace(CONTROL_AND_SEPARATOR_STRIP_RE, "")
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
  let evicted = false;
  stderr.on("data", (chunk: Buffer | string) => {
    const buffer = typeof chunk === "string" ? Buffer.from(chunk) : chunk;
    chunks.push(buffer);
    total += buffer.length;
    while (total > RING_CAPACITY_BYTES && chunks.length > 0) {
      evicted = true;
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
      let text = Buffer.concat(chunks).toString("utf8");
      if (evicted) {
        /* STRUCTURAL: the byte eviction can bisect the first retained line —
         * and with it a leaked credential — mid-token, leaving a suffix the
         * redactor's prefix match cannot recognize. A partial first line is
         * NEVER kept: drop through the first newline; if the whole retained
         * region is one unterminated line, drop it ENTIRELY. This closes every
         * straddle-at-the-cut case regardless of which separator sits at the
         * byte boundary — no partial line survives to be redacted — so the
         * posture does not depend on enumerating separators. A partial first
         * line is noise; a partial secret is a leak. */
        const newline = text.indexOf("\n");
        text = newline === -1 ? "" : text.slice(newline + 1);
      }
      return sanitizeStderrTail(text);
    },
  };
}

type ChildExitHandler = (
  code: number | null,
  signal: NodeJS.Signals | null,
) => void;

/**
 * Couple one child's stderr tail to its exit before the failure is published.
 *
 * A fast Grok worker on 0.1.29 reproduced the measured failure this fixes: its
 * exit reached the supervisor before pending stderr bytes, leaving the local
 * diagnostic tail null. Waiting only for close is unsafe too: a grandchild can
 * inherit stdio and delay close indefinitely. The short timer is therefore the
 * hard upper bound, while close can complete sooner when the final bytes flush.
 *
 * The latch and removed close listener are per child. They preserve the other
 * measured invariant: a late close from worker A can never publish A's stderr
 * into the callback state already serving worker B.
 */
export function attachStderrTailExitObserver(
  child: ChildProcessWithoutNullStreams,
  onStderrTail?: (tail: string) => void,
): (handler: ChildExitHandler) => void {
  const stderrTail = attachStderrTailRing(child.stderr);

  return (handler) => {
    const observeExit = (
      code: number | null,
      signal: NodeJS.Signals | null,
    ) => {
      let completed = false;
      let timer: NodeJS.Timeout | null = null;
      const complete = () => {
        if (completed) return;
        completed = true;
        if (timer) clearTimeout(timer);
        child.removeListener("close", complete);
        try {
          onStderrTail?.(stderrTail.read());
        } finally {
          handler(code, signal);
        }
      };
      child.once("close", complete);
      timer = setTimeout(complete, STDERR_EXIT_GRACE_MS);
      timer.unref();
    };

    if (child.exitCode !== null || child.signalCode !== null) {
      observeExit(child.exitCode, child.signalCode);
    } else {
      child.once("exit", observeExit);
    }
  };
}
