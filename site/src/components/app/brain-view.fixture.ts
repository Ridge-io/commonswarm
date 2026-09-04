import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { HOSTILE_MARKDOWN_BLOCKS } from "../../lib/message-markdown-fixtures.js";
import { findChrome } from "./participant-rail.fixture.js";

const run = promisify(execFile);
const componentDir = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(componentDir, "..", "..", "..");

export const BRAIN_BODY_MARKDOWN = [
  "# Architecture",
  "## Working agreement",
  "### Read path",
  "#### Details",
  "- versioned\n- shared",
  "1. Read\n2. Write",
  "Use `cswarm brain get architecture` and [the guide](https://example.com/guide).",
  '```ts\nconst safe = "<tag>";\n```',
  "| left | right |\n| --- | --- |",
  "![diagram](https://example.com/diagram.png)",
  HOSTILE_MARKDOWN_BLOCKS,
].join("\n\n").replaceAll("\n", "\r\n") + "  ";

const BOUNDED_BRAIN_MARKDOWN =
  `${"> ".repeat(12)}bottom\n` + Array.from({ length: 9_999 }, () => "line").join("\n");

export interface BrainViewSnapshot {
  paneClosedOnForeignFile: boolean;
  staleSaveRefused: boolean;
  boundedBlockquoteCount: number;
  boundedBreakCount: number;
  boundedHtmlLength: number;
  boundedShortened: boolean;
  dangerousElementCount: number;
  defaultRendered: boolean;
  historyCount: number;
  linkRel: string;
  linkTarget: string;
  listDetails: string[];
  listTopics: string[];
  panelLabel: string;
  rawModeShown: boolean;
  rawText: string;
  renderedHtml: string;
  saveCount: number;
  savedMarkdown: string;
  status: string;
  title: string;
  versionAfterSave: string;
}

