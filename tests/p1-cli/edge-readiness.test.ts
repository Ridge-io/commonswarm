/**
 * D-020 — the readiness gate for the local edge function.
 * D-024 — and the guarantee it claimed but could not express.
 *
 * These are pure: no supabase, no network, so they run everywhere the flaky integration test
 * does not. That is deliberate. A fix for a live-infrastructure flake whose only evidence is
 * "the live test stopped failing" would be unfalsifiable — you cannot tell a fixed flake from
 * a lucky run of a broken one.
 *
 * ★ EVERY TEST NAME BELOW WAS CHECKED AGAINST ITS OWN ASSERTION BEFORE BEING WRITTEN, because
 * that is precisely what failed here last time. The previous version contained:
 *
 *     test("the gate never treats a real refusal as a reason to keep waiting", () => {
 *       assert.equal(readinessVerdict(403, ...), "not-yet");   // "not-yet" IS keep-waiting
 *
 * The name claimed a guarantee, the comment above it explained why violating that guarantee
 * would be harmful, and the assertion required the violation. Three layers, none checked
 * against the others. When a name says "never X", the assertion has to be able to fail when
 * X happens — and with a two-valued verdict it could not.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  awaitFunctionRunning,
  readinessVerdict,
  ReadinessRefused,
} from "../support/edge-readiness.js";

/** The command function's own answer to an unauthenticated probe. */
const FUNCTION_401 = JSON.stringify({ error: "unauthenticated" });
/** What the gateway answers while the function module is still loading. */
const GATEWAY_401 = JSON.stringify({ message: "No API key found in request" });
const FORBIDDEN = JSON.stringify({ error: "forbidden" });

/* ---------- the predicate: three outcomes, not two ---------- */

test("D-020: the function's own 401 is the only response that means running", () => {
  assert.deepEqual(readinessVerdict(401, FUNCTION_401), { kind: "running" });
});

test("D-020: a gateway 401 means starting — this is the original defect", () => {
  // The first gate returned "ready" here, while the runtime was still cold.
  assert.equal(readinessVerdict(401, GATEWAY_401).kind, "starting");
  assert.equal(readinessVerdict(401, "").kind, "starting");
  assert.equal(readinessVerdict(401, "<html>401</html>").kind, "starting");
});

test("D-020: the three boot statuses mean starting", () => {
  for (const status of [502, 503, 504]) {
    assert.equal(readinessVerdict(status, "").kind, "starting", `HTTP ${status}`);
  }
});

/* ---------- D-024: a decided answer is a THIRD thing ---------- */

test("D-024: a 403 is refused, which is a different verdict from starting", () => {
  const verdict = readinessVerdict(403, FORBIDDEN);
  assert.equal(verdict.kind, "refused");
  // The assertion that the old test should have made and could not: refused is not starting.
  assert.notEqual(verdict.kind, "starting");
});

test("D-024: every status outside the boot allowlist is refused, not waited on", () => {
  // A denylist would have to anticipate refusals; this allowlist has to anticipate boot
  // artefacts, and being wrong about one of those fails loudly instead of hiding an answer.
  for (const status of [200, 400, 403, 404, 409, 429, 500]) {
    assert.equal(
      readinessVerdict(status, "body").kind,
      "refused",
      `HTTP ${status} must stop the gate, not extend it`,
    );
  }
});

test("D-024: a refused verdict carries the status and body it saw", () => {
  const verdict = readinessVerdict(403, FORBIDDEN);
  assert.equal(verdict.kind, "refused");
  if (verdict.kind !== "refused") return;
  assert.equal(verdict.status, 403);
  assert.equal(verdict.body, FORBIDDEN);
});

/* ---------- the gate ---------- */

function scriptedFetcher(responses: Array<{ status: number; body: string }>) {
  let calls = 0;
  const fetcher = (async () => {
    const next = responses[Math.min(calls, responses.length - 1)]!;
    calls += 1;
    return new Response(next.body, { status: next.status });
  }) as unknown as typeof fetch;
  return { fetcher, calls: () => calls };
}

function clock(startAt = 0) {
  let t = startAt;
  return { now: () => t, sleep: async (ms: number) => void (t += ms) };
}

const gate = (fetcher: typeof fetch, timeoutMs = 30_000, diagnostics?: () => string) => {
  const { now, sleep } = clock();
  return awaitFunctionRunning({
    url: "http://local/functions/v1/command",
    fetcher,
    timeoutMs,
    sleep,
    now,
    ...(diagnostics ? { diagnostics } : {}),
  });
};

test("D-020: the gate keeps waiting through gateway 401s and cold-start 502s", async () => {
  const { fetcher, calls } = scriptedFetcher([
    { status: 502, body: "unknown_error" },
    { status: 401, body: GATEWAY_401 },
    { status: 401, body: GATEWAY_401 },
    { status: 401, body: FUNCTION_401 },
  ]);
  await gate(fetcher);
  assert.equal(calls(), 4, "the gate must not stop at the gateway's 401");
});

/**
 * ★ NORI'S SCENARIO, AND THE ONE THAT PROVES D-024 IS FIXED.
 *
 * Against the two-valued predicate this RESOLVED in two calls and the 403 vanished. The
 * assertion is on the CALL COUNT as much as on the rejection: stopping after exactly one call
 * is what makes the guarantee structural, because a second request is the only way a later
 * response could overwrite the refusal.
 */
test("D-024: a 403 followed by a good 401 rejects after exactly ONE call", async () => {
  const { fetcher, calls } = scriptedFetcher([
    { status: 403, body: FORBIDDEN },
    { status: 401, body: FUNCTION_401 },
  ]);
  await assert.rejects(
    () => gate(fetcher),
    (error: unknown) => {
      assert.ok(error instanceof ReadinessRefused, "must be the refusal, not a timeout");
      assert.equal(error.status, 403);
      assert.match(error.message, /forbidden/);
      return true;
    },
  );
  assert.equal(
    calls(),
    1,
    "the gate probed again after a decided refusal, so a later response could erase it",
  );
});

test("D-024: a refusal survives being thrown through the transport handler", async () => {
  // The catch block exists for network errors. If it swallowed ReadinessRefused, the refusal
  // would be demoted to "keep waiting" and the gate would time out instead of naming it.
  const { fetcher } = scriptedFetcher([{ status: 500, body: "boom" }]);
  await assert.rejects(() => gate(fetcher), (error: unknown) => {
    assert.ok(error instanceof ReadinessRefused);
    assert.equal(error.status, 500);
    return true;
  });
});

test("D-020: the gate fails loudly rather than returning on a runtime that never boots", async () => {
  const { fetcher } = scriptedFetcher([{ status: 502, body: "unknown_error" }]);
  await assert.rejects(
    () => gate(fetcher, 1_000, () => "captured function logs"),
    (error: unknown) => {
      assert.ok(!(error instanceof ReadinessRefused), "a boot artefact is not a refusal");
      assert.match((error as Error).message, /never reported running/);
      assert.match((error as Error).message, /HTTP 502/);
      assert.match((error as Error).message, /captured function logs/);
      return true;
    },
  );
});

test("D-020: once the gate returns it performs no further requests", async () => {
  const { fetcher, calls } = scriptedFetcher([{ status: 401, body: FUNCTION_401 }]);
  await gate(fetcher);
  const afterReturn = calls();
  assert.equal(afterReturn, 1);
  assert.equal(calls(), afterReturn, "the gate must not remain active after returning");
});
