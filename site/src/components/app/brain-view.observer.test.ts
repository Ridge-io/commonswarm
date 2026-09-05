import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { MESSAGE_MARKDOWN_LIMITS } from "../../lib/message-markdown.js";
import { BRAIN_BODY_MARKDOWN, runBrainViewFixture } from "./brain-view.fixture.js";

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
  assert.match(dashboard, /data-brain-raw-toggle/);
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

test("Brain renders headings, lists, code, and safe links with the transcript sanitizer", async () => {
  const snapshot = await snapshotPromise;
  assert.equal(snapshot.title, "architecture");
  assert.match(snapshot.renderedHtml, /<h2>Architecture<\/h2>/);
  assert.match(snapshot.renderedHtml, /<h3>Working agreement<\/h3>/);
  assert.match(snapshot.renderedHtml, /<h4>Read path<\/h4>/);
  assert.match(snapshot.renderedHtml, /<h5>Details<\/h5>/);
  assert.match(snapshot.renderedHtml, /<ul><li>versioned<\/li><li>shared<\/li><\/ul>/);
  assert.match(snapshot.renderedHtml, /<ol><li>Read<\/li><li>Write<\/li><\/ol>/);
  assert.match(snapshot.renderedHtml, /<code>cswarm brain get architecture<\/code>/);
  assert.match(
    snapshot.renderedHtml,
    /<pre><code>const safe = "&lt;tag&gt;";<\/code><\/pre>/,
  );
  assert.match(snapshot.renderedHtml, /<a href="https:\/\/example\.com\/guide"/);
  assert.equal(snapshot.linkRel, "noopener noreferrer");
  assert.equal(snapshot.linkTarget, "_blank");
  assert.doesNotMatch(snapshot.renderedHtml, /<img/u);
  /* RETIRED (2026-09-04): "| left | right |" stayed literal here. It did, and a brain topic full
     of pipe tables read as raw text because of it. The Brain panel and the feed share one
     renderer, so one fix reaches both; what this pins now is that the table is built through this
     panel's live sanitizer path, in a real browser, rather than only in the pure unit test. */
  assert.match(
    snapshot.renderedHtml,
    /<table><thead><tr><th>left<\/th><th>right<\/th><\/tr><\/thead>/u,
  );
  assert.doesNotMatch(snapshot.renderedHtml, /\| left \| right \|/u);
  assert.match(snapshot.renderedHtml, /!\[diagram\]\(https:\/\/example\.com\/diagram\.png\)/u);
  assert.equal(snapshot.historyCount, 3);
});

test("hostile feed fixture stays inert through the Brain render path", async () => {
  const snapshot = await snapshotPromise;
  assert.equal(snapshot.dangerousElementCount, 0);
  assert.match(snapshot.renderedHtml, /Before &lt;b&gt;raw&lt;\/b&gt;/u);
  assert.match(snapshot.renderedHtml, /\[click\]\(javascript:alert\(1\)\)/u);
  assert.match(snapshot.renderedHtml, /&lt;img src=x onerror=/u);
  assert.doesNotMatch(snapshot.renderedHtml, /<(?:b|img)\b|href="javascript:/u);
});

test("the Raw toggle shows the stored topic text byte-for-byte", async () => {
  const snapshot = await snapshotPromise;
  assert.equal(snapshot.panelLabel, "Rendered from markdown · Raw");
  assert.equal(snapshot.defaultRendered, true);
  assert.equal(snapshot.rawModeShown, true);
  assert.equal(snapshot.rawText, BRAIN_BODY_MARKDOWN);
});

/* RETIRED (2026-09-04): "a 10,000-line topic is shortened for display". The bound moved up past
   any ordinary topic. It is NOT past everything a workspace can store — a file version may be
   25 MB (src/cloud/files.ts) against a 2,000,000-character render bound — so a very large topic
   is still shortened in the rendered view, and Raw is the disclosure that holds the whole stored
   text. What is asserted: the render below, and the byte-for-byte Raw check above for an
   ORDINARY topic. Raw for a SHORTENED topic is the same code path — Raw reads the file, not the
   rendered HTML — but no fixture exercises it, so that half is design, not measurement. */
test("Brain rendering renders a large topic whole and still bounds nesting", async () => {
  const snapshot = await snapshotPromise;
  assert.equal(snapshot.boundedShortened, false);
  assert.equal(snapshot.boundedBlockquoteCount, MESSAGE_MARKDOWN_LIMITS.nestingDepth);
  assert.ok(snapshot.boundedBreakCount < MESSAGE_MARKDOWN_LIMITS.lines);
  assert.ok(snapshot.boundedHtmlLength <= MESSAGE_MARKDOWN_LIMITS.inputCharacters * 6);
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

test("Brain binds the open pane to the file, not the slug — a workspace switch cannot leak content", async () => {
  const snapshot = await snapshotPromise;
  assert.equal(snapshot.paneClosedOnForeignFile, true, "the pane survived a same-slug foreign file");
  assert.equal(snapshot.staleSaveRefused, true, "a stale-pane save reached the foreign file");
});
