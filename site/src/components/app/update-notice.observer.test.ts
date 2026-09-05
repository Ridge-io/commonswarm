/**
 * The in-app update notice, driven in a real browser. Reached by `npm --prefix site test`
 * through the recursive component-observer glob.
 *
 * WHAT MAKES THIS A CONTROL AND NOT A DEMO. The page decides by comparing what it is RUNNING
 * against what the server returns for its own URL. So the server here answers the two requests
 * differently on purpose: the DOCUMENT load always gets the real built page, and the page's own
 * POLL gets a variant. `sec-fetch-dest` is what separates them — `document` for the navigation,
 * `empty` for `fetch()` — and it is the browser that sets it, not the test.
 *
 * The variants are the cases the notice has to get right, including the ones where it must stay
 * quiet: a probe that 404s and a probe that lands on a page with no build in it (a login
 * redirect, an SSO interstitial) both mean the poll learned nothing.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { findChrome } from "./participant-rail.fixture.js";

const run = promisify(execFile);
const siteRoot = join(import.meta.dirname, "..", "..", "..");
const distRoot = join(siteRoot, "dist");

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

/** What the page's own poll is answered with. The document load never gets any of these. */
type Variant = "same" | "markup" | "assets" | "assets-first" | "gone" | "no-build";

/* Served from the FIRST poll, so it becomes the markup baseline and only the asset comparison
   can see it. Without this the asset signal has no case of its own: every other variant differs
   from the baseline too, so the markup comparison alone would satisfy them all. */
const FROM_FIRST_POLL: ReadonlySet<Variant> = new Set<Variant>(["assets-first"]);

const appHtml = (): string => readFileSync(join(distRoot, "app", "index.html"), "utf8");

