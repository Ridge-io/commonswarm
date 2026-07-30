/**
 * D-025 — the p1-server harness retried a cold-start 502 and then returned it.
 *
 * Pure: no supabase, no network. Deliberate, for the same reason as the readiness gate's
 * observers — a fix for a startup flake evidenced only by "the flaky suite stopped failing"
 * cannot be distinguished from a lucky run.
 *
 * Every name below was checked against its own assertion before being written (D-024).
 *
 * ★ THIS FILE IS NAMED IN `npm test`, AND THAT IS LOAD-BEARING.
 *
 * It was first written into tests/support/ where NO npm script reached — `test` names its
 * files explicitly, the two suite scripts glob their own directories, and `check:tests` only
 * TYPECHECKS. Six observers proving the D-025 fix therefore ran in no suite: they passed only
 * when invoked by hand, which is not a gate. Found by Nori. D-012's shape — a guard nothing
 * executes — inside the change whose subject is a failure that went unreported.
 *
 * The first fix moved it to tests/p1-cli/, where the glob would pick it up. At that time the
 * same glob also pulled in local-integration.test.ts, which spawns `supabase functions serve`
 * and writes Postgres, so Nori withdrew that preference: filing PURE observers there would
 * have meant they could only run inside an exclusive database slot. D-030 later split that
 * stack-touching file into `test:p1-local`, making `test:p1-cli` pure as well.
 *
 * So it stays beside the helper it tests and is named in `npm test`, which touches no network
 * and no database. That is what makes the mutation proof for this change runnable by anyone,
 * at any time, without coordination.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { ColdStartExhausted, postThroughColdStart } from "./edge-readiness.js";

function scripted(statuses: Array<{ status: number; body?: string }>) {
  let calls = 0;
  const attempt = async () => {
    const next = statuses[Math.min(calls, statuses.length - 1)]!;
    calls += 1;
    return new Response(next.body ?? "", { status: next.status });
  };
  return { attempt, calls: () => calls };
}

function clock() {
  let t = 0;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

const run = (attempt: () => Promise<Response>, attempts = 10) => {
  const { now, sleep } = clock();
  return postThroughColdStart({ attempt, attempts, sleep, now, intervalMs: 100 });
};

test("D-025: a cold-start 502 that clears returns the real response", async () => {
  const { attempt, calls } = scripted([
    { status: 502, body: "unknown_error" },
    { status: 502, body: "unknown_error" },
    { status: 200, body: "{}" },
  ]);
  const response = await run(attempt);
  assert.equal(response.status, 200);
  assert.equal(calls(), 3);
});

/** ★ THE DEFECT. This is what used to come back as an ordinary response. */
test("D-025: exhausting the retries THROWS rather than returning the last 502", async () => {
  const { attempt } = scripted([{ status: 502, body: "unknown_error" }]);
  await assert.rejects(
    () => run(attempt, 4),
    (error: unknown) => {
      assert.ok(
        error instanceof ColdStartExhausted,
        "exhaustion must be an error, not a 502 handed back as an answer",
      );
      return true;
    },
  );
});

test("D-025: the exhaustion error carries attempts, elapsed and last status", async () => {
  const { attempt } = scripted([{ status: 502, body: "boot in progress" }]);
  await assert.rejects(
    () => run(attempt, 4),
    (error: unknown) => {
      const exhausted = error as ColdStartExhausted;
      assert.equal(exhausted.attempts, 4);
      // 4 attempts, sleeping only BETWEEN them: 3 intervals of 100ms.
      assert.equal(exhausted.elapsedMs, 300);
      assert.equal(exhausted.lastStatus, 502);
      assert.match(exhausted.lastBody, /boot in progress/);
      // The message must say what happened, so the failure is diagnosable without a debugger.
      assert.match(exhausted.message, /4 attempts over 300ms/);
      assert.match(exhausted.message, /not a failure of whatever assertion follows/);
      return true;
    },
  );
});

test("D-025: it makes exactly the number of attempts it was given", async () => {
  const { attempt, calls } = scripted([{ status: 502 }]);
  await assert.rejects(() => run(attempt, 3));
  assert.equal(calls(), 3);
});

/* ---------- it must never swallow a decided answer ---------- */

/**
 * Only 502 is retried. Everything else is a decided answer and comes straight back, so this
 * cannot become a machine for hiding defects — the constraint Lead6 set for D-020 and the
 * reason that fix was a gate rather than a retry. Here a retry IS correct, because a cold
 * Deno module genuinely answers 502 and genuinely recovers; the allowlist is what keeps it
 * honest.
 */
test("D-025: a decided status is returned on the first attempt, never retried", async () => {
  for (const status of [200, 400, 401, 403, 409, 500, 503]) {
    const { attempt, calls } = scripted([{ status }, { status: 200, body: "masked!" }]);
    const response = await run(attempt);
    assert.equal(response.status, status, `HTTP ${status} must not be retried`);
    assert.equal(calls(), 1, `HTTP ${status} was retried, so a real answer could be masked`);
  }
});

test("D-025: a 500 is not treated as a cold start", async () => {
  // 500 is the function running and failing — the opposite of not being up yet.
  const { attempt, calls } = scripted([{ status: 500, body: "internal_error" }]);
  const response = await run(attempt);
  assert.equal(response.status, 500);
  assert.equal(calls(), 1);
});

/* ---------- the trace, which exists to settle attribution in one run ---------- */

/**
 * ★ INSTRUMENTATION THAT IS NOT OBSERVED IS THE THING THIS BRANCH IS ABOUT.
 *
 * The trace exists to answer "did this test spend time in the retry loop?" without a second
 * run. If it were wrong — silent when it should speak, or speaking when it should not — the
 * attribution it is supposed to settle would be settled WRONGLY, which is worse than having
 * no trace. So it is pinned rather than trusted.
 */
test("D-025: a call that never waited emits no trace line", () => {
  const lines: string[] = [];
  const { attempt } = scripted([{ status: 200 }]);
  const { now, sleep } = clock();
  return postThroughColdStart({
    attempt, attempts: 10, sleep, now, label: "quiet", trace: (l) => lines.push(l),
  }).then(() => {
    assert.deepEqual(lines, [], "a first-attempt success must not add noise");
  });
});

test("D-025: a call that waited reports its call site, attempts and elapsed", async () => {
  const lines: string[] = [];
  const { attempt } = scripted([
    { status: 502 },
    { status: 502 },
    { status: 200 },
  ]);
  const { now, sleep } = clock();
  await postThroughColdStart({
    attempt, attempts: 10, sleep, now, intervalMs: 100,
    label: "T-03 probe", trace: (l) => lines.push(l),
  });
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /T-03 probe/);
  assert.match(lines[0]!, /cleared after 3 attempts/);
  assert.match(lines[0]!, /200ms/);
});

test("D-025: exhaustion is traced as well as thrown, so it is visible in a failing run", async () => {
  const lines: string[] = [];
  const { attempt } = scripted([{ status: 502 }]);
  const { now, sleep } = clock();
  await assert.rejects(() =>
    postThroughColdStart({
      attempt, attempts: 3, sleep, now, intervalMs: 100,
      label: "doomed", trace: (l) => lines.push(l),
    })
  );
  assert.equal(lines.length, 1);
  assert.match(lines[0]!, /doomed: EXHAUSTED after 3 attempts, 200ms, last HTTP 502/);
});
