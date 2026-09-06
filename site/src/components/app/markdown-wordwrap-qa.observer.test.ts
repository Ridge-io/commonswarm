/** Reached by `npm --prefix site test` through the recursive component-observer glob.
 *
 * Backlog item 3 made two claims that landed without a measurement on the device the operator reads
 * on: "markdown spacing like Notion" and "wordwrap in the agent response box, light text at the
 * bottom, no scroll". This file is the measurement. It renders a fixed corpus
 * (`fixtures/markdown-qa/`) through the shipped renderer and the shipped stylesheet in real Chrome
 * at a phone width and a desktop width, in both themes, as a feed message and (fixtures 1 and 2) as
 * a brain topic, and turns every target in the spec's table
 * (`docs/design/2026-09-06-MARKDOWN-WORDWRAP-QA.md` §2.3) into a row with a measured value and a
 * verdict. The same rows are written to `docs/evidence/2026-09-06-markdown-qa/RESULTS.md`, so the
 * table in the evidence directory is the assertion set, not a copy of it.
 *
 * Targets are px at a 16px root. They are read off the shipped tokens in the loaded page
 * (`--s-1`, `--s-2`, `--s-3`, `--s-6`, `--lh-base`), and the spec's numbers (4, 8, 12, 24) are pinned
 * against those tokens once, so a token edit fails one assertion by name instead of moving every
 * target silently.
 *
 * Gaps are geometric: the top of the second block's border box minus the bottom of the first, so a
 * UA margin that collapses with an author margin is measured as what the reader sees, not as what
 * one declaration says. (`margin-block-start` alone would have read 12px on a heading whose UA
 * bottom margin was 24px.)
 *
 * Every family has a mutation control: a separate load of the shipped page with one override
 * `<style>` that breaks exactly that family, so a green row is evidence about the rule and not
 * about a fixture that happened to fit.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createReadStream, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { build } from "esbuild";
import { findChrome } from "./participant-rail.fixture.js";

const run = promisify(execFile);
const siteRoot = join(import.meta.dirname, "..", "..", "..");
const repoRoot = join(siteRoot, "..");
const distRoot = join(siteRoot, "dist");
const fixtureDir = join(import.meta.dirname, "fixtures", "markdown-qa");
const evidenceDir = join(repoRoot, "docs", "evidence", "2026-09-06-markdown-qa");

/** Spec §2.2: a phone and a desktop. */
const VIEWPORTS = [
  { name: "390", width: 390, height: 844 },
  { name: "1440", width: 1440, height: 900 },
] as const;
const THEMES = ["dark", "light"] as const;
type Surface = "feed" | "brain";
/** Spec §2.1: fixture 6 is a human step. Its file name is fixed here so the skip is by name. */
const OPERATOR_FIXTURE = "06-operator-longest-message.md";
/** Spec §2.1: fixtures 1 and 2 are also rendered as a brain topic. */
const BRAIN_FIXTURES = new Set(["01", "02"]);
/** Spec §2.3: gap targets in px, and the token each one is pinned to. */
const GAP_PX = { s1: 4, s2: 8, s3: 12, s6: 24 } as const;
const GAP_TOLERANCE_PX = 2;
/** Spec §2.3: `--lh-base: 1.62` at a 16px root. */
const ROOT_PX = 16;
const LH_BASE = 1.62;

interface Fixture {
  id: string;
  name: string;
  body: string;
}

const loadFixtures = (): Fixture[] => readdirSync(fixtureDir)
  .filter((name) => name.endsWith(".md"))
  .sort()
  .map((name) => ({
    id: name.slice(0, 2),
    name: name.replace(/\.md$/u, ""),
    body: readFileSync(join(fixtureDir, name), "utf8"),
  }));

const fixtures = loadFixtures();
const operatorFixtureSupplied = fixtures.some((fixture) => fixture.name === OPERATOR_FIXTURE.replace(/\.md$/u, ""));
if (!operatorFixtureSupplied) {
  console.log(
    `markdown-wordwrap-qa: fixture 6 (${OPERATOR_FIXTURE}) is not supplied; its rows read "not supplied". ` +
      "It is a human step: the operator's longest channel message of the last seven days, copied verbatim.",
  );
}

interface Render {
  fixture: Fixture;
  surface: Surface;
}

