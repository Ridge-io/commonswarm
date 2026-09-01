import assert from "node:assert/strict";
import { test } from "node:test";
import {
  BRAIN_TOPIC_MAX_LENGTH,
  BrainTopicError,
  brainFileName,
  brainTopicFromFileName,
  canonicalBrainTopic,
} from "../src/cloud/brain.js";

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
