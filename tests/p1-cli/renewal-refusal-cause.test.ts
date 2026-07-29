/**
 * D-004 — what the client is allowed to tell an operator when a renewal is refused at
 * 401/403, where the deployment names no cause at all.
 *
 * The instance is "an expired credential must not be reported as revoked". The class, which
 * is the thing actually worth protecting, is "the client never reports a cause it did not
 * measure" — see `assertion cause` below.
 */
import assert from "node:assert/strict";
import { randomBytes, randomUUID } from "node:crypto";
import { test } from "node:test";
import {
  AgentCredentialSession,
  type RefusalCode,
  RenewalRevoked,
  requestSuccessor,
  REVOCATION_REASONS_LIST,
} from "../../src/cloud/renewal.js";
import type {
  AgentCredentialRecord,
  AgentCredentialStore,
} from "../../src/cloud/agent-credential.js";
import { cloudTarget } from "../../src/cloud/config.js";

const NOW = 1_700_000_000_000;
const target = cloudTarget("http://127.0.0.1:54321", "anon-key");

/** A refusal the deployment does not explain, which is what it really sends today. */
function refusal(status: number, body: Record<string, unknown>): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;
}

async function refusalError(options: {
  status?: number;
  body?: Record<string, unknown>;
  expiresAt?: number | null;
}): Promise<Error> {
  try {
    await requestSuccessor({
      target,
      workspaceId: randomUUID(),
      predecessor: `swm_agt_${randomBytes(32).toString("base64url")}`,
      commandId: randomUUID(),
      expiresAt: options.expiresAt ?? null,
      fetcher: refusal(options.status ?? 401, options.body ?? { error: "forbidden" }),
      now: () => NOW,
    });
  } catch (error) {
    return error as Error;
  }
  assert.fail("a refused renewal must throw");
}

async function refusalMessage(options: {
  status?: number;
  body?: Record<string, unknown>;
  expiresAt?: number | null;
}): Promise<string> {
  try {
    await requestSuccessor({
      target,
      workspaceId: randomUUID(),
      predecessor: `swm_agt_${randomBytes(32).toString("base64url")}`,
      commandId: randomUUID(),
      expiresAt: options.expiresAt ?? null,
      fetcher: refusal(options.status ?? 401, options.body ?? { error: "forbidden" }),
      now: () => NOW,
    });
  } catch (error) {
    return (error as Error).message;
  }
  assert.fail("a refused renewal must throw");
}

/* ---------- the instance: D-004 itself ---------- */

test("D-004: a credential past its own expiry is reported as expired, not revoked", async () => {
  const message = await refusalMessage({ expiresAt: NOW - 1 });
  assert.match(message, /past its own expiry/);
  assert.doesNotMatch(message, /what was revoked/);
});

test("D-004: the expiry message does not deny a revocation it cannot see", async () => {
  const message = await refusalMessage({ expiresAt: NOW - 1 });
  // It must not claim the workspace is fine, and it must not promise the re-issue works.
  assert.doesNotMatch(message, /nothing (was|is) revoked|no revocation|is not revoked/i);
  assert.match(message, /revoked as well/);
});

test("a named revocation outranks local expiry, because re-issuing would fail again", async () => {
  const message = await refusalMessage({
    body: { error: "forbidden", reason: "renewal_lineage_revoked" },
    expiresAt: NOW - 1,
  });
  assert.match(message, /what was revoked/);
  assert.doesNotMatch(message, /past its own expiry/);
});

/* ---------- D-011: when nothing was established, name nothing ---------- */

test("D-011: an unexpired credential refused at 401 names neither cause", async () => {
  const message = await refusalMessage({ expiresAt: NOW + 60_000 });
  assert.doesNotMatch(message, /past its own expiry/);
  assert.doesNotMatch(message, /what was revoked|revoking a credential/);
  assert.match(message, /does not say why/);
});

test("D-011: a null expiry names neither cause rather than guessing", async () => {
  const message = await refusalMessage({ expiresAt: null });
  assert.doesNotMatch(message, /past its own expiry/);
  assert.doesNotMatch(message, /what was revoked|revoking a credential/);
  assert.match(message, /does not say why/);
});

