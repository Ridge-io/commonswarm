/**
 * D-006(b) — what the CLI tells someone about archiving, in the list they are looking at.
 *
 * The instance is "stop printing an archive notice at people with nothing archived". The
 * class, and the reason this file exists next to renewal-refusal-cause.test.ts, is the same
 * one D-004 and D-011 protect: THE CLIENT MUST NOT CLAIM MORE THAN IS TRUE. Here the trap is
 * the opposite direction from D-004 — the tempting sentence over-claims that archiving does
 * nothing, when the capability endpoint really does refuse an archived workspace.
 */
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { test } from "node:test";
import { readFileSync } from "node:fs";
import {
  archiveKnownGaps,
  ARCHIVE_NOT_ENFORCED_CODE,
  ARCHIVE_NOT_ENFORCED_MESSAGE,
  renderWorkspaces,
  type WorkspaceSummary,
} from "../../src/cloud/workspaces.js";

function workspace(
  name: string,
  archived: boolean,
  workspaceId = randomUUID(),
): WorkspaceSummary {
  return {
    workspace_id: workspaceId,
    name,
    role: "owner",
    archived,
  } as WorkspaceSummary;
}

/* ---------- when the notice appears ---------- */

test("D-006: no archived project means no archive notice", () => {
  const rendered = renderWorkspaces(
    [workspace("Dogfood Workspace", false), workspace("Other", false)],
    null,
  );
  assert.doesNotMatch(rendered, /Archiving a project/);
  // The list itself must still be there — this is a notice change, not a list change.
  assert.match(rendered, /Dogfood Workspace/);
});

test("D-006: one archived project brings the notice back", () => {
  const rendered = renderWorkspaces(
    [workspace("Dogfood Workspace", true), workspace("Other", false)],
    null,
  );
  assert.match(rendered, /Archiving a project/);
  assert.match(rendered, /\(archived\)/);
});

test("D-006: an empty project list says nothing about archiving", () => {
  const rendered = renderWorkspaces([], null);
  assert.doesNotMatch(rendered, /Archiving a project/);
  assert.match(rendered, /not in any projects yet/);
});

/* ---------- what the notice is allowed to say ---------- */

/**
 * ★ THE WORDING IS THE DELIVERABLE HERE, SO IT IS PINNED RATHER THAN TRUSTED.
 *
 * Each assertion below is a claim someone could reasonably reintroduce while "improving"
 * this sentence, and each one would be false. They are separate assertions so a failure
 * names which false claim came back.
 */
test("D-006: the notice does not say archived projects are restricted", () => {
  const text = ARCHIVE_NOT_ENFORCED_MESSAGE;
  // False: the command path never consults archived_at (D-016).
  assert.doesNotMatch(text, /cannot be selected|no longer accessible|is inaccessible/i);
  assert.doesNotMatch(text, /read-only|readonly/i);
});

test("D-006: the notice does not promise enforcement is coming", () => {
  // Whether archiving SHOULD be an authorization boundary is an open product question
  // (D-016). "not available yet" asserted the outcome of a decision nobody has made.
  assert.doesNotMatch(ARCHIVE_NOT_ENFORCED_MESSAGE, /\byet\b|coming soon|will be enforced/i);
});

test("D-006: the notice does not over-claim that archiving does nothing", () => {
  // The capability endpoint DOES refuse an archived workspace, so a flat "archiving does
  // not restrict access" would be false. The claim must stay scoped to members and agents.
  assert.match(ARCHIVE_NOT_ENFORCED_MESSAGE, /members or their agents/);
  assert.doesNotMatch(
    ARCHIVE_NOT_ENFORCED_MESSAGE,
    /does not restrict access(?! what)|has no effect|does nothing/i,
  );
});

test("D-006: the notice gives a direction rather than inventing a command", () => {
  // Nothing in this CLI archives a project or ends a membership, so naming a flag would be
  // a lie that costs the reader a failed attempt to find it.
  assert.match(ARCHIVE_NOT_ENFORCED_MESSAGE, /ask whoever runs the project/);
  assert.doesNotMatch(ARCHIVE_NOT_ENFORCED_MESSAGE, /cswarm \w+ --/);
});

test("D-006: the machine-readable code is unchanged, so consumers keying on it still match", () => {
  assert.equal(ARCHIVE_NOT_ENFORCED_CODE, "workspace_archive_not_enforced");
});

/* ---------- the JSON surface, which the first version of this file never observed ---------- */

/**
 * ★ THE ORIGINAL DRIFT TEST COULD NOT SEE THE THING IT WAS NAMED AFTER.
 *
 * It asserted `renderWorkspaces(...).includes(ARCHIVE_NOT_ENFORCED_MESSAGE)` — the human
 * surface against the constant — and called that "text and JSON cannot drift". It never
 * touched either JSON payload. Mica changed `known_gaps.message` at one cli.ts site, left
 * the constant and the renderer untouched, and all 9 tests passed while the two surfaces
 * disagreed. Same failure as the D-004 observer gap: I tested the value I had changed
 * instead of the surface a consumer reads.
 */
test("D-006: the known_gaps payload is exactly the approved code and message", () => {
  // Literal, not the imported constants: comparing a constant to itself passes whatever it
  // says, which is how the earlier version of this suite survived a live mutation.
  assert.deepEqual(archiveKnownGaps(), [{
    code: "workspace_archive_not_enforced",
    message:
      "Archiving a project does not restrict what members or their agents can do in it: an archived project stays selectable, and commands against it still succeed while your membership is live. Removing a project from this list means ending your membership, which this CLI cannot do — ask whoever runs the project.",
  }]);
});

test("D-006: the JSON payload and the printed line are the same sentence", () => {
  const rendered = renderWorkspaces([workspace("Archived one", true)], null);
  const [gap] = archiveKnownGaps();
  assert.ok(
    rendered.includes(gap!.message),
    "the archived-list notice and the known_gaps message have drifted apart",
  );
  assert.equal(gap!.code, ARCHIVE_NOT_ENFORCED_CODE);
  assert.equal(gap!.message, ARCHIVE_NOT_ENFORCED_MESSAGE);
});

/**
 * ★ AND THE CALL SITES, BECAUSE A BUILDER ONLY HELPS IF THE SITES USE IT.
 *
 * The builder above closes the drift only while both `--json` commands actually call it.
 * Re-inlining a literal at one site would restore Mica's exact mutation and no behavioural
 * test above would see it, because neither command is reachable without auth and a cloud
 * target. So this reads the source and asserts the shape of the call sites.
 *
 * Stated plainly rather than sold as more than it is: this is a source-text assertion, which
 * is a weaker instrument than the behavioural checks above and is the same family as the
 * regex classifier D-017 killed. It is here because the alternative is no observation of the
 * call sites at all. The durable fix is dependency injection in the command functions so the
 * payloads can be built and asserted directly; that is a wider change than this defect.
 */
test("D-006: both --json commands build known_gaps from the shared builder", () => {
  const source = readFileSync(new URL("../../src/cli.ts", import.meta.url), "utf8");
  const uses = source.match(/known_gaps: archiveKnownGaps\(\),/g) ?? [];
  assert.equal(uses.length, 2, "both --json payloads must call archiveKnownGaps()");
  assert.equal(
    (source.match(/known_gaps:/g) ?? []).length,
    2,
    "a known_gaps payload appeared that does not come from the shared builder",
  );
  assert.doesNotMatch(
    source,
    /workspace_archive_not_enforced/,
    "the gap code was re-inlined in cli.ts instead of coming from the builder",
  );
});
