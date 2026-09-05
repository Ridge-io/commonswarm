/**
 * The thread surface of the workspace app, measured in real Chrome against the built `/app` in
 * sample mode, plus the source and wire claims a browser cannot see.
 *
 * Reached by `npm --prefix site test` through the recursive component-observer glob.
 *
 * The claims this file defends, stated so a reader can check them against the system rather
 * than against another artifact that repeats them:
 *   1. The reply control is offered exactly where `resolveThreadRoot` would accept the root.
 *   2. Replies render COLLAPSED under their root, with a count that expands them in place.
 *   3. The reply bar names the root and the channel the root is in, and offers
 *      `broadcast_to_channel` only where there is a channel to broadcast to.
 *   4. A thread reply carries NO recipient: the To: row says so and is locked, and the wire
 *      body carries no `to`.
 *   5. Threads and the channel filter COMPOSE: a reply in #mobile reads under its root in
 *      #mobile and again in all-signals.
 *
 * WHAT THIS FILE DOES NOT ESTABLISH. Nothing here touches production or a real workspace: the
 * page runs in sample mode, so a reply is a local row and not a `post_signal`. The wire claim
 * below is about the body this client BUILDS, taken from the exported builder, compared byte
 * for byte against the bodies `tests/p1-server/chat-signals.test.ts` sends to a served edge.
 * That suite is where the server answers for the shape, and it needs a local Supabase this
 * lane did not take.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { dirname, extname, join, normalize } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { test } from "node:test";
import { findChrome } from "./participant-rail.fixture.js";
import { browserSignalCommand, browserSignalKind } from "../../lib/commonswarm.js";
import {
  THREAD_REPLY_TO_TEXT,
  THREAD_ROOT_BLOCKS,
  threadReplyBroadcastLabel,
  threadReplyCountLabel,
  threadReplyTargetText,
  threadRootBlockText,
} from "../../lib/thread-reply.js";

const run = promisify(execFile);
const componentDir = dirname(fileURLToPath(import.meta.url));
const siteRoot = join(componentDir, "..", "..", "..");
const repoRoot = join(siteRoot, "..");
const distRoot = process.env.COMMONSWARM_THREADS_DIST_ROOT ?? join(siteRoot, "dist");
const dashboard = readFileSync(join(componentDir, "LiveDashboard.astro"), "utf8");
const commandEdge = readFileSync(
  join(repoRoot, "supabase", "functions", "command", "index.ts"),
  "utf8",
);
const serverSuite = readFileSync(
  join(repoRoot, "tests", "p1-server", "chat-signals.test.ts"),
  "utf8",
);
const appHtml = readFileSync(join(siteRoot, "dist", "app", "index.html"), "utf8");

const between = (source: string, start: string, end: string): string => {
  const startAt = source.indexOf(start);
  assert.notEqual(startAt, -1, `missing start anchor: ${start}`);
  const endAt = source.indexOf(end, startAt + start.length);
  assert.notEqual(endAt, -1, `missing end anchor: ${end}`);
  return source.slice(startAt, endAt);
};

/* ────────────────────────────────────────────────────────────────────────────────────────
 * THE WIRE
 * ──────────────────────────────────────────────────────────────────────────────────────── */

/**
 * The EXACT body `tests/p1-server/chat-signals.test.ts` sends, read from that file rather than
 * retyped here, so the two cannot drift. `installedPost` is the body every installed client
 * sends; its extras are what each thread test adds.
 */
const installedPostBody = (extra: Record<string, unknown> = {}): Record<string, unknown> => {
  const helper = between(serverSuite, "function installedPost(", "function signalOf");
  /* A POSITIVE CONTROL ON THE READ. If the helper moved or was renamed, the keys below would
     be an empty set and every comparison would pass vacuously. */
  const keys = [...helper.matchAll(/^\s{4}([a-z_]+):/gm)].map((match) => match[1]!);
  assert.deepEqual(
    keys.sort(),
    [
      "about",
      "body",
      "in_reply_to",
      "kind",
      "signal_kind",
      "to_agent_principal_id",
      "to_user_id",
    ],
    "the p1-server installed body is not the shape this file compares against",
  );
  return {
    kind: "post_signal",
    signal_kind: "note",
    body: "BODY",
    to_user_id: null,
    about: null,
    to_agent_principal_id: null,
    in_reply_to: null,
    ...extra,
  };
};

const ROOT_ID = "44444444-4444-4444-8444-444444444444";