const renders: Render[] = fixtures.flatMap((fixture): Render[] => [
  { fixture, surface: "feed" },
  ...(BRAIN_FIXTURES.has(fixture.id) ? [{ fixture, surface: "brain" as const }] : []),
]);

interface Tokens { s1: number; s2: number; s3: number; s6: number; lhBase: number; rootPx: number }

interface Measurement {
  innerWidth: number;
  documentScrollWidth: number;
  tokens: Tokens;
  /** The markdown container, the article (feed only), and the row (feed only). */
  scrollers: Array<{ name: string; overflowY: string; scrollHeight: number; clientHeight: number }>;
  container: { clientWidth: number; scrollWidth: number };
  /** Every element inside the message whose content is wider than its box, except a table. */
  overflowing: string[];
  /** The table, when there is one: it may overflow inside its own box. */
  table: { clientWidth: number; scrollWidth: number; overflowX: string } | null;
  lineHeightPx: number;
  fontSizePx: number;
  /** Geometric gap between adjacent top-level blocks, named by the kinds of the two blocks. */
  gaps: Record<string, number>;
  /** Inner padding of the first fenced block. */
  codePaddingPx: number | null;
  /** The long-token paragraph: how many line boxes it took, and whether it stayed inside its box. */
  longToken: { lines: number; clientWidth: number; scrollWidth: number } | null;
  lastLine: {
    text: string;
    color: string;
    bodyColor: string;
    opacity: number;
    masks: string[];
  };
}

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/* The stylesheets the built /app page links, read off the built page so this measures the shipped
 * CSS: a renamed bundle follows automatically, and a build without the app stylesheet fails here
 * rather than measuring an unstyled message. */
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

/* One override per family. Each is a separate load of the shipped page with this <style> appended,
 * so the rows it breaks are the rows the shipped rule is responsible for. */
const CONTROL_CSS: Record<string, string> = {
  /* Breaks the paragraph gap: 12px becomes 40px, outside the ±2px tolerance. */
  gap: `
  .dashboard__message-markdown :where(p) + :where(p) { margin-block-start: 40px; }`,
  /* Breaks the prose wrap: the `p` rule's `break-word` (global.css) is turned off, so an
   * unbreakable token runs past the box. */
  wrap: `
  .dashboard__message-markdown p { overflow-wrap: normal; }`,
  /* Breaks the last-line check both ways: a gradient mask over the message and a faded last block. */
  fade: `
  .dashboard__message-markdown { mask-image: linear-gradient(#000 60%, transparent); }
  .dashboard__message-markdown > :last-child { opacity: 0.4; }`,
};

const surfaceMarkup = (surface: Surface): string => surface === "feed"
  ? `<ul style="list-style:none;margin:0;padding:0">
      <li class="dashboard__message">
        <span class="dashboard__message-avatar" aria-hidden="true">CS</span>
        <article class="dashboard__message-body">
          <header class="dashboard__message-meta"><strong>CSwarmStrategist</strong></header>
          <div class="dashboard__message-markdown" data-target></div>
        </article>
      </li>
    </ul>`
  : `<div class="dashboard__message-markdown dashboard__brain-markdown" data-target></div>`;

