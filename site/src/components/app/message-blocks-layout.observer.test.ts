/** Reached by `npm --prefix site test` through the recursive component-observer glob.
 *
 * The renderer gained a table, a rule, strikethrough, and task items. Every one of them is a NEW
 * element in the message body, and none of them had a single line of CSS: the pure renderer tests
 * assert the HTML string and cannot see that.
 *
 * A table is the one that costs a reader something. A table of SHAs is wider than a phone, and a
 * default `display: table` grows past the message and pushes the whole PAGE sideways -- every other
 * message moves with it and the composer leaves the viewport. So this measures the shipped
 * stylesheet, not a copy of it: the fixture links exactly the stylesheets `dist/app/index.html`
 * links, and the assertions read geometry out of a real layout.
 *
 * There are TWO controls, because the fix has two halves and either one alone does nothing. Each is
 * an iframe of the SAME fixture at the same width with one half reverted:
 *
 *   `table`: the scroll rule reverted. The table must then widen its own document.
 *   `wrap`:  the cell `overflow-wrap` reverted to the `anywhere` the message body sets. The table
 *            must then NOT scroll -- it squeezes each column down instead, which is the state
 *            measured before this lane: at 320px the table reported no overflow at all.
 *
 * Without them a green result above would say nothing about whether either rule produced it -- the
 * table might simply be narrow.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { build } from "esbuild";
import { findChrome } from "./participant-rail.fixture.js";

const run = promisify(execFile);
const siteRoot = join(import.meta.dirname, "..", "..", "..");
const distRoot = join(siteRoot, "dist");

const VIEWPORT_WIDTH = 320;
const VIEWPORT_HEIGHT = 568;

/* Wide enough that no phone can show it whole, and shaped like the tables agents actually post:
 * full-length SHAs and refs. The first column carries an alignment so the `align` attribute is
 * under measurement too. */
const WIDE_TABLE = [
  "| ref | commit | who | when |",
  "|:---:|---:|---|---|",
  ...Array.from({ length: 4 }, (_, row) =>
    `| refs/heads/production | ${"0123456789abcdef".repeat(2)}${row} ` +
    `| a-very-long-agent-name-${row} | 2026-09-04T19:0${row}:00Z |`),
].join("\n");

/* A rule, strikethrough, a task list with a plain item beside the task items, and a nested list.
 * Every construct this lane added, in one body, so one layout pass covers all of them. */
const BLOCKS = [
  "before",
  "---",
  "~~withdrawn~~ and kept",
  "",
  "- [ ] open task",
  "- [x] done task",
  "- plain item",
  "",
  "- outer",
  "  - inner",
].join("\n");

interface Measurement {
  /** The message box must not overflow: the table scrolls inside itself, not out of the message. */
  container: { clientWidth: number; scrollWidth: number };
  /** The table IS the scroller, so its own content is wider than its box. */
  table: { clientWidth: number; scrollWidth: number };
  /** Computed `overflow-x` on the table. `auto` or `scroll` is what makes it a scroller. */
  tableOverflowX: string;
  /** The `align` attribute must still decide the column, so no author rule may outrank it. */
  headerTextAligns: string[];
  bodyTextAligns: string[];
  /** The whole document at 320px. This is the claim "the page does not widen". */
  documentScrollWidth: number;
  innerWidth: number;
  /** Each control frame's OWN measurements, keyed by the half it reverted. */
  controls: Record<string, {
    documentScrollWidth: number;
    containerOverflows: boolean;
    tableScrolls: boolean;
  }>;
  /** A task item drops its bullet; a plain item in the same list keeps one. */
  taskListStyle: string;
  plainListStyle: string;
  /** No renderer output may be an input: a task item is a class and a ballot character. */
  inputCount: number;
  /** A rule renders as a line rather than collapsing to nothing. */
  ruleHeight: number;
  ruleWidth: number;
  /** Strikethrough is visibly struck. */
  delLineThrough: string;
}

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/* The stylesheets the built /app page links. Reading them off the built page rather than naming
 * them is what makes this a measurement of the shipped CSS: a renamed or added bundle follows
 * automatically, and a build that stopped emitting the app stylesheet fails the assertion below
 * instead of quietly measuring an unstyled table. */
