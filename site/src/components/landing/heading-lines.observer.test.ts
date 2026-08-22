import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { findChrome } from "../app/participant-rail.fixture.js";

const run = promisify(execFile);
const siteRoot = join(import.meta.dirname, "..", "..", "..");
const distRoot = join(siteRoot, "dist");
const storySource = readFileSync(join(import.meta.dirname, "ConsumerStory.astro"), "utf8");
const heroSource = readFileSync(join(import.meta.dirname, "ConsumerHero.astro"), "utf8");

type HeadingMeasurement = {
  level: string;
  lines: number;
  text: string;
};

type LayoutMeasurement = {
  clientWidth: number;
  headings: HeadingMeasurement[];
  scrollWidth: number;
  viewportWidth: number;
};

const inlineBuiltStyles = (html: string): string =>
  html.replace(
    /<link rel="stylesheet" href="\/(?:_astro\/)?([^"]+\.css)">/g,
    (_tag, relative: string) => {
      const cssPath = relative.startsWith("_astro/")
        ? join(distRoot, relative)
        : join(distRoot, "_astro", relative);
      const fontsUrl = `${pathToFileURL(join(distRoot, "fonts")).href}/`;
      const css = readFileSync(cssPath, "utf8")
        .replaceAll('url("/fonts/', `url("${fontsUrl}`)
        .replaceAll("url('/fonts/", `url('${fontsUrl}`)
        .replaceAll("url(/fonts/", `url(${fontsUrl}`);
      return `<style>${css}</style>`;
    },
  );

const measureAt = async (
  chrome: string,
  tempRoot: string,
  pageUrl: string,
  width: number,
): Promise<LayoutMeasurement> => {
  const observerPath = join(tempRoot, `observer-${width}.html`);
  writeFileSync(observerPath, `<!doctype html>
    <html><head><meta charset="utf-8"><style>
      html, body { margin: 0; }
      iframe { display: block; width: ${width}px; height: 1000px; border: 0; }
    </style></head><body>
      <iframe src="${pageUrl}" title="${width}px homepage observer"></iframe>
      <script>
        const frame = document.querySelector("iframe");
        frame.addEventListener("load", async () => {
          const page = frame.contentDocument;
          await page.fonts.ready;
          await new Promise((resolve) => setTimeout(resolve, 50));
          const headings = Array.from(page.querySelectorAll("main h1, main h2, main h3, main h4, main h5, main h6"))
            .map((heading) => {
              const lineHeight = Number.parseFloat(frame.contentWindow.getComputedStyle(heading).lineHeight);
              return {
                level: heading.tagName,
                lines: Math.round(heading.getBoundingClientRect().height / lineHeight),
                text: heading.textContent.replace(/\\s+/g, " ").trim(),
              };
            });
          const root = page.documentElement;
          const report = {
            clientWidth: root.clientWidth,
            headings,
            scrollWidth: root.scrollWidth,
            viewportWidth: frame.contentWindow.innerWidth,
          };
          document.documentElement.dataset.headingReport = btoa(unescape(encodeURIComponent(JSON.stringify(report))));
        });
      </script>
    </body></html>`);

  const { stdout } = await run(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--single-process",
    "--no-zygote",
    "--allow-file-access-from-files",
    `--window-size=${Math.max(width + 32, 800)},1200`,
    "--virtual-time-budget=5000",
    "--dump-dom",
    pathToFileURL(observerPath).href,
  ], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
  const encoded = stdout.match(/data-heading-report="([^"]+)"/)?.[1];
  assert.ok(encoded, `${width}px: headless Chrome did not return heading measurements`);
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as LayoutMeasurement;
};

test("story illustrations are labeled and app previews match real views", () => {
  assert.equal(
    [...storySource.matchAll(/class="panel story__app-preview"/g)].length,
    2,
    "the roster and Files panel must sit beside the claims they prove",
  );
  assert.equal(
    [...storySource.matchAll(/<svg\b[^>]*role="img"[^>]*aria-labelledby="[^"]+"/g)].length,
    6,
    "the mechanism, roster, files, and setup illustrations must be accessible",
  );
  assert.equal(
    [...heroSource.matchAll(/<svg\b[^>]*role="img"[^>]*aria-labelledby="[^"]+"/g)].length,
    1,
    "the relay diagram must have an accessible name and description",
  );
  for (const sourceBoundary of [
    "participant-rail.ts",
    "file-list.ts",
    "CLAUDE_D",
    "OPENAI_D",
    "GEMINI_D",
    "Download",
    "joined by link",
  ]) {
    assert.ok(storySource.includes(sourceBoundary), `product previews are missing ${sourceBoundary}`);
  }
  for (const retiredSurface of ["Workspace settings", "Close workspace", "No process"]) {
    assert.equal(storySource.includes(retiredSurface), false, `retired homepage surface is still present: ${retiredSurface}`);
  }
});

test("every homepage heading stays within two rendered lines", async () => {
  const chrome = await findChrome();
  const tempRoot = mkdtempSync(join(tmpdir(), "commonswarm-heading-lines-"));
  try {
    const pagePath = join(tempRoot, "index.html");
    writeFileSync(pagePath, inlineBuiltStyles(readFileSync(join(distRoot, "index.html"), "utf8")));
    const pageUrl = pathToFileURL(pagePath).href;

    for (const width of [1440, 1024, 390]) {
      const report = await measureAt(chrome, tempRoot, pageUrl, width);
      assert.equal(report.viewportWidth, width, `${width}px: observer viewport was clamped`);
      assert.ok(
        report.scrollWidth <= report.clientWidth,
        `${width}px: horizontal overflow (${report.scrollWidth}px > ${report.clientWidth}px)`,
      );
      assert.ok(report.headings.length > 0, `${width}px: no headings found in main`);
      const failures = report.headings.filter((heading) => heading.lines > 2);
      assert.deepEqual(
        failures,
        [],
        `${width}px: headings over two lines:\n${failures.map((heading) => `${heading.level} ${heading.lines}L ${JSON.stringify(heading.text)}`).join("\n")}`,
      );
      console.log(
        `${width}px heading lines: ${report.headings.map((heading) => `${heading.lines}L ${heading.text}`).join(" | ")}`,
      );
    }
  } finally {
    rmSync(tempRoot, { recursive: true, force: true });
  }
});