const fixturePage = (
  markdownScript: string,
  render: Render,
  viewportWidth: number,
  control: string,
): string => `<!doctype html>
<html>
  <head>
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <script>
      /* The shipped theme switch (tokens.css): data-theme on the root, before any stylesheet
         applies, so the first paint is already the requested theme. */
      const params = new URLSearchParams(location.search);
      document.documentElement.dataset.theme = params.get("theme") === "dark" ? "dark" : "light";
    </script>
    ${appStylesheets().map((href) => `<link rel="stylesheet" href="${href}">`).join("\n    ")}
    <style>
      html, body { margin: 0; padding: 0; }
      /* The message is the width of the viewport, which is what a phone gives it. */
      .harness { inline-size: ${viewportWidth}px; }
    </style>
    ${control ? `<style>${CONTROL_CSS[control] ?? ""}</style>` : ""}
  </head>
  <body>
    <div class="harness">${surfaceMarkup(render.surface)}</div>
    <script>${markdownScript}</script>
    <script>
      const host = document.querySelector("[data-target]");
      MessageMarkdown.setSanitizedMessageMarkdown(host, ${JSON.stringify(render.fixture.body)}, { headingOffset: 1 });
      const style = (node, property) => getComputedStyle(node).getPropertyValue(property);
      const px = (value) => Number.parseFloat(value);
      const rootPx = px(style(document.documentElement, "font-size"));
      const remPx = (property) => px(style(document.documentElement, property)) * rootPx;
      const kindOf = (node) => {
        const tag = node.tagName.toLowerCase();
        if (tag === "p") return "paragraph";
        if (tag === "ul" || tag === "ol") return "list";
        if (tag === "pre") return "code";
        if (tag === "blockquote") return "quote";
        if (tag === "table") return "table";
        if (/^h[1-6]$/.test(tag)) return "heading";
        return tag;
      };
      const gapBetween = (first, second) =>
        second.getBoundingClientRect().top - first.getBoundingClientRect().bottom;
      const gaps = {};
      const blocks = Array.from(host.children);
      blocks.forEach((block, index) => {
        const next = blocks[index + 1];
        if (!next) return;
        const name = kindOf(block) + "→" + kindOf(next);
        if (!(name in gaps)) gaps[name] = gapBetween(block, next);
      });
      const firstList = host.querySelector("ul, ol");
      if (firstList) {
        const items = Array.from(firstList.children).filter((child) => child.tagName === "LI");
        if (items.length > 1) gaps["item→item"] = gapBetween(items[0], items[1]);
        const nested = firstList.querySelector("li > ul, li > ol");
        if (nested) {
          const inner = Array.from(nested.children).filter((child) => child.tagName === "LI");
          if (inner.length > 1) gaps["item→item (nested)"] = gapBetween(inner[0], inner[1]);
        }
      }
      const isScroller = (name, node) => ({
        name,
        overflowY: style(node, "overflow-y"),
        scrollHeight: node.scrollHeight,
        clientHeight: node.clientHeight,
      });
      const scrollers = [isScroller("markdown", host)];
      const article = host.closest(".dashboard__message-body");
      const row = host.closest(".dashboard__message");
      if (article) scrollers.push(isScroller("article", article));
      if (row) scrollers.push(isScroller("row", row));
      const overflowing = [host, ...host.querySelectorAll("*")]
        .filter((node) => node.tagName !== "TABLE" && node.scrollWidth > node.clientWidth)
        .map((node) => node.tagName.toLowerCase());
      const table = host.querySelector("table");
      const firstParagraph = host.querySelector("p");
      const pre = host.querySelector("pre");
      /* The last line: the last non-blank text node, the lowest of its client rects, and the
         style of the element that holds it. Opacity is the product up to the container, and any
         mask on the way is recorded by the element that carries it. */
      const walker = document.createTreeWalker(host, NodeFilter.SHOW_TEXT);
      let lastText = null;
      for (let node = walker.nextNode(); node; node = walker.nextNode()) {
        if (node.textContent.trim()) lastText = node;
      }
      const range = document.createRange();
      range.selectNodeContents(lastText);
      const rects = Array.from(range.getClientRects());
      const lowest = rects.reduce((best, rect) => rect.bottom > best.bottom ? rect : best, rects[0]);
      const lineHolder = lastText.parentElement;
      let opacity = 1;
      const masks = [];
      for (let node = lineHolder; node; node = node.parentElement) {
        opacity *= px(style(node, "opacity"));
        const mask = style(node, "mask-image");
        const webkitMask = style(node, "-webkit-mask-image");
        if (mask && mask !== "none") masks.push(node.tagName.toLowerCase() + ":" + mask);
        else if (webkitMask && webkitMask !== "none") masks.push(node.tagName.toLowerCase() + ":" + webkitMask);
        if (node === host) break;
      }
      const longToken = ${JSON.stringify(render.fixture.id)} === "05" && firstParagraph
        ? {
            lines: Math.round(
              firstParagraph.getBoundingClientRect().height / px(style(firstParagraph, "line-height")),
            ),
            clientWidth: firstParagraph.clientWidth,
            scrollWidth: firstParagraph.scrollWidth,
          }
        : null;
      const measurement = {
        innerWidth: window.innerWidth,
        documentScrollWidth: document.documentElement.scrollWidth,
        tokens: {
          s1: remPx("--s-1"), s2: remPx("--s-2"), s3: remPx("--s-3"), s6: remPx("--s-6"),
          lhBase: px(style(document.documentElement, "--lh-base")),
          rootPx,
        },
        scrollers,
        container: { clientWidth: host.clientWidth, scrollWidth: host.scrollWidth },
        overflowing,
        table: table
          ? { clientWidth: table.clientWidth, scrollWidth: table.scrollWidth, overflowX: style(table, "overflow-x") }
          : null,
        lineHeightPx: firstParagraph ? px(style(firstParagraph, "line-height")) : px(style(host, "line-height")),
        fontSizePx: firstParagraph ? px(style(firstParagraph, "font-size")) : px(style(host, "font-size")),
        gaps,
        codePaddingPx: pre ? px(style(pre, "padding-top")) : null,
        longToken,
        lastLine: {
          text: lastText.textContent.trim().slice(-40),
          color: style(lineHolder, "color"),
          bodyColor: style(host, "color"),
          opacity,
          masks,
          bottom: lowest ? lowest.bottom : -1,
        },
      };
      /* Text can carry non-Latin-1 characters (the fixture arrow names), so encode as UTF-8 first. */
      document.documentElement.dataset.qaMeasurement = btoa(
        Array.from(new TextEncoder().encode(JSON.stringify(measurement)), (b) => String.fromCharCode(b)).join(""),
      );
    </script>
  </body>
</html>`;

