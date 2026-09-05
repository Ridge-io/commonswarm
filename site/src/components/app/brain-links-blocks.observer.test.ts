/** Reached by `npm --prefix site test` through the recursive component-observer glob.
 *
 * The brain-link pass walks the tree the SANITIZER built and turns validated topic names into
 * buttons. This lane gave that tree four new places to walk: table headers, table cells, task
 * items, and sublists. `brain-links.observer.test.ts` covers paragraphs, code spans, links, and
 * fenced blocks; none of its fixture reaches a table or a task item, so the new constructs had no
 * control on them at all.
 *
 * What is under test is the BOUNDARY, not the feature: a topic name must not end up as a control
 * inside something that is meant to be opaque or verbatim, and the marker a task item owns must not
 * be swallowed into the control's own label -- a button reading "[ballot] shared-host" is a
 * checkbox the reader can click, which is exactly the shape the renderer refused to emit.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { build } from "esbuild";
import { findChrome } from "./participant-rail.fixture.js";

const run = promisify(execFile);
const siteRoot = join(import.meta.dirname, "..", "..", "..");

/* Every new construct, each carrying a topic mention, plus the two mentions that must stay prose. */
const BODY = [
  "| brain-how-to | note |",
  "|---|---|",
  "| shared-host | the `releases` ritual |",
  "| [shared-host](https://example.com/s) | releases is prose here |",
  "",
  "- [ ] read shared-host",
  "- [x] done with `releases`",
  "",
  "- outer note",
  "  - inner mentions shared-host",
].join("\n");

const TOPICS = ["brain-how-to", "shared-host", "releases"];

/** The ballot characters the renderer owns. Read from the module so this cannot drift from it. */
interface Snapshot {
  controlTopics: string[];
  controlWords: string[];
  controlsInsideAnchor: number;
  controlsInsideButton: number;
  controlsInsidePre: number;
  controlsInsideHeaderCell: number;
  controlsInsideBodyCell: number;
  controlsInsideTaskItem: number;
  controlsInsideSublist: number;
  inputCount: number;
  /** The text that sits before the first task item's control, marker included. */
  taskItemLeadingText: string;
  taskItemText: string;
  /** The anchor in the second row: its label is a topic name and it must stay a link, not a button. */
  anchorText: string;
  /** The cell that says "releases" in prose. It must hold no control. */
  proseCellText: string;
  proseCellControls: number;
  /** The code span inside a cell. The one-word gate has to still work through a table. */
  cellCodeSpanControls: string[];
  /** Rows still line up: dropping a cell tag would foster-parent its text out of the table. */
  tableTextOutsideCells: string;
  headerCellCount: number;
  bodyCellCount: number;
}

const snapshotPromise = (async (): Promise<Snapshot> => {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-brain-links-blocks-"));
  const fixture = join(directory, "index.html");
  const bundleOf = async (entry: string, globalName: string): Promise<string> => {
    const bundle = await build({
      absWorkingDir: siteRoot,
      bundle: true,
      entryPoints: [entry],
      format: "iife",
      globalName,
      platform: "browser",
      write: false,
    });
    const script = bundle.outputFiles[0]?.text;
    assert.ok(script, `${entry} must bundle for its browser fixture`);
    return script;
  };
  const markdownScript = await bundleOf("src/lib/message-markdown.ts", "MessageMarkdown");
  const linkScript = await bundleOf("src/lib/brain-links.ts", "BrainLinks");

  const html = `<!doctype html>
<html>
  <body>
    <div class="dashboard__message-markdown" data-message></div>
    <script>${markdownScript}</script>
    <script>${linkScript}</script>
    <script>
      const host = document.querySelector("[data-message]");
      MessageMarkdown.setSanitizedMessageMarkdown(host, ${JSON.stringify(BODY)}, { headingOffset: 1 });
      BrainLinks.linkifyBrainTopics(host, {
        topics: ${JSON.stringify(TOPICS)},
        open: () => {},
      });
      const controls = Array.from(host.querySelectorAll("[data-brain-link]"));
      const count = (selector) => host.querySelectorAll(selector).length;
      const task = host.querySelector("li.md-task");
      const proseCell = Array.from(host.querySelectorAll("td"))
        .find((cell) => cell.textContent.includes("prose here"));
      const cellCode = Array.from(host.querySelectorAll("td code"))
        .find((code) => code.textContent === "releases");
      const table = host.querySelector("table");
      /* Everything a table holds that is NOT inside a cell. The HTML parser foster-parents any
         text it finds directly inside a table, so a dropped cell tag would show up here. */
      const outside = table
        ? Array.from(table.childNodes)
            .flatMap((node) => node.nodeType === 3 ? [node.nodeValue] : [])
            .join("")
        : "NO TABLE";
      const snapshot = {
        controlTopics: controls.map((control) => control.dataset.brainLink),
        controlWords: controls.map((control) => control.textContent),
        controlsInsideAnchor: count("a [data-brain-link]"),
        controlsInsideButton: count("button [data-brain-link]"),
        controlsInsidePre: count("pre [data-brain-link]"),
        controlsInsideHeaderCell: count("th [data-brain-link]"),
        controlsInsideBodyCell: count("td [data-brain-link]"),
        controlsInsideTaskItem: count("li.md-task [data-brain-link]"),
        controlsInsideSublist: count("li ul li [data-brain-link]"),
        inputCount: count("input"),
        taskItemLeadingText: task && task.firstChild && task.firstChild.nodeType === 3
          ? task.firstChild.nodeValue
          : "NO LEADING TEXT NODE",
        taskItemText: task ? task.textContent : "NO TASK ITEM",
        anchorText: host.querySelector("td a") ? host.querySelector("td a").textContent : "NO ANCHOR",
        proseCellText: proseCell ? proseCell.textContent : "NO PROSE CELL",
        proseCellControls: proseCell ? proseCell.querySelectorAll("[data-brain-link]").length : -1,
        cellCodeSpanControls: cellCode
          ? Array.from(cellCode.querySelectorAll("[data-brain-link]"))
              .map((control) => control.dataset.brainLink)
          : ["NO CELL CODE SPAN"],
        tableTextOutsideCells: outside,
        headerCellCount: count("th"),
        bodyCellCount: count("td"),
      };
      document.documentElement.dataset.fixture = btoa(
        String.fromCharCode(...new TextEncoder().encode(JSON.stringify(snapshot))),
      );
    </script>
  </body>
</html>`;

  try {
    await writeFile(fixture, html, "utf8");
    const chrome = await findChrome();
    const { stdout } = await run(chrome, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--single-process",
      "--no-zygote",
      "--allow-file-access-from-files",
      "--dump-dom",
      `file://${fixture}`,
    ], { maxBuffer: 10 * 1024 * 1024, timeout: 20_000, killSignal: "SIGKILL" });
    const encoded = stdout.match(/data-fixture="([^"]+)"/u)?.[1];
    assert.ok(encoded, "headless Chrome must return the block brain-link snapshot");
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Snapshot;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
})();