const pollBody = (variant: Variant): { body: string; status: number } => {
  const html = appHtml();
  if (variant === "gone") return { body: "Not found", status: 404 };
  if (variant === "no-build") {
    return { body: "<!doctype html><title>Sign in</title><p>Sign in to continue.</p>", status: 200 };
  }
  if (variant === "assets" || variant === "assets-first") {
    /* A build whose code changed: every content hash moves. Rewriting the hash in the URL is
       exactly what a rebuild does to it. */
    const rewritten = html.replace(
      /(\/_astro\/[^"']+?\.)([A-Za-z0-9_-]{8})(\.(?:js|css))/g,
      (_all, head: string, _hash: string, tail: string) => `${head}ZZZZZZZZ${tail}`,
    );
    assert.notEqual(rewritten, html, "assets variant rewrote no hashes, so it tests nothing");
    return { body: rewritten, status: 200 };
  }
  if (variant === "markup") {
    /* A build that changed only markup. MEASURED: this is the case that produces a different
       page with byte-identical asset names, so the asset comparison alone cannot see it. */
    const rewritten = html.replace("A new version is ready.", "A new version is ready. Build two.");
    assert.notEqual(rewritten, html, "markup variant changed nothing, so it tests nothing");
    const assetsOf = (source: string) =>
      (source.match(/\/_astro\/[^"']+\.(?:js|css)/g) ?? []).sort().join("\n");
    assert.equal(
      assetsOf(rewritten),
      assetsOf(html),
      "markup variant moved an asset hash, so it no longer isolates a markup-only build",
    );
    return { body: rewritten, status: 200 };
  }
  return { body: html, status: 200 };
};

const frameScript = `<script>
  const frame = document.querySelector("iframe");
  const report = (value) => {
    document.documentElement.dataset.updateMeasurement = btoa(JSON.stringify(value));
  };
  const runMeasurement = async () => {
    /* Re-read the frame's document every time. Holding one reference goes stale the moment the
       app navigates or replaces it, and a stale document answers every query with null. */
    const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const notice = () => frame.contentDocument?.querySelector("[data-update-notice]") ?? null;
    for (let attempt = 0; attempt < 160 && !notice(); attempt += 1) await wait(25);
    /* The page polls once as soon as it starts. Give that first round trip room to land. */
    await wait(900);
    /* Then the second poll, which is the one that meets the deploy. The page polls on a timer
       and when a hidden tab comes back; driving the visibility path is how a test gets the
       second poll without waiting out the interval, and it exercises the real listener. */
    const view = frame.contentWindow;
    const doc0 = frame.contentDocument;
    Object.defineProperty(doc0, "visibilityState", { value: "hidden", configurable: true });
    doc0.dispatchEvent(new view.Event("visibilitychange"));
    Object.defineProperty(doc0, "visibilityState", { value: "visible", configurable: true });
    doc0.dispatchEvent(new view.Event("visibilitychange"));
    await wait(900);
    const polls = Number(await (await fetch("/__polls")).text());
    const doc = frame.contentDocument;
    const bar = notice();
    const buttons = [...(doc?.querySelectorAll(".dashboard__update-notice-actions .dashboard__button") ?? [])]
      .map((b) => {
        const r = b.getBoundingClientRect();
        return { label: b.textContent.trim(), height: r.height, right: r.right, left: r.left };
      });
    report({
      polls,
      present: Boolean(bar),
      shown: bar ? !bar.hidden : false,
      height: bar && !bar.hidden ? bar.getBoundingClientRect().height : 0,
      buttons,
      viewportWidth: frame.contentWindow?.innerWidth ?? 0,
      documentLength: doc?.body?.innerHTML.length ?? 0,
    });
  };
  const start = () => void runMeasurement().catch((error) => report({ error: String(error) }));
  frame.addEventListener("load", start, { once: true });
  if (frame.contentDocument?.readyState === "complete") start();
</script>`;

const startServer = async (
  variant: Variant,
): Promise<{ close(): Promise<void>; origin: string }> => {
  let polls = 0;
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__polls") {
      response.writeHead(200, { "content-type": "text/plain" }).end(String(polls));
      return;
    }
    if (url.pathname === "/__measure") {
      response.writeHead(200, { "content-type": contentTypes[".html"] });
      response.end(
        `<!doctype html><html><body style="margin:0"><iframe title="Update notice viewport" src="/app/" style="border:0;width:${url.searchParams.get("width")}px;height:${url.searchParams.get("height")}px"></iframe>${frameScript}</body></html>`,
      );
      return;
    }
    const isApp = url.pathname === "/app" || url.pathname === "/app/";
    /* THE DISCRIMINATOR. The browser sets this, not us: `document` for the navigation that loads
       the app, `empty` for the page's own fetch. Without it the poll and the load are the same
       request and no variant could be delivered to one and not the other. */
    if (isApp && request.headers["sec-fetch-dest"] === "empty") {
      polls += 1;
      /* THE FIRST POLL IS THE DEPLOY THAT HAS NOT HAPPENED YET. It answers with the real page,
         which is what a tab sitting open sees; the variant is the deploy that lands afterwards.
         This is not a convenience: one of the two signals compares the served page against the
         FIRST page this tab saw, so a variant served from the very first poll would become the
         baseline and a markup-only build could never be seen. Modelling the deploy in the right
         order is what makes that signal reachable at all. */
      const { body, status } = polls === 1 && !FROM_FIRST_POLL.has(variant)
        ? { body: appHtml(), status: 200 }
        : pollBody(variant);
      response.writeHead(status, { "content-type": contentTypes[".html"] }).end(body);
      return;
    }
    const relative = isApp ? "app/index.html" : url.pathname.replace(/^\/+/, "");
    const filePath = normalize(join(distRoot, relative));
    if (!filePath.startsWith(`${distRoot}/`)) {
      response.writeHead(403).end("Forbidden");
      return;
    }
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) throw new Error("not a file");
      let body = readFileSync(filePath);
      if (extname(filePath) === ".js") {
        /* Sample mode, the same rewrite the composer browser observer uses: with a backend
           configured the page renders the signed-out panel and never mounts the dashboard. */
        body = Buffer.from(
          body.toString("utf8").replaceAll(
            "PUBLIC_SUPABASE_URL:`https://api.commonswarm.com`",
            "PUBLIC_SUPABASE_URL:``",
          ),
          "utf8",
        );
        response.writeHead(200, {
          "content-length": body.byteLength,
          "content-type": contentTypes[".js"],
        }).end(body);
        return;
      }
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
  if (address === null || typeof address === "string") throw new Error("no server address");
  return {
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
    origin: `http://127.0.0.1:${address.port}`,
  };
};

type Measurement = {
  buttons: { height: number; label: string; left: number; right: number }[];
  error?: string;
  height: number;
  polls: number;
  present: boolean;
  shown: boolean;
  viewportWidth: number;
  documentLength: number;
};

const measure = async (
  chrome: string,
  variant: Variant,
  width = 390,
  height = 844,
): Promise<Measurement> => {
  const server = await startServer(variant);
  try {
    const { stdout } = await run(chrome, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--single-process",
      "--no-zygote",
      "--run-all-compositor-stages-before-draw",
      "--window-size=1600,1200",
      "--virtual-time-budget=20000",
      "--dump-dom",
      `${server.origin}/__measure?width=${width}&height=${height}`,
    ], { killSignal: "SIGKILL", maxBuffer: 12 * 1024 * 1024, timeout: 40_000 });
    const encoded = stdout.match(/data-update-measurement="([^"]+)"/)?.[1];
    assert.ok(encoded, `${variant}: Chrome returned no measurement.\nDOM: ${stdout.slice(-1_500)}`);
    const value = JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as Measurement;
    assert.equal(value.error, undefined, `${variant}: the measurement page threw: ${value.error}`);
    return value;
  } finally {
    await server.close();
  }
};

/* POSITIVE CONTROL, run against every case below. "Hidden" proves nothing if the page never
   asked the server anything, and every quiet case would pass hardest with the feature deleted. */
const assertProbeHappened = (value: Measurement, variant: Variant): void => {
  assert.ok(
    value.present,
    `${variant}: there is no update notice in the page, so nothing here measures it: ` +
      JSON.stringify(value),
  );
  /* TWO polls: the baseline and the one that meets the deploy. With one, the markup signal has
     nothing to compare against and every quiet result below would be quiet for the wrong reason. */
  assert.ok(
    value.polls >= 2,
    `${variant}: the page polled its own URL ${value.polls} time(s); a result read before the ` +
      "deploy poll says nothing about detection",
  );
};

test("the same build being served raises no notice", async () => {
  const value = await measure(await findChrome(), "same");
  assertProbeHappened(value, "same");
  assert.equal(value.shown, false, `same build must not claim an update: ${JSON.stringify(value)}`);
});

test("a build that changed only markup is detected", async () => {
  const value = await measure(await findChrome(), "markup");
  assertProbeHappened(value, "markup");
  assert.equal(
    value.shown,
    true,
    "a markup-only build ships a different page with byte-identical asset hashes; comparing " +
      `assets alone cannot see it: ${JSON.stringify(value)}`,
  );
});

test("a build whose asset hashes moved is detected", async () => {
  const value = await measure(await findChrome(), "assets");
  assertProbeHappened(value, "assets");
  assert.equal(value.shown, true, `a changed build must be detected: ${JSON.stringify(value)}`);
});

/* The asset comparison ALONE. This variant is served from the first poll, so it is also the
   markup baseline: the markup comparison sees nothing and only the running-versus-served asset
   check can raise this. It is also the case a baseline cannot cover — a build deployed before
   this tab ever loaded. */
test("a build deployed before the tab loaded is detected by the asset comparison alone", async () => {
  const value = await measure(await findChrome(), "assets-first");
  assertProbeHappened(value, "assets-first");
  assert.equal(
    value.shown,
    true,
    "the served assets differ from the ones this page is running, which no baseline is needed " +
      `to see: ${JSON.stringify(value)}`,
  );
});

test("a probe that did not reach the page stays quiet", async () => {
  const chrome = await findChrome();
  for (const variant of ["gone", "no-build"] as const) {
    const value = await measure(chrome, variant);
    assertProbeHappened(value, variant);
    assert.equal(
      value.shown,
      false,
      `${variant}: a probe that learned nothing must not claim an update: ${JSON.stringify(value)}`,
    );
  }
});

/* The bar sits ABOVE the app bar on a phone, which is the space the 2026-09-04 mobile work was
   for. One row, and both controls reachable with a real target. */
test("the notice is one row and both controls stay reachable on a phone", async () => {
  const chrome = await findChrome();
  for (const [width, height] of [[390, 844], [320, 568]] as const) {
    const value = await measure(chrome, "assets", width, height);
    assert.equal(value.shown, true, `${width}px: the notice must be up for this to measure it`);
    assert.equal(value.viewportWidth, width, `${width}px: viewport drifted`);
    assert.ok(
      value.height > 0 && value.height <= 64,
      `${width}px: the update bar is ${value.height}px, which is more than one row: ` +
        JSON.stringify(value),
    );
    assert.equal(value.buttons.length, 2, `${width}px: both controls must be present`);
    for (const button of value.buttons) {
      assert.ok(
        button.height >= 44,
        `${width}px: "${button.label}" is a ${button.height}px target`,
      );
      assert.ok(
        button.left >= -0.5 && button.right <= width + 0.5,
        `${width}px: "${button.label}" is off-screen at ${button.right}px, and the shell clips ` +
          "its overflow, so it cannot be pressed",
      );
    }
  }
});
