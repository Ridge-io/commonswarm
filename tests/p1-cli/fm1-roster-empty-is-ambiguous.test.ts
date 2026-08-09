import assert from "node:assert/strict";
import { test } from "node:test";
import { renderRoster } from "../../src/cli.js";
import type { SignalDirectory } from "../../src/cloud/signals.js";

/* FM-1, found by Verity reviewing `cswarm members` as a non-author.
 *
 * The read edge answers a workspace the credential is NOT scoped to with
 * `200 {members: [], agents: []}` — deliberately, because a 403 would be a workspace-existence
 * oracle. That is correct on the server. What was wrong was this command turning it into
 * "nobody yet" / "none yet": an assertion that the workspace is EMPTY, at exit 0.
 *
 * That is the confident zero this repo's whole doctrine exists to prevent, produced by the verb
 * built to stop people manufacturing confident zeros, and caught by a non-author. Verity's
 * phrase: "the product manufacturing a zero."
 *
 * The distinction these tests hold: ambiguity is TOTAL only when both lists are empty. If people
 * are visible then the credential is demonstrably scoped to the workspace, so an empty agent list
 * is genuinely empty and "none yet" is true. Collapsing both cases into the cautious wording
 * would trade a false claim for a useless one. */

const directory = (
  members: Array<{ user_id: string; display_name: string }>,
  agents: Array<{ principal_id: string; name: string; owner_user_id?: string }>,
): SignalDirectory => ({ members, agents });

const MEMBER = { user_id: "919ce195-4e19-4c89-852b-8f09a4b556d9", display_name: "Tom" };
const AGENT = {
  principal_id: "3a37b055-035b-45d4-9597-7f189e397c44",
  name: "wren-crossuser",
  owner_user_id: MEMBER.user_id,
};
const names = new Map([[MEMBER.user_id, "Tom"]]);

test("FM-1: an entirely empty roster does NOT claim the project is empty", () => {
  const out = renderRoster(directory([], []), new Map());

  // The two claims that were false. Either one asserts emptiness the command cannot establish.
  assert.doesNotMatch(out, /nobody yet/);
  assert.doesNotMatch(out, /none yet/);

  // And it must say why it cannot tell, or the caution is just vagueness.
  assert.match(out, /may not be\s+scoped to it/);
  assert.match(out, /cannot tell you which/);
});

test("FM-1: the cautious wording does not leak whether the project exists", () => {
  // The server's ambiguity is deliberate. Copy that resolved it — "no such project", "not
  // authorised" — would reintroduce the oracle the server is avoiding, which would be a worse
  // defect than the one being fixed.
  const out = renderRoster(directory([], []), new Map());

  assert.doesNotMatch(out, /not authoris|not authoriz|no such|does not exist|forbidden|denied/i);
});

test("FM-1: zero agents WITH visible people is genuinely empty, and still says so", () => {
  // The discriminating case. Seeing a person proves the credential is scoped to this workspace,
  // so an empty agent list is a fact rather than an ambiguity. If this test ever passes with the
  // cautious wording, the fix has over-applied and made a true statement unavailable.
  const out = renderRoster(directory([MEMBER], []), names);

  assert.match(out, /none yet/);
  assert.doesNotMatch(out, /cannot tell you which/);
  assert.match(out, /Tom/);
});

test("FM-1: a populated roster is unchanged", () => {
  const out = renderRoster(directory([MEMBER], [AGENT]), names);

  assert.match(out, /People:/);
  assert.match(out, /Agents:/);
  assert.match(out, new RegExp(AGENT.principal_id));
  assert.match(out, /wren-crossuser/);
  // CONTROL for the three tests above: if this ever printed the cautious wording, they would all
  // be passing against a renderer that had stopped rendering.
  assert.doesNotMatch(out, /Nothing is visible here/);
});
