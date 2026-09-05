import assert from "node:assert/strict";
import { test } from "node:test";
import {
  DELIVERY_CAPABILITIES,
  parseClaimLedger,
} from "../supabase/functions/command/durable-delivery.js";

test("production parseClaimLedger behavior", () => {
  // absent terminal_delivery_failure_count -> 0
  const absent = parseClaimLedger({
    ok: true,
    event_ids: [],
    delivery_refs: [],
    pending_delivery_count: 0,
  });
  assert.notEqual(absent, null);
  assert.equal(absent?.terminal_delivery_failure_count, 0);

  // zero -> 0
  const zero = parseClaimLedger({
    ok: true,
    event_ids: [],
    delivery_refs: [],
    pending_delivery_count: 0,
    terminal_delivery_failure_count: 0,
  });
  assert.notEqual(zero, null);
  assert.equal(zero?.terminal_delivery_failure_count, 0);

  // positive integer -> accepted
  const pos = parseClaimLedger({
    ok: true,
    event_ids: [],
    delivery_refs: [],
    pending_delivery_count: 0,
    terminal_delivery_failure_count: 5,
  });
  assert.notEqual(pos, null);
  assert.equal(pos?.terminal_delivery_failure_count, 5);

  // present undefined -> reject (null)
  const undef = parseClaimLedger({
    ok: true,
    event_ids: [],
    delivery_refs: [],
    pending_delivery_count: 0,
    terminal_delivery_failure_count: undefined,
  });
  assert.equal(undef, null);

  // negative integer -> reject (null)
  const neg = parseClaimLedger({
    ok: true,
    event_ids: [],
    delivery_refs: [],
    pending_delivery_count: 0,
    terminal_delivery_failure_count: -1,
  });
  assert.equal(neg, null);

  // non-integer -> reject (null)
  const floatVal = parseClaimLedger({
    ok: true,
    event_ids: [],
    delivery_refs: [],
    pending_delivery_count: 0,
    terminal_delivery_failure_count: 1.5,
  });
  assert.equal(floatVal, null);

  const stringVal = parseClaimLedger({
    ok: true,
    event_ids: [],
    delivery_refs: [],
    pending_delivery_count: 0,
    terminal_delivery_failure_count: "5",
  });
  assert.equal(stringVal, null);
});

test("oldest_pending_at keeps absent, null and a time apart", () => {
  const base = {
    ok: true,
    event_ids: [],
    delivery_refs: [],
    pending_delivery_count: 0,
  };

  /* ABSENT is not null. A claim stored before this field existed replays with
   * the count it observed then; turning its missing time into null would pair
   * "nothing is waiting" with a count that says something is. The parsed
   * object must not carry the key at all. */
  const absent = parseClaimLedger({ ...base, pending_delivery_count: 3 });
  assert.notEqual(absent, null);
  assert.equal(
    Object.hasOwn(absent as object, "oldest_pending_at"),
    false,
    "absent stays absent",
  );
  assert.equal(absent?.oldest_pending_at, undefined);

  /* null is the server saying it looked and nothing is pending. */
  const empty = parseClaimLedger({ ...base, oldest_pending_at: null });
  assert.notEqual(empty, null);
  assert.equal(
    Object.hasOwn(empty as object, "oldest_pending_at"),
    true,
    "an explicit null is carried, not dropped",
  );
  assert.equal(empty?.oldest_pending_at, null);

  const when = "2026-09-05T01:02:03.004Z";
  const timed = parseClaimLedger({
    ...base,
    pending_delivery_count: 2,
    oldest_pending_at: when,
  });
  assert.equal(timed?.oldest_pending_at, when);

  /* Anything that is not a time and not null is a malformed ledger. Each of
   * these would otherwise reach a listener as a queue age. */
  for (
    const bad of [
      undefined,
      0,
      1757030400000,
      "not a timestamp",
      "",
      { at: when },
      [when],
      true,
    ]
  ) {
    assert.equal(
      parseClaimLedger({ ...base, oldest_pending_at: bad }),
      null,
      `oldest_pending_at ${JSON.stringify(bad)} must be refused`,
    );
  }

  /* Control: the same body with a valid value parses, so the loop above is
   * refusing the value and not the body shape. */
  assert.notEqual(parseClaimLedger({ ...base, oldest_pending_at: when }), null);
});

test("the claim ledger says it reports the queue age, so a reader can tell absent from unsupported", () => {
  /* Three states on the wire, and a reader needs a fourth fact to use them:
   * whether this server reports the field at all. The capability marker is
   * that fact. Old listeners check only the markers they require, so adding
   * one cannot break them. */
  assert.equal(DELIVERY_CAPABILITIES.oldest_pending_at, 1);
  for (const required of ["delivery_claim", "delivery_ack", "sender_owner_relation"]) {
    assert.equal(
      (DELIVERY_CAPABILITIES as Record<string, number>)[required],
      1,
      `${required} must still be advertised`,
    );
  }
});
