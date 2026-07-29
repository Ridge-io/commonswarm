/**
 * D-020 — waiting for the local edge function to be RUNNING, not merely reachable.
 * D-024 — and never erasing a decided answer while doing it.
 *
 * `local-integration.test.ts` used to treat any `401` as "the command function has started".
 * A 401 proves the request reached something willing to reject it — the local gateway answers
 * one before the function module is loaded — so the gate returned while the runtime was still
 * booting, and the first real command hit a cold module and came back `502 unknown_error`.
 * Measured at roughly 1 in 8 full runs.
 *
 * ★ THE GATE WAS NAMED FOR WHAT IT WANTED AND WROTE DOWN WHAT IT COULD SEE. It was a
 * readiness check that returned success for something other than the thing it claimed to
 * establish.
 *
 * ★ WHY A GATE AND NOT A RETRY. A bounded retry around the failing command would also make
 * the flake go away, and it would do it by swallowing responses — and a retry that cannot
 * distinguish a cold-start 502 from a genuine refusal is a mechanism for hiding defects,
 * which is worse than the flake it fixes. This waits BEFORE the test's assertions begin and
 * swallows nothing: once the gate returns, every response the test sees is delivered to it
 * unmodified.
 *
 * ★★ AND THAT ARGUMENT WAS NOT EXPRESSIBLE IN THE FIRST VERSION OF THIS FILE (D-024).
 *
 * The predicate was two-valued: `running` or `not-yet`. `not-yet` was the keep-waiting value,
 * and everything that was not the function's own 401 mapped to it — including a decided 403.
 * So a forbidden probe was indistinguishable from a cold runtime. Nori demonstrated the
 * consequence by scripting 403-then-401; reproduced here before fixing:
 *
 *     RESOLVED after 2 calls — the 403 was ERASED
 *
 * The gate-not-retry reasoning was right; the TYPE WAS TOO SMALL TO HOLD IT. Two values
 * cannot separate "keep waiting" from "stop now", so the guarantee had nowhere to live, and
 * a test asserting `403 -> not-yet` read as protection while encoding the opposite.
 *
 * The verdict is therefore TRI-STATE, and the retryable set is an explicit ALLOWLIST:
 * anything not named as a boot artefact is a decided answer that stops the gate immediately,
 * carrying its status and body out with it.
 */

/**
 * What a probe response proves.
 *
 * - `running`  — the function's own code answered. Stop, successfully.
 * - `starting` — an explicitly identified boot/gateway artefact. Keep waiting.
 * - `refused`  — a decided answer, from something ready enough to decide. Stop loudly and
 *                carry the evidence. Never retried, so it can never be erased by a later
 *                response.
 */
export type ReadinessVerdict =
  | { kind: "running" }
  | { kind: "starting"; detail: string }
  | { kind: "refused"; status: number; body: string };

/**
 * The only statuses that mean "the stack is still coming up".
 *
 * An allowlist, not a denylist, and the direction is the point: an unrecognised status
 * becomes `refused` and fails the gate loudly. A boot artefact we failed to anticipate costs
 * one noisy, diagnosable failure; a decided refusal we failed to anticipate would be waited
 * through in silence and then erased. Only one of those two mistakes hides a defect.
 */
const BOOT_STATUSES: ReadonlySet<number> = new Set([502, 503, 504]);

/**
 * What a probe response proves about the command function.
 *
 * The distinguishing evidence for `running` is the body: `supabase/functions/command/index.ts`
 * answers an unauthenticated request with its own JSON `{ "error": "unauthenticated" }`. The
 * gateway's 401 does not carry that shape. Status alone cannot tell them apart, which is
 * exactly why the original gate could not.
 *
 * A 401 that is not the function's maps to `starting` rather than `refused`. That is not an
 * exception to the allowlist — it is the one status that cannot carry a meaningful refusal
 * here, because the probe is deliberately unauthenticated and 401 is the expected answer from
 * both the gateway and the function.
 */
export function readinessVerdict(status: number, body: string): ReadinessVerdict {
  if (status === 401) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(body);
    } catch {
      return { kind: "starting", detail: "401 without a JSON body (gateway)" };
    }
    if (
      typeof parsed === "object" && parsed !== null &&
      (parsed as { error?: unknown }).error === "unauthenticated"
    ) {
      return { kind: "running" };
    }
    return { kind: "starting", detail: "401 the function did not author (gateway)" };
  }
  if (BOOT_STATUSES.has(status)) {
    return { kind: "starting", detail: `HTTP ${status} while the runtime boots` };
  }
  return { kind: "refused", status, body };
}

/** A decided refusal the gate stopped on, carrying its evidence rather than re-deriving it. */
export class ReadinessRefused extends Error {
  override name = "ReadinessRefused";
  constructor(readonly status: number, readonly body: string) {
    super(
      `the readiness probe was refused with HTTP ${status}: ${body.slice(0, 300)}. ` +
        `That is a decided answer, not a cold runtime, so the gate stopped instead of waiting it out.`,
    );
  }
}

export interface ReadinessOptions {
  url: string;
  fetcher: typeof fetch;
  /** Milliseconds to keep probing before giving up loudly. */
  timeoutMs: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Included in the failure message so a timeout is diagnosable. */
  diagnostics?: () => string;
}

/**
 * Probe until the function itself answers, or fail loudly.
 *
 * Two distinct failures, deliberately different sentences: a decided refusal throws
 * `ReadinessRefused` on FIRST sighting, and a runtime that never comes up throws a timeout
 * naming the last thing seen. Neither returns — a gate that gave up quietly would hand the
 * suite the cold runtime it exists to wait for, and the resulting 502 would look like a
 * defect in whatever ran next.
 */
