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

type PageMeasurement = {
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
    document.documentElement.dataset.pageMeasurement = btoa(unescape(encodeURIComponent(JSON.stringify({
      clientWidth: document.documentElement.clientWidth,
      headings,
      scrollWidth: document.documentElement.scrollWidth,
      viewportWidth: window.innerWidth,
    }))));
  })();
</script>`;

const frameScript = `<script>
  const frame = document.querySelector("iframe");
  const copyMeasurement = () => {
    const measurement = frame.contentDocument?.documentElement.dataset.pageMeasurement;
    if (measurement) {
      document.documentElement.dataset.pageMeasurement = measurement;
      return;
    }
    setTimeout(copyMeasurement, 10);
  };
  frame.addEventListener("load", copyMeasurement);
  copyMeasurement();
</script>`;

const startDistServer = async (): Promise<{
  close(): Promise<void>;
  origin: string;
}> => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const pathname = url.pathname;
    if (pathname === "/__measure") {
      const width = Number.parseInt(url.searchParams.get("width") ?? "", 10);
      if (!Number.isSafeInteger(width) || width <= 0) {
        response.writeHead(400).end("Invalid width");
        return;
      }
      response.writeHead(200, { "content-type": contentTypes[".html"] });
      response.end(`<!doctype html><html><body><iframe title="Measurement viewport" src="/" style="border:0;width:${width}px;height:1200px"></iframe>${frameScript}</body></html>`);
      return;
    }
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
): Promise<PageMeasurement> => {
  const { stdout } = await run(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--single-process",
    "--no-zygote",
    "--window-size=1600,1400",
    "--virtual-time-budget=5000",
    "--dump-dom",
    `${origin}/__measure?width=${width}`,
  ], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
  const encoded = stdout.match(/data-page-measurement="([^"]+)"/)?.[1];
  assert.ok(encoded, `${width}px: headless Chrome did not return page measurements`);
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as PageMeasurement;
};

test("story svgs are labeled and retired surfaces stay gone", () => {
  /* 2026-08-22, operator directive: the landing page follows the supplied plain
   * copy — no illustration panels, no product comparisons. The old pins on the
   * roster/Files preview panels and their source markers are retired WITH those
   * panels. What survives: any SVG that does exist must be accessible, and the
   * retired surfaces must never return. */
  const svgs = [...storySource.matchAll(/<svg\b[^>]*>/g)];
  for (const svg of svgs) {
    assert.ok(
      /role="img"/.test(svg[0]) && /aria-labelledby="[^"]+"/.test(svg[0]),
      `story SVG without accessible name: ${svg[0].slice(0, 80)}`,
    );
  }
  for (const retiredSurface of [
    "Workspace settings",
    "Close workspace",
    "No process",
    // Comparison strip retired by the same directive — must not return.
    "Slack is a room for people.",
    "GitHub records commits, reviews, and issues after the work.",
  ]) {
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
      const measurement = await measureAt(chrome, server.origin, width);
      assert.equal(measurement.viewportWidth, width, `${width}px: iframe viewport width drifted`);
      assert.ok(
        measurement.scrollWidth <= measurement.clientWidth + 1,
        `${width}px: horizontal overflow (${measurement.scrollWidth}px > ${measurement.clientWidth}px)`,
      );
      const { headings } = measurement;
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