interface Load {
  render: Render;
  viewport: (typeof VIEWPORTS)[number];
  theme: (typeof THEMES)[number];
  control: string;
}

const loadKey = (load: Load): string =>
  `${load.render.fixture.id}-${load.render.surface}-${load.viewport.name}-${load.theme}` +
  (load.control ? `-control:${load.control}` : "");

const shippedLoads: Load[] = renders.flatMap((render) =>
  VIEWPORTS.flatMap((viewport) => THEMES.map((theme) => ({ render, viewport, theme, control: "" }))));

/* The controls run at the phone width in dark on the fixture that carries the family's rows:
 * fixture 1 has the paragraph gap, fixture 5 has the long tokens, fixture 1 has a last line. */
const controlLoads: Load[] = [
  { family: "gap", fixtureId: "01" },
  { family: "wrap", fixtureId: "05" },
  { family: "fade", fixtureId: "01" },
].flatMap(({ family, fixtureId }) => {
  const render = renders.find((candidate) =>
    candidate.fixture.id === fixtureId && candidate.surface === "feed");
  return render ? [{ render, viewport: VIEWPORTS[0], theme: THEMES[0], control: family }] : [];
});

interface Harness {
  chrome: string;
  origin: string;
  markdownScript: string;
  close: () => Promise<void>;
}

const startHarness = async (): Promise<Harness> => {
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

  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__fixture") {
      const fixtureId = url.searchParams.get("fixture") ?? "";
      const surface: Surface = url.searchParams.get("surface") === "brain" ? "brain" : "feed";
      const width = Number.parseInt(url.searchParams.get("width") ?? "", 10);
      const render = renders.find((candidate) =>
        candidate.fixture.id === fixtureId && candidate.surface === surface);
      if (!render || !Number.isFinite(width)) {
        response.writeHead(404).end("No such fixture");
        return;
      }
      response.writeHead(200, { "content-type": contentTypes[".html"] });
      response.end(fixturePage(markdownScript, render, width, url.searchParams.get("control") ?? ""));
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
  assert.ok(address && typeof address !== "string", "the markdown-qa server must bind a port");
  return {
    chrome: await findChrome(),
    origin: `http://127.0.0.1:${address.port}`,
    markdownScript,
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
  };
};

const fixtureUrl = (harness: Harness, load: Load): string =>
  `${harness.origin}/__fixture?fixture=${load.render.fixture.id}&surface=${load.render.surface}` +
  `&width=${load.viewport.width}&theme=${load.theme}&control=${load.control}`;

