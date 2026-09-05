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

type Rect = {
  bottom: number;
  height: number;
  left: number;
  right: number;
  top: number;
  width: number;
};

type LayoutMeasurement = {
  combinedHeaderHeight: number;
  composer: Rect;
  header: Rect;
  input: Rect;
  send: Rect;
  toolbar: Rect;
  menu: {
    bottom: number;
    items: Array<{ bottom: number; label: string; top: number }>;
    top: number;
  };
  transcriptToHeaderRatio: number;
  transcriptVisibleHeight: number;
  feedListPaddingBlockStart: string;
  feedMore: Rect | null;
  feedMoreToFirstRowGap: number | null;
  feedViewScrollTop: number;
  firstRow: Rect | null;
  viewport: { height: number; width: number };
  shell: {
    app: Rect;
    channel: Rect;
    channelBody: Rect;
    frame: Rect;
    product: Rect;
    root: Rect;
  };
};

const contentTypes: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
};

const revertedStyles = `<style>
  .dashboard__channel-head {
    min-block-size: 6.25rem;
    gap: var(--s-3) var(--s-6);
    padding: var(--s-4) clamp(var(--s-5), 4vw, var(--s-8));
  }
  .dashboard__feed-toolbar { min-block-size: 3.25rem; }
  .dashboard__composer-status:empty { display: block; }
  @media (max-width: 52rem) {
    .dashboard__channel-head {
      min-block-size: 5.5rem;
      padding: var(--s-4);
    }
    .dashboard__channel-titleblock { order: 1; }
    .dashboard__channel-actions {
      order: 2;
      margin-inline-start: auto;
    }
    .dashboard__channel-roster {
      order: 3;
      flex: 1 1 100%;
      margin-inline-start: 0;
    }
    .dashboard__channel--roster .dashboard__channel-body {
      min-block-size: calc(100svh - 5.5rem - 4.5rem - 3.5rem);
    }
    .dashboard__channel-body {
      min-block-size: calc(100svh - 5.5rem - 4.5rem);
    }
  }
  @media (max-width: 52rem) {
    /* The 2026-09-04 change put the channel head OUT of the flow and took the filter row's
       height back with a negative margin. This is the state before it: both are rows again,
       and the transcript starts below all three bars. */
    .dashboard__channel {
      position: static;
      grid-template-rows: auto minmax(0, 1fr);
    }
    .dashboard__channel-head {
      position: static;
      min-block-size: 4.75rem;
      justify-content: space-between;
      flex-wrap: wrap;
      padding: var(--s-3) var(--s-4);
      border-block-end: 1px solid var(--border);
      pointer-events: auto;
    }
    .dashboard__channel-titleblock {
      position: static;
      inline-size: auto;
      block-size: auto;
      margin: 0;
      overflow: visible;
      clip-path: none;
    }
    .dashboard__feed-toolbar {
      margin-block-end: 0;
      border-block-end: 1px solid var(--border);
    }
    .dashboard__feed { padding-block-start: 0; }
  }
  @media (max-width: 34rem) {
    .dashboard__channel-head {
      display: flex;
      align-items: flex-start;
      flex-direction: column;
      flex-wrap: nowrap;
      gap: var(--s-3);
    }
    .dashboard__channel-description { line-height: var(--lh-xs); }
    .dashboard__channel-actions {
      order: 2;
      margin-inline-start: auto;
    }
    .dashboard__channel-roster {
      order: 3;
    }
  }
</style>`;

