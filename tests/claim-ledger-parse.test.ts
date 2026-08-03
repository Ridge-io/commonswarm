import assert from "node:assert/strict";
import { test } from "node:test";
import { parseClaimLedger } from "../supabase/functions/command/durable-delivery.js";

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
