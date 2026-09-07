/** Reached by `npm --prefix site test` through the src/lib/*.test.mjs glob. */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  MENTION_MAX_RECIPIENTS,
  addressFromBody,
  mentionTargets,
} from "./mention-address.ts";

const agent = (id, name) => ({ principalId: id, name });
const person = (id, name) => ({ userId: id, name });

const roster = mentionTargets(
  [agent("a-wren", "Wren"), agent("a-wrenley", "Wrenley"), agent("a-orbit", "Orbit")],
  [person("p-dana", "Dana Rivera"), person("p-dan", "Dana")],
);

const names = (body, targets = roster) =>
  addressFromBody(body, targets).recipients.map((entity) => `${entity.kind}:${entity.id}`);

test("a tag is a word in the message and names one recipient", () => {
  assert.deepEqual(names("@Wren please ship it"), ["agent:a-wren"]);
  assert.deepEqual(names("thanks @Orbit"), ["agent:a-orbit"]);
  assert.deepEqual(names("no tags here"), []);
});

test("the longest matching name wins, so a shorter name cannot steal it", () => {
  /* "Dana" is also a member. Reading "@Dana Rivera" as "@Dana" would address the wrong person
   * and leave " Rivera" looking like part of the sentence. */
  assert.deepEqual(names("@Dana Rivera take a look"), ["person:p-dana"]);
  assert.deepEqual(names("@Dana take a look"), ["person:p-dan"]);
  assert.deepEqual(names("@Wrenley over to you"), ["agent:a-wrenley"]);
});

test("a tag must end on a boundary", () => {
  assert.deepEqual(names("@Wrenzo is not Wren"), []);
  assert.deepEqual(names("@Wren, @Orbit: both"), ["agent:a-wren", "agent:a-orbit"]);
  assert.deepEqual(names("(@Wren) in brackets"), ["agent:a-wren"]);
  /* An email address is not a tag: the @ has no opening boundary in front of it. */
  assert.deepEqual(names("write to tom@Wren.example"), []);
});

test("case folding that changes a string's length still finds the tag", () => {
  /* "İ".toLowerCase() is TWO code units. Folding the whole body and indexing into it dropped
   * this tag; slicing by the original name length and folding both sides finds it. */
  const turkish = mentionTargets([agent("a-ipek", "İpek")], []);
  assert.deepEqual(
    addressFromBody("@İpek hello", turkish).recipients,
    [{ kind: "agent", id: "a-ipek" }],
  );
  assert.deepEqual(
    addressFromBody("@ipek hello", turkish).recipients.length,
    1,
    "a tag typed in lower case must still resolve",
  );
});

test("the same recipient tagged twice is addressed once", () => {
  assert.deepEqual(names("@Wren and again @Wren"), ["agent:a-wren"]);
});

test("two roster entries sharing a name resolve to nobody, and say so", () => {
  const twins = mentionTargets([agent("a-1", "Echo")], [person("p-1", "Echo")]);
  const address = addressFromBody("@Echo which one?", twins);
  assert.deepEqual(address.recipients, []);
  assert.deepEqual(address.ambiguous, ["Echo"]);
});

test("two same-name agents stay separately selectable by UUID suffix", () => {
  const left = "11111111-1111-4111-8111-111111111111";
  const right = "22222222-2222-4222-8222-222222222222";
  const twins = mentionTargets(
    [agent(left, "Echo"), agent(right, "Echo")],
    [],
  );
  assert.equal(twins.length, 2);
  assert.notEqual(twins[0].label, twins[1].label);
  assert.deepEqual(addressFromBody("@Echo which one?", twins).recipients, []);
  assert.deepEqual(addressFromBody("@Echo which one?", twins).ambiguous, ["Echo"]);

  const leftLabel = twins.find((target) => target.entity.id === left)?.label;
  const rightLabel = twins.find((target) => target.entity.id === right)?.label;
  assert.ok(leftLabel && rightLabel);
  assert.deepEqual(
    addressFromBody(`@${leftLabel} take this`, twins).recipients,
    [{ kind: "agent", id: left }],
  );
  assert.deepEqual(
    addressFromBody(`@${rightLabel} take that`, twins).recipients,
    [{ kind: "agent", id: right }],
  );
  assert.deepEqual(
    addressFromBody(`@${leftLabel} and @${rightLabel}`, twins).recipients,
    [{ kind: "agent", id: left }, { kind: "agent", id: right }],
  );
});

test("a raw name equal to another record's generated label stays separately selectable", () => {
  const left = "11111111-1111-4111-8111-111111111111";
  const right = "22222222-2222-4222-8222-222222222222";
  const literal = "33333333-3333-4333-8333-333333333333";
  const twins = mentionTargets(
    [agent(left, "Echo"), agent(right, "Echo"), agent(literal, "Echo · 11111111")],
    [],
  );
  assert.equal(new Set(twins.map((target) => target.label)).size, 3);
  const leftLabel = twins.find((target) => target.entity.id === left)?.label;
  const literalRow = twins.find((target) => target.entity.id === literal);
  assert.ok(leftLabel);
  assert.equal(literalRow?.label, "Echo · 11111111");
  assert.notEqual(leftLabel, literalRow?.label);
  assert.deepEqual(
    addressFromBody(`@${leftLabel} take this`, twins).recipients,
    [{ kind: "agent", id: left }],
  );
  assert.deepEqual(
    addressFromBody("@Echo · 11111111 take that", twins).recipients,
    [{ kind: "agent", id: literal }],
  );
  assert.deepEqual(addressFromBody("@Echo which one?", twins).recipients, []);
  assert.deepEqual(addressFromBody("@Echo which one?", twins).ambiguous, ["Echo"]);
});

