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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

/** A throwaway HOME holding one codex rollout, so detect_codex reads a real session record. */
function codexHome(threadId: string, model: string): string {
  const home = mkdtempSync(join(tmpdir(), "agent-trailers-home-"));
  const dir = resolve(home, ".codex/sessions/2026/09/04");
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    resolve(dir, `rollout-2026-09-04T00-00-00-${threadId}.jsonl`),
    [
      JSON.stringify({ type: "session_meta", payload: { cli_version: "0.147.0", model_provider: "openai" } }),
      JSON.stringify({ type: "turn_context", payload: { model } }),
    ].join("\n") + "\n",
  );
  return home;
}

/* Every runtime marker cleared, BUILT FROM THE VOCABULARY. Retyping this list would leave a newly
 * added runtime uncleared, so its marker would leak in from the environment the tests run in and a
 * case would silently measure something other than what it set. `CLAUDE_CODE_SESSION_ID` is added
 * because the Claude Code detector reads it after its own marker. */
const runtimeMarkers = vocabArray("AGENT_TRAILER_RUNTIMES").map((entry) => entry.split("|")[2]!);
const noRuntime: NodeJS.ProcessEnv = Object.fromEntries(
  [...runtimeMarkers, "CLAUDE_CODE_SESSION_ID"].map((name) => [name, ""]),
);