const appStylesheets = (): string[] => {
  const page = readFileSync(join(distRoot, "app", "index.html"), "utf8");
  const hrefs = [...page.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/gu)]
    .map((match) => match[1] ?? "");
  assert.ok(
    hrefs.length > 0,
    "dist/app/index.html must link at least one stylesheet; run `npm --prefix site run build`",
  );
  return hrefs;
};

/* Reverts the one rule under test, and only that rule, back to what a table gets with no CSS at
 * all. `revert` would fall back to the UA sheet for `display` but the other two declarations do
 * not exist there, so they are written out as the values a plain table has. */
const REVERTED_CSS: Record<string, string> = {
  table: `
  .dashboard__message-markdown table {
    display: table;
    inline-size: auto;
    max-inline-size: none;
    overflow-x: visible;
  }`,
  /* What a cell inherits from `.dashboard__message-markdown` with no cell rule of its own. */
  wrap: `
  .dashboard__message-markdown :is(th, td) { overflow-wrap: anywhere; }`,
};

const fixturePage = (markdownScript: string, control: string, origin: string): string => `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    ${appStylesheets().map((href) => `<link rel="stylesheet" href="${href}">`).join("\n    ")}
    <style>
      html, body { margin: 0; padding: 0; }
      /* The message box is the width of the viewport, which is what a phone gives it. */
      .harness { inline-size: ${VIEWPORT_WIDTH}px; }
      iframe { display: block; border: 0; }
    </style>
    ${control ? `<style>${REVERTED_CSS[control] ?? ""}</style>` : ""}
  </head>
  <body>
    <div class="harness"><div class="dashboard__message-markdown" data-table></div></div>
    ${control ? "" : `<div class="harness"><div class="dashboard__message-markdown" data-blocks></div></div>
    ${Object.keys(REVERTED_CSS).map((name) => `<iframe title="reverted ${name} control" data-control="${name}"
      src="${origin}/__fixture?control=${name}" width="${VIEWPORT_WIDTH}" height="${VIEWPORT_HEIGHT}"></iframe>`).join("\n    ")}`}
    <script>${markdownScript}</script>
    <script>
      const tableHost = document.querySelector("[data-table]");
      MessageMarkdown.setSanitizedMessageMarkdown(tableHost, ${JSON.stringify(WIDE_TABLE)}, { headingOffset: 1 });
      const blocksHost = document.querySelector("[data-blocks]");
      if (blocksHost) {
        MessageMarkdown.setSanitizedMessageMarkdown(blocksHost, ${JSON.stringify(BLOCKS)}, { headingOffset: 1 });
      }
      const publish = () => {
        const table = tableHost.querySelector("table");
        const style = (node, property) => getComputedStyle(node).getPropertyValue(property);
        const controls = {};
        for (const frame of document.querySelectorAll("[data-control]")) {
          const frameDocument = frame.contentDocument;
          const container = frameDocument ? frameDocument.querySelector("[data-table]") : null;
          const controlTable = container ? container.querySelector("table") : null;
          controls[frame.dataset.control] = {
            documentScrollWidth: frameDocument
              ? frameDocument.documentElement.scrollWidth
              : -1,
            containerOverflows: container
              ? container.scrollWidth > container.clientWidth
              : false,
            tableScrolls: controlTable
              ? controlTable.scrollWidth > controlTable.clientWidth
              : false,
          };
        }
        const rule = blocksHost ? blocksHost.querySelector("hr") : null;
        const task = blocksHost ? blocksHost.querySelector("li.md-task") : null;
        const plain = blocksHost
          ? Array.from(blocksHost.querySelectorAll("li")).find((li) => !li.className)
          : null;
        const struck = blocksHost ? blocksHost.querySelector("del") : null;
        const measurement = {
          container: { clientWidth: tableHost.clientWidth, scrollWidth: tableHost.scrollWidth },
          table: table
            ? { clientWidth: table.clientWidth, scrollWidth: table.scrollWidth }
            : { clientWidth: -1, scrollWidth: -1 },
          tableOverflowX: table ? style(table, "overflow-x") : "NO TABLE",
          headerTextAligns: table
            ? Array.from(table.querySelectorAll("th")).map((cell) => style(cell, "text-align"))
            : [],
          bodyTextAligns: table
            ? Array.from(table.querySelectorAll("tbody tr:first-child td"))
                .map((cell) => style(cell, "text-align"))
            : [],
          documentScrollWidth: document.documentElement.scrollWidth,
          innerWidth: window.innerWidth,
          controls,
          taskListStyle: task ? style(task, "list-style-type") : "NO TASK ITEM",
          plainListStyle: plain ? style(plain, "list-style-type") : "NO PLAIN ITEM",
          inputCount: document.querySelectorAll("input").length,
          ruleHeight: rule ? rule.getBoundingClientRect().height : -1,
          ruleWidth: rule ? rule.getBoundingClientRect().width : -1,
          delLineThrough: struck ? style(struck, "text-decoration-line") : "NO DEL",
        };
        /* Every measured value is a number or a CSS keyword, so plain btoa is enough and the
           test does not need the deprecated escape/unescape pair to move it. */
        document.documentElement.dataset.blocksMeasurement = btoa(JSON.stringify(measurement));
      };
      const frames = Array.from(document.querySelectorAll("[data-control]"));
      if (frames.length === 0) publish();
      else {
        let pending = frames.length;
        const ready = () => { if (--pending === 0) publish(); };
        for (const frame of frames) {
          if (frame.contentDocument && frame.contentDocument.readyState === "complete") ready();
          else frame.addEventListener("load", ready, { once: true });
        }
      }
    </script>
  </body>
</html>`;