const measureOne = async (harness: Harness, load: Load): Promise<Measurement> => {
  const { stdout, stderr } = await run(harness.chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--single-process",
    "--no-zygote",
    "--run-all-compositor-stages-before-draw",
    `--window-size=${load.viewport.width},${load.viewport.height}`,
    "--virtual-time-budget=8000",
    "--dump-dom",
    fixtureUrl(harness, load),
  ], { maxBuffer: 20 * 1024 * 1024, timeout: 30_000, killSignal: "SIGKILL" });
  const encoded = stdout.match(/data-qa-measurement="([^"]+)"/u)?.[1];
  assert.ok(
    encoded,
    `Chrome returned no measurement for ${loadKey(load)}\n` +
      `stderr: ${stderr.slice(-1_000)}\nDOM: ${stdout.slice(-2_000)}`,
  );
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Measurement;
};

/** A separate Chrome process per image, as the spec requires; the DOM run never screenshots. */
const screenshotOne = async (harness: Harness, load: Load, path: string): Promise<void> => {
  await run(harness.chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--single-process",
    "--no-zygote",
    "--hide-scrollbars",
    `--window-size=${load.viewport.width},${load.viewport.height}`,
    "--virtual-time-budget=5000",
    `--screenshot=${path}`,
    fixtureUrl(harness, load),
  ], { maxBuffer: 20 * 1024 * 1024, timeout: 30_000, killSignal: "SIGKILL" });
};

/* ---------------------------------------------------------------------------------------------
 * Rows. One evaluator turns a measurement into the spec's rows, and BOTH the assertions and the
 * RESULTS.md table read those rows, so the table cannot say PASS where the test says otherwise.
 * ------------------------------------------------------------------------------------------- */

type Family = "gap" | "wrap" | "scroll" | "light";

interface Row {
  key: string;
  fixture: string;
  surface: Surface;
  width: string;
  theme: string;
  measurement: string;
  measured: string;
  target: string;
  family: Family;
  pass: boolean;
}

const within = (measured: number, target: number): boolean =>
  Math.abs(measured - target) <= GAP_TOLERANCE_PX;

/** Spec §2.3, by pair. A heading is 24 above and 8 below; items are 4; everything else is 12. */
const gapTarget = (pair: string, tokens: Tokens): { px: number; token: string } => {
  if (pair.startsWith("item→item")) return { px: tokens.s1, token: "--s-1" };
  if (pair.endsWith("→heading")) return { px: tokens.s6, token: "--s-6" };
  if (pair.startsWith("heading→")) return { px: tokens.s2, token: "--s-2" };
  return { px: tokens.s3, token: "--s-3" };
};

const rowsFor = (load: Load, m: Measurement): Row[] => {
  const base = {
    fixture: load.render.fixture.name,
    surface: load.render.surface,
    width: load.viewport.name,
    theme: load.theme,
  };
  const row = (measurement: string, measured: string, target: string, family: Family, pass: boolean): Row =>
    ({ ...base, key: `${loadKey(load)}|${measurement}`, measurement, measured, target, family, pass });
  const rows: Row[] = [];
  const fmt = (n: number): string => `${Math.round(n * 100) / 100}`;

  for (const [pair, gap] of Object.entries(m.gaps)) {
    const target = gapTarget(pair, m.tokens);
    rows.push(row(`gap ${pair}`, `${fmt(gap)} px`, `${target.px} px ±${GAP_TOLERANCE_PX} (${target.token})`, "gap",
      within(gap, target.px)));
  }
  rows.push(row("line-height", `${fmt(m.lineHeightPx)} px`,
    `${fmt(m.tokens.rootPx * m.tokens.lhBase)} px (root × --lh-base)`, "gap",
    Math.abs(m.lineHeightPx - m.tokens.rootPx * m.tokens.lhBase) < 0.01));
  if (m.codePaddingPx !== null) {
    rows.push(row("code block inner padding", `${fmt(m.codePaddingPx)} px`,
      `${m.tokens.s3} px ±${GAP_TOLERANCE_PX} (--s-3)`, "gap", within(m.codePaddingPx, m.tokens.s3)));
  }

  rows.push(row("horizontal overflow (non-table elements)",
    m.overflowing.length === 0 ? "none" : m.overflowing.join(", "), "none", "wrap", m.overflowing.length === 0));
  rows.push(row("message box overflow", `scrollWidth ${m.container.scrollWidth} / clientWidth ${m.container.clientWidth}`,
    "equal", "wrap", m.container.scrollWidth === m.container.clientWidth));
  rows.push(row("page width", `${m.documentScrollWidth} px`, `≤ ${load.viewport.width} px`, "wrap",
    m.documentScrollWidth <= load.viewport.width));
  if (m.table) {
    rows.push(row("table is its own scroller", `overflow-x ${m.table.overflowX}`, "auto or scroll", "wrap",
      /^(auto|scroll)$/u.test(m.table.overflowX)));
  }
  if (m.longToken) {
    rows.push(row("long token wraps inside the message",
      `${m.longToken.lines} lines, scrollWidth ${m.longToken.scrollWidth} / clientWidth ${m.longToken.clientWidth}`,
      "> 1 line and no overflow", "wrap",
      m.longToken.lines > 1 && m.longToken.scrollWidth <= m.longToken.clientWidth));
  }

  for (const scroller of m.scrollers) {
    rows.push(row(`self-scroll (${scroller.name})`,
      `overflow-y ${scroller.overflowY}, scrollHeight ${scroller.scrollHeight} / clientHeight ${scroller.clientHeight}`,
      "not auto/scroll; scrollHeight ≤ clientHeight + 1", "scroll",
      !/^(auto|scroll)$/u.test(scroller.overflowY) && scroller.scrollHeight <= scroller.clientHeight + 1));
  }

  rows.push(row("last-line colour", m.lastLine.color, `body colour ${m.lastLine.bodyColor}`, "light",
    m.lastLine.color === m.lastLine.bodyColor));
  rows.push(row("last-line opacity", fmt(m.lastLine.opacity), "1", "light", m.lastLine.opacity === 1));
  rows.push(row("mask on an ancestor", m.lastLine.masks.length === 0 ? "none" : m.lastLine.masks.join("; "),
    "none", "light", m.lastLine.masks.length === 0));
  return rows;
};

