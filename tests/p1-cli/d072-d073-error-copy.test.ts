import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { ReauthenticationRequired } from "../../src/cloud/command-client.js";

/* Two findings from Wren's round-4 walk of paths nobody had exercised on the shipped 0.1.9.
 *
 * D-072 — `member remove` told a user to sign in again, implying that would let them retry. For a
 * non-owner it would not: the fresh-auth gate runs in `handleTransaction` step 7, BEFORE the
 * reducer evaluates authority, and the reducer then refuses with `role_forbidden` because
 * "removing members requires Owner/Admin". So the advice costs a browser OAuth round trip and
 * arrives at a second wall.
 *
 * The cost is not hypothetical: it was found on a machine whose browser automation was broken,
 * where signing out can strand the seat. The message recommended the exact action its reader had
 * refused to take the day before, for that reason.
 *
 * NOTE ON THE DIAGNOSIS, because the original report had it slightly wrong and the difference
 * decides the fix. Wren read this as "reports an authority failure as an authentication failure".
 * It does not — the server genuinely returned 401 `fresh_auth_required` and had not yet evaluated
 * authority. Reporting `role_forbidden` here would be a DIFFERENT false cause. The defect is the
 * implied promise, so the fix is to stop implying it.
 *
 * D-073 — server-returned errors printed twice on stderr: the sentence, then the raw structured
 * object, with no `--json` requested. Client-side errors printed once, so the doubling followed
 * the error CLASS rather than the verb. */

test("D-072: the fresh-auth message does not promise that signing in will let you retry", () => {
  const message = new ReauthenticationRequired().message;

  // It must still tell you what to run and that nothing changed.
  assert.match(message, /cswarm login/);
  assert.match(message, /No membership change was recorded/);

  // And it must say the permission check is separate, or the reader spends a browser round trip
  // to discover it. This is the whole finding.
  assert.match(message, /Owner or Admin/);
  assert.match(message, /separate check|separate from/i);

  // The retired wording, which implied repeating the command was sufficient.
  assert.doesNotMatch(message, /then repeat the member remove command\./);
});

test("D-072: it does not claim an authority refusal the server has not made", () => {
  // Over-correcting is the other failure mode: at this point the server returned 401
  // fresh_auth_required and has NOT evaluated the caller's role. Asserting `role_forbidden`, or
  // that the caller lacks permission, would swap one false cause for another — which is the
  // D-060 family this repo has now hit four times.
  const message = new ReauthenticationRequired().message;

  assert.doesNotMatch(message, /role_forbidden/);
  assert.doesNotMatch(message, /you (do not|don't) have permission/i);
  assert.doesNotMatch(message, /you are not an? (owner|admin)/i);
});

test("D-073: the human error path does not also dump the structured object", () => {
  /* Asserted against the source. The behaviour needs a server-returned WorkspaceCliError, which
   * needs a live deployment, and the handler lives inside `main().catch` and is not exported —
   * so this pins the claim at the only place a pure gate can reach it. Verified live on
   * production at the same time: `cswarm use <bogus-uuid>` now emits one sentence and no braces,
   * while `--json` still writes the object to stdout. */
  const source = readFileSync("src/cli.ts", "utf8");
  const handler = source.slice(source.indexOf("if (error instanceof WorkspaceCliError)"));
  const humanBranch = handler.slice(0, handler.indexOf("process.exitCode = 1;"));

  assert.doesNotMatch(
    humanBranch,
    /stderr\.write\(`\$\{JSON\.stringify\(structured\)\}/,
    "the structured object is being dumped to stderr on the human path again",
  );

  // CONTROL: the machine form must still exist somewhere in this handler, or the assertion above
  // would also pass on a handler that had stopped emitting JSON entirely — which would be a
  // worse defect than the one being fixed.
  assert.match(handler, /JSON\.stringify\(structured, null, 2\)/);
  assert.match(handler, /process\.stdout\.write/);
});
