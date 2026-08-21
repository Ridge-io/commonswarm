import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  archiveKnownGaps,
  renderWorkspaces,
  type WorkspaceSummary,
} from "../../src/cloud/workspaces.js";

function workspace(name: string, archived: boolean): WorkspaceSummary {
  return {
    workspace_id: randomUUID(),
    name,
    role: "owner",
    archived,
  };
}

test("workspace lists no longer publish the retired archive-enforcement gap", () => {
  const rendered = renderWorkspaces([
    workspace("Science Swarm", false),
    workspace("Legacy archived row", true),
  ], null);
  assert.match(rendered, /Science Swarm/);
  assert.match(rendered, /Legacy archived row \(archived\)/);
  assert.doesNotMatch(rendered, /archive enforcement|stays selectable|still succeed/i);
  assert.deepEqual(archiveKnownGaps(), []);
});

test("both JSON workspace surfaces keep the stable empty known_gaps field", () => {
  const source = readFileSync(new URL("../../src/cli.ts", import.meta.url), "utf8");
  const uses = source.match(/known_gaps: archiveKnownGaps\(\),/g) ?? [];
  assert.equal(uses.length, 2);
  assert.equal((source.match(/known_gaps:/g) ?? []).length, 2);
  assert.doesNotMatch(source, /workspace_archive_not_enforced/);
});