const frameScript = (
  reverted: boolean,
  empty: boolean,
  pending: boolean,
  more: boolean,
): string => `<script>
  const frame = document.querySelector("iframe");
  const reportError = (value) => {
    document.documentElement.dataset.layoutError = btoa(String(value));
  };
  const runMeasurement = async () => {
    const doc = frame.contentDocument;
    const view = frame.contentWindow;
    const settle = () => new Promise((resolve) => view.setTimeout(resolve, 80));
    ${reverted ? `doc.head.insertAdjacentHTML("beforeend", ${JSON.stringify(revertedStyles)});` : ""}
    const app = doc.querySelector("live-dashboard");
    app.dataset.state = "channel";
    doc.querySelectorAll(".dashboard__root > [data-panel]").forEach((panel) => {
      panel.hidden = panel.dataset.panel !== "channel";
    });
    doc.querySelectorAll("[data-channel-view]").forEach((section) => {
      section.hidden = section.dataset.channelView !== ${JSON.stringify(empty ? "feed-empty" : "feed")};
    });
    doc.querySelector(".dashboard__channel").classList.add("dashboard__channel--roster");
    const roster = doc.querySelector("[data-header-roster]");
    roster.hidden = false;
    /* "0 · 3 pending" is the widest label this pill ever carries, and it is the state that
       broke the one-row header: it wrapped, took the bar to two lines, and left the channel
       name at 0px. */
    doc.querySelector("[data-header-roster-summary]").textContent =
      ${JSON.stringify(pending ? "0 · 3 pending" : "8")};
    const live = doc.querySelector("[data-live-chip]");
    live.hidden = false;
    const updates = doc.querySelector("[data-update-count]");
    updates.hidden = false;
    updates.textContent = "25+ updates";
    doc.querySelector("[data-refresh]").hidden = false;
    /* "Load older updates" sits BETWEEN the floating band and the list, so when it is showing
       it is the element that clears the band and the list must not clear it a second time. */
    doc.querySelector("[data-feed-more]").hidden = ${JSON.stringify(!more)};
    const composer = doc.querySelector("[data-composer]");
    composer.hidden = false;
    const list = doc.querySelector("[data-feed-list]");
    list.replaceChildren(...Array.from({ length: ${empty ? 0 : 40} }, (_, index) => {
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
      message.textContent = "Rendered transcript row " + (index + 1) +
        " with enough copy to exercise live feed geometry.";
      meta.append(author);
      body.append(meta, message);
      row.append(avatar, body);
      return row;
    }));
    await doc.fonts.ready;
    await settle();
    const rect = (selector) => {
      const box = doc.querySelector(selector).getBoundingClientRect();
      return {
        bottom: box.bottom,
        height: box.height,
        left: box.left,
        right: box.right,
        top: box.top,
        width: box.width,
      };
    };
    /* The account popover is a grid. A stray placement on any item reorders what the reader
       sees while DOM and focus order stay put, and on a phone this menu is the only Sign out.
       Open it and report each item in DOM order, so a text grep is not the control. */
    doc.querySelector("[data-user-menu-trigger]").click();
    await settle();
    const menuBox = doc.querySelector("[data-user-menu]").getBoundingClientRect();
    const menuItems = [...doc.querySelector("[data-user-menu]").children].map((item) => ({
      label: (item.textContent || "").trim().slice(0, 20),
      top: item.getBoundingClientRect().top,
      bottom: item.getBoundingClientRect().bottom,
    }));
    const menu = {
      bottom: menuBox.bottom,
      items: menuItems,
      top: menuBox.top,
    };
    doc.querySelector("[data-user-menu-trigger]").click();
    await settle();
    const feedMore = doc.querySelector("[data-feed-more]");
    const firstRow = doc.querySelector("[data-feed-list] > li");
    const header = rect(".dashboard__channel-head");
    const toolbar = rect(".dashboard__feed-toolbar");
    const composerBox = rect("[data-composer]");
    const combinedHeaderHeight = toolbar.bottom - header.top;
    const transcriptVisibleHeight = composerBox.top - toolbar.bottom;
    document.documentElement.dataset.layoutMeasurement = btoa(JSON.stringify({
      combinedHeaderHeight,
      composer: composerBox,
      feedListPaddingBlockStart:
        view.getComputedStyle(doc.querySelector("[data-feed-list]")).paddingBlockStart,
      feedMore: feedMore.hidden ? null : rect("[data-feed-more]"),
      feedViewScrollTop: doc.querySelector(".dashboard__feed-view").scrollTop,
      feedMoreToFirstRowGap: feedMore.hidden || !firstRow
        ? null
        : firstRow.getBoundingClientRect().top - feedMore.getBoundingClientRect().bottom,
      firstRow: firstRow ? rect("[data-feed-list] > li") : null,
      header,
      input: rect(".dashboard__composer-input"),
      menu,
      send: rect("[data-composer-send]"),
      toolbar,
      transcriptToHeaderRatio: transcriptVisibleHeight / combinedHeaderHeight,
      transcriptVisibleHeight,
      viewport: { height: view.innerHeight, width: view.innerWidth },
      shell: {
        app: rect("live-dashboard"),
        channel: rect(".dashboard__channel"),
        channelBody: rect(".dashboard__channel-body"),
        frame: rect(".dashboard__frame"),
        product: rect(".dashboard__product"),
        root: rect(".dashboard__root"),
      },
    }));
  };
  const start = () => void runMeasurement().catch((error) => reportError(error?.stack ?? error));
  frame.addEventListener("load", start, { once: true });
  if (frame.contentDocument?.readyState === "complete" && frame.contentWindow?.location.pathname === "/app") start();
</script>`;