export async function awaitFunctionRunning(options: ReadinessOptions): Promise<void> {
  const deadline = options.now() + options.timeoutMs;
  let lastSeen = "no response";
  while (options.now() < deadline) {
    try {
      const response = await options.fetcher(options.url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ command_id: "healthcheck" }),
      });
      const body = await response.text();
      const verdict = readinessVerdict(response.status, body);
      if (verdict.kind === "running") return;
      /* Thrown on sight, before any further probe can run. That ordering is what makes "a
       * decided answer is never erased" structural: there is no later response, because
       * there is no later request. */
      if (verdict.kind === "refused") {
        throw new ReadinessRefused(verdict.status, verdict.body);
      }
      lastSeen = verdict.detail;
    } catch (error) {
      // A refusal must not be caught by the transport handler and demoted to "keep waiting".
      if (error instanceof ReadinessRefused) throw error;
      lastSeen = `transport: ${(error as Error).message}`;
    }
    await options.sleep(200);
  }
  throw new Error(
    `command function never reported running (last: ${lastSeen})\n${
      options.diagnostics?.() ?? ""
    }`,
  );
}

/* ------------------------------------------------------------------------- *
 * D-025 — a cold-start retry that reports exhaustion instead of hiding it.
 * ------------------------------------------------------------------------- */

/**
 * ★ WHAT THIS REPLACES, AND WHY IT IS THE D-024 FAMILY.
 *
 * `tests/p1-server/command.test.ts` retried a 502 up to ten times and then did this:
 *
 *     return response!;
 *
 * It handed the LAST 502 back as though it were an ordinary answer. So a runtime that never
 * came up did not surface as "the runtime never came up" — it surfaced as whatever assertion
 * happened to run next, usually a status or body comparison, in a test that has nothing to do
 * with process startup. The honest answer was available and got converted into a confusing
 * one, which is exactly D-024's shape: the information existed and the code threw it away.
 *
 * Retrying a 502 is right. A cold Deno module really does answer 502 and really does become
 * healthy. What is wrong is being quiet when the retries run out, because at that moment the
 * function knows something no caller can reconstruct: how many attempts, over how long, ending
 * in what status.
 */
export class ColdStartExhausted extends Error {
  override name = "ColdStartExhausted";
  constructor(
    readonly attempts: number,
    readonly elapsedMs: number,
    readonly lastStatus: number,
    readonly lastBody: string,
  ) {
    super(
      `the edge runtime never became healthy: ${attempts} attempts over ${elapsedMs}ms, ` +
        `last HTTP ${lastStatus}: ${lastBody.slice(0, 200)}. ` +
        `This is a runtime that did not boot, not a failure of whatever assertion follows.`,
    );
  }
}

export interface ColdStartRetryOptions {
  /** Performs one attempt. Kept generic so the caller owns url, headers and body. */
  attempt: () => Promise<Response>;
  /** How many times to try before reporting exhaustion. */
  attempts: number;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** Milliseconds between attempts. */
  intervalMs?: number;
  /**
   * Names this call site in the cold-start trace. Present so an attribution question can be
   * answered in ONE run: without it, "did this test spend time in the retry loop?" needs a
   * second run with instrumentation added, and the two runs may not fail the same way.
   */
  label?: string;
  /** Where a trace line goes. Defaults to stderr, so it survives a failing test's output. */
  trace?: (line: string) => void;
}

/**
 * Return the first response that is not a cold-start 502, or throw naming what was seen.
 *
 * ONLY 502 is retried. Every other status — including 500, 403 and any 2xx — is a decided
 * answer and is returned to the caller untouched on the first attempt, so this can never
 * swallow a real result. That is the same allowlist reasoning as the readiness gate above:
 * an unanticipated status returns immediately rather than being waited on.
 */
export async function postThroughColdStart(
  options: ColdStartRetryOptions,
): Promise<Response> {
  const started = options.now();
  const trace = options.trace ??
    ((line: string) => process.stderr.write(`${line}\n`));
  const label = options.label ?? "unlabelled";
  let lastStatus = 0;
  let lastBody = "";
  for (let attempt = 1; attempt <= options.attempts; attempt += 1) {
    const response = await options.attempt();
    if (response.status !== 502) {
      /* Traced only when the loop actually spun. A silent first-attempt success is the
       * common case and logging it would bury the interesting lines. A call site that never
       * appears here never waited — which is exactly how "was this test slow because of the
       * retry budget?" gets answered without guessing. */
      if (attempt > 1) {
        trace(
          `[cold-start] ${label}: cleared after ${attempt} attempts, ${
            options.now() - started
          }ms`,
        );
      }
      return response;
    }
    lastStatus = response.status;
    // Draining keeps the connection reusable; the body is kept for the failure message
    // rather than discarded, because "last HTTP 502: <what it said>" is the diagnosable part.
    lastBody = await response.text().catch(() => "");
    if (attempt < options.attempts) await options.sleep(options.intervalMs ?? 100);
  }
  trace(
    `[cold-start] ${label}: EXHAUSTED after ${options.attempts} attempts, ${
      options.now() - started
    }ms, last HTTP ${lastStatus}`,
  );
  throw new ColdStartExhausted(
    options.attempts,
    options.now() - started,
    lastStatus,
    lastBody,
  );
}
