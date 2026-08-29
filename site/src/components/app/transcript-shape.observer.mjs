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
  assert.match(
    src,
    /for \(const signal of \[\.\.\.visibleSignals\]\.reverse\(\)\)/,
    "the display reversal is gone — newest would render at the top again",
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
    /visualViewport\?\.addEventListener\("resize", syncDashboardViewport\)/,
    "software-keyboard viewport changes no longer reach the shell",
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