const startDistServer = async (): Promise<{ close(): Promise<void>; origin: string }> => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__measure") {
      const width = Number.parseInt(url.searchParams.get("width") ?? "", 10);
      const height = Number.parseInt(url.searchParams.get("height") ?? "", 10);
      const reverted = url.searchParams.get("reverted") === "1";
      const empty = url.searchParams.get("empty") === "1";
      const pending = url.searchParams.get("pending") === "1";
      const more = url.searchParams.get("more") === "1";
      if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height)) {
        response.writeHead(400).end("Invalid measurement");
        return;
      }
      response.writeHead(200, { "content-type": contentTypes[".html"] });
      response.end(
        `<!doctype html><html><body style="margin:0"><iframe title="Layout measurement viewport" src="/app" style="border:0;width:${width}px;height:${height}px"></iframe>${frameScript(reverted, empty, pending, more)}</body></html>`,
      );
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
  assert.ok(address && typeof address !== "string", "layout observer server must bind a port");
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
  height: number,
  reverted: boolean,
  empty = false,
  pending = false,
  more = false,
): Promise<LayoutMeasurement> => {
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
    `${origin}/__measure?width=${width}&height=${height}&reverted=${reverted ? 1 : 0}&empty=${empty ? 1 : 0}&pending=${pending ? 1 : 0}&more=${more ? 1 : 0}`,
  ], {
    maxBuffer: 10 * 1024 * 1024,
    timeout: 20_000,
    killSignal: "SIGKILL",
  });
  const encoded = stdout.match(/data-layout-measurement="([^"]+)"/)?.[1];
  const encodedError = stdout.match(/data-layout-error="([^"]+)"/)?.[1];
  assert.ok(
    encoded,
    `${width}x${height}: Chrome did not return layout measurements\n` +
      `page error: ${encodedError ? Buffer.from(encodedError, "base64").toString("utf8") : "none"}\n` +
      `stderr: ${stderr.slice(-1_000)}\nDOM: ${stdout.slice(-2_000)}`,
  );
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8")) as LayoutMeasurement;
};

/* THE OPERATOR'S RULE (2026-09-04), stated against the bars themselves rather than a magic
 * number: on a phone the ENTIRE header is no taller than the workspace bar — the row with the
 * workspace name and the account control. So the only thing between the top of the screen and
 * the top of the transcript is that bar. The channel head and the filter row are painted OVER
 * the transcript and take none of its height.
 *
 * The app bar's height IS the channel section's top edge, and the transcript's own box is
 * `shell.channelBody`, so the whole rule is one comparison of two measured edges. Measured
 * before the change at 390x844: a 73px bar, a 53px head and a 45px filter row — 171px of
 * header on an 844px screen, and the transcript began at 126px. After it: 73px and 73px. */
