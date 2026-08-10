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

test("--help states listen start's stricter credential contract", () => {
  /* Wren, 2026-08-10, and the finding is sharper than the defect it started as. The flag NAME is
   * shared and the CONTRACT is not: `members --agent-token-stdin` accepts a bare swm_agt_ token,
   * `listen start --agent-token-stdin` refuses one. Both of us measured the flag and reached
   * opposite conclusions, because we happened to pick different subcommands.
   *
   * The refusal itself is CORRECT and stays — listen start keeps durable state and rotates, and
   * neither is possible without expires_at. What was wrong is that --help documented the bare
   * form as if it were universal, so the documentation was true for whichever subcommand the
   * reader checked it against. */
  const help = run(["--help"]);

  assert.match(help, /listen start is the exception/);
  assert.match(help, /COMPLETE JSON artifact/);
  /* CONTROL: the general case must still be documented. Deleting the bare form entirely would
   * satisfy the assertions above while making the line wrong for every other subcommand. */
  assert.match(help, /legacy swm_agt_/);
});
