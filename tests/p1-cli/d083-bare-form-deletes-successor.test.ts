import assert from "node:assert/strict";
import { test } from "node:test";
import { AgentCredentialSession } from "../../src/cloud/renewal.js";
import type { AgentCredentialRecord } from "../../src/cloud/agent-credential.js";

/* D-083. `AgentCredentialSession.open` compared the stored lineage's `rootTokenId` to the
 * presented credential's `tokenId` by STRICT EQUALITY, then DELETED THE RECORD on mismatch.
 *
 * The bare credential form carries no token id — `tokenId: null` at cli.ts:587 against cli.ts:644
 * for the artifact form. So an agent that renewed under the artifact form and then ran ANY
 * command under the bare form OF THE SAME SECRET lost its stored successor.
 *
 * Reachable today, and not hypothetically: D-082 measured that `listen start` REQUIRES the
 * artifact form while `members` accepts a bare token, so alternating subcommands is enough.
 *
 * A null id cannot mean "someone else's lineage". The store filename is
 * `credentialLineageKey(agent.token)` — sha256 of the PRESENTED SECRET — so finding the record at
 * all already proves the caller holds the same root token.
 *
 * The comment above the check records this exact bug happening once before, to `principalId`, and
 * being fixed THERE. The identical defect sat one clause to its left for the whole time. */

const ROOT_ID = "11111111-1111-4111-8111-111111111111";
const PRINCIPAL = "22222222-2222-4222-8222-222222222222";

const record = (over: Partial<AgentCredentialRecord> = {}): AgentCredentialRecord => ({
  version: 1,
  rootTokenId: ROOT_ID,
  principalId: PRINCIPAL,
  token: "swm_agt_successor",
  tokenId: "33333333-3333-4333-8333-333333333333",
  runId: "44444444-4444-4444-8444-444444444444",
  expiresAt: new Date(Date.now() + 3_600_000).toISOString(),
  pendingRenewal: null,
  ...over,
}) as AgentCredentialRecord;

/** A store that reports whether delete() was called. */
function spyStore(initial: AgentCredentialRecord | null) {
  let current = initial;
  let deleted = false;
  return {
    deleted: () => deleted,
    current: () => current,
    store: {
      read: async () => current,
      write: async (r: AgentCredentialRecord) => {
        current = r;
      },
      delete: async () => {
        deleted = true;
        current = null;
      },
      withLock: async <T>(work: () => Promise<T>) => await work(),
    } as never,
  };
}

const presented = (tokenId: string | null) => ({
  token: "swm_agt_root",
  tokenId,
  principalId: PRINCIPAL,
  runId: "44444444-4444-4444-8444-444444444444",
  expiresAt: null,
}) as never;

test("D-083: the BARE form does not delete a successor stored by the artifact form", async () => {
  const spy = spyStore(record());

  await AgentCredentialSession.open({
    presented: presented(null), // bare: cli.ts:587 supplies no token id
    store: spy.store,
    now: () => Date.now(),
    warn: () => undefined,
  } as never);

  assert.equal(spy.deleted(), false, "the bare form deleted the stored successor");
  assert.notEqual(spy.current(), null, "the record is gone");
});

test("D-083: a genuinely DIFFERENT lineage is still deleted — the fix is not a blanket allow", async () => {
  /* CONTROL, and the one that matters. "Treat null as unknown" could be mis-implemented as
   * "never delete", which would leave a foreign record in place and defeat the check entirely.
   * Both sides name an id here, and they differ. */
  const spy = spyStore(record({ rootTokenId: "99999999-9999-4999-8999-999999999999" }));

  await AgentCredentialSession.open({
    presented: presented(ROOT_ID),
    store: spy.store,
    now: () => Date.now(),
    warn: () => undefined,
  } as never);

  assert.equal(spy.deleted(), true, "a foreign lineage was kept");
});

test("D-083: matching ids are still adopted, so the fix does not break the normal path", async () => {
  /* CONTROL. Without this, a change that deleted nothing AND adopted nothing would pass both
   * tests above while silently disabling renewal. */
  const spy = spyStore(record());

  const session = await AgentCredentialSession.open({
    presented: presented(ROOT_ID),
    store: spy.store,
    now: () => Date.now(),
    warn: () => undefined,
  } as never);

  assert.equal(spy.deleted(), false);
  /* `expiry` rather than the private `token`: the PRESENTED credential carries `expiresAt: null`
   * and the stored successor carries a real one, so a non-null expiry can only have come from
   * adopting the record. Asserting through the public surface also means this test cannot be
   * satisfied by a field the class stops maintaining. */
  assert.notEqual(session.expiry, null, "the stored successor was not adopted");
});