const assertPhoneHeaderRule = (measurement: LayoutMeasurement, width: number): void => {
  const appBar = measurement.shell.channel.top;
  /* Positive control on the same invocation: without a real app bar the comparison below is
   * satisfied by two zeroes, so it would pass hardest when nothing rendered at all. */
  assert.ok(
    appBar >= 40 && appBar <= 100,
    `${width}px density: the app bar is not a one-row bar (${appBar}px), so the rule below ` +
      `is not measuring anything: ${JSON.stringify(measurement.shell)}`,
  );
  assert.ok(
    measurement.shell.channelBody.top <= appBar + 0.5,
    `${width}px density: ${measurement.shell.channelBody.top}px of header sits above the ` +
      `transcript, which is taller than the ${appBar}px workspace bar`,
  );
  /* The head must FLOAT, not vanish: the roster pill inside it is the only door to agent
   * management on a phone, and a zero-height head would satisfy the rule above by deleting it. */
  assert.ok(
    measurement.header.height > 0 && measurement.header.top >= appBar - 0.5,
    `${width}px density: the channel head is gone rather than floating over the transcript: ` +
      JSON.stringify(measurement.header),
  );
  /* FLOATING IS NOT FREE AT REST. The transcript scrolls UNDER the band, which is the point,
   * but the first message must start below ALL of it before anybody scrolls. The band's two
   * parts are not the same height — the filter row is 2.5rem and the roster cluster 3.25rem —
   * and the clearance used to be the shorter one, so 12px of the first row sat under the pill.
   * Positive control first: this measures nothing if the feed is already scrolled or empty. */
  assert.equal(
    measurement.feedViewScrollTop,
    0,
    `${width}px density: the transcript is already scrolled, so "at rest" is not what was measured`,
  );
  assert.ok(
    measurement.firstRow !== null && measurement.firstRow.height > 0,
    `${width}px density: there is no first message, so the clearance below measures nothing`,
  );
  assert.ok(
    measurement.firstRow.top >= measurement.header.bottom - 0.5,
    `${width}px density: ${(measurement.header.bottom - measurement.firstRow.top).toFixed(1)}px ` +
      "of the first message sits under the floating roster pill at rest: " +
      JSON.stringify({ firstRow: measurement.firstRow, header: measurement.header }),
  );
  assert.ok(
    measurement.firstRow.top >= measurement.toolbar.bottom - 0.5,
    `${width}px density: the first message sits under the floating filter row at rest: ` +
      JSON.stringify({ firstRow: measurement.firstRow, toolbar: measurement.toolbar }),
  );
  assert.ok(
    measurement.transcriptVisibleHeight >= 600,
    `${width}px density: transcript is too short: ${JSON.stringify(measurement)}`,
  );
};

const assertDensity = (measurement: LayoutMeasurement, width: number): void => {
  /* The later composer sprint added the visible TO and keyboard-hint rows. The
   * accepted empty composer leaves 607.9px of transcript at 1440x900. This floor keeps a
   * small regression margin while the reverted-density control below still has to fail. */
  if (width !== 1440) {
    assertPhoneHeaderRule(measurement, width);
    return;
  }
  /* headerMax is deliberately LOOSER than the measurement (125, not 115) so a reverted variant
   * still reaches the transcript and ratio floors below rather than stopping at the band. */
  const limits = { headerMax: 125, headerMin: 110, ratioMin: 5, transcriptMin: 600 };
  assert.ok(
    measurement.combinedHeaderHeight >= limits.headerMin &&
      measurement.combinedHeaderHeight <= limits.headerMax,
    `${width}px density: header is outside its usable band: ${JSON.stringify(measurement)}`,
  );
  assert.ok(
    measurement.transcriptVisibleHeight >= limits.transcriptMin,
    `${width}px density: transcript is too short: ${JSON.stringify(measurement)}`,
  );
  assert.ok(
    measurement.transcriptToHeaderRatio >= limits.ratioMin,
    `${width}px density: transcript/header ratio is too low: ${JSON.stringify(measurement)}`,
  );
};

const assertInsideViewport = (measurement: LayoutMeasurement): void => {
  for (const [name, rect] of Object.entries({
    composer: measurement.composer,
    input: measurement.input,
    send: measurement.send,
  })) {
    assert.ok(
      rect.bottom <= measurement.viewport.height + 0.1 &&
        rect.left >= -0.1 &&
        rect.right <= measurement.viewport.width + 0.1,
      `${name} is outside the viewport: ${JSON.stringify({ rect, viewport: measurement.viewport })}`,
    );
  }
};

