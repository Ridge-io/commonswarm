import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runBrainViewFixture } from "./brain-view.fixture.js";

/* Reached by site/package.json's recursive component observer-test glob. */

const snapshotPromise = runBrainViewFixture();

test("the dashboard wires a Brain tab to the existing file read and put paths", () => {
  const dashboard = readFileSync(new URL("./LiveDashboard.astro", import.meta.url), "utf8");
  assert.equal(
    [...dashboard.matchAll(/data-workspace-view="brain"/g)].length,
    2,
    "Brain must be reachable from the desktop rail and the mobile view switcher",
  );
  assert.match(dashboard, /data-channel-view="brain"/);
  assert.match(dashboard, /brainTopics\(files, workspaceFileUploaderName\)/);
  assert.match(dashboard, /setSanitizedMessageMarkdown/);
  assert.match(
    dashboard,
    /new File\(\[markdown\], topic\.name[\s\S]*uploadBrowserAttachment/,
    "browser edits must use the current file create → PUT → commit flow",
  );
  assert.match(dashboard, /<summary>Version history<\/summary>/);
});

test("Brain lists only reserved topics with updater, age, and version count", async () => {
  const snapshot = await snapshotPromise;
  assert.deepEqual(snapshot.listTopics, ["architecture"]);
  assert.match(snapshot.listDetails[0]!, /2 versions/);
  assert.match(snapshot.listDetails[0]!, /2 hours ago/);
  assert.match(snapshot.listDetails[0]!, /Atlas/);
});

test("Brain renders topic Markdown with the transcript sanitizer and links history", async () => {
  const snapshot = await snapshotPromise;
  assert.equal(snapshot.title, "architecture");
  assert.equal(snapshot.dangerousElementCount, 0);
  assert.match(snapshot.renderedHtml, /<strong>File layer<\/strong>/);
  assert.equal(snapshot.historyCount, 3);
});

test("Brain edit submits Markdown and returns the confirmed new file version", async () => {
  const snapshot = await snapshotPromise;
  assert.equal(snapshot.saveCount, 1);
  assert.equal(
    snapshot.savedMarkdown,
    "**File layer**\n\nUse the existing file verbs.\n\n<img src=x>",
  );
  assert.match(snapshot.status, /Saved architecture as v3/);
  assert.match(snapshot.versionAfterSave, /3 versions/);
  assert.match(snapshot.versionAfterSave, /Dana/);
});