test("the link pass reaches table cells, task items, and sublists, and only the gated mentions link", async () => {
  const snapshot = await snapshotPromise;
  /* Document order. The second row's anchor label is a topic name and produces nothing, because
   * an anchor is opaque; the same row's "releases" is prose in a cell and stays prose. */
  assert.deepEqual(snapshot.controlTopics, [
    "brain-how-to",
    "shared-host",
    "releases",
    "shared-host",
    "releases",
    "shared-host",
  ], JSON.stringify(snapshot));
  assert.deepEqual(snapshot.controlWords, snapshot.controlTopics);
  /* Each new construct is reached. Without these a green negative below could mean the pass never
   * entered a table or a list at all. */
  assert.equal(snapshot.controlsInsideHeaderCell, 1);
  assert.equal(snapshot.controlsInsideBodyCell, 2);
  assert.equal(snapshot.controlsInsideTaskItem, 2);
  assert.equal(snapshot.controlsInsideSublist, 1);
});

test("no control lands inside an opaque element, and none is nested in another control", async () => {
  const snapshot = await snapshotPromise;
  assert.ok(snapshot.controlTopics.length > 0, "controls must exist for a negative to mean anything");
  /* The anchor's own label IS "shared-host", so this is the case that would break first if the
   * opaque set stopped covering the new tree. */
  assert.equal(snapshot.anchorText, "shared-host");
  assert.equal(snapshot.controlsInsideAnchor, 0);
  assert.equal(snapshot.controlsInsidePre, 0);
  /* A control inside a control is unreachable by design (BUTTON is opaque) and is also invalid
   * HTML, which the parser would resolve by moving the inner one out of the cell. */
  assert.equal(snapshot.controlsInsideButton, 0);
});

test("a task item's ballot marker stays outside the control, so the control is not a checkbox", async () => {
  const snapshot = await snapshotPromise;
  /* The whole item still reads as the author wrote it... */
  assert.equal(snapshot.taskItemText, "☐ read shared-host");
  /* ...and the marker sits in the text node BEFORE the control, never inside its label. A control
   * whose label began with the ballot character would render as a clickable checkbox, which is the
   * element the renderer refused to emit in the first place. */
  assert.equal(snapshot.taskItemLeadingText, "☐ read ");
  assert.equal(snapshot.controlWords.includes("☐ read shared-host"), false);
  for (const word of snapshot.controlWords) {
    assert.doesNotMatch(word, /[☐☑]/u, `a control label carries a ballot marker: ${word}`);
  }
  /* And nothing in the tree is a real form control. */
  assert.equal(snapshot.inputCount, 0);
});

test("the one-word gate still works through a table cell", async () => {
  const snapshot = await snapshotPromise;
  /* Positive: a code span in a cell that IS the name links. */
  assert.deepEqual(snapshot.cellCodeSpanControls, ["releases"]);
  /* Negative, on the same word in the same table: prose in a cell does not. */
  assert.equal(snapshot.proseCellText, "releases is prose here");
  assert.equal(snapshot.proseCellControls, 0);
});

test("building controls inside cells leaves the table intact", async () => {
  const snapshot = await snapshotPromise;
  /* Text directly inside <table> is text the HTML parser foster-parented because a cell tag was
   * missing. It must be empty or whitespace: a dropped cell would move a reader's data out of its
   * column and above the table. */
  assert.match(snapshot.tableTextOutsideCells, /^\s*$/u);
  assert.equal(snapshot.headerCellCount, 2);
  assert.equal(snapshot.bodyCellCount, 4);
});