test("the live feed header stays compact and the narrow composer stays in view", async () => {
  const chrome = await findChrome();
  const server = await startDistServer();
  try {
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      const current = await measureAt(chrome, server.origin, width, height, false);
      const reverted = await measureAt(chrome, server.origin, width, height, true);
      assert.equal(current.viewport.width, width, `${width}px iframe width drifted`);
      assert.equal(current.viewport.height, height, `${width}px iframe height drifted`);
      assertDensity(current, width);
      assertInsideViewport(current);
      /* On mobile the reverted body extends below the viewport, so its raw
       * transcript rectangle is larger while unusable. The viewport assertion
       * below is the discriminating mobile control; density gain is meaningful
       * only while both variants remain inside the desktop viewport. */
      if (width === 1440) {
        assert.ok(
          current.transcriptVisibleHeight >= reverted.transcriptVisibleHeight + 30,
          `${width}px: transcript did not gain at least 30px: ${JSON.stringify({ current, reverted })}`,
        );
      }
      assert.ok(
        current.combinedHeaderHeight <= reverted.combinedHeaderHeight - 25,
        `${width}px: header did not lose at least 25px: ${JSON.stringify({ current, reverted })}`,
      );
      assert.throws(
        () => assertDensity(reverted, width),
        /density/,
        `${width}px: reverted density unexpectedly passed`,
      );
      if (width === 390) {
        assert.throws(
          () => assertInsideViewport(reverted),
          /outside the viewport/,
          "390px: reverted composer unexpectedly fit inside the viewport",
        );
      }
      console.log(`mobile-feed-layout ${width}px ${JSON.stringify({ current, reverted })}`);
    }
  } finally {
    await server.close();
  }
});

/* A separate case, not another width in the loop above: the short-viewport block at 36rem of
   height changes the composer and the head's padding, and the smallest phone is where a floor
   that is 8px too generous stops fitting. Found by measuring: the short-viewport block once put
   the taller padding back and made the head 61px against a 57px app bar. The transcript floor
   in the shared rule does not apply at 568px of screen, so this case asserts the rule's other
   three parts and the viewport containment. */
test("the smallest phone keeps the whole header inside the app bar row", async () => {
  const chrome = await findChrome();
  const server = await startDistServer();
  try {
    /* With the pending label, which is the widest the roster pill gets. */
    const measurement = await measureAt(chrome, server.origin, 320, 568, false, false, true);
    assert.deepEqual(measurement.viewport, { width: 320, height: 568 });
    const appBar = measurement.shell.channel.top;
    assert.ok(
      appBar >= 40 && appBar <= 100,
      `320x568: the app bar is not a one-row bar (${appBar}px), so the rule below is not ` +
        `measuring anything: ${JSON.stringify(measurement.shell)}`,
    );
    assert.ok(
      measurement.shell.channelBody.top <= appBar + 0.5,
      `320x568: ${measurement.shell.channelBody.top}px of header sits above the transcript, ` +
        `which is taller than the ${appBar}px workspace bar`,
    );
    assert.ok(
      measurement.header.height > 0 && measurement.header.top >= appBar - 0.5,
      `320x568: the channel head is gone rather than floating: ${JSON.stringify(measurement.header)}`,
    );
    assertInsideViewport(measurement);
    console.log(`mobile-feed-layout 320px ${JSON.stringify(measurement)}`);
  } finally {
    await server.close();
  }
});

/* A live control, because a text grep is not one: `grid-area`, `order`, or a grouped selector
   can reorder this menu without matching any pattern. What must hold is that the reader sees
   the items in the order the DOM and the focus ring use, and that the whole menu is on screen —
   on a phone this popover is the only Sign out there is. */
test("the account menu paints in DOM order and stays on screen at phone widths", async () => {
  const chrome = await findChrome();
  const server = await startDistServer();
  try {
    for (const [width, height] of [[390, 844], [320, 568]]) {
      const measurement = await measureAt(chrome, server.origin, width, height, false);
      const { items } = measurement.menu;
      assert.ok(items.length >= 3, `${width}px: the account menu is missing items`);
      /* Positive control on the same invocation. A closed popover reports zeroes for every
         rectangle, and zeroes satisfy the ordering test below — so without this the control
         would pass hardest exactly when the menu never opened. */
      assert.ok(
        measurement.menu.bottom - measurement.menu.top > 0,
        `${width}px: the account menu did not open, so nothing below was measured`,
      );
      for (const item of items) {
        assert.ok(
          item.bottom - item.top > 0,
          `${width}px: the account menu item "${item.label}" has no box: ${JSON.stringify(items)}`,
        );
      }
      for (const [index, item] of items.entries()) {
        const previous = items[index - 1];
        if (previous) {
          assert.ok(
            item.top >= previous.bottom - 0.1,
            `${width}px: the account menu paints "${item.label}" above "${previous.label}", ` +
              `which is not the order the DOM and the focus ring use: ${JSON.stringify(items)}`,
          );
        }
      }
      assert.ok(
        measurement.menu.top >= -0.1 && measurement.menu.bottom <= height + 0.1,
        `${width}px: the account menu is outside the viewport: ${JSON.stringify(measurement.menu)}`,
      );
    }
  } finally {
    await server.close();
  }
});

