/*
 * Phone measurement for the To: field. Not shipped: run from the worktree root after
 * `cd site && npm run build`.
 *
 *   node docs/evidence/2026-09-05-composer-to/measure-mobile.mjs
 *
 * It serves site/dist with the same sample-mode rewrite the observer harness uses, then, at
 * each phone width, writes a screenshot and a measurement record beside this file.
 *
 * THE APP RUNS IN AN IFRAME SIZED TO THE PHONE, which is the instrument
 * mobile-feed-layout.observer.test.ts already uses for these two viewports and is not a
 * convenience: headless Chrome on macOS refuses a window narrower than 500px, so
 * `--window-size=390,844` reports a 500px viewport and would measure a layout no phone has.
 * The numbers below are read inside the iframe, so they are the phone's. The screenshots are
 * window-sized, so each one carries a blank gutter to the right of the phone.
 */
import { execFile } from "node:child_process";
import { createReadStream, readFileSync, statSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

const run = promisify(execFile);
const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(here, "..", "..", "..");
const distRoot = join(repoRoot, "site", "dist");
const VIEWPORTS = [[390, 844], [320, 568]];

const chrome = process.env.CHROME_BIN ??
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

const types = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const probe = `
  const waitFor = async (predicate) => {
    for (let attempt = 0; attempt < 200; attempt += 1) {
      if (predicate()) return true;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    return false;
  };
  const ready = await waitFor(() =>
    !document.querySelector("[data-composer]")?.hidden &&
    document.querySelectorAll("[data-feed-list] > li").length > 0 &&
    document.querySelector("[data-composer-to-note]")?.textContent !== "");
  const box = (selector) => {
    const el = document.querySelector(selector);
    if (!el) return null;
    const rect = el.getBoundingClientRect();
    return {
      top: +rect.top.toFixed(2), bottom: +rect.bottom.toFixed(2),
      left: +rect.left.toFixed(2), right: +rect.right.toFixed(2),
      height: +rect.height.toFixed(2), width: +rect.width.toFixed(2),
    };
  };
  const type = (value) => {
    const field = document.querySelector("[data-composer-input]");
    field.value = value;
    field.setSelectionRange(value.length, value.length);
    field.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText" }));
  };
  const chips = () => [...document.querySelectorAll("[data-composer-to-chip]")]
    .map((chip) => chip.querySelector("[data-composer-to-promote]")?.textContent ?? "");
  const snapshot = (label) => ({
    label,
    chips: chips(),
    note: document.querySelector("[data-composer-to-note]")?.textContent ?? "",
    toRow: box("[data-composer-to]"),
    composer: box("[data-composer]"),
    input: box(".dashboard__composer-input"),
    send: box("[data-composer-send]"),
    appBar: box("[data-channel-switch]") ?? box(".dashboard__channel-switch"),
    firstFeedRow: box("[data-feed-list] > li"),
  });
  const broadcast = snapshot("broadcast");
  type("as @Orbit said, ship it with @Kenji Ito");
  await new Promise((resolve) => setTimeout(resolve, 400));
  const twoChips = snapshot("two-recipients");
  return JSON.stringify({
    ready,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    devicePixelRatio: window.devicePixelRatio,
    broadcast,
    twoChips,
    insideViewport: {
      composer: twoChips.composer.bottom <= window.innerHeight + 0.1,
      send: twoChips.send.right <= window.innerWidth + 0.1 && twoChips.send.left >= -0.1,
      toRow: twoChips.toRow.right <= window.innerWidth + 0.1 && twoChips.toRow.left >= -0.1,
    },
    documentScrollsSideways: document.documentElement.scrollWidth > window.innerWidth,
  });
`;

const server = createServer((request, response) => {
  const url = new URL(request.url ?? "/", "http://127.0.0.1");
  /* THE PROBE RUNS INSIDE /app ITSELF. An outer wrapper page cannot reach the app's document
     at a phone width without an iframe, and an iframe is not the viewport being measured, so
     the app's own HTML is served with the probe appended to it. Same origin, same document,
     same layout the screenshot above captured. */
  if (url.pathname === "/__frame") {
    const probing = url.searchParams.get("probe") === "1";
    response.writeHead(200, { "content-type": types[".html"] });
    response.end(
      `<!doctype html><html><body style="margin:0;background:#fff">` +
        `<iframe src="${probing ? "/__probe" : "/app"}" width="${url.searchParams.get("w")}" ` +
        `height="${url.searchParams.get("h")}" style="border:0;display:block"></iframe>` +
        (probing
          ? `<script>
              const frame = document.querySelector("iframe");
              const lift = async () => {
                for (let attempt = 0; attempt < 400; attempt += 1) {
                  const value = frame.contentDocument?.documentElement?.dataset?.probe;
                  if (value) {
                    document.documentElement.dataset.probe = value;
                    return;
                  }
                  await new Promise((resolve) => setTimeout(resolve, 25));
                }
              };
              void lift();
            </script>`
          : "") +
        `</body></html>`,
    );
    return;
  }
  if (url.pathname === "/__probe") {
    const html = readFileSync(join(distRoot, "app", "index.html"), "utf8").replace(
      "</body>",
      `<script type="module">
        const result = await (async () => { ${probe} })();
        document.documentElement.dataset.probe = btoa(unescape(encodeURIComponent(result)));
      </script></body>`,
    );
    response.writeHead(200, {
      "content-length": Buffer.byteLength(html),
      "content-type": types[".html"],
    });
    response.end(html);
    return;
  }
  const relative = url.pathname === "/app" || url.pathname === "/app/"
    ? "app/index.html"
    : url.pathname.replace(/^\/+/, "");
  const filePath = normalize(join(distRoot, relative));
  if (!filePath.startsWith(`${distRoot}/`)) {
    response.writeHead(403).end("Forbidden");
    return;
  }
  try {
    const stat = statSync(filePath);
    if (!stat.isFile()) throw new Error("not a file");
    if (extname(filePath) === ".js") {
      let body = readFileSync(filePath, "utf8").replace(
        /PUBLIC_SUPABASE_URL:`https:\/\/api\.commonswarm\.com`/g,
        "PUBLIC_SUPABASE_URL:``",
      );
      response.writeHead(200, {
        "content-length": Buffer.byteLength(body),
        "content-type": types[".js"],
      });
      response.end(body);
      return;
    }
    response.writeHead(200, {
      "content-length": stat.size,
      "content-type": types[extname(filePath)] ?? "application/octet-stream",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    response.writeHead(404).end("Not found");
  }
});

const origin = await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", () => resolve(`http://127.0.0.1:${server.address().port}`));
});

const record = { measuredAt: new Date().toISOString(), origin: "site/dist, sample mode", viewports: {} };
for (const [width, height] of VIEWPORTS) {
  const name = `${width}x${height}`;
  const shot = join(here, `mobile-${name}.png`);
  await run(chrome, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    `--window-size=${width},${height}`,
    "--virtual-time-budget=9000",
    `--screenshot=${shot}`,
    `${origin}/__frame?w=${width}&h=${height}`,
  ], { maxBuffer: 40 * 1024 * 1024, timeout: 60_000 });
  const { stdout } = await run(chrome, [
    "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
    `--window-size=${width},${height}`,
    "--virtual-time-budget=9000",
    "--dump-dom",
    `${origin}/__frame?w=${width}&h=${height}&probe=1`,
  ], { maxBuffer: 40 * 1024 * 1024, timeout: 60_000 }).catch((error) => ({ stdout: String(error) }));
  const encoded = stdout.match(/data-probe="([^"]+)"/)?.[1];
  record.viewports[name] = {
    screenshot: `mobile-${name}.png`,
    measurement: encoded ? JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) : null,
  };
}
writeFileSync(join(here, "mobile-measurements.json"), `${JSON.stringify(record, null, 2)}\n`);
await new Promise((resolve) => server.close(resolve));
console.log(JSON.stringify(record, null, 2));