interface Results {
  harness: Harness;
  shipped: Map<string, { load: Load; measurement: Measurement; rows: Row[] }>;
  controls: Map<string, { load: Load; measurement: Measurement; rows: Row[] }>;
}

const measureAll = async (): Promise<Results> => {
  const harness = await startHarness();
  const shipped = new Map<string, { load: Load; measurement: Measurement; rows: Row[] }>();
  const controls = new Map<string, { load: Load; measurement: Measurement; rows: Row[] }>();
  try {
    /* Sequential: the host runs many agents, and nothing here depends on loads overlapping. */
    for (const load of shippedLoads) {
      const measurement = await measureOne(harness, load);
      shipped.set(loadKey(load), { load, measurement, rows: rowsFor(load, measurement) });
    }
    for (const load of controlLoads) {
      const measurement = await measureOne(harness, load);
      controls.set(load.control, { load, measurement, rows: rowsFor(load, measurement) });
    }
  } catch (error) {
    /* A failed load must not leave the server open, or the test process never exits. */
    await harness.close();
    throw error;
  }
  return { harness, shipped, controls };
};

const resultsPromise = measureAll();
const allRows = async (): Promise<Row[]> =>
  [...(await resultsPromise).shipped.values()].flatMap((entry) => entry.rows);

const failuresIn = (rows: Row[], family: Family): string[] => rows
  .filter((r) => r.family === family && !r.pass)
  .map((r) => `${r.key}: measured ${r.measured}, target ${r.target}`);

test("the corpus renders at both widths in both themes with the requested viewport", async () => {
  const { shipped } = await resultsPromise;
  const expectedLoads = renders.length * VIEWPORTS.length * THEMES.length;
  assert.equal(shipped.size, expectedLoads, `expected ${expectedLoads} shipped loads`);
  for (const { load, measurement } of shipped.values()) {
    assert.ok(
      measurement.innerWidth > 0 && measurement.innerWidth <= load.viewport.width,
      `${loadKey(load)}: unexpected viewport ${measurement.innerWidth}`,
    );
  }
  /* Both themes really were applied: the body colour differs between them for the same render. */
  const dark = shipped.get(loadKey(shippedLoads[0]!));
  const light = shipped.get(loadKey({ ...shippedLoads[0]!, theme: "light" }));
  assert.ok(dark && light, "the first render must be measured in both themes");
  assert.notEqual(dark.measurement.lastLine.bodyColor, light.measurement.lastLine.bodyColor,
    "dark and light loads report the same body colour, so data-theme did not switch the palette");
});