test("D-011: the unexplained refusal still gives a remedy, and asks without asserting", async () => {
  const message = await refusalMessage({ expiresAt: null });
  assert.match(message, /Ask whoever runs this workspace/);
  // "was this access changed?" is a question; "what was revoked" presumes an answer.
  assert.match(message, /whether this agent's access was changed/);
});

/**
 * D-011 must not leak into the branch where revocation IS measured. A rejection arrives as
 * HTTP 200 with a named reason — there the client has evidence and should still say so.
 */
test("a server-named revocation at HTTP 200 still reports revocation", async () => {
  const message = await refusalMessage({
    status: 200,
    body: { status: "rejected", reason: "renewal_lineage_revoked" },
    expiresAt: null,
  });
  assert.match(message, /what was revoked/);
});

test("a server-named expiry at HTTP 200 keeps its own stronger message", async () => {
  const message = await refusalMessage({
    status: 200,
    body: { status: "rejected", reason: "predecessor_expired" },
    expiresAt: null,
  });
  assert.match(message, /expired before it could renew itself/);
  // The server confirmed expiry, so this one may say what the 401 path may not.
  assert.match(message, /nothing that was already posted is affected/);
});

test("403 is treated exactly as 401", async () => {
  const message = await refusalMessage({ status: 403, expiresAt: NOW - 1 });
  assert.match(message, /past its own expiry/);
});

/* ---------- the production path, not just the wire function ---------- */

/**
 * ★ EVERY TEST ABOVE CALLS requestSuccessor DIRECTLY AND PASSES expiresAt ITSELF, SO NONE OF
 * THEM CAN SEE THE HANDOFF THAT MAKES ANY OF IT REACH AN OPERATOR.
 *
 * In production nobody calls requestSuccessor; AgentCredentialSession.bearer() does, and it
 * has to hand its own `this.expiresAt` across. Delete that one property from the call site
 * and production silently reverts to the message D-004 exists to remove — while all seven
 * tests above stay green, because they were never routed through it. Found in cross-family
 * review by Mica (codex), who deleted the line and watched 7/7 pass anyway. The gap was
 * mine: I tested the unit I had changed instead of the path a person actually travels.
 *
 * This test therefore starts where the CLI starts — a session opened over an expired
 * credential — and only asserts on what comes back out of bearer().
 */
function memoryStore(): AgentCredentialStore {
  let record: AgentCredentialRecord | null = null;
  return {
    location: "memory://renewal-refusal-cause",
    read: async () => record,
    write: async (next) => {
      record = next;
    },
    delete: async () => {
      record = null;
    },
    withLock: async (work) => work(),
  };
}

function sessionExpiring(expiresAt: number): Promise<AgentCredentialSession> {
  return AgentCredentialSession.open({
    target,
    workspaceId: randomUUID(),
    presented: {
      token: `swm_agt_${randomBytes(32).toString("base64url")}`,
      tokenId: randomUUID(),
      principalId: randomUUID(),
      runId: randomUUID(),
      expiresAt,
    },
    store: memoryStore(),
    fetcher: refusal(401, { error: "forbidden" }),
    now: () => NOW,
    warn: () => {},
  });
}

const expiredSession = () => sessionExpiring(NOW - 1);

test("D-004 reaches production: bearer() on an expired credential reports expiry", async () => {
  const session = await expiredSession();
  await assert.rejects(
    () => session.bearer(),
    (error: unknown) => {
      assert.ok(
        error instanceof RenewalRevoked,
        "an unusable predecessor must still fail closed",
      );
      assert.equal(error.code, "predecessor_expired_local");
      assert.match(error.message, /past its own expiry/);
      assert.doesNotMatch(error.message, /what was revoked/);
      return true;
    },
  );
});

/**
 * D-011 through the same door, and this is the COMMON case rather than an edge one.
 *
 * Renewal fires ahead of expiry, so the ordinary refusal arrives while the credential is
 * still live and unexpired — which is exactly the input that used to reach for the
 * revocation message. A live credential refused at 401 is still fatal (RenewalRevoked is
 * rethrown even when the predecessor has time left, because a refusal we cannot explain is
 * not something to continue through); D-011 changes only what the person is told, and this
 * proves the new sentence is what actually reaches them.
 */
test("D-011 reaches production: bearer() on a live credential names no cause", async () => {
  const session = await sessionExpiring(NOW + 60_000);
  await assert.rejects(
    () => session.bearer(),
    (error: unknown) => {
      assert.ok(error instanceof RenewalRevoked);
      assert.match(error.message, /does not say why/);
      assert.doesNotMatch(error.message, /what was revoked|revoking a credential/);
      assert.doesNotMatch(error.message, /past its own expiry/);
      return true;
    },
  );
});


/* ---------- the class: never assert a cause you did not measure ---------- */

/**
 * ★ THIS CHECK WAS PROSE-BASED AND IT DID NOT WORK. THE REPLACEMENT IS STRUCTURAL.
 *
 * The first version read the operator-facing text with two regexes and called the result
 * "the causes this message asserts". Mica (codex) broke it in cross-family review by
 * appending one flatly false sentence — "This credential was revoked by an administrator."
 * — to the unexplained-refusal message. Build green, all 12 targeted tests green, including
 * the one named "names neither cause" and this class test with an empty deviation list. Two
 * regexes cannot decide what a paragraph of English claims, and adding a third would only
 * move the hole: the classifier is guessing at natural language, and the mutation just has
 * to phrase it differently.
 *
 * So the invariant is no longer read off the prose. It is read off the CODE the client
 * chooses, which is a closed set the client itself decides, and each code is mapped to the
 * cause it stands for. The prose is then pinned separately by exact equality, so changing
 * one word of an operator-facing sentence forces a deliberate edit here and a re-review,
 * rather than sliding through because it happened to dodge a regex.
 *
 * The two halves cover different failures and both are needed: the structural check catches
 * "this input picked the wrong branch", the equality pins catch "this branch's words changed
 * into something nobody approved".
 */

type Cause = "expiry" | "revocation" | null;

/**
 * Every code the 401/403 branch may throw, and the cause each one asserts to a reader.
 *
 * `Record<RefusalCode, Cause>` makes this exhaustive over the production tuple: adding a
 * revocation reason in renewal.ts leaves this object missing a key. The previous version was
 * a Map keyed by plain string, which stayed silent while production grew a sixth reason —
 * Mica added `credential_disabled` to the production set and all 15 tests passed.
 *
 * ★ BUT THE TYPE IS NOT WHAT CATCHES IT TODAY, AND SAYING OTHERWISE WOULD REPEAT D-017.
 *
 * `tsconfig.json` is `"include": ["src/**\/*.ts"]`, and no npm script typechecks this
 * directory — `build` is `tsc` over src, the test scripts run tsx, which strips types without
 * checking them. So this annotation fires in an editor and in nothing else. Measured, not
 * assumed: with the sixth reason added, `npx tsc --noEmit` exits 0.
 *
 * What actually fails is the runtime check below, because the input space is DERIVED from the
 * same tuple — the new reason gets sent, comes back as an unclassified code, and trips the
 * guard. The type annotation is kept because it is free and becomes a real second line the
 * day tests are typechecked. It is documented as inert so nobody counts it twice.
 */
const CAUSE_BY_CODE: Record<RefusalCode, Cause> = {
  predecessor_expired_local: "expiry",
  forbidden: null,
  renewal_lineage_revoked: "revocation",
  renewal_grant_revoked: "revocation",
  predecessor_revoked: "revocation",
  predecessor_not_found: "revocation",
  predecessor_not_owned: "revocation",
};

/** What the client could actually establish from the inputs it had. */
function measurableCauses(input: {
  expiresAt: number | null;
  reason?: string;
}): string[] {
  const causes: string[] = [];
  if (input.expiresAt !== null && NOW >= input.expiresAt) causes.push("expiry");
  if (input.reason !== undefined) causes.push("revocation");
  return causes;
}

/**
 * ★ EMPTY, AND IT HAS TO STAY EMPTY (D-011).
 *
 * It was not empty when this test was written: two inputs — no reason sent, expiry either in
 * the future or unreadable — fell through to the revocation message and named a cause on no
 * evidence, which is D-004's defect reached by a different route and the one an operator
 * meets by default. D-011 replaced that fallback with a message that names nothing.
 *
 * A non-empty list here is not a failing test to be appeased by adding an entry. It means
 * the client has started asserting a cause it did not measure, and the fix belongs in
 * src/cloud/renewal.ts.
 */
const KNOWN_UNMEASURED: ReadonlyArray<string> = [];

test("class: the client asserts no cause it did not measure at 401/403", async () => {
  /* ★ THE REASON HALF OF THIS SPACE IS DERIVED, NOT LISTED. A hand-written fixture only ever
   * exercises the reasons its author remembered, so a reason added to production is never
   * presented and never checked — which is exactly how the previous version passed 15/15
   * with a sixth production reason it had never heard of. Every member of the production
   * tuple is now sent, against both a measured and an unmeasured expiry. */
  const space: Array<{ label: string; expiresAt: number | null; reason?: string }> = [
    { label: "expiry=past reason=none", expiresAt: NOW - 1 },
    { label: "expiry=future reason=none", expiresAt: NOW + 60_000 },
    { label: "expiry=null reason=none", expiresAt: null },
    { label: "expiry=now reason=none", expiresAt: NOW },
    ...REVOCATION_REASONS_LIST.flatMap((reason) => [
      { label: `expiry=past reason=${reason}`, expiresAt: NOW - 1, reason },
      { label: `expiry=null reason=${reason}`, expiresAt: null, reason },
      { label: `expiry=future reason=${reason}`, expiresAt: NOW + 60_000, reason },
    ]),
  ];

  const violations: string[] = [];
  for (const item of space) {
    const error = await refusalError({
      expiresAt: item.expiresAt,
      body: item.reason === undefined
        ? { error: "forbidden" }
        : { error: "forbidden", reason: item.reason },
    });
    assert.ok(error instanceof RenewalRevoked, `${item.label}: must fail closed`);
    /* An unrecognised code is a violation, not a pass. This is the hole the regex version
     * had — anything it did not know about was silently treated as claiming nothing. A new
     * code has to be classified here before it can reach an operator. */
    assert.ok(
      Object.prototype.hasOwnProperty.call(CAUSE_BY_CODE, error.code),
      `${item.label}: unclassified refusal code ${JSON.stringify(error.code)} — add it to CAUSE_BY_CODE and say which cause it asserts`,
    );
    const claimed = CAUSE_BY_CODE[error.code as RefusalCode];
    if (claimed === null) continue;
    const measured = measurableCauses({
      expiresAt: item.expiresAt,
      ...(item.reason === undefined ? {} : { reason: item.reason }),
    });
    if (!measured.includes(claimed)) violations.push(`${item.label} -> ${claimed}`);
  }

  assert.deepEqual(
    violations,
    [...KNOWN_UNMEASURED],
    "a refusal picked a branch asserting a cause the client never measured; either measure it or stop saying it",
  );
});

/**
 * ★ THE PROSE PINS. DELIBERATELY LITERAL, NOT IMPORTED.
 *
 * Comparing against the exported constant would pass no matter what the constant said —
 * both sides would move together, which is precisely how Mica's mutation survived. These
 * strings are copies on purpose: editing an operator-facing sentence must break this file
 * and force someone to look at the new wording, because the wording IS the deliverable.
 */
const APPROVED_MESSAGES: ReadonlyArray<[string, { expiresAt: number | null; reason?: string }, string]> = [
  [
    "expired locally",
    { expiresAt: NOW - 1 },
    "This agent credential is past its own expiry, so renewal cannot bring it back. Ask whoever set this agent up for a new one. The deployment does not say why a credential was refused, so if a fresh one is refused too, ask them whether this agent's access was revoked as well.",
  ],
  [
    "unexplained refusal",
    { expiresAt: null },
    "This agent credential was refused, and the deployment does not say why — it answers every refusal identically on purpose, so that nobody can discover which credentials exist by asking. Renewal cannot get past that. Ask whoever runs this workspace for a new credential, and whether this agent's access was changed.",
  ],
  [
    "named revocation",
    { expiresAt: null, reason: "renewal_lineage_revoked" },
    "This agent credential is no longer accepted, and renewal cannot bring it back — that is deliberate: revoking a credential, a device, or a person's membership revokes everything descended from it. Ask whoever runs this workspace what was revoked and why, then get a new credential from them.",
  ],
];

for (const [name, input, expected] of APPROVED_MESSAGES) {
  test(`prose pin: the ${name} message is exactly the approved wording`, async () => {
    const message = await refusalMessage({
      expiresAt: input.expiresAt,
      body: input.reason === undefined
        ? { error: "forbidden" }
        : { error: "forbidden", reason: input.reason },
    });
    assert.equal(
      message,
      expected,
      `the ${name} message changed. That is not automatically wrong, but it is operator-facing text that was reviewed: update this pin deliberately and get the new wording re-read.`,
    );
  });
}
