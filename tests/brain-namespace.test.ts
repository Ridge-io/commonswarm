import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  BRAIN_END_OF_TASK_NUDGE,
  BRAIN_TOPIC_MAX_LENGTH,
  BrainTopicError,
  brainEndOfTaskNudge,
  brainFileName,
  brainTopicFromFileName,
  canonicalBrainTopic,
  parseBrainTopicSelector,
  type BrainTopicSnapshot,
} from "../src/cloud/brain.js";
import { FileBrainDigestStore } from "../src/listener/brain-digest.js";
import {
  BRAIN_LIVE_VERSION_LIMIT,
  isBrainFileArtifactName,
  planFileVersionWindow,
} from "../src/protocol/brain-version-window.js";

/* Reached by package.json's literal `npm test` list. */

test("brain topics map into the slash-free reserved file namespace", () => {
  assert.equal(brainFileName("Architecture"), "brain--architecture.md");
  assert.equal(brainFileName("release_notes.v2"), "brain--release_notes.v2.md");
  assert.equal(brainTopicFromFileName("brain--architecture.md"), "architecture");
  assert.equal(brainTopicFromFileName("BRAIN--ARCHITECTURE.MD"), "architecture");

  assert.equal(brainTopicFromFileName("architecture.md"), null);
  assert.equal(brainTopicFromFileName("brain--bad topic.md"), null);
  assert.equal(brainTopicFromFileName("brain/architecture.md"), null);
});

test("brain topic validation is closed and keeps the 255-byte file-name bound", () => {
  assert.equal(canonicalBrainTopic("  durable-decisions  "), "durable-decisions");
  const longest = `a${"b".repeat(BRAIN_TOPIC_MAX_LENGTH - 1)}`;
  assert.equal(brainFileName(longest).length, 255);

  for (const invalid of ["", ".hidden", "with space", "nested/topic", "topic!", `${longest}x`]) {
    assert.throws(() => brainFileName(invalid), BrainTopicError);
  }
});

test("brain history selectors accept topic@version without weakening topic validation", () => {
  assert.deepEqual(parseBrainTopicSelector("Architecture@21"), {
    topic: "architecture",
    version: 21,
  });
  assert.deepEqual(parseBrainTopicSelector("architecture"), {
    topic: "architecture",
    version: null,
  });
  for (const invalid of ["architecture@0", "architecture@-1", "architecture@x", "@1"]) {
    assert.throws(() => parseBrainTopicSelector(invalid), BrainTopicError);
  }
});

test("brain version policy rolls live history and refuses only 20 in-flight uploads", () => {
  assert.equal(isBrainFileArtifactName("brain--architecture.md"), true);
  assert.equal(isBrainFileArtifactName("BRAIN--ARCHITECTURE.MD"), true);
  assert.equal(isBrainFileArtifactName("brain--bad topic.md"), false);
  assert.equal(isBrainFileArtifactName("ordinary.md"), false);

  assert.deepEqual(
    planFileVersionWindow("brain--architecture.md", 20, 0),
    { brainTopic: true, createAllowed: true, retireOnCommitCount: 1 },
  );
  assert.deepEqual(
    planFileVersionWindow("brain--architecture.md", 21, 19),
    { brainTopic: true, createAllowed: true, retireOnCommitCount: 2 },
  );
  assert.deepEqual(
    planFileVersionWindow(
      "brain--architecture.md",
      20,
      BRAIN_LIVE_VERSION_LIMIT,
    ),
    { brainTopic: true, createAllowed: false, retireOnCommitCount: 1 },
  );

  // Normal files keep the old fixed cap: live and unexpired pending rows share it.
  assert.deepEqual(
    planFileVersionWindow("architecture.md", 19, 1),
    { brainTopic: false, createAllowed: false, retireOnCommitCount: 0 },
  );
  assert.deepEqual(
    planFileVersionWindow("architecture.md", 18, 1),
    { brainTopic: false, createAllowed: true, retireOnCommitCount: 0 },
  );
});

function topic(
  name: string,
  version: number,
  updatedAt: string,
): BrainTopicSnapshot {
  return { topic: name, version, updatedAt };
}

test("brain digest state emits each new or bumped version once and stays 0600", async () => {
  const root = await mkdtemp(join(tmpdir(), "cswarm-brain-digest-"));
  const principalId = "11111111-1111-4111-8111-111111111111";
  try {
    const store = new FileBrainDigestStore(root, principalId);
    const initial = [
      topic("alpha", 1, "2026-09-01T10:00:00.000Z"),
      topic("beta", 1, "2026-09-01T11:00:00.000Z"),
      topic("gamma", 1, "2026-09-01T12:00:00.000Z"),
    ];
    const first = await store.consume(initial);
    assert.match(first ?? "", /^\[CommonSwarm brain\] 3 topics;/);
    assert.match(first ?? "", /gamma v1, beta v1/);
    assert.doesNotMatch(first ?? "", /alpha v1/);
    assert.equal(await store.consume(initial), null);

    const withNew = [
      ...initial,
      topic("delta", 1, "2026-09-01T13:00:00.000Z"),
    ];
    assert.match(await store.consume(withNew) ?? "", /delta v1/);
    assert.equal(await store.consume(withNew), null);

    const withBump = [
      ...withNew.map((row) =>
        row.topic === "beta"
          ? topic("beta", 2, "2026-09-01T14:00:00.000Z")
          : row
      ),
      topic("epsilon", 1, "2026-09-01T15:00:00.000Z"),
    ];
    const bumped = await store.consume(withBump) ?? "";
    assert.match(bumped, /epsilon v1, beta v2/);
    assert.equal(await store.consume(withBump), null);

    assert.equal((await stat(store.location)).mode & 0o777, 0o600);
    const stored = await readFile(store.location, "utf8");
    assert.doesNotMatch(stored, /body|markdown|content/i);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the end-of-task nudge is fixed and exclusive to replied outcomes", () => {
  assert.equal(brainEndOfTaskNudge(["replied"]), BRAIN_END_OF_TASK_NUDGE);
  assert.equal(
    brainEndOfTaskNudge(["queued", "observed", "expired", "failed_terminal", null]),
    null,
  );
  assert.equal(
    brainEndOfTaskNudge(["replied", "replied"]),
    BRAIN_END_OF_TASK_NUDGE,
  );
});
