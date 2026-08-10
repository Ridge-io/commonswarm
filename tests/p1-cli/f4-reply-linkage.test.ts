import assert from "node:assert/strict";
import { test } from "node:test";
import { renderSignals } from "../../src/cloud/signals.js";

/* F-4 of the 2026-08-10 dogfood, measured against production.
 *
 * `cswarm reply` sets `in_reply_to`, and the field survives into the JSON surface — the run read
 * it back carrying the exact ask id. The human line dropped it, so a reply landed in the inbox
 * rendered `[note]` and indistinguishable from an unrelated one. In a product whose core loop is
 * ask -> reply, the reply was invisible AS a reply. Same family as D-062: the data was there and
 * the reader could not see it.
 *
 * The run also found an ELEVEN-DAY-OLD reply in the same inbox that had never been shown as one,
 * so this is not a new regression — it has been true for every reply the product has carried. */

const ASK = "6253c58a-d829-4c24-a7b8-e1f3afb95420";

const signal = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  workspace_id: "22222222-2222-4222-8222-222222222222",
  from: "33333333-3333-4333-8333-333333333333",
  from_kind: "user" as const,
  to: null,
  to_agent: null,
  in_reply_to: null,
  about: null,
  kind: "note" as const,
  body: "the reply body",
  until: new Date(Date.now() + 86_400_000).toISOString(),
  created_at: new Date().toISOString(),
  sender_owner_relation: "same_owner" as const,
  ...over,
}) as never;

test("F-4: a reply names the ask it answers", () => {
  const out = renderSignals([signal({ in_reply_to: ASK })], {
    inbox: true,
    includeStale: false,
  });

  assert.match(out, new RegExp(`in reply to ${ASK}`), "the reply linkage is not shown");
});

test("F-4: an ordinary note gains nothing — the marker means something", () => {
  /* CONTROL. Without this, printing the phrase unconditionally would pass the test above while
   * labelling every note a reply, which is worse than the defect: it would make the marker
   * meaningless exactly where the user relies on it. */
  const out = renderSignals([signal()], { inbox: true, includeStale: false });

  assert.doesNotMatch(out, /in reply to/, "an unrelated note was labelled a reply");
});

test("F-4: an absent field is treated as no reply, not as a literal", () => {
  /* An older edge response omits the field entirely; signals.ts normalises that to null. A
   * renderer testing only `!== null` would print "in reply to undefined" to the user. */
  const { in_reply_to: _omitted, ...withoutField } = signal() as Record<string, unknown>;
  const out = renderSignals([withoutField as never], {
    inbox: true,
    includeStale: false,
  });

  assert.doesNotMatch(out, /in reply to/, "an absent field rendered as a reply");
  assert.doesNotMatch(out, /undefined/, "the raw undefined reached the user");
});
