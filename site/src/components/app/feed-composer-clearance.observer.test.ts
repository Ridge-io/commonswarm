/** Reached by `npm --prefix site test` through the recursive component-observer glob. */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createReadStream, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { findChrome } from "./participant-rail.fixture.js";

const run = promisify(execFile);
const siteRoot = join(import.meta.dirname, "..", "..", "..");
const distRoot = join(siteRoot, "dist");

type Clearance = {
  clearance: number;
  clearsAtWholePixel: boolean;
  composerHeight: number;
  composerTop: number;
  lastBottom: number;
  paddingBottom: number;
  scrollHeight: number;
  scrollTop: number;
  viewportHeight: number;
};

type FeedMeasurement = {
  before: Clearance;
  dynamic: Clearance;
  negative: Clearance;
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

const frameScript = (tall: boolean): string => `<script>
  const frame = document.querySelector("iframe");
  const reportFeedError = (value) => {
    document.documentElement.dataset.feedError = btoa(String(value));
  };
  const runMeasurement = async () => {
    const doc = frame.contentDocument;
    const view = frame.contentWindow;
    const settle = () => new Promise((resolve) => view.setTimeout(resolve, 40));
    const app = doc.querySelector("live-dashboard");
    app.dataset.state = "channel";
    doc.querySelectorAll(".dashboard__root > [data-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.panel !== "channel";
    });
    doc.querySelectorAll("[data-channel-view]").forEach((channelView) => {
      channelView.hidden = channelView.dataset.channelView !== "feed";
    });

    const composer = doc.querySelector("[data-composer]");
    const input = doc.querySelector("[data-composer-input]");
    const list = doc.querySelector("[data-feed-list]");
    const scroller = doc.querySelector(".dashboard__feed-view");
    composer.hidden = false;
    input.value = ${tall
      ? `["Line one", "Line two", "Line three", "Line four", "Line five", "Line six"].join(String.fromCharCode(10))`
      : `""`};
    input.dispatchEvent(new view.InputEvent("input", { bubbles: true, inputType: "insertText" }));
    list.replaceChildren(...Array.from({ length: 40 }, (_, index) => {
      const row = doc.createElement("li");
      row.className = "dashboard__message";
      const avatar = doc.createElement("span");
      avatar.className = "dashboard__message-avatar";
      avatar.textContent = "AG";
      const body = doc.createElement("article");
      body.className = "dashboard__message-body";
      const meta = doc.createElement("header");
      meta.className = "dashboard__message-meta";
      const author = doc.createElement("strong");
      author.textContent = "Agent " + (index + 1);
      const message = doc.createElement("div");
      message.className = "dashboard__message-markdown";
      message.textContent = "Rendered transcript row " + (index + 1) + " with enough copy to use the live feed geometry.";
      meta.append(author);
      body.append(meta, message);
      row.append(avatar, body);
      return row;
    }));

    const measure = async () => {
      await settle();
      scroller.scrollTop = scroller.scrollHeight;
      await settle();
      const last = list.lastElementChild.getBoundingClientRect();
      const composerBox = composer.getBoundingClientRect();
      const clearance = composerBox.top - last.bottom;
      return {
        clearance,
        clearsAtWholePixel: Math.ceil(last.bottom) < Math.floor(composerBox.top),
        composerHeight: composerBox.height,
        composerTop: composerBox.top,
        lastBottom: last.bottom,
        paddingBottom: Number.parseFloat(view.getComputedStyle(list).paddingBottom),
        scrollHeight: scroller.scrollHeight,
        scrollTop: scroller.scrollTop,
        viewportHeight: scroller.clientHeight,
      };
    };
    await doc.fonts.ready;
    await settle();
    const dynamic = await measure();
    list.style.setProperty("padding-block-end", "var(--s-10)", "important");
    const before = await measure();
    list.style.setProperty("padding-block-end", "0px", "important");
    const negative = await measure();
    document.documentElement.dataset.feedMeasurement = btoa(JSON.stringify({
      before,
      dynamic,
      negative,
      viewportWidth: view.innerWidth,
    }));
  };
  const startMeasurement = () => void runMeasurement().catch((error) => reportFeedError(error?.stack ?? error));
  frame.addEventListener("load", startMeasurement, { once: true });
  if (
    frame.contentDocument?.readyState === "complete" &&
    frame.contentWindow?.location.pathname === "/app"
  ) startMeasurement();
</script>`;

const startDistServer = async (): Promise<{ close(): Promise<void>; origin: string }> => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__measure") {
      const width = Number.parseInt(url.searchParams.get("width") ?? "", 10);
      const tall = url.searchParams.get("tall") === "1";
      if (
        !Number.isSafeInteger(width) || width <= 0 ||
        !["0", "1"].includes(url.searchParams.get("tall") ?? "")
      ) {
        response.writeHead(400).end("Invalid measurement");
        return;
      }
      response.writeHead(200, { "content-type": contentTypes[".html"] });
      response.end(`<!doctype html><html><body style="margin:0"><iframe title="Feed measurement viewport" src="/app" style="border:0;width:${width}px;height:1000px"></iframe>${frameScript(tall)}</body></html>`);
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
  assert.ok(address && typeof address !== "string", "feed observer server must bind a port");
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
  tall: boolean,
): Promise<FeedMeasurement> => {
  const { stdout, stderr } = await run(chrome, [
    "--headless=new",
    "--disable-gpu",
    "--no-sandbox",
    "--single-process",
    "--no-zygote",
    "--run-all-compositor-stages-before-draw",
    "--window-size=1600,1200",
    "--virtual-time-budget=8000",
    "--dump-dom",
    `${origin}/__measure?width=${width}&tall=${tall ? 1 : 0}`,
  ], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
  const encoded = stdout.match(/data-feed-measurement="([^"]+)"/)?.[1];
  const encodedError = stdout.match(/data-feed-error="([^"]+)"/)?.[1];
  assert.ok(
    encoded,
    `${width}px: headless Chrome did not return feed measurements\n` +
      `page error: ${encodedError ? Buffer.from(encodedError, "base64").toString("utf8") : "none"}\n` +
      `stderr: ${stderr.slice(-1_000)}\nDOM: ${stdout.slice(-2_000)}`,
  );
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as FeedMeasurement;
};