test("a thread reply's body is the installed body plus thread_root_id, and nothing else", () => {
  const command = browserSignalCommand("BODY", [], browserSignalKind([]), [], {
    threadRootId: ROOT_ID,
  });
  assert.deepEqual(command, installedPostBody({ thread_root_id: ROOT_ID }));
  /* THE KEY SET MATTERS AS MUCH AS THE VALUES: the command edge refuses any key it did not
     expect, and `chatSignalKeys` groups each optional chat key on its own `Object.hasOwn`
     test. A key sent as an explicit null would 400 the post. */
  assert.deepEqual(
    Object.keys(command).sort(),
    Object.keys(installedPostBody({ thread_root_id: ROOT_ID })).sort(),
  );
  /* AND NO RECIPIENT. `chatSignalShapeProblem` refuses a thread reply that also carries one,
     so a `to` key here is a 400 on every reply this browser sends. */
  assert.equal(Object.hasOwn(command, "to"), false);
  assert.equal(command.signal_kind, "note", "and a reply is never working-on");
});

test("broadcast_to_channel reaches the wire only when it is asked for", () => {
  const asked = browserSignalCommand("BODY", [], browserSignalKind([]), [], {
    threadRootId: ROOT_ID,
    broadcastToChannel: true,
  });
  assert.deepEqual(
    asked,
    installedPostBody({ thread_root_id: ROOT_ID, broadcast_to_channel: true }),
  );
  /* NOT ASKED MEANS NOT SENT, which is the shape `cswarm reply --thread` sends without the
     flag and the shape every installed client sends. `false` on the wire is legal and means
     the same thing; sending nothing keeps the key set the smallest statement of what was
     asked, and the browser's placement is built so the key cannot appear as `false`. */
  const unasked = browserSignalCommand("BODY", [], browserSignalKind([]), [], {
    threadRootId: ROOT_ID,
  });
  assert.equal(Object.hasOwn(unasked, "broadcast_to_channel"), false);
});

test("a top-level post still sends no thread fields at all", () => {
  const command = browserSignalCommand("BODY", [], browserSignalKind([]), [], {});
  assert.deepEqual(command, installedPostBody());
  assert.equal(Object.hasOwn(command, "thread_root_id"), false);
  assert.equal(Object.hasOwn(command, "broadcast_to_channel"), false);
});

test("the four rules the reply control follows are the four arms the edge enforces", () => {
  /* THE SET, ENUMERATED RATHER THAN PATTERN-MATCHED. `resolveThreadRoot`'s WHERE has three
     arms and the archive check that follows it is the fourth; the browser's classifier returns
     one member of THREAD_ROOT_BLOCKS for each. This is a source read of the edge, and its
     bound is stated: it looks for four exact clauses inside `resolveThreadRoot` alone. It
     cannot see a rule moved elsewhere or written differently, and a rewrite of that kind makes
     one of these counts zero and this test red, which is the outcome that matters. */
  const resolve = between(commandEdge, "async function resolveThreadRoot(", "\n}\n");
  const clauses: Record<string, string> = {
    directed: "AND s.to_user_id IS NULL",
    "already-a-reply": "if (root.thread_root_id !== null)",
    expiring: "AND s.until > statement_timestamp() + interval '1 second'",
    "channel-archived": "if (root.channel_archived_at !== null)",
  };
  assert.deepEqual(
    Object.keys(clauses).sort(),
    [...THREAD_ROOT_BLOCKS].sort(),
    "the browser knows a rule the edge does not, or the other way round",
  );
  for (const [block, clause] of Object.entries(clauses)) {
    assert.equal(
      resolve.split(clause).length - 1,
      1,
      `${block}: expected exactly one \`${clause}\` in resolveThreadRoot`,
    );
  }
  /* And the second recipient column, which is the other half of the directed arm. */
  assert.match(resolve, /AND s\.to_agent_principal_id IS NULL/);
});

/* ────────────────────────────────────────────────────────────────────────────────────────
 * THE SOURCE
 * ──────────────────────────────────────────────────────────────────────────────────────── */