test("the spec's pixel targets are the shipped tokens at a 16px root", async () => {
  const { shipped } = await resultsPromise;
  const [{ measurement }] = [...shipped.values()];
  assert.ok(measurement, "at least one load must be measured");
  assert.equal(measurement.tokens.rootPx, ROOT_PX);
  assert.equal(measurement.tokens.s1, GAP_PX.s1, "--s-1 must be 4px");
  assert.equal(measurement.tokens.s2, GAP_PX.s2, "--s-2 must be 8px");
  assert.equal(measurement.tokens.s3, GAP_PX.s3, "--s-3 must be 12px");
  assert.equal(measurement.tokens.s6, GAP_PX.s6, "--s-6 must be 24px");
  assert.equal(measurement.tokens.lhBase, LH_BASE, "--lh-base must be 1.62");
});

test("every fixture measures every pair the spec names", async () => {
  const { shipped } = await resultsPromise;
  /* A row that is not produced cannot fail, so the pairs each fixture must yield are pinned. */
  const required: Record<string, string[]> = {
    "01": ["paragraph→paragraph", "paragraph→list", "item→item", "item→item (nested)"],
    "02": ["paragraph→heading", "heading→paragraph", "paragraph→code", "code→paragraph"],
    "03": [],
    "04": ["quote→list"],
    "05": [],
  };
  for (const { load, measurement } of shipped.values()) {
    for (const pair of required[load.render.fixture.id] ?? []) {
      assert.ok(pair in measurement.gaps, `${loadKey(load)} produced no "${pair}" gap: ${JSON.stringify(measurement.gaps)}`);
    }
  }
  const withLongToken = [...shipped.values()].filter((entry) => entry.measurement.longToken);
  assert.equal(withLongToken.length, VIEWPORTS.length * THEMES.length, "fixture 5 must report its long-token paragraph");
});

test("block gaps: 12 between blocks, 4 between items, 24 above and 8 below a heading (±2 px)", async () => {
  const failures = failuresIn(await allRows(), "gap");
  assert.deepEqual(failures, [], `gap rows failed:\n${failures.join("\n")}`);
});

test("CONTROL: with the paragraph gap overridden to 40px the gap row fails", async () => {
  const { controls } = await resultsPromise;
  const control = controls.get("gap");
  assert.ok(control, "the gap control was not measured");
  const broken = control.rows.find((r) => r.measurement === "gap paragraph→paragraph");
  assert.ok(broken && !broken.pass, `the gap control did not fail its row: ${JSON.stringify(broken)}`);
  /* The override changed only that pair: the list gap on the same page still passes. */
  const untouched = control.rows.find((r) => r.measurement === "gap paragraph→list");
  assert.ok(untouched?.pass, `the gap control disturbed a row it did not target: ${JSON.stringify(untouched)}`);
});

test("wrap: no horizontal overflow at either width except inside a table's own box", async () => {
  const failures = failuresIn(await allRows(), "wrap");
  assert.deepEqual(failures, [], `wrap rows failed:\n${failures.join("\n")}`);
  /* The table exemption is used, not merely allowed: at 390 the 6×4 table is wider than the phone
   * and scrolls inside itself. Without this, "no overflow" could be a table that happened to fit. */
  const { shipped } = await resultsPromise;
  const phoneTable = [...shipped.values()]
    .find((entry) => entry.load.render.fixture.id === "03" && entry.load.viewport.name === "390");
  assert.ok(phoneTable?.measurement.table, "fixture 3 at 390 must render a table");
  assert.ok(
    phoneTable.measurement.table.scrollWidth > phoneTable.measurement.table.clientWidth,
    `the fixture-3 table is not wider than the phone: ${JSON.stringify(phoneTable.measurement.table)}`,
  );
});

test("CONTROL: with the p wrap rule overridden the long tokens run past the message", async () => {
  const { controls } = await resultsPromise;
  const control = controls.get("wrap");
  assert.ok(control, "the wrap control was not measured");
  const failed = control.rows.filter((r) => r.family === "wrap" && !r.pass).map((r) => r.measurement);
  assert.ok(
    failed.includes("long token wraps inside the message") && failed.includes("horizontal overflow (non-table elements)"),
    `the wrap control did not overflow: ${JSON.stringify(control.rows.filter((r) => r.family === "wrap"))}`,
  );
});