test("an empty feed keeps the app shell at the dynamic viewport height", async () => {
  const chrome = await findChrome();
  const server = await startDistServer();
  try {
    for (const [width, height] of [[1440, 900], [390, 844]]) {
      const measurement = await measureAt(chrome, server.origin, width, height, false, true);
      assert.deepEqual(measurement.viewport, { width, height });
      for (const name of ["app", "root", "product"] as const) {
        const rect = measurement.shell[name];
        assert.ok(
          Math.abs(rect.height - height) <= 0.1 &&
            Math.abs(rect.top) <= 0.1 &&
            Math.abs(rect.bottom - height) <= 0.1,
          `${width}x${height}: ${name} does not fill the empty app viewport: ${JSON.stringify(rect)}`,
        );
      }
      /* The frame is product grid row 2, below the product header. Requiring its
       * top to be viewport row 0 contradicts that layout. It must fill the
       * remaining row to the viewport bottom, like its channel children. */
      for (const name of ["frame", "channel", "channelBody"] as const) {
        const rect = measurement.shell[name];
        assert.ok(
          rect.height > 0 && Math.abs(rect.bottom - height) <= 0.1,
          `${width}x${height}: ${name} does not flex to the viewport bottom: ${JSON.stringify(rect)}`,
        );
      }
      assert.equal(measurement.composer.bottom, height);
      console.log(`empty-app-shell ${width}x${height} ${JSON.stringify(measurement.shell)}`);
    }
  } finally {
    await server.close();
  }
});

/* The floating band costs the reading area nothing only if its clearance is paid ONCE. Three
   elements agree on 2.5rem: the filter row's height, the negative margin that takes that height
   back out of the flow, and the top padding that keeps the first thing under the band clear of
   it. "Load older updates" sits BETWEEN the band and the list, so when it is showing it is the
   element that clears the band — and the list's own clearance becomes dead screen between the
   button and the first message. Found by measuring at 390x844: a 40px gap. */
test("the floating band's clearance is paid once when older updates can be loaded", async () => {
  const chrome = await findChrome();
  const server = await startDistServer();
  try {
    const withMore = await measureAt(chrome, server.origin, 390, 844, false, false, false, true);
    const withoutMore = await measureAt(chrome, server.origin, 390, 844, false, false, false, false);
    /* Positive control on the same invocation: with no visible button there is nothing to pay
       twice, so every assertion below would be satisfied by a knob that did nothing. */
    assert.ok(
      withMore.feedMore !== null && withMore.feedMore.height > 0,
      `load-older is not on screen, so this case measures nothing: ${JSON.stringify(withMore.feedMore)}`,
    );
    assert.equal(
      withoutMore.feedMore,
      null,
      "load-older is showing in the variant that must not show it",
    );
    /* The clearance still exists — it just belongs to whichever element is first under the band. */
    assert.notEqual(
      withoutMore.feedListPaddingBlockStart,
      "0px",
      "with no load-older button the list itself must clear the floating band",
    );
    assert.equal(
      withMore.feedListPaddingBlockStart,
      "0px",
      "the band's clearance is paid twice: load-older already cleared it and the list clears it " +
        `again (${withMore.feedListPaddingBlockStart})`,
    );
    assert.ok(
      withMore.feedMoreToFirstRowGap !== null && withMore.feedMoreToFirstRowGap < 20,
      `${withMore.feedMoreToFirstRowGap}px of dead screen sits between load-older and the first ` +
        "message",
    );
    /* The rule the whole block exists for still holds while the button is up. */
    assertPhoneHeaderRule(withMore, 390);
    assertInsideViewport(withMore);
    console.log(`feed-more-clearance ${JSON.stringify({
      gap: withMore.feedMoreToFirstRowGap,
      withMore: withMore.feedListPaddingBlockStart,
      withoutMore: withoutMore.feedListPaddingBlockStart,
    })}`);
  } finally {
    await server.close();
  }
});