test("the reply control asks the classifier, and asks it about the ROW's channel", () => {
  const rowBuilder = between(
    dashboard,
    "const buildMessageRow = (signal: Signal, isReply: boolean)",
    "row.append(avatar, body);",
  );
  assert.match(
    rowBuilder,
    /if \(!isReply && canStartThread\(signal, now, rootChannel\?\.archivedAt != null\)\) \{/,
  );
  /* NOT `rowChannel`, WHICH IS A DIFFERENT QUESTION. That one is deliberately null whenever the
     feed is narrowed to a channel, because a row's place is only worth printing in all-signals;
     reusing it read every row inside a channel as unarchived and offered the control on threads
     the server refuses. The compiler caught the name collision; this keeps them apart. */
  assert.match(rowBuilder, /const rootChannel = channelById\(channels, signal\.channelId\);/);
  assert.match(
    rowBuilder,
    /const rowChannel = activeChannelId === null && signal\.channelId !== null/,
    "the place chip's own question is unchanged",
  );
  /* AND THE ROOT'S CHANNEL IS CAPTURED, not read again at send time from a live global. */
  assert.match(rowBuilder, /channelId: signal\.channelId,\s*\n\s*until: signal\.until,/);
  /* AND NOT WHILE A MESSAGE IS ON THE WIRE, the same rule the chips follow. */
  assert.match(rowBuilder, /if \(composerSending\) return;/);
});

test("the send never re-reads the reply from a global after its first await", () => {
  const submit = between(dashboard, "const replyRoot = threadReplyRoot;", "} finally {");
  /* THE FREEZE. Everything else this send captures is frozen for the whole post; the reply is
     too, so a cancel or a second reply opened mid-post cannot change where the message on the
     wire is going. The only `threadReplyRoot` left in the submit is the guarded close on
     success, which NAMES this send's own reply. */
  /* TWO reads, and both are named: the capture that opens this slice, and the guarded close on
     success. Any third is the send reaching for a live global after its first await, which is
     the shape of defect this file's siblings found six times. */
  const reads = [...submit.matchAll(/threadReplyRoot/g)];
  assert.equal(reads.length, 2, "the send reads threadReplyRoot somewhere new");
  assert.match(submit, /^const replyRoot = threadReplyRoot;/);
  assert.match(submit, /if \(replyRoot !== null && threadReplyRoot\?\.id === replyRoot\.id\) \{/);
  assert.match(submit, /setThreadReplyRoot\(null\);/);
});

test("a reply does not overwrite the set the last message went to", () => {
  const submit = between(dashboard, "const replyRoot = threadReplyRoot;", "} finally {");
  /* `rememberComposerTo([])` REMOVES the stored set, so an unguarded call would have wiped the
     recipients of the reader's last real message every time they replied in a thread, and the
     next message would have opened as a broadcast. */
  assert.match(
    submit,
    /if \(placementThreadRootId === null\) rememberComposerTo\(recipients, sendToKey\);/,
  );
});

test("the To: row draws the set the send posts, and is locked while a reply is written", () => {
  const render = between(
    dashboard,
    "const renderComposerTo = (): void => {",
    "\n    };",
  );
  assert.match(render, /const shown = composerRecipients\(\);/);
  assert.match(render, /row\.toggleAttribute\("data-composer-to-locked", replying\);/);
  assert.match(render, /note\.textContent = THREAD_REPLY_TO_TEXT;/);
  /* THE LOCK IS THE HOLD, not a second write path. Nothing in the row assigns the pair. */
  assert.doesNotMatch(render, /composerTo = |composerToApplied = |rememberComposerTo\(/);
  /* AND THE CHIP EDIT SURFACE IS UNREACHABLE, because there are no chips to click: the render
     returns before it builds any. */
  const beforeChips = render.slice(0, render.indexOf("for (const entity of shown)"));
  assert.match(beforeChips, /if \(replying\) \{[\s\S]*?return;\s*\n\s*\}/);
});

test("the app ships the reply bar, its window line and its broadcast control", () => {
  /* THE BUILT ARTIFACT, not the source: Astro has to have shipped the markup. */
  assert.match(appHtml, /data-composer-reply\b/);
  assert.match(appHtml, /data-composer-reply-target-text/);
  assert.match(appHtml, /data-composer-reply-window/);
  assert.match(appHtml, /data-composer-reply-broadcast-row/);
  assert.match(appHtml, /data-composer-reply-cancel/);
  /* AND IT IS HIDDEN AT REST, so the composer at rest is the bar the phone budget measured. */
  assert.match(appHtml, /data-composer-reply hidden/);
  assert.match(appHtml, /data-composer-reply-broadcast-row hidden/);
  /* THE BROADCAST LABEL IS EMPTY IN THE MARKUP and written from the channel's slug at sync
     time. A label typed into the HTML could not name the channel it would send to. */
  assert.match(appHtml, /<span data-composer-reply-broadcast-label><\/span>/);
});

/* ────────────────────────────────────────────────────────────────────────────────────────
 * THE BROWSER
 * ──────────────────────────────────────────────────────────────────────────────────────── */

type ThreadMeasurement = {
  /** The feed at rest: two threads, collapsed, with a count under each root. */
  atRest: {
    rows: number;
    toggles: string[];
    repliesVisible: number;
    /** The reply control is on eligible roots and on nothing else. */
    replyControlIds: string[];
  };
  /** The count opens its replies in place, and closes them again. */
  expanded: { repliesVisible: number; toggleState: string; replyBodies: string[] };
  collapsedAgain: { repliesVisible: number; toggleState: string };
  /** Opening a reply names the root and its channel, and locks To:. */
  replyBar: {
    hidden: boolean;
    target: string;
    windowLine: string;
    broadcastHidden: boolean;
    placeholder: string;
    toNote: string;
    toChips: string[];
    toLocked: boolean;
  };
  /** An @tag typed INSIDE a reply changes nothing about the address. */
  taggedInsideReply: { toChips: string[]; toNote: string };
  /** Cancelling gives the reader back the chips they had before the reply. */
  cancelled: { hidden: boolean; toChips: string[]; placeholder: string };
  /** A root that IS in a channel offers the broadcast control, named after that channel. */
  replyInChannel: { broadcastHidden: boolean; broadcastLabel: string; target: string };
  /** A root that is NOT in a channel does not. */
  replyUnfiled: { broadcastHidden: boolean; target: string };
  /** A directed message has no reply control at all. */
  directedRoot: { hasReplyControl: boolean };
  /** A reply row has no reply control either: a thread does not root on a reply. */
  replyRow: { hasReplyControl: boolean };
  /** Sending a reply: one row, under its root, and the bar comes down. */
  sentReply: {
    barHidden: boolean;
    repliesUnderRoot: string[];
    topLevelRows: number;
    toChips: string[];
    placeholder: string;
  };
  /** THE COMPOSITION CLAIM: the same reply reads under its root in #mobile and in all-signals. */
  composed: {
    inChannel: { rootIds: string[]; repliesUnderMobileRoot: string[] };
    inAllSignals: { rootIds: string[]; repliesUnderMobileRoot: string[] };
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

const frameScript = `<script>
  const frame = document.querySelector("iframe");
  const report = (value) => {
    document.documentElement.dataset.threadError = btoa(unescape(encodeURIComponent(String(value))));
  };
  const runMeasurement = async () => {
    let doc = frame.contentDocument;
    let view = frame.contentWindow;
    const waitFor = async (predicate, label) => {
      for (let attempt = 0; attempt < 160; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => view.setTimeout(resolve, 25));
      }
      throw new Error("Timed out waiting for " + label + ": " + JSON.stringify({
        rows: doc.querySelectorAll("[data-feed-list] > li").length,
        toggles: [...doc.querySelectorAll("[data-thread-toggle]")].map((b) => b.textContent),
        replyBarHidden: doc.querySelector("[data-composer-reply]")?.hidden,
        chips: [...doc.querySelectorAll("[data-composer-to-chip]")].length,
        note: doc.querySelector("[data-composer-to-note]")?.textContent,
        value: doc.querySelector("[data-composer-input]")?.value,
      }));
    };
    const ready = async () => {
      await waitFor(
        () => !doc.querySelector("[data-composer]")?.hidden &&
          doc.querySelectorAll("[data-feed-list] > li").length > 0 &&
          doc.querySelector("[data-composer-to-note]")?.textContent !== "",
        "the sample composer and its feed",
      );
    };
    await ready();
    const input = () => doc.querySelector("[data-composer-input]");
    const list = () => doc.querySelector("[data-feed-list]");
    const noteText = () => doc.querySelector("[data-composer-to-note]")?.textContent ?? "";
    const chipNames = () => [...doc.querySelectorAll("[data-composer-to-chip]")]
      .map((chip) => chip.querySelector("[data-composer-to-promote]")?.textContent ?? "");
    const bar = () => doc.querySelector("[data-composer-reply]");
    const barTarget = () =>
      doc.querySelector("[data-composer-reply-target-text]")?.textContent ?? "";
    const placeholder = () => input().getAttribute("placeholder") ?? "";
    const type = (value) => {
      const field = input();
      field.value = value;
      field.setSelectionRange(value.length, value.length);
      field.dispatchEvent(new view.InputEvent("input", { bubbles: true, inputType: "insertText" }));
    };
    const settle = async (ms) => {
      await new Promise((resolve) => view.setTimeout(resolve, ms));
    };
    /* THE THREAD'S OWN LIST, read by the ROOT id rather than by position: a group that lost a
       row would otherwise shift every index and several unrelated steps would go red together,
       which is the mis-aimed-control failure a review arm found in the sibling harness. */
    const repliesUnder = (rootId) => {
      const replies = doc.querySelector("#dashboard-thread-" + rootId);
      if (!replies || replies.hidden) return [];
      return [...replies.children].map((row) => row.dataset.signalId ?? "");
    };
    const toggleFor = (rootId) =>
      doc.querySelector('[data-thread-toggle="' + rootId + '"]');
    const topLevelIds = () => [...list().children]
      .filter((row) => row.dataset.signalId !== undefined)
      .map((row) => row.dataset.signalId);
    const replyControlIds = () => [...doc.querySelectorAll("[data-message-reply]")]
      .map((button) => button.dataset.messageReply).sort();
    const visibleReplyCount = () =>
      [...doc.querySelectorAll(".dashboard__thread-replies")]
        .filter((ol) => !ol.hidden)
        .reduce((total, ol) => total + ol.children.length, 0);

    /* AT REST. Both sample threads are collapsed, each root carries a count, and the reply
       control is on the eligible roots and on nothing else. */
    const atRest = {
      rows: list().children.length,
      toggles: [...doc.querySelectorAll("[data-thread-toggle]")].map((b) => b.textContent),
      repliesVisible: visibleReplyCount(),
      replyControlIds: replyControlIds(),
    };

    /* THE COUNT OPENS IN PLACE. No drawer, no navigation, and the rows around it stay put. */
    toggleFor("sample-3").click();
    await settle(60);
    const expanded = {
      repliesVisible: visibleReplyCount(),
      toggleState: toggleFor("sample-3").getAttribute("aria-expanded"),
      replyBodies: repliesUnder("sample-3"),
    };
    toggleFor("sample-3").click();
    await settle(60);
    const collapsedAgain = {
      repliesVisible: visibleReplyCount(),
      toggleState: toggleFor("sample-3").getAttribute("aria-expanded"),
    };

    /* A DIRECTED ROOT HAS NO CONTROL, and neither does a reply. Read by id, so the claim is
       about those rows and not about a count. */
    const directedRoot = { hasReplyControl: replyControlIds().includes("sample-1") };
    const replyRow = { hasReplyControl: replyControlIds().includes("sample-4") };

    /* ADDRESS THE COMPOSER FIRST, so the lock has something to hide and the cancel has
       something to give back. */
    type("as @Orbit said, ship it");
    await waitFor(() => chipNames().length === 1, "one chip before the reply");

    /* OPEN A REPLY ON THE UNFILED ROOT. The bar names the root and #all-signals, the box
       promises the thread, and To: is locked with the reply's own sentence. */
    doc.querySelector('[data-message-reply="sample-3"]').click();
    await waitFor(() => bar().hidden === false, "the reply bar");
    await settle(60);
    const toRow = doc.querySelector("[data-composer-to]");
    const replyBar = {
      hidden: bar().hidden,
      target: barTarget(),
      windowLine: doc.querySelector("[data-composer-reply-window]")?.textContent ?? "",
      broadcastHidden: doc.querySelector("[data-composer-reply-broadcast-row]").hidden,
      placeholder: placeholder(),
      toNote: noteText(),
      toChips: chipNames(),
      toLocked: toRow.getAttribute("aria-disabled") === "true",
    };
    const replyUnfiled = { broadcastHidden: replyBar.broadcastHidden, target: replyBar.target };

    /* AN @TAG INSIDE A REPLY CHANGES NOTHING. The pass holds, so the pair underneath is
       untouched and the row still shows no recipients. */
    type("@River what do you think");
    await settle(400);
    const taggedInsideReply = { toChips: chipNames(), toNote: noteText() };

    /* CANCELLING GIVES THE CHIPS BACK. They were never written away, which is the point. */
    doc.querySelector("[data-composer-reply-cancel]").click();
    await waitFor(() => bar().hidden === true, "the reply bar closing");
    await settle(400);
    const cancelled = {
      hidden: bar().hidden,
      toChips: chipNames(),
      placeholder: placeholder(),
    };

    /* A ROOT IN A CHANNEL OFFERS THE BROADCAST CONTROL, named after that channel. */
    doc.querySelector('[data-message-reply="sample-2"]').click();
    await waitFor(() => bar().hidden === false, "the reply bar on the channel root");
    await settle(60);
    const replyInChannel = {
      broadcastHidden: doc.querySelector("[data-composer-reply-broadcast-row]").hidden,
      broadcastLabel:
        doc.querySelector("[data-composer-reply-broadcast-label]")?.textContent ?? "",
      target: barTarget(),
    };

    /* SEND IT. One row, under its root, and the bar comes down with the send. */
    const rootsBefore = topLevelIds().length;
    type("checked on a phone, it holds");
    doc.querySelector("[data-composer]").requestSubmit();
    await waitFor(() => bar().hidden === true, "the reply bar coming down after the send");
    await settle(120);
    if (toggleFor("sample-2").getAttribute("aria-expanded") !== "true") {
      toggleFor("sample-2").click();
      await settle(60);
    }
    const sentReply = {
      barHidden: bar().hidden,
      repliesUnderRoot: repliesUnder("sample-2"),
      topLevelRows: topLevelIds().length - rootsBefore,
      toChips: chipNames(),
      placeholder: placeholder(),
    };

    /* ── THE COMPOSITION CLAIM ─────────────────────────────────────────────────────────
       The same reply reads under its root in #mobile and in all-signals. Sample mode narrows
       its own array, which is the one place a client-side narrowing is honest, because the
       sample IS the whole set. */
    const openChannel = async (channelId) => {
      /* BY ID, NOT BY LABEL. The rail writes the slug and the phone's switch list writes
         "#slug", so a text match would find one surface at one width and neither at the other;
         the id is what selectChannel actually takes. All-signals is the empty id. Only a
         VISIBLE control is clicked: the switch list lives inside a dialog that is closed at
         this width, and clicking a hidden button would measure nothing. */
      const button = [...doc.querySelectorAll('[data-channel-place]')]
        .filter((control) => control.offsetParent !== null)
        .find((control) => control.dataset.channelPlace === channelId);
      if (!button) {
        throw new Error("no visible channel control for " + JSON.stringify(channelId) + ": " +
          JSON.stringify([...doc.querySelectorAll("[data-channel-place]")]
            .map((c) => [c.dataset.channelPlace, c.offsetParent !== null])));
      }
      button.click();
      await settle(200);
      if (toggleFor("sample-2")) {
        if (toggleFor("sample-2").getAttribute("aria-expanded") !== "true") {
          toggleFor("sample-2").click();
          await settle(60);
        }
      }
    };
    await openChannel("sample-channel-mobile");
    const inChannel = {
      rootIds: topLevelIds(),
      repliesUnderMobileRoot: repliesUnder("sample-2"),
    };
    await openChannel("");
    const inAllSignals = {
      rootIds: topLevelIds(),
      repliesUnderMobileRoot: repliesUnder("sample-2"),
    };
    const composed = { inChannel, inAllSignals };

    document.documentElement.dataset.threadMeasurement = btoa(unescape(encodeURIComponent(JSON.stringify({
      atRest,
      expanded,
      collapsedAgain,
      replyBar,
      taggedInsideReply,
      cancelled,
      replyInChannel,
      replyUnfiled,
      directedRoot,
      replyRow,
      sentReply,
      composed,
    }))));
  };
  const start = () => void runMeasurement().catch((error) => report(error?.stack ?? error));
  frame.addEventListener("load", start, { once: true });
  if (
    frame.contentDocument?.readyState === "complete" &&
    frame.contentWindow?.location.pathname === "/app"
  ) start();
</script>`;

const startDistServer = async (): Promise<{ close(): Promise<void>; origin: string }> => {
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/__measure") {
      response.writeHead(200, { "content-type": contentTypes[".html"]! });
      response.end(
        `<!doctype html><html><body style="margin:0">` +
          `<iframe src="/app" width="1440" height="900" style="border:0"></iframe>` +
          `${frameScript}</body></html>`,
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
      if (extname(filePath) === ".js") {
        /* SAMPLE MODE ON PURPOSE: emptying the published Supabase URL is what makes `/app`
           render its made-up workspace with no server behind it. */
        const body = readFileSync(filePath, "utf8").replace(
          /PUBLIC_SUPABASE_URL:`https:\/\/api\.commonswarm\.com`/g,
          "PUBLIC_SUPABASE_URL:``",
        );
        response.writeHead(200, {
          "content-length": Buffer.byteLength(body),
          "content-type": contentTypes[".js"]!,
        });
        response.end(body);
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
  const address = await new Promise<string>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const value = server.address();
      if (value === null || typeof value === "string") reject(new Error("no port"));
      else resolve(`http://127.0.0.1:${value.port}`);
    });
  });
  return {
    origin: address,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
};

test("replies collapse under their root, and a reply carries no recipient", async () => {
  const chrome = await findChrome();
  const server = await startDistServer();
  try {
    /* ONE RETRY, AND ONLY WHEN THE BROWSER DIED ON A SIGNAL. Same bound and same reason as the
       sibling harness: `--single-process --no-zygote` takes a SIGSEGV under memory pressure on
       this host, a crash is not a measurement, and anything that is not a signal death is
       rethrown untouched, so a real defect still fails on both attempts. */
    const runChrome = async (attempt = 0): Promise<{ stdout: string; stderr: string }> => {
      try {
        return await run(chrome, [
          "--headless=new",
          "--disable-gpu",
          "--no-sandbox",
          "--single-process",
          "--no-zygote",
          "--virtual-time-budget=180000",
          "--dump-dom",
          `${server.origin}/__measure`,
        ], { maxBuffer: 10 * 1024 * 1024, timeout: 180_000, killSignal: "SIGKILL" });
      } catch (error) {
        const signal = (error as { signal?: string | null }).signal ?? null;
        if (attempt === 0 && signal !== null && signal !== "SIGKILL") {
          return runChrome(attempt + 1);
        }
        throw error;
      }
    };
    const { stdout, stderr } = await runChrome();
    const encoded = stdout.match(/data-thread-measurement="([^"]+)"/)?.[1];
    const encodedError = stdout.match(/data-thread-error="([^"]+)"/)?.[1];
    assert.ok(
      encoded,
      "headless Chrome returned no thread measurement\n" +
        `page error: ${encodedError ? Buffer.from(encodedError, "base64").toString("utf8") : "none"}\n` +
        `stderr: ${stderr.slice(-1_000)}`,
    );
    const measured = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8"),
    ) as ThreadMeasurement;

    /* COLLAPSED AT REST, with a count under each root. The sample has two threads: one on the
       unfiled ask (`sample-3`) and one on the message filed in #mobile (`sample-2`). */
    assert.deepEqual(
      measured.atRest.toggles,
      [threadReplyCountLabel(1), threadReplyCountLabel(1)],
      "atRest: the count under each root is generated, not typed",
    );
    assert.equal(measured.atRest.repliesVisible, 0, "atRest: replies are collapsed");
    /* AND THE CONTROL IS ON THE ELIGIBLE ROOTS ONLY. `sample-1` is directed, `sample-4` and
       `sample-5` are replies; the two roots are what is left. */
    assert.deepEqual(
      measured.atRest.replyControlIds,
      ["sample-2", "sample-3"],
      "atRest: the reply control is offered where the server would accept the thread",
    );
    assert.equal(measured.directedRoot.hasReplyControl, false, "a directed message may not root a thread");
    assert.equal(measured.replyRow.hasReplyControl, false, "a reply may not root a second thread");

    /* THE COUNT OPENS IN PLACE, AND CLOSES AGAIN. */
    assert.deepEqual(measured.expanded, {
      repliesVisible: 1,
      toggleState: "true",
      replyBodies: ["sample-4"],
    }, "expanded: the count opens its own replies in place");
    assert.deepEqual(measured.collapsedAgain, {
      repliesVisible: 0,
      toggleState: "false",
    }, "collapsedAgain: it closes them again");

    /* THE BAR NAMES THE ROOT AND ITS CHANNEL, and locks To: with the reply's own sentence. */
    assert.deepEqual(measured.replyBar, {
      hidden: false,
      target: threadReplyTargetText("Orbit", null),
      /* The sample rows do not expire, so there is no ceiling to state and the line collapses
         rather than saying "never". */
      windowLine: "",
      broadcastHidden: true,
      placeholder: "Reply in this thread",
      toNote: THREAD_REPLY_TO_TEXT,
      toChips: [],
      toLocked: true,
    }, "replyBar: the bar names the root and the channel, and To: is locked and empty");

    /* AN @TAG INSIDE A REPLY IS A NAME IN THE TEXT AND NOTHING ELSE. */
    assert.deepEqual(measured.taggedInsideReply, {
      toChips: [],
      toNote: THREAD_REPLY_TO_TEXT,
    }, "taggedInsideReply: a tag inside a reply must not address anybody");

    /* AND CANCELLING GIVES BACK THE CHIP THE READER HAD, PLUS THE ONE THE BODY NOW NAMES.
       Both halves are load-bearing and neither is an accident:

       ORBIT proves the HOLD. By this point the box says "@River what do you think" — Orbit's
       tag is not in the body any more — so Orbit can only have come from the pair the pass
       held for the whole reply. Had the reply committed its empty set over that pair, Orbit
       would be gone and this list would read ["River"]. That makes it a discriminating
       control rather than a restatement of the step above.

       RIVER IS THE CORRECT DERIVATION, not a leak. Cancelling leaves the text in the box, so
       that text is now a top-level message, and an @tag in a top-level body ADDS to the set
       (ruling D2). Nothing is hidden: the reader is looking at the row when it happens. The
       @tag did nothing while the bar was up, which is what `taggedInsideReply` above shows.

       ~~`toChips: ["Orbit"]`~~ was this assertion's first form, written before the step typed
       over the body it was about. */
    assert.deepEqual(measured.cancelled, {
      hidden: true,
      toChips: ["Orbit", "River"],
      placeholder: "What are you about to do?",
    }, "cancelled: the held pair comes back, and the body's own tag joins it");

    /* BROADCAST IS OFFERED ONLY WHERE THERE IS A CHANNEL TO BROADCAST TO. */
    assert.deepEqual(measured.replyUnfiled, {
      broadcastHidden: true,
      target: threadReplyTargetText("Orbit", null),
    }, "replyUnfiled: an unfiled thread has nowhere to broadcast, so there is no control");
    assert.deepEqual(measured.replyInChannel, {
      broadcastHidden: false,
      broadcastLabel: threadReplyBroadcastLabel("mobile"),
      target: threadReplyTargetText("River", "mobile"),
    }, "replyInChannel: the control names the channel it would send to");

    /* THE SEND. One reply under its root, no new top-level row, and the composer goes back to
       the message it was writing. */
    assert.equal(measured.sentReply.barHidden, true, "sentReply: the bar comes down");
    assert.equal(
      measured.sentReply.repliesUnderRoot.length,
      2,
      "sentReply: the reply joins its own thread",
    );
    assert.equal(
      measured.sentReply.topLevelRows,
      0,
      "sentReply: a reply must not appear as a message of its own",
    );
    /* AND THE PAIR IS EXACTLY WHAT IT WAS BEFORE THE REPLY. Compared against the step above
       rather than against a typed list: the claim is that sending a reply changed NOTHING
       about the To: set, and comparing two measured moments says that directly. A typed list
       would have to be updated whenever an earlier step's body changes, which is how this
       assertion was wrong the first time it was written.

       IT ALSO PROVES THE REMEMBER GUARD. `rememberComposerTo([])` REMOVES the stored set, so
       an unguarded reply would have wiped it; the pair on screen was held, but the next
       message would then have opened as a broadcast. */
    assert.deepEqual(
      measured.sentReply.toChips,
      measured.cancelled.toChips,
      "sentReply: sending a reply moved the To: set",
    );
    assert.ok(
      measured.sentReply.toChips.length > 0,
      "sentReply: the comparison above must not be two empty sets",
    );
    assert.equal(measured.sentReply.placeholder, "What are you about to do?");

    /* ── THE COMPOSITION CLAIM, MEASURED ───────────────────────────────────────────────
       The #mobile root and its replies read the same in the channel and in all-signals. The
       server stamps a reply with its root's channel, so both reads carry the pair. */
    assert.deepEqual(
      measured.composed.inChannel.rootIds,
      ["sample-2"],
      "composed: #mobile holds its own root and nothing else",
    );
    assert.equal(
      measured.composed.inChannel.repliesUnderMobileRoot.length,
      2,
      "composed: and both replies are under it there",
    );
    assert.deepEqual(
      measured.composed.inAllSignals.repliesUnderMobileRoot,
      measured.composed.inChannel.repliesUnderMobileRoot,
      "composed: all-signals shows the same replies under the same root",
    );
    assert.ok(
      measured.composed.inAllSignals.rootIds.length >
        measured.composed.inChannel.rootIds.length,
      "composed: and all-signals is the wider view, so the comparison above is not two of the same page",
    );
    assert.ok(
      measured.composed.inAllSignals.rootIds.includes("sample-3"),
      "composed: the unfiled thread is in all-signals and not in #mobile",
    );
    assert.equal(
      measured.composed.inChannel.rootIds.includes("sample-3"),
      false,
    );
  } finally {
    await server.close();
  }
});

test("every block sentence a reply can meet is reachable from the composer", () => {
  /* THE REFUSALS HAVE A READER. A reply bar is opened against a row and sent later, so the
     root can expire and its channel can be archived in that window; both are refused at send
     time with the classifier's own sentence. Without this the sentences would be an
     enumeration nobody ever reads, which is a claim with no control on it. */
  const submit = between(dashboard, "const replyRoot = threadReplyRoot;", "} finally {");
  assert.match(submit, /setComposerStatus\(threadRootBlockText\(block\), "error"\);/);
  assert.match(submit, /threadRootBlockText\("channel-archived"\)/);
  /* AND THE ARCHIVED SENTENCE IS THE SERVER'S OWN. */
  assert.equal(
    commandEdge.split(threadRootBlockText("channel-archived")).length - 1,
    1,
    "the archived refusal must be the edge's sentence, word for word",
  );
});
