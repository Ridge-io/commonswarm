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
  RenewalRevoked,
  requestSuccessor,
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

test("an unexpired credential refused at 401 keeps the generic message", async () => {
  const message = await refusalMessage({ expiresAt: NOW + 60_000 });
  assert.doesNotMatch(message, /past its own expiry/);
});

test("a null expiry keeps the generic message rather than guessing", async () => {
  const message = await refusalMessage({ expiresAt: null });
  assert.doesNotMatch(message, /past its own expiry/);
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

async function expiredSession(): Promise<AgentCredentialSession> {
  return AgentCredentialSession.open({
    target,
    workspaceId: randomUUID(),
    presented: {
      token: `swm_agt_${randomBytes(32).toString("base64url")}`,
      tokenId: randomUUID(),
      principalId: randomUUID(),
      runId: randomUUID(),
      expiresAt: NOW - 1,
    },
    store: memoryStore(),
    fetcher: refusal(401, { error: "forbidden" }),
    now: () => NOW,
    warn: () => {},
  });
}

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

/* ---------- the class: never assert a cause you did not measure ---------- */

/** What a message CLAIMS the cause was, read off the text an operator actually sees. */
function assertedCauses(message: string): string[] {
  const causes: string[] = [];
  if (/past its own expiry|expired before it could/i.test(message)) causes.push("expiry");
  if (/what was revoked|revoking a credential/i.test(message)) causes.push("revocation");
  return causes;
}

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
 * ★ THE KNOWN DEVIATIONS, RULED IN DELIBERATELY, AND NOT MINE TO CLOSE.
 *
 * Whenever the deployment names nothing and the credential is NOT measurably past its
 * expiry, the client falls back to the generic message — which says "ask what was revoked",
 * a revocation it did not measure either. That is D-004 wearing different clothes, and the
 * D-004 ruling kept the generic message unchanged on purpose, so it stands for now.
 *
 * Both reachable inputs are listed rather than collapsed to a rule, because the list is the
 * point: this test fails the moment a THIRD unmeasured assertion appears, and it tells
 * whoever finally fixes the generic message to delete these entries. I originally wrote this
 * list with only the null case in it; the test caught the future-expiry case, which is the
 * behaviour I wanted from it.
 */
const KNOWN_UNMEASURED: ReadonlyArray<string> = [
  "expiry=future reason=none -> revocation",
  "expiry=null reason=none -> revocation",
];

test("class: the client asserts no cause it did not measure at 401/403", async () => {
  const space = [
    { label: "expiry=past reason=none", expiresAt: NOW - 1 },
    { label: "expiry=past reason=revoked", expiresAt: NOW - 1, reason: "predecessor_revoked" },
    { label: "expiry=future reason=none", expiresAt: NOW + 60_000 },
    { label: "expiry=future reason=revoked", expiresAt: NOW + 60_000, reason: "predecessor_revoked" },
    { label: "expiry=null reason=none", expiresAt: null },
    { label: "expiry=null reason=revoked", expiresAt: null, reason: "renewal_grant_revoked" },
    { label: "expiry=now reason=none", expiresAt: NOW },
  ] as const;

  const violations: string[] = [];
  for (const item of space) {
    const message = await refusalMessage({
      expiresAt: item.expiresAt,
      body: item.reason === undefined
        ? { error: "forbidden" }
        : { error: "forbidden", reason: item.reason },
    });
    const measured = measurableCauses({
      expiresAt: item.expiresAt,
      ...(item.reason === undefined ? {} : { reason: item.reason }),
    });
    for (const claimed of assertedCauses(message)) {
      if (!measured.includes(claimed)) violations.push(`${item.label} -> ${claimed}`);
    }
  }

  assert.deepEqual(
    violations,
    [...KNOWN_UNMEASURED],
    "a refusal message asserted a cause the client never measured; either measure it or stop saying it",
  );
});