test("one runtime marker reads the model as a clean measurement", () => {
  const home = codexHome("thread-solo", "gpt-5.6-sol");
  try {
    const detected = run(emitter, ["--detect"], { ...noRuntime, HOME: home, CODEX_THREAD_ID: "thread-solo" });
    assert.match(detected, /^model=gpt-5\.6-sol$/m);
    assert.match(detected, /^source=runtime-transcript$/m);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("a second runtime marker downgrades the source to runtime-ambiguous", () => {
  /* Inheritance is symmetric. A codex parent leaves CODEX_THREAD_ID in a grok child exactly as a
   * Claude Code parent leaves CLAUDE_* in a codex child, and the probe order can only ever be
   * right for one nesting direction. When two runtimes are visible the environment cannot say
   * which is innermost, so the model may belong to a PARENT session. The order still picks — it is
   * right for the nesting this repo runs — but the trailer must stop calling the answer a clean
   * measurement, or a reader weighs a parent's model as if it were the author's.
   *
   * The pair is what makes this discriminating: the same rollout, the same model, and only the
   * presence of a second marker changes the source. */
  const home = codexHome("thread-nested", "gpt-5.6-sol");
  try {
    const detected = run(emitter, ["--detect"], {
      ...noRuntime,
      HOME: home,
      CODEX_THREAD_ID: "thread-nested",
      CLAUDECODE: "1",
    });
    assert.match(detected, /^model=gpt-5\.6-sol$/m, "the ordered pick changed, not just the source");
    assert.match(detected, /^source=runtime-ambiguous$/m);
    assert.ok(sources.includes("runtime-ambiguous"), "runtime-ambiguous is not in the vocabulary");
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});

test("every runtime in the vocabulary names the variable that marks it", () => {
  /* The ambiguity count is only as complete as this third field. A runtime added without its
   * marker would be invisible to the count, and a nested lane using it would be signed as a clean
   * measurement of the wrong session. */
  const entries = vocabArray("AGENT_TRAILER_RUNTIMES");
  for (const entry of entries) {
    const fields = entry.split("|");
    assert.equal(fields.length, 3, `${entry} does not have id|detector|marker`);
    assert.match(fields[2]!, /^[A-Z][A-Z0-9_]*$/, `${entry} has no environment-variable marker`);
  }
});

test("the checker's self-test passes and reports its assertion count", () => {
  /* An exit code cannot certify that a test run happened: deleting the suite body would make
   * --self-test exit 0 having asserted nothing. CI parses this same count for that reason. */
  const out = run(checker, ["--self-test"]);
  const count = /^self-test: PASSED (\d+) assertions$/m.exec(out);
  assert.notEqual(count, null, `no assertion-count line in:\n${out}`);
  assert.ok(Number(count![1]) >= 20, `self-test ran only ${count![1]} assertions`);
});

test("the hook path constant, the file, and hooks:install all agree", () => {
  /* Grace skips any commit whose tree has no hook, so this one path decides what the gate checks.
   * Three places must agree on it and only one of them is bash: the vocabulary the gate reads, the
   * file itself, and the `hooks:install` script in package.json, which is JSON and cannot source
   * the constant. A path naming no file would skip every commit and leave the gate green while
   * checking nothing, which is the failure this control exists to catch. */
  const dir = /^AGENT_TRAILER_HOOK_DIR=(\S+)$/m.exec(vocabSource)?.[1];
  assert.ok(dir, "AGENT_TRAILER_HOOK_DIR not found in the vocabulary");
  const hookPath = `${dir}/prepare-commit-msg`;
  assert.match(
    vocabSource,
    /^AGENT_TRAILER_HOOK_PATH="\$\{AGENT_TRAILER_HOOK_DIR\}\/prepare-commit-msg"$/m,
    "AGENT_TRAILER_HOOK_PATH is not built from AGENT_TRAILER_HOOK_DIR",
  );
  assert.ok(existsSync(resolve(repoRoot, hookPath)), `${hookPath} names no file`);
  const install = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8"))
    .scripts["hooks:install"] as string;
  assert.ok(install.includes(dir!), `hooks:install does not install into ${dir}`);
});

test("the grace cutoff's two forms agree and the cutoff is in the past", () => {
  /* The vocabulary carries the cutoff twice: an ISO string for the sentences the scripts print and
   * an epoch for the shell to compare. Bash cannot parse an ISO date portably, so nothing in the
   * shell can see the two drift apart; Node can. If they drift, the gate skips a different set of
   * commits than every message says it does. A cutoff in the future skips every commit. */
  const iso = /^AGENT_TRAILER_GRACE_BEFORE=(\S+)$/m.exec(vocabSource)?.[1];
  const epoch = /^AGENT_TRAILER_GRACE_BEFORE_EPOCH=(\d+)$/m.exec(vocabSource)?.[1];
  assert.ok(iso && epoch, "the grace cutoff is not in the vocabulary in both forms");
  const parsed = Date.parse(iso!);
  assert.ok(Number.isFinite(parsed), `${iso} is not a date Date.parse understands`);
  assert.equal(parsed / 1000, Number(epoch), `${iso} and epoch ${epoch} disagree`);
  assert.ok(parsed < Date.now(), `the grace cutoff ${iso} is in the future`);
});

test("the PR summary's categories cover every model source in the vocabulary", () => {
  /* The summary sorts commits into measured / ambiguous / declared / not-established. Those
   * categories are built from constants, but nothing forced them to PARTITION the vocabulary: a
   * source added to the array and matched by no category would quietly drop out of the totals, and
   * a reader would be told less work was audited than was. So build one commit per source and
   * require the script to account for all of them. */
  const repo = mkdtempSync(join(tmpdir(), "agent-trailers-pr-"));
  try {
    const git = (...args: string[]) =>
      execFileSync("git", args, { cwd: repo, encoding: "utf8", env: { ...process.env, HOME: repo } });
    git("init", "--quiet", "-b", "main");
    git("-c", "user.name=F", "-c", "user.email=f@cloud-swarm.local",
        "commit", "--quiet", "--allow-empty", "--no-verify", "-m", "base");
    for (const source of sources) {
      git("-c", "user.name=F", "-c", "user.email=f@cloud-swarm.local",
          "commit", "--quiet", "--allow-empty", "--no-verify", "-m",
          `chore: ${source}

Agent-Model: probe
Agent-Family: unknown
Agent-Model-Source: ${source}`);
    }
    const summary = execFileSync(resolve(repoRoot, "scripts/pr-agent-trailers.sh"),
      [`HEAD~${sources.length}..HEAD`], { cwd: repo, encoding: "utf8" });
    assert.ok(!/WARNING/.test(summary), `a model source falls into no category:
${summary}`);
    const counted = /^(\d+) of (\d+) commit\(s\)/m.exec(summary);
    assert.ok(counted, `no honesty line in:
${summary}`);
    assert.equal(Number(counted![2]), sources.length, "the summary counted the wrong number of commits");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("the hook is opt-in and no lifecycle script installs it", () => {
  /* A hook installed by `npm install` would rewrite commit messages in every checkout that ever
   * ran it, including ones whose owner never asked. The install must stay an explicit command. */
  const scripts = JSON.parse(readFileSync(resolve(repoRoot, "package.json"), "utf8")).scripts as
    Record<string, string>;
  for (const [name, body] of Object.entries(scripts)) {
    if (name === "hooks:install") continue;
    assert.ok(
      !/core\.hooksPath|hooks:install/.test(body),
      `the lifecycle-reachable script ${name} installs the hook: ${body}`,
    );
  }
});

test("the checker's help names the hook path from the constant", () => {
  /* AGENTS.md, "An enumeration inside a message must be generated, not typed": the path a reader is
   * told about must be the path the enforcement reads, not a second copy of it. */
  const dir = /^AGENT_TRAILER_HOOK_DIR=(\S+)$/m.exec(vocabSource)![1]!;
  const help = run(checker, ["--help"]);
  assert.ok(help.includes(`${dir}/prepare-commit-msg`), "the checker's help does not name the hook path");
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

test("the doc does not pin the self-test's assertion count", () => {
  /* A count in prose goes stale silently every time an assertion is added, and this doc has already
   * carried a wrong one twice. CI floors the count instead. This fails if somebody writes a figure
   * back in, which is the only way the paragraph can go wrong again. */
  const doc = readFileSync(resolve(repoRoot, "docs/development/agent-trailers.md"), "utf8");
  const pinned = /(\d+)\s+assertions?\s+pass|passes?\s+(\d+)\s+assertions?/i.exec(doc);
  assert.equal(pinned, null, `the doc pins an assertion count: ${pinned?.[0]}`);
});

test("the doc's tables name every family and every source in the vocabulary", () => {
  /* The doc says outright: "The accepted values live in scripts/lib/agent-trailer-vocab.sh and
   * nowhere else ... this table is documentation and the arrays are the definition. If they ever
   * disagree, tests/p1-cli/agent-trailers.test.ts fails." That sentence was a claim with nothing
   * behind it until this test existed. A doc table cannot be generated from a bash array — each row
   * carries prose only a person can write — so the control is coverage: adding a family or a source
   * to the vocabulary and not to the doc fails here. */
  const doc = readFileSync(resolve(repoRoot, "docs/development/agent-trailers.md"), "utf8");
  for (const family of families) {
    assert.ok(new RegExp(`\\b${family}\\b`).test(doc), `family ${family} is not documented`);
  }
  for (const source of sources) {
    assert.ok(doc.includes(source), `model source ${source} is not documented`);
  }
  /* Runtime ids were left out of this control once and the doc's table drifted to `claude` while
   * the vocabulary said `claude-code` — a live disagreement the page claimed this test would catch.
   *
   * Asking whether the id appears ANYWHERE in the file is not enough: `claude-code` also appears in
   * the prose around the table, so the wrong table row stayed green. The control reads the table's
   * first column and requires the set to match the vocabulary exactly, which catches drift in
   * either direction. */
  const tableIds = [...doc.matchAll(/^\|\s*`([^`]+)`\s*\|\s*(?:yes|\*\*no\*\*)\s*\|/gm)].map((m) => m[1]!);
  assert.deepEqual(
    [...tableIds].sort(),
    [...runtimeIds].sort(),
    "the doc's runtime table and AGENT_TRAILER_RUNTIMES name different runtimes",
  );
});

test("the doc marks exactly the required trailer keys as required", () => {
  /* Which keys are required is enforcement, and the doc restates it in a table. Nothing tied the
   * two together, so quietly dropping a key from AGENT_TRAILER_REQUIRED_KEYS weakened the gate and
   * left the page still promising the field. This reads the key table and requires the two to
   * agree, in both directions. */
  const doc = readFileSync(resolve(repoRoot, "docs/development/agent-trailers.md"), "utf8");
  const rows = [...doc.matchAll(/^\|\s*`(Agent-[A-Za-z-]+|Reviewed-By-Model)`\s*\|([^|]*)\|/gm)];
  assert.ok(rows.length > 0, "the doc has no trailer-key table");
  const documentedAsRequired = rows.filter((m) => /\bRequired\./.test(m[2]!)).map((m) => m[1]!);
  assert.deepEqual(
    [...documentedAsRequired].sort(),
    [...requiredKeys].sort(),
    "the doc's key table and AGENT_TRAILER_REQUIRED_KEYS disagree about what is required",
  );
});

test("a runtime that cannot read its model still records the family it can establish", () => {
  /* Claude Code serves Anthropic models and nothing else, so an unreadable transcript leaves the
   * family known and only the model unknown. That is a measurement, not the "family from the tool"
   * guess agy is denied: agy serves 15 model ids across three families, so its family stays
   * unknown. The doc said the unknown sentinel was always unknown/unknown, which this pins as
   * wrong. */
  const detected = run(emitter, ["--detect"], {
    ...noRuntime,
    CLAUDECODE: "1",
    CLAUDE_CODE_SESSION_ID: "no-such-session-exists",
  });
  const unknown = /^AGENT_TRAILER_MODEL_UNKNOWN=(\S+)$/m.exec(vocabSource)![1]!;
  assert.match(detected, new RegExp(`^model=${unknown}$`, "m"));
  assert.match(detected, /^family=anthropic$/m, "the family a runtime can establish was dropped");
  assert.match(detected, /^source=none$/m, "an unread model must not claim a source");
});

test("the doc records the grace rule and does not overstate what the gate blocks", () => {
  /* The grace rule is what keeps the gate off work written before it existed. A later edit that
   * drops it makes every branch that predates the rule fail for commits nobody could have tagged.
   *
   * The last assertion pins a claim, not a behaviour: main has no branch protection, so the
   * workflow reports and blocks nothing. A doc that calls it a merge gate is wrong until somebody
   * flips a repository setting, and that wrongness is invisible from inside the repo. */
  const doc = readFileSync(resolve(repoRoot, "docs/development/agent-trailers.md"), "utf8");
  const dir = /^AGENT_TRAILER_HOOK_DIR=(\S+)$/m.exec(vocabSource)![1]!;
  assert.ok(doc.includes(`${dir}/prepare-commit-msg`), "the doc does not name the hook path");
  assert.match(doc, /AGENT_TRAILER_HOOK_PATH/, "the doc does not name the tree half of the rule");
  assert.match(doc, /AGENT_TRAILER_GRACE_BEFORE/, "the doc does not name the date half of the rule");
  /* Both halves, and WHY each is needed. A later edit that drops one leaves a rule that fails on
   * rebase or on concurrent lanes, and the reason is the part nobody reconstructs from the code. */
  /* Anchored on the phrase, not on the bare word "rebase", which appears elsewhere on the page and
   * would let the explanation be deleted while the test stayed green. */
  assert.match(doc, /tree alone loses to a rebase/i, "the doc does not explain what the tree test alone loses to");
  assert.match(doc, /date alone loses to concurrent lanes/i, "the doc does not explain what the date test alone loses to");
  assert.match(doc, /author date, not committer date/i);
  assert.match(doc, /no branch protection/i, "the doc does not say the check blocks no merge today");
});
