import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { test } from "node:test";

/* Wren, 2026-08-10. Every unknown flag reported "--X requires a value", because anything outside
 * BOOLEAN_FLAGS is assumed to take one. A flag that DOES NOT EXIST was reported as a flag used
 * wrongly. Found when someone on 0.1.11 tried `--reveal-anon-key`, which only exists on a later
 * build, and was told it "requires a value" — the error blamed the reader for the version.
 *
 * AGENTS.md records the other cost: a control written with a bare `--not-a-real-flag` died in the
 * parser before reaching the gate it was meant to exercise, and passed for the wrong reason. */

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..", "..");
const cli = resolve(root, "dist", "cli.js");

function run(args: string[]): string {
  try {
    return execFileSync(process.execPath, [cli, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    });
  } catch (error) {
    const e = error as { stdout?: string; stderr?: string };
    return `${e.stdout ?? ""}${e.stderr ?? ""}`;
  }
}

test("a flag that does not exist is reported as unknown, not as misused", () => {
  const out = run(["target", "show", "--not-a-real-flag"]);

  assert.match(out, /unknown option --not-a-real-flag/);
  assert.doesNotMatch(out, /requires a value/, "it still blames the user for the value");
});

test("a real flag missing its value still says so — the two must stay distinguishable", () => {
  /* CONTROL. Reporting everything as "unknown option" would satisfy the test above while
   * destroying the message that is correct far more often. */
  const out = run(["members", "--workspace-id"]);

  assert.match(out, /--workspace-id requires a value/);
  assert.doesNotMatch(out, /unknown option/);
});

test("KNOWN_FLAGS covers every flag the usage text advertises", () => {
  /* The list is for wording only, never for acceptance, so a stale entry cannot break a command
   * — but it CAN word an error badly, telling someone a real flag does not exist. This derives
   * the expectation from the help text itself, so adding a documented flag without listing it
   * fails here rather than surfacing to a user as "unknown option --your-new-flag". */
  const help = run(["--help"]);
  const advertised = [...new Set(
    (help.match(/--[a-z][a-z0-9-]*/g) ?? []).map((f) => f.slice(2)),
  )];
  assert.ok(advertised.length > 40, `usage parse looks wrong: ${advertised.length} flags`);

  const source = execFileSync("node", [
    "-e",
    `const s=require("fs").readFileSync(${JSON.stringify(resolve(root, "src", "cli.ts"))},"utf8");
     const m=s.match(/const KNOWN_FLAGS = new Set\\(\\[([\\s\\S]*?)\\]\\)/);
     process.stdout.write(m ? m[1] : "");`,
  ], { encoding: "utf8" });
  const known = new Set(
    (source.match(/"[a-z0-9-]+"/g) ?? []).map((q) => q.slice(1, -1)),
  );

  const missing = advertised.filter((f) => !known.has(f));
  assert.deepEqual(missing, [], `documented but not in KNOWN_FLAGS: ${missing.join(", ")}`);
});

test("--help states the credential contract as a PROPERTY, and names both strict cases", () => {
  /* Wren swept the flag across every subcommand that takes it and refuted the first version of
   * this fix. There are THREE contracts, not two, and the two refusals cite DIFFERENT missing
   * fields — `listen start` needs expires_at, `token revoke` needs token_id. They are two
   * independent requirements that happen to be satisfied by the same artifact, not one strict
   * mode with one reason.
   *
   * ~~The first fix said "listen start is the exception" and THIS TEST REQUIRED THAT STRING.~~
   * Dead. That shape only holds if there is one exception, so the gate would have stayed green
   * while `token revoke` remained undocumented — and worse, the wording newly implied the
   * difference had been enumerated. Wren: "the original defect was documentation silent on a
   * difference; the risk in the fix is documentation that appears to have enumerated the
   * difference and has not."
   *
   * That is a control discriminating toward a false claim, which AGENTS.md documents and which I
   * wrote hours after quoting it. The fix is to pin the PROPERTY — what the subcommand does with
   * the credential — because that survives the next subcommand; an enumeration does not. */
  const help = run(["--help"]);

  assert.match(help, /DEPENDS ON WHAT THE SUBCOMMAND DOES/);
  assert.match(help, /listen start[^\n]*expires_at/, "listen start's requirement is unstated");
  assert.match(help, /token revoke[^\n]*token_id/, "token revoke's requirement is unstated");
  assert.doesNotMatch(
    help,
    /is the exception/,
    "it claims a single exception again, which is the refuted shape",
  );
  /* CONTROL: the permissive general case must survive. Documenting only the strict subcommands
   * would satisfy everything above while making the flag look unusable for `members`. */
  assert.match(help, /bare swm_agt_ token/);
});

test("every subcommand taking --agent-token-stdin is accounted for in its description", () => {
  /* The safety net for the enumeration above. Wren's scope note is explicit that its sweep covered
   * the three subcommands documented TODAY; a fourth added later would inherit whichever contract
   * its implementation happens to have, and the description would silently stop being complete.
   *
   * Derived from the usage text rather than a hand-written list, so this fails when someone adds
   * the flag to a subcommand without saying which form it takes. */
  const help = run(["--help"]);
  const takers = [...new Set(
    help.split("\n")
      .filter((line) => /^\s{2}cswarm /.test(line) && line.includes("--agent-token-stdin"))
      /* Words after `cswarm` up to the first option/placeholder. Taking a fixed two tokens
       * yielded "members [--url", because `members` is a one-word subcommand and `token revoke`
       * is two — the shape differs per line and a fixed slice cannot see that. */
      .map((line) => {
        const words = line.trim().split(/\s+/).slice(1);
        const name: string[] = [];
        for (const word of words) {
          if (!/^[a-z][a-z-]*$/.test(word)) break;
          name.push(word);
        }
        return name.join(" ");
      })
      .filter((name) => name.length > 0),
  )];

  assert.ok(takers.length >= 3, `usage parse looks wrong: found ${takers.length}`);

  const description = help.slice(help.indexOf("--agent-token-stdin  "));
  /* The FULL subcommand, never a fallback to its first word. A verb-level fallback was tried and
   * measured useless: deleting `token revoke`'s whole line left this green, because "token"
   * appears in the description's own prose ("bare swm_agt_ token"). A control matching a word
   * that the surrounding sentence already contains cannot fail. */
  const undocumented = takers.filter((sub) => !description.includes(sub));

  assert.deepEqual(
    undocumented,
    [],
    `these take --agent-token-stdin but the description does not say which form: ${
      undocumented.join(", ")
    }`,
  );
});
