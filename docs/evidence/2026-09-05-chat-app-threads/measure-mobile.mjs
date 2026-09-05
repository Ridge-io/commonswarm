/*
 * Phone measurement for the thread surface. Not shipped: run from the worktree root after
 * `cd site && npm run build`.
 *
 *   node docs/evidence/2026-09-05-chat-app-threads/measure-mobile.mjs
 *
 * It serves site/dist with the same sample-mode rewrite the observer harness uses, then, at
 * each phone width, writes a screenshot and a measurement record beside this file.
 *
 * WHAT IT MEASURES. Two states at each viewport: the feed at rest with both threads collapsed,
 * and the composer with a reply bar open on the #mobile thread — the tallest the composer gets,
 * because that bar is the only chrome this lane adds and it carries the broadcast control. The
 * claim under test is that the 73px app bar is still the only in-flow header: the reply bar is
 * INSIDE the composer, not a second band above the transcript.
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
    replyBar: box("[data-composer-reply]"),
    thread: box('[data-thread-root="sample-2"]'),
  });
  const collapsed = snapshot("threads-collapsed");
  /* THE TALLEST STATE THIS LANE CAN PRODUCE: a reply open on the thread that IS in a channel,
     so the bar carries its target line AND the broadcast control. An unfiled thread's bar is
     strictly shorter, so measuring this one bounds both. */
  const openReply = document.querySelector('[data-message-reply="sample-2"]');
  if (openReply) openReply.click();
  await waitFor(() => document.querySelector("[data-composer-reply]")?.hidden === false);
  await new Promise((resolve) => setTimeout(resolve, 200));
  const replying = snapshot("reply-open");
  /* AND THE THREAD OPENED, so the collapsed replies are on screen at a phone width too. */
  const toggle = document.querySelector('[data-thread-toggle="sample-2"]');
  if (toggle && toggle.getAttribute("aria-expanded") !== "true") toggle.click();
  await new Promise((resolve) => setTimeout(resolve, 150));
  const expanded = snapshot("thread-expanded");
  /* THE APP-BAR RULE, MEASURED WITH THE SAME INSTRUMENT mobile-feed-layout.observer.test.ts
     uses and not a second one invented here. The app bar's height IS the channel section's top
     edge, and the transcript's own box is .dashboard__channel-body; the whole rule is one
     comparison of two measured edges. Anything in flow above the transcript pushes
     channelBody.top past channel.top, so a second band cannot hide from this.

     ~~a header, .dashboard__channel-head sweep~~ was the first version and it was wrong: it
     matched the <header class="dashboard__message-meta"> inside every message row, which is
     four rows of a transcript rather than a header above one. A count that goes up with the
     number of messages is not measuring a header rule. */
  const channelBox = box(".dashboard__channel");
  const channelBodyBox = box(".dashboard__channel-body");
  /* THE SAMPLE BANNER IS SAMPLE MODE'S OWN, and it is in flow above everything. It is not
     part of the signed-in layout the app-bar rule is about, so it is reported and subtracted
     rather than hidden: subtracting a number the reader can see beats deleting an element and
     saying nothing. mobile-feed-layout.observer.test.ts measures the signed-in layout with no
     banner at all, and it is the gate on this rule. */
  const sampleNoticeBox = box("[data-sample-notice]");
  const sampleNoticeHeight = sampleNoticeBox ? sampleNoticeBox.height : 0;
  const appBarRule = {
    sampleNoticeHeight,
    appBarHeight: channelBox ? +(channelBox.top - sampleNoticeHeight).toFixed(2) : null,
    appBarHeightWithSampleBanner: channelBox ? channelBox.top : null,
    transcriptTop: channelBodyBox ? channelBodyBox.top : null,
    /* True when nothing in flow sits above the transcript but the app bar. */
    transcriptStartsAtTheBar: Boolean(channelBox && channelBodyBox &&
      channelBodyBox.top <= channelBox.top + 0.5),
    /* POSITIVE CONTROL on the same invocation: two zeroes would satisfy the comparison, so the
       bar has to be a real one-row bar for the result above to mean anything. */
    barIsARealBar: Boolean(channelBox &&
      channelBox.top - sampleNoticeHeight >= 40 && channelBox.top - sampleNoticeHeight <= 100),
    /* AND THE REPLY BAR IS INSIDE THE COMPOSER, which is why it adds no header at all. */
    replyBarInsideComposer: (() => {
      const composer = document.querySelector("[data-composer]");
      const bar = document.querySelector("[data-composer-reply]");
      return Boolean(composer && bar && composer.contains(bar));
    })(),
  };
  return JSON.stringify({
    ready,
    viewport: { width: window.innerWidth, height: window.innerHeight },
    devicePixelRatio: window.devicePixelRatio,
    collapsed,
    replying,
    expanded,
    replyBar: {
      target: document.querySelector("[data-composer-reply-target-text]")?.textContent ?? "",
      broadcastLabel:
        document.querySelector("[data-composer-reply-broadcast-label]")?.textContent ?? "",
      broadcastHidden: document.querySelector("[data-composer-reply-broadcast-row]")?.hidden,
      box: box("[data-composer-reply]"),
      toNote: document.querySelector("[data-composer-to-note]")?.textContent ?? "",
      toLocked:
        document.querySelector("[data-composer-to]")?.getAttribute("aria-disabled") === "true",
    },
    threadRows: {
      toggles: [...document.querySelectorAll("[data-thread-toggle]")].map((b) => b.textContent),
      /* BY ROOT ID. ~~box(".dashboard__thread")~~ read the FIRST thread in the document,
         which is the older unfiled one and is still collapsed here, so it reported a 0x0 rect
         for the thread this step had just expanded. */
      expandedThreadBox: box('[data-thread-root="sample-2"]'),
      expandedRepliesBox: box("#dashboard-thread-sample-2"),
      expandedRepliesVisible:
        document.querySelector("#dashboard-thread-sample-2")?.hidden === false,
      collapsedRepliesVisible:
        document.querySelector("#dashboard-thread-sample-3")?.hidden === false,
    },
    /* THE APP BAR IS THE ONLY IN-FLOW HEADER. Anything else with a static position and a real
       height would be a second band eating the reading area, which the 2026-09-04 ruling
       forbids and which is the one thing the reply bar could have introduced. */
    appBarRule,
    insideViewport: {
      composer: replying.composer.bottom <= window.innerHeight + 0.1,
      send: replying.send.right <= window.innerWidth + 0.1 && replying.send.left >= -0.1,
      toRow: replying.toRow.right <= window.innerWidth + 0.1 && replying.toRow.left >= -0.1,
      replyBar: (() => {
        const bar = document.querySelector("[data-composer-reply]");
        if (!bar) return null;
        const rect = bar.getBoundingClientRect();
        return rect.left >= -0.1 && rect.right <= window.innerWidth + 0.1 &&
          rect.bottom <= window.innerHeight + 0.1;
      })(),
      threadReplies: (() => {
        const replies = document.querySelector("#dashboard-thread-sample-2");
        if (!replies || replies.hidden) return null;
        const rect = replies.getBoundingClientRect();
        return rect.left >= -0.1 && rect.right <= window.innerWidth + 0.1;
      })(),
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
    const replying = url.searchParams.get("reply") === "1";
    response.writeHead(200, { "content-type": types[".html"] });
    response.end(
      `<!doctype html><html><body style="margin:0;background:#fff">` +
        `<iframe src="${probing ? "/__probe" : replying ? "/__reply" : "/app"}" width="${url.searchParams.get("w")}" ` +
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
  /* THE SECOND SCREENSHOT'S STATE. The at-rest shot shows the collapsed threads and the reply
     control; this one shows the surface the measurement is about — a reply bar open on the
     thread that is in a channel, with its broadcast control, and that thread expanded. Same
     document and same layout as the probe, so the picture and the numbers are of one page. */
  if (url.pathname === "/__reply") {
    const html = readFileSync(join(distRoot, "app", "index.html"), "utf8").replace(
      "</body>",
      `<script type="module">
        const settle = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if (document.querySelectorAll("[data-feed-list] > li").length > 0) break;
          await settle(25);
        }
        document.querySelector('[data-message-reply="sample-2"]')?.click();
        await settle(200);
        const toggle = document.querySelector('[data-thread-toggle="sample-2"]');
        if (toggle && toggle.getAttribute("aria-expanded") !== "true") toggle.click();
        await settle(150);
      </script></body>`,
    );
    response.writeHead(200, {
      "content-length": Buffer.byteLength(html),
      "content-type": types[".html"],
    });
    response.end(html);
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
  const replyShot = join(here, `mobile-reply-${name}.png`);
  for (const [file, extra] of [[shot, ""], [replyShot, "&reply=1"]]) {
    await run(chrome, [
      "--headless=new", "--disable-gpu", "--no-sandbox", "--hide-scrollbars",
      `--window-size=${width},${height}`,
      "--virtual-time-budget=12000",
      `--screenshot=${file}`,
      `${origin}/__frame?w=${width}&h=${height}${extra}`,
    ], { maxBuffer: 40 * 1024 * 1024, timeout: 60_000 });
  }
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
    replyScreenshot: `mobile-reply-${name}.png`,
    measurement: encoded ? JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) : null,
  };
}
writeFileSync(join(here, "mobile-measurements.json"), `${JSON.stringify(record, null, 2)}\n`);
await new Promise((resolve) => server.close(resolve));
console.log(JSON.stringify(record, null, 2));
