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
type Variant =
  | "same"
  | "markup"
  | "assets"
  | "assets-first"
  | "gone"
  | "no-build"
  | "injected"
  | "dismiss-then-markup"
  | "gone-first"
  | "no-build-first"
  | "other-astro-page"
  | "rollback";

/* Served from the FIRST poll, so it becomes the markup baseline and only the asset comparison
   can see it. Without this the asset signal has no case of its own: every other variant differs
   from the baseline too, so the markup comparison alone would satisfy them all. */
const FROM_FIRST_POLL: ReadonlySet<Variant> = new Set<Variant>([
  "assets-first",
  /* The very first probe failing is its own case: offline at load, or a login wall in front of
     the page. The quiet cases below otherwise only ever test a LATER probe failing. */
  "gone-first",
  "no-build-first",
]);

const appHtml = (): string => readFileSync(join(distRoot, "app", "index.html"), "utf8");

const pollBody = (variant: Variant): { body: string; status: number } => {
  const html = appHtml();
  if (variant === "gone" || variant === "gone-first") {
    return { body: "Not found", status: 404 };
  }
  if (variant === "no-build" || variant === "no-build-first") {
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
    /* Change markup INSIDE <live-dashboard>, which is what a build does and what the markup
       comparison reads. Keyed to the element, not to product copy: keying it to a sentence made
       this variant silently stop changing anything the first time the copy was edited. */
    const rewritten = html.replace("<live-dashboard ", '<live-dashboard data-build-probe="two" ');
    assert.notEqual(rewritten, html, "markup variant changed nothing, so it tests nothing");
    assert.ok(
      rewritten.includes('data-build-probe="two"'),
      "markup variant did not land inside live-dashboard, where a build's own markup lives",
    );
    const assetsOf = (source: string) =>
      (source.match(/\/_astro\/[^"']+\.(?:js|css)/g) ?? []).sort().join("\n");
    assert.equal(
      assetsOf(rewritten),
      assetsOf(html),
      "markup variant moved an asset hash, so it no longer isolates a markup-only build",
    );
    return { body: rewritten, status: 200 };
  }
  if (variant === "other-astro-page") {
    /* A sign-in wall that is ALSO an Astro page: 200 OK, its own /_astro/ URLs, and no
       <live-dashboard>. fetch follows redirects, so this is what an SSO gate can return for
       /app. The asset check alone would read it as a deploy. */
    const rewritten = html
      .replace(/<live-dashboard[\s\S]*<\/live-dashboard>/, "<p>Sign in to continue.</p>")
      .replace(
        /(\/_astro\/[^"']+?\.)([A-Za-z0-9_-]{8})(\.(?:js|css))/g,
        (_all: string, head: string, _hash: string, tail: string) => `${head}YYYYYYYY${tail}`,
      );
    assert.ok(
      !rewritten.includes("<live-dashboard"),
      "other-astro-page still carries live-dashboard, so it is not a foreign page",
    );
    assert.ok(
      /\/_astro\/[^"']+\.(?:js|css)/.test(rewritten),
      "other-astro-page carries no hashed assets, so the earlier guard would catch it and this " +
        "case would not reach the one it is for",
    );
    return { body: rewritten, status: 200 };
  }
  if (variant === "injected") {
    /* The same build, with bytes that are not ours added around it: a preview or analytics
       toolbar, a per-request id from a proxy. The page must not read this as a deploy. */
    const rewritten = html.replace("</body>", '<script>window.__injected="req-000123"</script></body>');
    assert.notEqual(rewritten, html, "injected variant injected nothing, so it tests nothing");
    assert.ok(
      !rewritten.includes('__injected="req-000123"</live-dashboard>'),
      "injected variant put its bytes INSIDE live-dashboard, where a build's own markup lives",
    );
    return { body: rewritten, status: 200 };
  }
  return { body: html, status: 200 };
};

/* Poll 3 of the dismissal case: the asset-changed build the reader dismissed, and then a markup
   change on top of it. The asset set is IDENTICAL to the dismissed one, so this is caught only if
   dismissal is remembered against the whole build and not against whichever half differed. */
const dismissThenMarkupBody = (): string => {
  const assets = pollBody("assets").body;
  const rewritten = assets.replace("<live-dashboard ", '<live-dashboard data-build-probe="three" ');
  assert.notEqual(rewritten, assets, "the third build changed nothing, so it tests nothing");
  return rewritten;
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
    let dismissSawBuildTwo = null;
    let dismissTookEffect = null;
    const notice = () => frame.contentDocument?.querySelector("[data-update-notice]") ?? null;
    for (let attempt = 0; attempt < 160 && !notice(); attempt += 1) await wait(25);
    /* WAIT ON THE CONDITION, NOT A DURATION. A flat sleep made this case pass or fail with the
       load on the host: the third poll is two round trips deep and a busy box does not finish it
       in a fixed window. The server counts polls, so wait for the count. */
    const polledAtLeast = async (target) => {
      for (let attempt = 0; attempt < 300; attempt += 1) {
        if (Number(await (await fetch("/__polls")).text()) >= target) return true;
        await wait(25);
      }
      return false;
    };
    await polledAtLeast(1);
    /* The decision runs after the response resolves, so give that microtask turn room. */
    await wait(120);
    /* Then the second poll, which is the one that meets the deploy. The page polls on a timer
       and when a hidden tab comes back; driving the visibility path is how a test gets the
       second poll without waiting out the interval, and it exercises the real listener. */
    const view = frame.contentWindow;
    const doc0 = frame.contentDocument;
    Object.defineProperty(doc0, "visibilityState", { value: "hidden", configurable: true });
    doc0.dispatchEvent(new view.Event("visibilitychange"));
    Object.defineProperty(doc0, "visibilityState", { value: "visible", configurable: true });
    doc0.dispatchEvent(new view.Event("visibilitychange"));
    await polledAtLeast(2);
    await wait(120);
    if (new URL(location.href).searchParams.get("dismiss") === "1") {
      const cycle = () => {
        Object.defineProperty(doc0, "visibilityState", { value: "hidden", configurable: true });
        doc0.dispatchEvent(new view.Event("visibilitychange"));
        Object.defineProperty(doc0, "visibilityState", { value: "visible", configurable: true });
        doc0.dispatchEvent(new view.Event("visibilitychange"));
      };
      const until = async (predicate) => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if (predicate()) return true;
          await wait(25);
        }
        return false;
      };
      const shownNow = () => { const b = notice(); return Boolean(b) && !b.hidden; };
      /* Build two. Wait for the bar itself, not for a poll count: the bar going up is the
         condition the dismiss below depends on. */
      await fetch("/__stage?to=2");
      cycle();
      dismissSawBuildTwo = await until(shownNow);
      frame.contentDocument.querySelector("[data-update-dismiss]").click();
      dismissTookEffect = !shownNow();
      /* Build three, only now. Any number of polls may land in between; they all carry build two,
         which is the one just dismissed, so the bar stays down until this stage moves. */
      await fetch("/__stage?to=3");
      cycle();
      /* The rollback case takes one more step: stage 3 is the build this tab is running, so the
         bar goes DOWN there, and stage 4 ships the dismissed build again. */
      if (new URL(location.href).searchParams.get("rollback") === "1") {
        await until(() => !shownNow());
        await fetch("/__stage?to=4");
        cycle();
      }
      await until(shownNow);
      await wait(120);
    }
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
      height: bar ? bar.getBoundingClientRect().height : 0,
      /* The attribute is not the question a reader has. The app's own [hidden] rule carries
         display:none !important, and asserting the COMPUTED value is what proves the bar is
         really gone rather than merely marked. NOTE: no backticks in here, this is inside a
         template literal. */
      display: bar ? frame.contentWindow.getComputedStyle(bar).display : "absent",
      buttons,
      viewportWidth: frame.contentWindow?.innerWidth ?? 0,
      documentLength: doc?.body?.innerHTML.length ?? 0,
      dismissSawBuildTwo,
      dismissTookEffect,
      stageNow: await (await fetch("/__stage")).text(),
      servedStages: await (await fetch("/__served")).text(),
      sampleNoticeShown: (() => {
        const s = doc?.querySelector("[data-sample-notice]");
        return s ? !s.hidden : false;
      })(),
      composerBottom: doc?.querySelector(".dashboard__composer")?.getBoundingClientRect().bottom ?? 0,
      frameHeight: doc?.querySelector(".dashboard__frame")?.getBoundingClientRect().height ?? 0,
    });
  };
  /* ONCE. Both arms of this can fire — the load event and an already-complete frame — and this
     measurement is not idempotent: it CLICKS. Running it twice dismissed the second build as well
     as the first and read as the product failing to re-ask. */
  let started = false;
  const start = () => {
    if (started) return;
    started = true;
    void runMeasurement().catch((error) => report({ error: String(error) }));
  };
  frame.addEventListener("load", start, { once: true });
  if (frame.contentDocument?.readyState === "complete") start();
</script>`;

const startServer = async (
  variant: Variant,
): Promise<{ close(): Promise<void>; origin: string }> => {
  let polls = 0;
  /* THE DEPLOY IS DRIVEN, NOT COUNTED. The page polls on a timer AND whenever a hidden tab comes
     back, so the number of polls between two points is not something a test controls. Counting
     them made the dismissal case dismiss whichever build happened to have landed, which is a
     property of the harness and not of the product. The page advances this stage explicitly. */
  let stage = 0;
  const servedStages: number[] = [];
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__polls") {
      response.writeHead(200, { "content-type": "text/plain" }).end(String(polls));
      return;
    }
    if (url.pathname === "/__stage") {
      /* Reading must not write. Without the guard, the probe that reports the stage SET it. */
      const to = url.searchParams.get("to");
      if (to !== null) stage = Number(to);
      response.writeHead(200, { "content-type": "text/plain" }).end(String(stage));
      return;
    }
    if (url.pathname === "/__served") {
      response.writeHead(200, { "content-type": "text/plain" }).end(servedStages.join(","));
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
      if (variant === "dismiss-then-markup" || variant === "rollback") servedStages.push(stage);
      const { body, status } = variant === "rollback"
        /* Stage 2 is a different build, stage 3 is the build this tab is RUNNING (the rollback),
           and stage 4 is that different build again. */
        ? stage === 2 || stage >= 4
          ? pollBody("assets")
          : { body: appHtml(), status: 200 }
        : variant === "dismiss-then-markup"
        ? stage >= 3
          ? { body: dismissThenMarkupBody(), status: 200 }
          : stage === 2
          ? pollBody("assets")
          : { body: appHtml(), status: 200 }
        : polls === 1 && !FROM_FIRST_POLL.has(variant)
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
  composerBottom: number;
  dismissSawBuildTwo: boolean | null;
  dismissTookEffect: boolean | null;
  stageNow: string;
  servedStages: string;
  display: string;
  frameHeight: number;
  sampleNoticeShown: boolean;
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
  dismiss = false,
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
      `${server.origin}/__measure?width=${width}&height=${height}&dismiss=${dismiss ? 1 : 0}` +
        `&rollback=${variant === "rollback" ? 1 : 0}`,
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
  assert.equal(value.display, "none", "the bar is marked hidden but still painted");
  assert.equal(value.height, 0, "the bar is marked hidden but still takes height");
});

/* Bytes that are not ours, around a build that did not change. A preview or analytics toolbar and
   a proxy's per-request id both land outside <live-dashboard>, which is why the markup comparison
   reads that element and not the whole document. */
test("bytes injected around an unchanged build raise no notice", async () => {
  const value = await measure(await findChrome(), "injected");
  assertProbeHappened(value, "injected");
  assert.equal(
    value.shown,
    false,
    `an injected script is not a deploy: ${JSON.stringify(value)}`,
  );
  assert.equal(value.display, "none", "the bar is marked hidden but still painted");
});

/* Dismissal must not silence a LATER, different build. The third build here carries the SECOND
   build's asset set with different markup, so it is only seen if dismissal was remembered against
   the whole build rather than whichever half happened to differ. */
test("dismissing one build does not hide the next one", async () => {
  const value = await measure(await findChrome(), "dismiss-then-markup", 390, 844, true);
  /* Positive controls in order: the second build really raised the bar, and the dismiss really
     put it down. Without both, "shown" at the end could be the second build never dismissed. */
  assert.equal(
    value.dismissSawBuildTwo,
    true,
    `the second build never raised the bar, so there was nothing to dismiss: ${JSON.stringify(value)}`,
  );
  assert.equal(
    value.dismissTookEffect,
    true,
    `Not now did not put the bar down, so the case below is not about dismissal: ${JSON.stringify(value)}`,
  );
  assert.equal(
    value.shown,
    true,
    `a build after the dismissed one must ask again: ${JSON.stringify(value)}`,
  );
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

/* A page that is not ours, answered 200 with its own hashed assets. The asset comparison alone
   would call that a deploy; requiring OUR element is what makes the probe honest. */
test("a sign-in page built the same way raises no notice", async () => {
  const value = await measure(await findChrome(), "other-astro-page");
  assertProbeHappened(value, "other-astro-page");
  assert.equal(
    value.shown,
    false,
    `a page with no live-dashboard in it is not a deploy: ${JSON.stringify(value)}`,
  );
  assert.equal(value.display, "none", "the bar is marked hidden but still painted");
});

/* A rollback must not strand the dismissal. Dismiss build two; the server rolls back to the build
   this tab is running, which puts the tab back in step; then build two ships again and must ask. */
test("a rollback does not silence the build that follows it", async () => {
  const value = await measure(await findChrome(), "rollback", 390, 844, true);
  assert.equal(
    value.dismissSawBuildTwo,
    true,
    `the second build never raised the bar: ${JSON.stringify(value)}`,
  );
  assert.equal(
    value.dismissTookEffect,
    true,
    `Not now did not put the bar down: ${JSON.stringify(value)}`,
  );
  assert.equal(
    value.shown,
    true,
    `the build after a rollback must ask again: ${JSON.stringify(value)}`,
  );
});

test("a probe that did not reach the page stays quiet", async () => {
  const chrome = await findChrome();
  for (const variant of ["gone", "no-build", "gone-first", "no-build-first"] as const) {
    const value = await measure(chrome, variant);
    assertProbeHappened(value, variant);
    assert.equal(
      value.shown,
      false,
      `${variant}: a probe that learned nothing must not claim an update: ${JSON.stringify(value)}`,
    );
    assert.equal(value.display, "none", `${variant}: the bar is marked hidden but still painted`);
    assert.equal(value.height, 0, `${variant}: the bar is marked hidden but still takes height`);
  }
});

/* The bar sits ABOVE the app bar on a phone, which is the space the 2026-09-04 mobile work was
   for. One row, and both controls reachable with a real target. */
/* Both notices at once. The product grid went from two rows to three when this bar arrived, and
   every child is pinned, so the case that breaks a pinned grid is the one where BOTH content rows
   are filled: the frame must still get the viewport row and the composer must stay on screen. */
test("both notices at once still leave the composer in the viewport", async () => {
  /* Sample mode renders the sample-data notice, so this measurement has both rows filled
     without any test-only arrangement. */
  const value = await measure(await findChrome(), "assets", 390, 844);
  assert.equal(value.shown, true, "the update bar must be up for this to measure anything");
  assert.equal(
    value.sampleNoticeShown,
    true,
    "the sample notice must be up too, or this is the one-notice case again",
  );
  assert.ok(
    value.composerBottom > 0 && value.composerBottom <= 844 + 0.5,
    `the composer is at ${value.composerBottom}px in an 844px viewport with both notices up: ` +
      JSON.stringify(value),
  );
  assert.ok(
    value.frameHeight > 300,
    `the frame collapsed to ${value.frameHeight}px with both notices up: ${JSON.stringify(value)}`,
  );
});

test("the notice is one row and both controls stay reachable on a phone", async () => {
  const chrome = await findChrome();
  for (const [width, height] of [[390, 844], [320, 568]] as const) {
    const value = await measure(chrome, "assets", width, height);
    assert.equal(value.shown, true, `${width}px: the notice must be up for this to measure it`);
    assert.equal(value.viewportWidth, width, `${width}px: viewport drifted`);
    /* 53px is what the shipped CSS computes: var(--s-1) + a 44px button + var(--s-1) + a 1px
       border. The bound is tight enough to fail a second line, which is the regression this
       case exists for, and loose enough not to break on a token nudge. */
    assert.ok(
      value.height > 0 && value.height <= 56,
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
