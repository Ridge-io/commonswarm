import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
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

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const startDistServer = async (): Promise<{
  close(): Promise<void>;
  origin: string;
}> => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    if (pathname === "/__measure") {
      const width = Number(url.searchParams.get("width"));
      if (!Number.isInteger(width) || width < 1 || width > 2000) {
        response.writeHead(400).end("Bad width");
        return;
      }
      const observer = `<!doctype html>
        <html><head><meta charset="utf-8"><style>
          html, body { margin: 0; }
          iframe { display: block; width: ${width}px; height: 1000px; border: 0; }
        </style></head><body>
          <iframe src="/" title="${width}px homepage observer"></iframe>
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
        </body></html>`;
      response.writeHead(200, { "content-type": contentTypes[".html"] });
      response.end(observer);
      return;
    }
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = normalize(join(distRoot, relative));
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
  assert.ok(address && typeof address !== "string", "HTTP observer server must bind a port");
  return {
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
    origin: `http://127.0.0.1:${address.port}`,
  };
};

const measureAt = async (
  chrome: string,
  origin: string,
  width: number,
): Promise<LayoutMeasurement> => {
  const { stdout } = await run(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--single-process",
    "--no-zygote",
    `--window-size=${Math.max(width + 32, 800)},1200`,
    "--virtual-time-budget=5000",
    "--dump-dom",
    `${origin}/__measure?width=${width}`,
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
    // Six since the duplicate "two ways in" section was deleted: it repeated the setup
    // steps and carried two door illustrations that proved nothing new.
    6,
    "every story illustration must have an accessible name and description",
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
    assert.ok(
      storySource.includes(sourceBoundary),
      `product previews are missing ${sourceBoundary}`,
    );
  }
  for (const retiredSurface of ["Workspace settings", "Close workspace", "No process"]) {
    assert.equal(
      storySource.includes(retiredSurface),
      false,
      `retired homepage surface is still present: ${retiredSurface}`,
    );
  }
});

test("every homepage heading stays within two rendered lines", async () => {
  const chrome = await findChrome();
  const server = await startDistServer();
  try {
    for (const width of [1440, 1024, 390]) {
      const report = await measureAt(chrome, server.origin, width);
      assert.equal(report.viewportWidth, width, `${width}px: observer viewport was clamped`);
      assert.ok(
        report.scrollWidth <= report.clientWidth,
        `${width}px: horizontal overflow (${report.scrollWidth}px > ${report.clientWidth}px)`,
      );
      const headings = report.headings;
      assert.ok(headings.length > 0, `${width}px: no headings found in main`);
      const failures = headings.filter((heading) => heading.lines > 2);
      assert.deepEqual(
        failures,
        [],
        `${width}px: headings over two lines:\n${failures.map((heading) => `${heading.level} ${heading.lines}L ${JSON.stringify(heading.text)}`).join("\n")}`,
      );
      console.log(
        `${width}px heading lines: ${headings.map((heading) => `${heading.lines}L ${heading.text}`).join(" | ")}`,
      );
    }
  } finally {
    await server.close();
  }
});
