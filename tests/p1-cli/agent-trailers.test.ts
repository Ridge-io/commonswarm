/**
 * Controls for the agent-authorship commit trailers.
 *
 * The load-bearing claim these defend is AGENTS.md, "An enumeration inside a message must be
 * generated, not typed": every user-facing list the trailer scripts print — required keys,
 * families, model sources, supported runtimes — must come from the same arrays the enforcement
 * reads, in scripts/lib/agent-trailer-vocab.sh. A typed list is a claim with no control on it and
 * drifts the moment the enforcement changes.
 *
 * So these tests do NOT assert against a list written here. They parse the vocabulary out of the
 * shell file and require the scripts' own output to agree with it. Adding a family to the array is
 * then a one-line change that cannot leave a stale sentence behind; retyping one into a script is
 * caught here.
 *
 * The gate's own behaviour (does it reject an untagged commit?) is covered by
 * `scripts/check-agent-trailers.sh --self-test`, which builds fixture repos and is run both here
 * and by .github/workflows/agent-trailers.yml.
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { test } from "node:test";

const repoRoot = process.cwd();
const vocabPath = resolve(repoRoot, "scripts/lib/agent-trailer-vocab.sh");
const emitter = resolve(repoRoot, "scripts/agent-trailers.sh");
const checker = resolve(repoRoot, "scripts/check-agent-trailers.sh");
const vocabSource = readFileSync(vocabPath, "utf8");

/** Read a bash array literal out of the vocabulary file. */
function vocabArray(name: string): string[] {
  const match = new RegExp(`^${name}=\\(([^)]*)\\)`, "m").exec(vocabSource);
  assert.notEqual(match, null, `${name} not found in ${vocabPath}`);
  return match![1]!
    .split("\n")
    .map((line) => line.replace(/#.*$/, "").trim())
    .filter((line) => line.length > 0)
    .map((line) => line.replace(/^['"]|['"]$/g, ""));
}

function run(command: string, args: string[], env?: NodeJS.ProcessEnv): string {
  return execFileSync(command, args, {
    cwd: repoRoot,
    encoding: "utf8",
    env: { ...process.env, ...env },
  });
}

const families = vocabArray("AGENT_TRAILER_FAMILIES");
const sources = vocabArray("AGENT_TRAILER_SOURCES");
const requiredKeys = vocabArray("AGENT_TRAILER_REQUIRED_KEYS");
const emittedKeys = vocabArray("AGENT_TRAILER_EMITTED_KEYS");
const optionalKeys = vocabArray("AGENT_TRAILER_OPTIONAL_KEYS");
const runtimeIds = vocabArray("AGENT_TRAILER_RUNTIMES").map((entry) => entry.split("|")[0]!);

test("the vocabulary is non-empty and internally consistent", () => {
  assert.ok(families.length > 0);
  assert.ok(sources.length > 0);
  assert.ok(requiredKeys.length > 0);
  assert.ok(runtimeIds.length > 0);
  /* Every required key must also be a key the emitter is allowed to produce, or the hook would
   * write commits the gate rejects — a failure that only shows up after the work is done. */
  for (const key of requiredKeys) assert.ok(emittedKeys.includes(key), `${key} is required but never emitted`);
  /* The two sentinels must be distinct: they answer different audit questions ("no agent wrote
   * this" versus "an agent did and we could not read which"). */
  const noAgent = /^AGENT_TRAILER_MODEL_NO_AGENT=(\S+)$/m.exec(vocabSource)?.[1];
  const unknown = /^AGENT_TRAILER_MODEL_UNKNOWN=(\S+)$/m.exec(vocabSource)?.[1];
  assert.ok(noAgent && unknown);
  assert.notEqual(noAgent, unknown);
});

test("the emitter's help lists every family, source and runtime from the vocabulary", () => {
  const help = run(emitter, ["--help"]);
  for (const family of families) assert.match(help, new RegExp(`\\b${family}\\b`), `family ${family} missing from --help`);
  for (const source of sources) assert.match(help, new RegExp(`\\b${source}\\b`), `source ${source} missing from --help`);
  for (const id of runtimeIds) assert.match(help, new RegExp(`\\b${id}\\b`), `runtime ${id} missing from --help`);
});

test("the checker's help lists every required key and family from the vocabulary", () => {
  const help = run(checker, ["--help"]);
  for (const key of requiredKeys) assert.match(help, new RegExp(key), `required key ${key} missing from --help`);
  for (const family of families) assert.match(help, new RegExp(`\\b${family}\\b`), `family ${family} missing from --help`);
});

test("the emitter only produces keys the vocabulary declares", () => {
  const known = new Set([...emittedKeys, ...optionalKeys]);
  const emitted = run(emitter, ["--emit"], { CSWARM_HUMAN_EDIT: "1" });
  const keys = emitted.split("\n").filter(Boolean).map((line) => line.split(":")[0]!);
  assert.ok(keys.length > 0);
  for (const key of keys) assert.ok(known.has(key), `emitter produced undeclared trailer key ${key}`);
  /* CSWARM_HUMAN_EDIT must actually reach the output; without this the flag could silently do
   * nothing and the audit would credit a model for work a human changed. */
  assert.ok(keys.includes("Agent-Human-Edit"));
});

test("the emitter always produces the required keys with non-empty values", () => {
  /* Run with every runtime variable stripped: the worst case is a seat we cannot identify, and
   * even then the block must satisfy the gate rather than emitting nothing. */
  const emitted = run(emitter, ["--emit"], {
    CLAUDECODE: "",
    CLAUDE_CODE_SESSION_ID: "",
    CODEX_THREAD_ID: "",
    GROK_SESSION_ID: "",
    ANTIGRAVITY_AGENT: "",
  });
  for (const key of requiredKeys) {
    const line = emitted.split("\n").find((candidate) => candidate.startsWith(`${key}:`));
    assert.ok(line, `${key} absent from an unidentified-runtime emit`);
    assert.ok(line!.slice(key.length + 1).trim().length > 0, `${key} emitted with an empty value`);
  }
});

test("an unreadable runtime emits the unknown sentinel, never a guessed model", () => {
  const detected = run(emitter, ["--detect"], {
    CLAUDECODE: "",
    CLAUDE_CODE_SESSION_ID: "",
    CODEX_THREAD_ID: "",
    GROK_SESSION_ID: "",
    ANTIGRAVITY_AGENT: "",
  });
  const unknown = /^AGENT_TRAILER_MODEL_UNKNOWN=(\S+)$/m.exec(vocabSource)![1]!;
  assert.match(detected, new RegExp(`^model=${unknown}$`, "m"));
  assert.match(detected, /^source=none$/m);
});

test("an explicitly declared model is recorded as declared, not as a measurement", () => {
  const detected = run(emitter, ["--detect"], {
    CSWARM_AGENT_MODEL: "gpt-5.6-sol",
    CSWARM_AGENT_FAMILY: "openai",
  });
  assert.match(detected, /^model=gpt-5\.6-sol$/m);
  assert.match(detected, /^family=openai$/m);
  /* The distinction the whole audit rests on: an assertion must never claim to be a runtime read. */
  assert.match(detected, /^source=declared$/m);
});

test("the human escape hatch resolves to the human family", () => {
  const noAgent = /^AGENT_TRAILER_MODEL_NO_AGENT=(\S+)$/m.exec(vocabSource)![1]!;
  const detected = run(emitter, ["--detect"], { CSWARM_AGENT_MODEL: noAgent });
  assert.match(detected, new RegExp(`^model=${noAgent}$`, "m"));
  assert.match(detected, /^family=human$/m);
});

test("claude-code is probed last so a nested lane is not mislabelled", () => {
  /* Measured 2026-09-04: a Claude Code session that shells out to grok or agy leaves every
   * CLAUDE_* variable in the child environment. If claude-code were probed first, every nested
   * lane would be signed with Anthropic's name. This pins the order, not just the membership. */
  assert.equal(runtimeIds[runtimeIds.length - 1], "claude-code");
});

test("the checker's self-test passes and reports its assertion count", () => {
  /* An exit code cannot certify that a test run happened: deleting the suite body would make
   * --self-test exit 0 having asserted nothing. CI parses this same count for that reason. */
  const out = run(checker, ["--self-test"]);
  const count = /^self-test: PASSED (\d+) assertions$/m.exec(out);
  assert.notEqual(count, null, `no assertion-count line in:\n${out}`);
  assert.ok(Number(count![1]) >= 20, `self-test ran only ${count![1]} assertions`);
});

test("the doc records the no-backfill rule and the escape hatch", () => {
  /* These are the two things a cold reader most needs and the two most likely to be dropped in a
   * later edit: without the first the audit gets poisoned with guesses, and without the second
   * people type a fake model to get past the gate. */
  const doc = readFileSync(resolve(repoRoot, "docs/development/agent-trailers.md"), "utf8");
  assert.match(doc, /must not be backfilled/i);
  assert.match(doc, /CSWARM_AGENT_MODEL=none/);
  assert.match(doc, /CSWARM_HUMAN_EDIT=1/);
});