test("three-way label collisions keep each tag on one record", () => {
  const left = "11111111-1111-4111-8111-111111111111";
  const right = "22222222-2222-4222-8222-222222222222";
  const take8 = "33333333-3333-4333-8333-333333333333";
  const take9 = "44444444-4444-4444-8444-444444444444";
  const twins = mentionTargets(
    [
      agent(left, "Echo"),
      agent(right, "Echo"),
      agent(take8, `Echo · ${left.slice(0, 8)}`),
      agent(take9, `Echo · ${left.slice(0, 9)}`),
    ],
    [],
  );
  assert.equal(new Set(twins.map((target) => target.label)).size, 4);
  const leftLabel = twins.find((target) => target.entity.id === left)?.label;
  assert.equal(leftLabel, `Echo · ${left.slice(0, 10)}`);
  assert.deepEqual(
    addressFromBody(`@${leftLabel} go`, twins).recipients,
    [{ kind: "agent", id: left }],
  );
  assert.deepEqual(
    addressFromBody(`@Echo · ${left.slice(0, 8)} go`, twins).recipients,
    [{ kind: "agent", id: take8 }],
  );
  assert.deepEqual(
    addressFromBody(`@Echo · ${left.slice(0, 9)} go`, twins).recipients,
    [{ kind: "agent", id: take9 }],
  );
});

test("a label that still matches two records is refused", () => {
  const left = "11111111-1111-4111-8111-111111111111";
  const literal = "33333333-3333-4333-8333-333333333333";
  const colliding = [
    { entity: { kind: "agent", id: left }, name: "Echo", label: "Echo · 11111111" },
    {
      entity: { kind: "agent", id: literal },
      name: "Echo · 11111111",
      label: "Echo · 11111111",
    },
  ];
  const address = addressFromBody("@Echo · 11111111 take this", colliding);
  assert.deepEqual(address.recipients, []);
  assert.ok(address.ambiguous.length > 0);
  assert.notEqual(address.ambiguous[0], undefined);
});

test("a name that folds to nothing or to whitespace can never be tagged", () => {
  /* Two shapes, and the first control has to use the form the PICKER would write. A lone
     combining mark folds to ""; the empty span after a dangling "@" matched it, and so did
     "@<mark> ". A name of spaces folds to spaces, and "@ " matched that one. */
  const marks = [
    { entity: { kind: "agent", id: "a-mark" }, name: "\u0301" },
    { entity: { kind: "agent", id: "a-space" }, name: "   " },
    { entity: { kind: "agent", id: "a-wren" }, name: "Wren" },
  ];
  assert.deepEqual(addressFromBody("@", marks).recipients, []);
  assert.deepEqual(addressFromBody("@\u0301 hello", marks).recipients, []);
  assert.deepEqual(addressFromBody("@   hello", marks).recipients, []);
  assert.deepEqual(
    addressFromBody("@Wren", marks).recipients,
    [{ kind: "agent", id: "a-wren" }],
  );
  /* And the roster builder drops them too, so the picker cannot offer what cannot be sent. */
  assert.deepEqual(
    mentionTargets([agent("a-mark", "\u0301"), agent("a-space", "   ")], []),
    [],
  );
});

test("a name is matched as text, never as a pattern", () => {
  const odd = mentionTargets(
    [agent("a-dot", "a.c"), agent("a-star", "b*"), agent("a-at", "ci@cd")],
    [],
  );
  assert.deepEqual(addressFromBody("@abc", odd).recipients, [], "a dot must not match any char");
  assert.deepEqual(addressFromBody("@a.c ok", odd).recipients, [{ kind: "agent", id: "a-dot" }]);
  assert.deepEqual(addressFromBody("@b* ok", odd).recipients, [{ kind: "agent", id: "a-star" }]);
  assert.deepEqual(addressFromBody("@ci@cd ok", odd).recipients, [{ kind: "agent", id: "a-at" }]);
});

test("a tag at the very end, and one before a CRLF, both resolve", () => {
  assert.deepEqual(names("ship it @Wren"), ["agent:a-wren"]);
  assert.deepEqual(names("@Wren\r\n@Orbit\r\n"), ["agent:a-wren", "agent:a-orbit"]);
});

test("tags past the cap are named, never dropped in silence", () => {
  const many = mentionTargets(
    Array.from({ length: MENTION_MAX_RECIPIENTS + 2 }, (_, index) =>
      agent(`a-${index}`, `Agent${index}`)),
    [],
  );
  const body = many.map((target) => `@${target.name}`).join(" ");
  const address = addressFromBody(body, many);
  assert.equal(address.recipients.length, MENTION_MAX_RECIPIENTS);
  assert.equal(address.overflow.length, 2);
  /* The body still shows every tag. The send refuses rather than posting a message whose text
   * names people it never reached. */
  assert.ok(address.overflow.every((name) => body.includes(`@${name}`)));
});
