import assert from "node:assert/strict";
import { test } from "node:test";
import { AcpHostSession } from "../../src/host/session.js";

/* D-081. The opencode permission canary is intermittent: byte-identical config, and reaching
 * ready is a coin flip. It lands on FIRST RUN, where a new user has no way to know a retry would
 * work — which is why it is the top launch risk rather than an annoyance.
 *
 * This is a MITIGATION and not a diagnosis. Seven mechanisms were proposed and refuted in one
 * afternoon; the cause is still unknown. The retry is justified by a narrower fact: the pass
 * condition depends on a remote model CHOOSING to attempt a tool call, and
 * `runPermissionBoundaryCanary` resets its own state and sends a fresh prompt, so a second call
 * genuinely re-samples that choice. Precedent: D-076's bounded one-shot retry shipped in 0.1.11
 * with its root cause open. */

type CanaryVerdict = { passed: boolean; reason?: string };

/* The real prototype, so the method under test is the shipped one — only its single dependency,
 * runPermissionBoundaryCanary, is scripted. Typed through a local shape rather than an
 * intersection with the class: `promptsEnabled` is private, and intersecting a private member
 * collapses the type to `never`. */
type CanaryHarness = {
  promptsEnabled: boolean;
  runPermissionBoundaryCanary: () => Promise<CanaryVerdict>;
  enablePromptsAfterCanary: (options?: {
    attempts?: number;
    onAttempt?: (attempt: number, total: number, result: CanaryVerdict) => void;
  }) => Promise<void>;
};

/** A session whose canary verdicts are scripted, counting how many times it was asked. */
function scripted(verdicts: boolean[]) {
  const session = Object.create(
    AcpHostSession.prototype,
  ) as unknown as CanaryHarness;
  session.promptsEnabled = false;
  let calls = 0;
  session.runPermissionBoundaryCanary = async () => {
    const passed = verdicts[Math.min(calls, verdicts.length - 1)]!;
    calls += 1;
    return {
      passed,
      sawPermissionRequest: passed,
      sawDeniedToolResult: passed,
      reason: passed ? undefined : `canary incomplete: attempt ${calls}`,
    };
  };
  return { session, calls: () => calls };
}

test("D-081: a first-attempt failure followed by a pass reaches ready instead of failing", async () => {
  const s = scripted([false, true]);
  const seen: Array<[number, number, boolean]> = [];

  await s.session.enablePromptsAfterCanary({
    onAttempt: (a: number, t: number, r: CanaryVerdict) =>
      seen.push([a, t, r.passed]),
  });

  assert.equal(s.calls(), 2, "it did not retry");
  assert.deepEqual(seen, [[1, 2, false], [2, 2, true]], "both attempts must be reported");
});

test("D-081: a HAPPY PATH costs exactly one canary — the retry is not a tax on everyone", async () => {
  /* CONTROL. A retry implemented as "always run twice" would satisfy the test above while
   * doubling the startup cost of every healthy listener, which is worse than the defect for the
   * majority of runs. */
  const s = scripted([true]);

  await s.session.enablePromptsAfterCanary();

  assert.equal(s.calls(), 1, "a passing canary was run more than once");
});

test("D-081: two failures still FAIL, and the error says it tried twice", async () => {
  /* CONTROL, and the one that matters most. A retry that masked a deterministic failure would be
   * a regression: the listener would be reported healthy when the host genuinely cannot prove the
   * permission boundary. The count must reach the message so a reader can tell "flaky, retried,
   * ready" from "failed twice" — those are different defects with different owners. */
  const s = scripted([false, false]);

  await assert.rejects(
    s.session.enablePromptsAfterCanary(),
    (error: unknown) => {
      assert.match(String((error as Error).message), /failed 2 attempts/);
      return true;
    },
  );
  assert.equal(s.calls(), 2, "it must not retry unboundedly");
});

test("D-081: attempts is bounded, so a large value cannot become an unbounded loop", async () => {
  /* The listener restart policy is deliberately bounded elsewhere in this codebase for the same
   * reason D-051 exists — an unbounded retry recreates an amplification one process at a time. */
  const s = scripted([false]);

  await assert.rejects(s.session.enablePromptsAfterCanary({ attempts: 3 }));
  assert.equal(s.calls(), 3, "attempts was not honoured exactly");

  const one = scripted([false]);
  await assert.rejects(one.session.enablePromptsAfterCanary({ attempts: 0 }));
  assert.equal(one.calls(), 1, "attempts below 1 must still run once, not zero times");
});
