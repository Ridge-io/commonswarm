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

test("FM-1: an entirely empty roster does NOT claim the workspace is empty", () => {
  const out = renderRoster(directory([], []), new Map());

  // The two claims that were false. Either one asserts emptiness the command cannot establish.
  assert.doesNotMatch(out, /nobody yet/);
  assert.doesNotMatch(out, /none yet/);
});

test("FM-1: it states the scope answer, because there is one", () => {
  /* The first fix said "this command cannot tell you which" — true-sounding and false. A
   * workspace can never have zero members: `WorkspaceCreated` seeds `owners_count: 1`, the
   * reducer treats fewer than one live owner as a StreamIntegrityError rather than a refusal,
   * the last owner can be neither removed nor demoted, and no leave command exists. So an empty
   * roster means NOT SCOPED, with certainty. Found by Verity after it shipped in 0.1.10. */
  const out = renderRoster(directory([], []), new Map());

  assert.match(out, /not scoped to that workspace/);
  assert.doesNotMatch(
    out,
    /cannot tell you which/,
    "the message claims an ambiguity that the owner-count invariant rules out",
  );
  // It must not reintroduce the emptiness it cannot establish, in the other direction either.
  assert.doesNotMatch(out, /may have no members/);
});

test("FM-1: stating scope does not leak whether the workspace exists", () => {
  /* The two ambiguities are different and only one must be preserved. EXISTENCE stays hidden —
   * this sentence is identical whether the workspace is absent or present-without-you. SCOPE is
   * the caller's own state and was never the secret. Copy resolving existence — "no such
   * workspace", "not authorised" — would reintroduce the oracle. */
  const out = renderRoster(directory([], []), new Map());

  assert.doesNotMatch(out, /not authoris|not authoriz|no such|does not exist|forbidden|denied/i);
  // And it must say the indistinguishability is deliberate, or a reader treats it as vagueness.
  assert.match(out, /same whether the workspace does\s+not exist or exists without you/);
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
