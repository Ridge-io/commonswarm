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

type HeadingMeasurement = {
  level: string;
  lines: number;
  text: string;
};

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const measurementScript = `<script>
  (async () => {
    await document.fonts.ready;
    await new Promise((resolve) => setTimeout(resolve, 50));
    const headings = Array.from(document.querySelectorAll("main h1, main h2, main h3, main h4, main h5, main h6"))
      .map((heading) => {
        const lineHeight = Number.parseFloat(getComputedStyle(heading).lineHeight);
        return {
          level: heading.tagName,
          lines: Math.round(heading.getBoundingClientRect().height / lineHeight),
          text: heading.textContent.replace(/\\s+/g, " ").trim(),
        };
      });
    document.documentElement.dataset.headingLines = btoa(unescape(encodeURIComponent(JSON.stringify(headings))));
  })();
</script>`;

const startDistServer = async (): Promise<{
  close(): Promise<void>;
  origin: string;
}> => {
  const server = createServer((request, response) => {
    const pathname = new URL(request.url ?? "/", "http://127.0.0.1").pathname;
    const relative = pathname === "/" ? "index.html" : pathname.replace(/^\/+/, "");
    const filePath = normalize(join(distRoot, relative));
    if (!filePath.startsWith(`${distRoot}/`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    try {
      if (relative === "index.html") {
        const html = readFileSync(filePath, "utf8")
          .replace("</body>", `${measurementScript}</body>`);
        response.writeHead(200, { "content-type": contentTypes[".html"] });
        response.end(html);
        return;
      }
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
): Promise<HeadingMeasurement[]> => {
  const { stdout } = await run(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--single-process",
    "--no-zygote",
    `--window-size=${width},1200`,
    "--virtual-time-budget=5000",
    "--dump-dom",
    origin,
  ], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
  const encoded = stdout.match(/data-heading-lines="([^"]+)"/)?.[1];
  assert.ok(encoded, `${width}px: headless Chrome did not return heading measurements`);
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as HeadingMeasurement[];
};

test("product previews are real labeled app views", () => {
  assert.equal(
    [...storySource.matchAll(/class="panel story__product-preview"/g)].length,
    3,
    "benefits must show the roster, Files panel, and workspace settings",
  );
  assert.equal(
    [...storySource.matchAll(/<svg\b[^>]*role="img"[^>]*aria-labelledby="[^"]+"/g)].length,
    3,
    "each product preview must name its title and description",
  );
  for (const sourceBoundary of [
    "participant-rail.ts",
    "file-list.ts",
    "workspace-settings.ts",
    "CLAUDE_D",
    "OPENAI_D",
    "GEMINI_D",
    "Close workspace",
    "Copy ID",
  ]) {
    assert.ok(
      storySource.includes(sourceBoundary),
      `product previews are missing ${sourceBoundary}`,
    );
  }
});

test("every homepage heading stays within two rendered lines", async () => {
  const chrome = await findChrome();
  const server = await startDistServer();
  try {
    for (const width of [1440, 1024, 390]) {
      const headings = await measureAt(chrome, server.origin, width);
      assert.ok(headings.length > 0, `${width}px: no headings found in main`);
      const failures = headings.filter((heading) => heading.lines > 2);
      assert.deepEqual(
        failures,
        [],
        `${width}px: headings over two lines:\n${failures.map((heading) => `${heading.level} ${heading.lines}L ${JSON.stringify(heading.text)}`).join("\n")}`,
      );
    }
  } finally {
    await server.close();
  }
});
