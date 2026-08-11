import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { renderSignals } from "../../src/cloud/signals.js";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const installer = readFileSync(resolve(root, "install.sh"), "utf8");

/* Round-3 dogfood, 2026-08-11. Four defects a stranger hits, none of which had a gate. */

test("installer: a version copied from the releases page installs", () => {
  /* Every one of the 14 tags is DISPLAYED with a leading v, and the URL adds its own, so
   * CSWARM_VERSION=v0.1.11 built .../download/vv0.1.11 and 404'd — measured, against a 200
   * control on the un-doubled URL. The failure names the version, so it reads as "that release
   * does not exist" rather than "we mangled your input". */
  assert.match(installer, /VERSION="\$\{VERSION#v\}"/, "the leading v is not stripped");
});

test("installer: no un-pasteable placeholder survives in any message", () => {
  /* `<url>` parses as a stdin redirection: the shell says "no such file or directory: url", curl
   * never runs, and the pipeline exits 0 — a cryptic line with a success-shaped status. */
  assert.doesNotMatch(installer, /<url>|<host>/, "a literal placeholder is still printed");
  /* CONTROL: the real host must be present, or the assertion above passes on an empty file. */
  assert.ok(
    installer.split("https://commonswarm.com").length - 1 >= 3,
    "the host is missing; the absence check above proves nothing",
  );
});

test("installer: env assignments sit RIGHT of the pipe, where the shell they configure runs", () => {
  /* `CSWARM_INSTALL_DIR=x curl … | sh` binds the variable to CURL. It never reaches the sh on the
   * far side, so the printed remedy silently installs to the default directory — the one that had
   * just failed. Following the advice reproduces the failure byte for byte. */
  assert.doesNotMatch(
    installer,
    /CSWARM_INSTALL_DIR=\S*\s+curl/,
    "an assignment is still bound to curl instead of the piped shell",
  );
  assert.match(installer, /\|\s*(sudo env )?CSWARM_INSTALL_DIR=/, "no piped-shell form is offered");
});

const signal = (over: Record<string, unknown> = {}) => ({
  id: "11111111-1111-4111-8111-111111111111",
  workspace_id: "22222222-2222-4222-8222-222222222222",
  from: "33333333-3333-4333-8333-333333333333",
  from_kind: "agent" as const,
  to: null, to_agent: null, in_reply_to: null, about: null,
  kind: "ask" as const, body: "answer me",
  until: new Date(Date.now() + 86_400_000).toISOString(),
  created_at: new Date().toISOString(),
  sender_owner_relation: "same_owner" as const,
  ...over,
}) as never;

test("reply loop: an ask shows the command that answers it", () => {
  /* `cswarm reply <signal-id>` requires an id that NO human-readable surface printed — not feed,
   * inbox, status, or the confirmation after a post. The loop was unusable from the CLI. */
  const out = renderSignals([signal()], { inbox: false, includeStale: false });
  assert.match(out, /cswarm reply 11111111-1111-4111-8111-111111111111/);
});

test("reply loop: a note does NOT, so the hint means something", () => {
  /* CONTROL. Printing it on every row would satisfy the test above while adding a uuid and a
   * command to lines that cannot be replied to — noise on the majority of the feed. */
  const out = renderSignals([signal({ kind: "note" })], { inbox: false, includeStale: false });
  assert.doesNotMatch(out, /cswarm reply/);
});

test("reply loop: the id shown is the SIGNAL's, not the author's", () => {
  /* The line already carried a uuid — the author's — so a reader following the obvious cue pasted
   * the wrong one and got a refusal that looked like their own mistake. */
  const out = renderSignals([signal()], { inbox: false, includeStale: false });
  assert.doesNotMatch(
    out,
    /cswarm reply 33333333-3333-4333-8333-333333333333/,
    "the author id is being offered as the reply target",
  );
});
