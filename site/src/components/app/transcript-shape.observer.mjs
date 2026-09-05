import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

/* The transcript's shape, pinned. Four properties the operator reported broken on 2026-08-11,
 * none of which had a gate — measured: the fixes passed 148/148 before AND after, and a control
 * mutation elsewhere in the file does turn the suite red, so the suite reaches this code and
 * simply never asserted on it. Without these, a future "simplification" flips the transcript back
 * and nothing notices. */

const raw = readFileSync(
  new URL("./LiveDashboard.astro", import.meta.url),
  "utf8",
);

/* COMMENTS STRIPPED before any assertion. This repo's doctrine is to keep a superseded line and
 * mark it dead, so the file legitimately CONTAINS `~~align-self: start~~` inside the comment
 * explaining why it was removed. A must-be-absent check against the raw text therefore fails on
 * our own prose — the third time in one day that a control matched a string its surrounding
 * commentary already contained. Assert on the DECLARATIONS. */
const src = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/<!--[\s\S]*?-->/g, "");

test("transcript: rows render OLDEST-first so the newest sits at the bottom", () => {
  /* ~~`for (const signal of [...visibleSignals].reverse())`~~ was the loop until
     `lane/chat-app-threads` (2026-09-05) collapsed replies under their root. This test is
     about the REVERSAL, so it asserts the reversal: the loop's shape is another file's
     subject, and pinning it here reported a grouping change as an ordering regression. */
  assert.match(
    src,
    /\[\.\.\.visibleSignals\]\.reverse\(\)/,
    "the display reversal is gone — newest would render at the top again",
  );
  assert.equal(
    src.split("[...visibleSignals].reverse()").length - 1,
    1,
    "the display reversal must happen exactly once",
  );
});

test("transcript: the QUERY stays descending, because the cursor pages backwards", () => {
  /* CONTROL on the fix above, and the reason it lives at the render rather than the query.
   * Flipping to ascending fetches the OLDEST page on first paint and breaks every "load older"
   * after it, because the keyset pages with created_at.lt. */
  assert.match(src, /\.order\("created_at", \{ ascending: false \}\)/);
  assert.match(src, /created_at\.lt\.\$\{cursor\.createdAt\}/);
});

test("transcript: the feed pane is the scroller, not the page", () => {
  /* align-self:start sized the pane to its CONTENT inside a fixed track, so its own
   * overflow-y:auto never engaged and the whole document scrolled — measured 14,907px against an
   * 846px viewport. All three declarations are load-bearing. */
  assert.match(src, /\.dashboard__feed-view \{[\s\S]{0,300}?align-self: stretch/);
  assert.doesNotMatch(
    src,
    /\.dashboard__feed-view \{[\s\S]{0,300}?align-self: start/,
    "align-self:start is back; the page will scroll instead of the transcript",
  );
  assert.match(
    src,
    /\.dashboard__product \{[\s\S]{0,300}?block-size: var\(--dashboard-viewport-height, 100dvh\)[\s\S]{0,200}?overflow: hidden/,
    "the product shell no longer consumes the measured visual viewport",
  );
  assert.match(
    src,
    /\.dashboard__frame \{[\s\S]{0,500}?block-size: 100%;[\s\S]{0,100}?min-block-size: 0/,
    "the frame can grow past the bounded product shell",
  );
  assert.match(
    src,
    /visualViewport\?\.addEventListener\("resize", requestDashboardViewportSync\)/,
    "software-keyboard viewport changes no longer reach the shell",
  );
  /* iOS Safari also SCROLLS the layout viewport when a field near the bottom takes focus. The
   * shell is sized to the visible viewport, so a scrolled page slides it off the screen — the
   * composer thrown to the top of the screen and then dropped part way, which is what the
   * operator reported on 2026-09-04. Returning the page to 0 on every visual-viewport event
   * is what pins the shell to the screen. */
  assert.match(
    src,
    /const syncDashboardViewport[\s\S]{0,400}?window\.scrollTo\(0, 0\)/,
    "the shell no longer undoes the layout-viewport scroll the keyboard causes",
  );
  /* `window.innerHeight` reports the LAYOUT viewport on iOS Safari and does not change when the
   * keyboard opens, so it must not be the fallback: it would write a height that is too tall at
   * exactly the moment a shorter one is needed. With no visualViewport the property stays unset
   * and the stylesheet's own 100dvh applies. */
  assert.doesNotMatch(
    src,
    /const syncDashboardViewport[\s\S]{0,400}?window\.innerHeight/,
    "window.innerHeight is back in the viewport sync, where it describes the wrong viewport",
  );
  /* The composer's own height cap has to be measured the same way, for the same reason. */
  assert.match(
    src,
    /\.dashboard__composer textarea \{[\s\S]{0,700}?max-block-size: min\(calc\(var\(--dashboard-viewport-height/,
    "the composer's height cap is back on a viewport unit rather than the measured height",
  );
});

test("transcript: the load-older control sits ABOVE the list", () => {
  /* Older rows render at the top. A control below the list loads content the reader cannot see,
   * and renderFeed then pins them to the newest row, so the click looks like it did nothing. */
  const more = src.indexOf("data-feed-more");
  const list = src.indexOf("data-feed-list");
  assert.ok(more > 0 && list > 0, "markup anchors not found");
  assert.ok(more < list, "the load-older control is below the list again");
});

test("transcript: first paint loads a window, not the whole history", () => {
  const m = /const SIGNAL_PAGE_SIZE = (\d+);/.exec(src);
  assert.ok(m, "SIGNAL_PAGE_SIZE not found");
  const size = Number(m[1]);
  assert.ok(size >= 20 && size <= 30, `page size ${size} is outside the requested 20-30`);
});

test("transcript: image and generic attachments share one card renderer and download path", () => {
  const renderer = src.slice(
    src.indexOf("const renderMessageAttachments"),
    src.indexOf("const renderFeed ="),
  );
  assert.match(renderer, /dataset\.attachmentKind = inlineImage \? "image" : "file"/);
  assert.match(renderer, /dashboard__attachment-card--image/);
  assert.match(renderer, /download\.textContent = "Download"/);
  assert.match(renderer, /freshAttachmentDownload/);
  assert.match(src, /renderMessageAttachments\(body, signal\)/);
});

test("transcript: image bytes load only after their card reaches the visible feed", () => {
  const renderer = src.slice(
    src.indexOf("const renderMessageAttachments"),
    src.indexOf("const renderFeed ="),
  );
  const observerAt = renderer.indexOf("new IntersectionObserver");
  const downloadAt = renderer.indexOf("await freshAttachmentDownload");
  assert.ok(observerAt > 0 && downloadAt > 0, "lazy image anchors are missing");
  assert.match(renderer, /entry\.isIntersecting/);
  assert.match(renderer, /observer\.disconnect\(\)/);
  assert.match(renderer, /root: feedScroller\(\)/);
  assert.doesNotMatch(renderer.slice(0, observerAt), /void load\(\)/);
});
