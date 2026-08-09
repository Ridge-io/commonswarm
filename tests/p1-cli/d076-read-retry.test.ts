import assert from "node:assert/strict";
import { test } from "node:test";
import { readAgentSignalDirectory } from "../../src/cloud/signals.js";

/* D-076. `postgres@3.4.9` crashes the read isolate outside the handler's promise catch — a
 * `nextWrite` firing after `closed()` has nulled the socket — and the platform answers 503.
 * Measured by Plumb against production: 8 crashes in a day, 8/8 joining a `POST 503 /read`.
 * Upstream PR #1168 adds the null guard and is still OPEN, so there is no version to upgrade to.
 *
 * A retry works here for a specific reason: it reaches a FRESH ISOLATE. That is not true of
 * server errors in general, which is why the scope below is narrow and each boundary is tested.
 *
 * The measured user-visible symptom was `member read could not reach the cloud service` at
 * roughly 1 in 12 — this exact function. */

const TARGET = { url: "https://example.supabase.co", anonKey: "anon" } as never;
const WORKSPACE = "00000000-0000-4000-8000-000000000001";

const ok = () =>
  new Response(JSON.stringify({ members: [], agents: [] }), { status: 200 });
const fail = (status: number, body: unknown = { error: "boom" }) =>
  new Response(JSON.stringify(body), { status });

/** A fetcher that replays a fixed script and counts calls. */
function scripted(responses: Array<() => Response>) {
  let calls = 0;
  const fetcher = (async () => {
    const make = responses[Math.min(calls, responses.length - 1)]!;
    calls += 1;
    return make();
  }) as unknown as typeof fetch;
  return { fetcher, calls: () => calls };
}

test("D-076: a 503 then a success — the read recovers instead of failing the command", async () => {
  const s = scripted([() => fail(503), ok]);

  const directory = await readAgentSignalDirectory(
    TARGET,
    "swm_agt_x",
    WORKSPACE,
    s.fetcher,
  );

  assert.deepEqual(directory, { members: [], agents: [] });
  assert.equal(s.calls(), 2, "expected exactly one retry");
});

test("D-076: a 4xx is NOT retried — repeating a rejected request cannot help", async () => {
  const s = scripted([() => fail(400)]);

  await assert.rejects(
    readAgentSignalDirectory(TARGET, "swm_agt_x", WORKSPACE, s.fetcher),
    /HTTP 400/,
  );
  assert.equal(s.calls(), 1, "a 4xx must not be repeated");
});

test("D-076: `retryable: false` vetoes the retry, even on a 5xx", async () => {
  /* D-051. That flag governs exactly this — an immediate retry of the same request — so the
   * server's instruction outranks the status code. Without this the fix would quietly overrule a
   * veto the server added on purpose. */
  const s = scripted([() => fail(503, { error: "boom", retryable: false })]);

  await assert.rejects(
    readAgentSignalDirectory(TARGET, "swm_agt_x", WORKSPACE, s.fetcher),
    /HTTP 503/,
  );
  assert.equal(s.calls(), 1, "the server's veto was ignored");
});

test("D-076: a persistently failing service still fails, and promptly", async () => {
  // The retry must not turn an outage into a hang. Three attempts total, then the error.
  const s = scripted([() => fail(503)]);

  await assert.rejects(
    readAgentSignalDirectory(TARGET, "swm_agt_x", WORKSPACE, s.fetcher),
    /HTTP 503/,
  );
  assert.equal(s.calls(), 3, "expected the initial attempt plus two retries");
});

test("D-076: a first-attempt success makes no extra request", async () => {
  // CONTROL for every test above. If the happy path retried, the counts they assert would all be
  // measuring a different behaviour than the one named.
  const s = scripted([ok]);

  await readAgentSignalDirectory(TARGET, "swm_agt_x", WORKSPACE, s.fetcher);
  assert.equal(s.calls(), 1);
});