test("the newest feed row clears the measured composer at rest and when it grows", async () => {
  const chrome = await findChrome();
  const server = await startDistServer();
  try {
    for (const width of [1440, 390]) {
      const measurements = {
        rest: await measureAt(chrome, server.origin, width, false),
        tall: await measureAt(chrome, server.origin, width, true),
      };
      for (const [state, measurement] of Object.entries(measurements)) {
        const geometry = measurement.dynamic;
        assert.equal(measurement.viewportWidth, width, `${width}px iframe width drifted`);
        assert.ok(
          geometry.clearsAtWholePixel,
          `${width}px ${state}: last row does not clear composer: ${JSON.stringify(geometry)}`,
        );
        assert.ok(
          geometry.scrollTop + geometry.viewportHeight >= geometry.scrollHeight - 1,
          `${width}px ${state}: auto-scroll did not reach the transcript end`,
        );
        assert.equal(
          measurement.negative.clearsAtWholePixel,
          false,
          `${width}px ${state}: zero-padding negative control did not fail: ${JSON.stringify(measurement.negative)}`,
        );
        assert.ok(
          Math.abs(measurement.before.paddingBottom - 40) <= 0.1,
          `${width}px ${state}: fixed-padding before control drifted: ${JSON.stringify(measurement.before)}`,
        );
      }
      assert.ok(
        measurements.tall.dynamic.composerHeight > measurements.rest.dynamic.composerHeight + 40,
        `${width}px: multiline input did not make the composer materially taller`,
      );
      const composerGrowth = measurements.tall.dynamic.composerHeight -
        measurements.rest.dynamic.composerHeight;
      const paddingGrowth = measurements.tall.dynamic.paddingBottom -
        measurements.rest.dynamic.paddingBottom;
      assert.ok(
        Math.abs(composerGrowth - paddingGrowth) <= 1,
        `${width}px: transcript padding did not track composer growth: ${JSON.stringify(measurements)}`,
      );
      console.log(`feed-composer-clearance ${width}px ${JSON.stringify(measurements)}`);
    }
  } finally {
    await server.close();
  }
});
