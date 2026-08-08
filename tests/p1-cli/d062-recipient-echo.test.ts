import assert from "node:assert/strict";
import { test } from "node:test";
import { describeAudience } from "../../src/cli.js";

/* D-062, second half. `--to <name>` is resolved server-side and the resolved id came back in
 * `to_agent` on every send — but only under `--json`. So a sender never saw who their signal
 * actually went to. A principal named `Wren` existed, was not the Wren anyone meant, and three
 * agents spent about twenty hours on it with the answer in every response object they held.
 *
 * These assert on a string a user reads, so they are pinning a CLAIM. The claim is "this signal
 * went to exactly this recipient" — and it must stay true when the directory is incomplete,
 * which is the case that would otherwise print a confident wrong name. */

const labels = (
  agents: Array<[string, string]>,
  users: Array<[string, string]> = [],
) => ({ agents: new Map(agents), users: new Map(users) });

const AGENT = "3a37b055-035b-45d4-9597-7f189e397c44";
const IMPOSTOR = "23733ab6-cb45-473c-8996-210930dffdf3";
const USER = "919ce195-4e19-4c89-852b-8f09a4b556d9";

test("D-062: a directed signal names the recipient AND shows the id", () => {
  const line = describeAudience(
    { to: null, to_agent: AGENT },
    labels([[AGENT, "wren-crossuser"]]),
  );

  assert.match(line, /wren-crossuser/);
  // The id is the load-bearing half: the name is what the sender typed and believed, the id is
  // what the server resolved. Printing only the name would echo the sender's own assumption
  // back at them, which is precisely the failure this exists to prevent.
  assert.match(line, new RegExp(AGENT));
});

test("D-062: the id shown is the RESOLVED one, not the name the sender used", () => {
  // The exact shape of the original defect: the sender typed `--to Wren` believing they meant
  // AGENT; the server resolved IMPOSTOR. The line must expose what the server did.
  const line = describeAudience(
    { to: null, to_agent: IMPOSTOR },
    labels([[IMPOSTOR, "Wren"], [AGENT, "wren-crossuser"]]),
  );

  assert.match(line, new RegExp(IMPOSTOR));
  assert.doesNotMatch(
    line,
    new RegExp(AGENT),
    "the line shows an id the send did not resolve to",
  );
});

test("D-062: an unknown recipient prints the bare id rather than a guessed name", () => {
  // A wrong name is worse than no name here — the whole defect was a plausible label attached
  // to the wrong identity. An empty directory must degrade to the id, not to a placeholder.
  const line = describeAudience({ to: null, to_agent: AGENT }, labels([]));

  assert.match(line, new RegExp(AGENT));
  assert.doesNotMatch(line, /Unnamed|unknown|undefined|null/i);
});

test("D-062: a broadcast names nobody", () => {
  const line = describeAudience({ to: null, to_agent: null }, labels([]));

  assert.match(line, /members of this workspace/);
  // CONTROL for every test above: if this ever contained an id or "only to", the assertions
  // that a directed signal names its recipient would be passing for the wrong reason.
  assert.doesNotMatch(line, /only to/);
  assert.doesNotMatch(line, /[0-9a-f]{8}-[0-9a-f]{4}/);
});

test("D-062: a signal directed at a person resolves through the member directory", () => {
  const line = describeAudience(
    { to: USER, to_agent: null },
    labels([], [[USER, "Tom Langridge"]]),
  );

  assert.match(line, /Tom Langridge/);
  assert.match(line, new RegExp(USER));
});

test("D-062: to_agent wins over to, so an agent recipient is never reported as its owner", () => {
  // Both fields populated. The agent is the actual recipient; reporting the human would name a
  // real party who is not the one that received it — a true-sounding sentence that is false.
  const line = describeAudience(
    { to: USER, to_agent: AGENT },
    labels([[AGENT, "wren-crossuser"]], [[USER, "Tom Langridge"]]),
  );

  assert.match(line, /wren-crossuser/);
  assert.match(line, new RegExp(AGENT));
  assert.doesNotMatch(line, /Tom Langridge/);
});
