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