const measure = async (): Promise<Measurement> => {
  const bundle = await build({
    absWorkingDir: siteRoot,
    bundle: true,
    entryPoints: ["src/lib/message-markdown.ts"],
    format: "iife",
    globalName: "MessageMarkdown",
    platform: "browser",
    write: false,
  });
  const markdownScript = bundle.outputFiles[0]?.text;
  assert.ok(markdownScript, "the message renderer must bundle for its browser fixture");

  let origin = "";
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__fixture") {
      response.writeHead(200, { "content-type": contentTypes[".html"] });
      response.end(fixturePage(markdownScript, url.searchParams.get("control") ?? "", origin));
      return;
    }
    const filePath = normalize(join(distRoot, url.pathname.replace(/^\/+/u, "")));
    if (!filePath.startsWith(`${distRoot}/`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) throw new Error("not a file");
      response.writeHead(200, {
        "content-length": stat.size,
        "content-type": contentTypes[extname(filePath)] ?? "application/octet-stream",
      });
      createReadStream(filePath).pipe(response);
    } catch {
      response.writeHead(404).end("Not found");
    }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "the block-layout server must bind a port");
  origin = `http://127.0.0.1:${address.port}`;

  try {
    const chrome = await findChrome();
    const { stdout, stderr } = await run(chrome, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--single-process",
      "--no-zygote",
      "--run-all-compositor-stages-before-draw",
      `--window-size=${VIEWPORT_WIDTH},${VIEWPORT_HEIGHT}`,
      "--virtual-time-budget=8000",
      "--dump-dom",
      `${origin}/__fixture`,
    ], { maxBuffer: 20 * 1024 * 1024, timeout: 30_000, killSignal: "SIGKILL" });
    const encoded = stdout.match(/data-blocks-measurement="([^"]+)"/u)?.[1];
    assert.ok(
      encoded,
      `Chrome returned no block measurement\nstderr: ${stderr.slice(-1_000)}\n` +
        `DOM: ${stdout.slice(-2_000)}`,
    );
    return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Measurement;
  } finally {
    await new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    });
  }
};

const measurementPromise = measure();