test("the message never scrolls inside itself", async () => {
  const failures = failuresIn(await allRows(), "scroll");
  assert.deepEqual(failures, [], `self-scroll rows failed:\n${failures.join("\n")}`);
});

test("the last line is body-coloured at full opacity with no mask on the way up", async () => {
  const failures = failuresIn(await allRows(), "light");
  assert.deepEqual(failures, [], `last-line rows failed:\n${failures.join("\n")}`);
});

test("CONTROL: with a gradient mask and a faded last block the last-line rows fail", async () => {
  const { controls } = await resultsPromise;
  const control = controls.get("fade");
  assert.ok(control, "the fade control was not measured");
  const failed = control.rows.filter((r) => r.family === "light" && !r.pass).map((r) => r.measurement);
  assert.ok(failed.includes("last-line opacity") && failed.includes("mask on an ancestor"),
    `the fade control did not fail its rows: ${JSON.stringify(control.rows.filter((r) => r.family === "light"))}`);
});

/* Last, after every assertion above: the evidence. The table is written from the same rows the
 * assertions read, and each screenshot is its own Chrome process against the same URL the DOM run
 * measured. */
test("RESULTS.md and the screenshots are written from the measured rows", async () => {
  const { harness, shipped, controls } = await resultsPromise;
  try {
    mkdirSync(evidenceDir, { recursive: true });
    const screenshots: string[] = [];
    for (const load of shippedLoads) {
      const name = `${load.render.fixture.id}-${load.render.surface}-${load.viewport.name}-${load.theme}.png`;
      await screenshotOne(harness, load, join(evidenceDir, name));
      assert.ok(statSync(join(evidenceDir, name)).size > 0, `screenshot ${name} is empty`);
      screenshots.push(name);
    }
    const expected = renders.length * VIEWPORTS.length * THEMES.length;
    assert.equal(screenshots.length, expected);

    const rows = [...shipped.values()].flatMap((entry) => entry.rows);
    const failing = rows.filter((r) => !r.pass);
    const lines: string[] = [
      "# Markdown spacing and wordwrap: measured results",
      "",
      "Generated by `site/src/components/app/markdown-wordwrap-qa.observer.test.ts` from real headless Chrome",
      `(${harness.chrome}) against the stylesheets linked by \`site/dist/app/index.html\`. Every number below was`,
      "measured on the loaded page; none was typed. Spec: `docs/design/2026-09-06-MARKDOWN-WORDWRAP-QA.md` §2.3.",
      "",
      `Loads: ${shipped.size} shipped (${renders.length} renders × ${VIEWPORTS.length} widths × ${THEMES.length} themes)`,
      `+ ${controls.size} mutation controls. Rows: ${rows.length}; PASS ${rows.length - failing.length}; FAIL ${failing.length}.`,
      `Screenshots: ${screenshots.length} (${screenshots[0]} … ${screenshots.at(-1)}).`,
      "",
      operatorFixtureSupplied
        ? `Fixture 6 (\`${OPERATOR_FIXTURE}\`): supplied.`
        : `Fixture 6 (\`${OPERATOR_FIXTURE}\`): **not supplied** — its rows and its 4 screenshots do not exist.`,
      "",
      "| fixture | surface | width | theme | measurement | measured | target | verdict |",
      "|---|---|---|---|---|---|---|---|",
      ...rows.map((r) =>
        `| ${r.fixture} | ${r.surface} | ${r.width} | ${r.theme} | ${r.measurement} | ${r.measured} | ${r.target} | ${r.pass ? "PASS" : "FAIL"} |`),
      "",
      "## Mutation controls (must FAIL, and do)",
      "",
      "| control | fixture | surface | width | theme | measurement | measured | target | verdict |",
      "|---|---|---|---|---|---|---|---|---|",
      ...[...controls.values()].flatMap(({ load, rows: controlRows }) => controlRows
        .filter((r) => !r.pass)
        .map((r) =>
          `| ${load.control} | ${r.fixture} | ${r.surface} | ${r.width} | ${r.theme} | ${r.measurement} | ${r.measured} | ${r.target} | FAIL (expected) |`)),
      "",
      "## Screenshots",
      "",
      ...screenshots.map((name) => `- \`${name}\``),
      "",
    ];
    writeFileSync(join(evidenceDir, "RESULTS.md"), lines.join("\n"), "utf8");
  } finally {
    await harness.close();
  }
});