/** Bundles the live brain controller and runs its list/read/edit flow in Chrome. */
export async function runBrainViewFixture(): Promise<BrainViewSnapshot> {
  const directory = await mkdtemp(join(tmpdir(), "commonswarm-brain-view-"));
  const fixture = join(directory, "index.html");
  const bundle = await build({
    absWorkingDir: siteRoot,
    bundle: true,
    entryPoints: ["src/lib/brain-view.ts"],
    format: "iife",
    globalName: "BrainView",
    platform: "browser",
    write: false,
  });
  const script = bundle.outputFiles[0]?.text;
  assert.ok(script, "the live brain controller must bundle for its browser fixture");
  const files = [
    {
      fileId: "10000000-0000-4000-8000-000000000001",
      name: "brain--architecture.md",
      currentVersion: 2,
      sizeBytes: 64,
      uploadedByKind: "agent",
      uploadedBy: "20000000-0000-4000-8000-000000000001",
      committedAt: "2026-08-31T16:00:00.000Z",
      tombstonedAt: null,
    },
    {
      fileId: "10000000-0000-4000-8000-000000000002",
      name: "ordinary-plan.md",
      currentVersion: 4,
      sizeBytes: 128,
      uploadedByKind: "user",
      uploadedBy: "30000000-0000-4000-8000-000000000001",
      committedAt: "2026-08-31T15:00:00.000Z",
      tombstonedAt: null,
    },
  ];
  const html = `<!doctype html>
<html>
  <body>
    <ul data-brain-list hidden></ul>
    <p data-brain-empty></p>
    <article data-brain-detail hidden>
      <h2 data-brain-title></h2><p data-brain-meta></p>
      <p data-brain-error hidden></p>
      <p data-brain-body-mode hidden>
        <span>Rendered from markdown</span> ·
        <button type="button" aria-pressed="false" data-brain-raw-toggle disabled>Raw</button>
      </p>
      <div data-brain-markdown></div>
      <pre data-brain-raw hidden></pre>
      <button type="button" data-brain-edit>Edit</button>
      <form data-brain-form hidden>
        <textarea data-brain-textarea></textarea>
        <button type="submit" data-brain-save>Save new version</button>
        <button type="button" data-brain-cancel>Cancel</button>
      </form>
      <p data-brain-status></p>
      <details data-brain-history><summary>Version history</summary><ul data-brain-history-list></ul></details>
    </article>
    <script>${script}</script>
    <script>
      window.alert = () => {};
      (async () => {
        const one = (selector) => document.querySelector(selector);
        const targets = {
          list: one("[data-brain-list]"), empty: one("[data-brain-empty]"),
          detail: one("[data-brain-detail]"), title: one("[data-brain-title]"),
          meta: one("[data-brain-meta]"), bodyMode: one("[data-brain-body-mode]"),
          markdown: one("[data-brain-markdown]"), raw: one("[data-brain-raw]"),
          rawToggle: one("[data-brain-raw-toggle]"),
          error: one("[data-brain-error]"), edit: one("[data-brain-edit]"),
          form: one("[data-brain-form]"), textarea: one("[data-brain-textarea]"),
          save: one("[data-brain-save]"), cancel: one("[data-brain-cancel]"),
          status: one("[data-brain-status]"), history: one("[data-brain-history]"),
          historyList: one("[data-brain-history-list]"),
        };
        const contents = new Map([
          [1, ${JSON.stringify(BOUNDED_BRAIN_MARKDOWN)}],
          [2, ${JSON.stringify(BRAIN_BODY_MARKDOWN)}],
        ]);
        const saves = [];
        const topics = BrainView.brainTopics(${JSON.stringify(files)}, () => "Atlas");
        const view = BrainView.createBrainView(targets, {
          now: Date.parse("2026-08-31T18:00:00.000Z"),
          read: async (_topic, version) => contents.get(version) || "# older",
          save: async (topic, markdown) => {
            saves.push(markdown);
            const saved = {
              ...topic,
              currentVersion: topic.currentVersion + 1,
              committedAt: "2026-08-31T18:00:00.000Z",
              updaterName: "Dana",
            };
            contents.set(saved.currentVersion, markdown);
            return saved;
          },
        });
        view.setTopics(topics);
        const initialTopics = Array.from(document.querySelectorAll("[data-brain-topic]"), (node) => node.querySelector("strong").textContent);
        const initialDetails = Array.from(document.querySelectorAll("[data-brain-topic]"), (node) => node.querySelector("span").textContent);
        await view.open("architecture");
        const rendered = one("[data-brain-markdown]");
        const raw = one("[data-brain-raw]");
        const rawToggle = one("[data-brain-raw-toggle]");
        const defaultRendered = !rendered.hidden && raw.hidden && rawToggle.getAttribute("aria-pressed") === "false";
        const renderedHtml = rendered.innerHTML;
        const dangerousElementCount = rendered.querySelectorAll("img, script, iframe, [onerror]").length;
        const safeLink = rendered.querySelector('a[href="https://example.com/guide"]');
        const linkRel = safeLink?.rel || "";
        const linkTarget = safeLink?.target || "";
        const panelLabel = one("[data-brain-body-mode]").textContent.replace(/\\s+/g, " ").trim();
        rawToggle.click();
        const rawText = raw.textContent;
        const rawModeShown = rendered.hidden && !raw.hidden && rawToggle.getAttribute("aria-pressed") === "true";
        rawToggle.click();
        one("[data-brain-edit]").click();
        one("[data-brain-textarea]").value = "**File layer**\\n\\nUse the existing file verbs.\\n\\n<img src=x>";
        one("[data-brain-form]").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        await new Promise((resolve) => setTimeout(resolve, 0));
        const statusAfterSave = one("[data-brain-status]").textContent;
        const metaAfterSave = one("[data-brain-meta]").textContent;
        await view.open("architecture", 1);
        const boundedBlockquoteCount = one("[data-brain-markdown]").querySelectorAll("blockquote").length;
        const boundedBreakCount = one("[data-brain-markdown]").querySelectorAll("br").length;
        const boundedHtmlLength = one("[data-brain-markdown]").innerHTML.length;
        const boundedShortened = one("[data-brain-markdown]").textContent.includes("Message shortened for safe display.");
        /* Workspace-switch counterexample from the a0b6734 review: same slug,
           DIFFERENT fileId (workspace B). The pane must close, and a save with
           stale state must refuse. */
        const foreignTopics = topics.map((topic) => ({ ...topic, fileId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb" }));
        const savesBeforeSwitch = saves.length;
        one("[data-brain-edit]").click();
        one("[data-brain-textarea]").value = "workspace A secret";
        view.setTopics(foreignTopics);
        const paneClosedOnForeignFile = one("[data-brain-detail]").hidden && one("[data-brain-form]").hidden;
        one("[data-brain-form]").dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
        await new Promise((resolve) => setTimeout(resolve, 0));
        const staleSaveRefused = saves.length === savesBeforeSwitch;
        const snapshot = {
          paneClosedOnForeignFile,
          staleSaveRefused,
          boundedBlockquoteCount,
          boundedBreakCount,
          boundedHtmlLength,
          boundedShortened,
          dangerousElementCount,
          defaultRendered,
          historyCount: document.querySelectorAll("[data-brain-history-list] a").length,
          linkRel,
          linkTarget,
          listDetails: initialDetails,
          listTopics: initialTopics,
          panelLabel,
          rawModeShown,
          rawText,
          renderedHtml,
          saveCount: saves.length,
          savedMarkdown: saves[0] || "",
          status: statusAfterSave,
          title: one("[data-brain-title]").textContent,
          versionAfterSave: metaAfterSave,
        };
        document.documentElement.dataset.fixture = encodeURIComponent(JSON.stringify(snapshot));
      })();
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
    ], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 15_000,
      killSignal: "SIGKILL",
    });
    const encoded = stdout.match(/data-fixture="([^"]+)"/)?.[1];
    assert.ok(encoded, "headless Chrome must return the live brain-view snapshot");
    return JSON.parse(decodeURIComponent(encoded)) as BrainViewSnapshot;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