test("a table wider than the phone scrolls inside itself and does not widen the page", async () => {
  const measurement = await measurementPromise;
  assert.ok(
    measurement.innerWidth > 0 && measurement.innerWidth <= VIEWPORT_WIDTH,
    `unexpected viewport: ${JSON.stringify(measurement)}`,
  );
  /* The table has to be wider than the box, or nothing below is a test of anything. */
  assert.ok(
    measurement.table.scrollWidth > measurement.table.clientWidth,
    `the fixture table is not wider than the viewport: ${JSON.stringify(measurement)}`,
  );
  assert.match(measurement.tableOverflowX, /^(auto|scroll)$/u);
  /* The message box does not overflow: the sideways travel is inside the table. */
  assert.equal(
    measurement.container.scrollWidth,
    measurement.container.clientWidth,
    `the message box overflows, so the table is not its own scroller: ${JSON.stringify(measurement)}`,
  );
  /* And the page itself stays the width of the phone. */
  assert.ok(
    measurement.documentScrollWidth <= VIEWPORT_WIDTH,
    `the page widened to ${measurement.documentScrollWidth}px at ${VIEWPORT_WIDTH}px`,
  );
});

test("CONTROL: with the scroll rule reverted the same table widens its document", async () => {
  const measurement = await measurementPromise;
  /* Reached through the shipped stylesheet with ONE half overridden, so a green test above is
   * evidence about that half rather than about a table that happened to fit. */
  const control = measurement.controls.table;
  assert.ok(control, `no table control was measured: ${JSON.stringify(measurement)}`);
  assert.ok(
    control.documentScrollWidth > VIEWPORT_WIDTH,
    `the control did not widen its document (${control.documentScrollWidth}px), so the passing ` +
      "case above is not attributable to the scroll rule",
  );
  assert.equal(control.containerOverflows, true);
  assert.equal(control.tableScrolls, false);
});

test("CONTROL: with the cell wrap rule reverted the table squeezes instead of scrolling", async () => {
  const measurement = await measurementPromise;
  /* The state before this lane. `overflow-wrap: anywhere` is inherited from the message body, a
   * cell can then shrink to almost nothing, and the table always fits: no overflow, no scroll,
   * and a column of SHAs three characters wide. The scroll rule alone cannot produce the passing
   * case above, which is what this control establishes. */
  const control = measurement.controls.wrap;
  assert.ok(control, `no wrap control was measured: ${JSON.stringify(measurement)}`);
  assert.equal(
    control.tableScrolls,
    false,
    "with `anywhere` restored the table still scrolled, so the cell rule is not what makes it",
  );
  assert.ok(control.documentScrollWidth <= VIEWPORT_WIDTH);
});

test("the align attribute still decides a column, so no cell rule outranks it", async () => {
  const measurement = await measurementPromise;
  /* `align` is a presentational hint and ANY author `text-align` on a cell beats it. A rule added
   * to the stylesheet for tidiness would delete the alignment feature without failing one string
   * assertion in the pure tests, so the computed value is pinned here.
   *
   * Each assertion is chosen so the UA default cannot satisfy it: a `th` already centres, so the
   * header is checked on the RIGHT-aligned column; a `td` already starts, so the body is checked
   * on the centred and right columns. The last pair are the columns the delimiter row left
   * unaligned, and they must read as neither. */
  /* Chrome computes the attribute's mapping as `-webkit-right` / `-webkit-center`, so match the
   * keyword rather than the exact string; the distinction under test is which edge, not the
   * vendor prefix. */
  assert.match(measurement.headerTextAligns[1] ?? "", /right$/u, JSON.stringify(measurement));
  assert.match(measurement.bodyTextAligns[0] ?? "", /center$/u, JSON.stringify(measurement));
  assert.match(measurement.bodyTextAligns[1] ?? "", /right$/u);
  for (const align of measurement.bodyTextAligns.slice(2)) {
    assert.doesNotMatch(align, /center$|right$/u, `unaligned column reads as ${align}`);
  }
});

test("a task item drops its bullet, a plain item beside it keeps one, and neither is an input", async () => {
  const measurement = await measurementPromise;
  assert.equal(measurement.taskListStyle, "none");
  /* The positive half: the rule is scoped to task items, so an ordinary item is untouched. */
  assert.notEqual(measurement.plainListStyle, "none");
  assert.equal(measurement.inputCount, 0);
});

test("a rule is a visible line and strikethrough is struck through", async () => {
  const measurement = await measurementPromise;
  assert.ok(
    measurement.ruleHeight >= 1 && measurement.ruleWidth > 100,
    `the rule did not render as a line: ${JSON.stringify(measurement)}`,
  );
  assert.equal(measurement.delLineThrough, "line-through");
});
