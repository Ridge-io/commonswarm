/** Reached by `npm --prefix site test` through the recursive component-observer glob. */
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
const distRoot = process.env.COMMONSWARM_COMPOSER_DIST_ROOT ?? join(siteRoot, "dist");

type ComposerMeasurement = {
  /** The pick writes "@Name " into the body AND puts that name in To:. */
  pick: { enterPrevented: boolean; value: string; chips: string[] };
  /** A second pick ADDS a second tag and a second chip; neither replaces the first. */
  secondPick: { value: string; chips: string[] };
  /** Two names in To: post ONE signal, addressed to the set; recipient 0 is its target. */
  oneSignal: { added: number; target: string; chipsAfterSend: string[] };
  /** Emptying To: by hand leaves a broadcast, named on the row rather than shown as nothing. */
  cleared: { chips: string[]; note: string };
  /** No recipient at all is still one broadcast row with no target. */
  broadcast: { added: number; target: string };
  plainEnter: { prevented: boolean; submitted: boolean };
  shiftEnter: { insertedNewline: boolean; prevented: boolean; submitted: boolean };
  metaEnter: { kind: string; recipient: string; submitted: boolean };
  ctrlEnter: { kind: string; recipient: string; submitted: boolean };
  metaMention: { submitted: boolean; value: string };
  ctrlMention: { submitted: boolean; value: string };
  zeroCandidate: { pickerHidden: boolean; submitted: boolean };
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
  const reportError = (value) => {
    /* UTF-8 first, exactly like the measurement below. A plain btoa threw on the first "…"
       that reached a timeout message, and the throw replaced the real error with a
       btoa complaint, which is a harness that hides what it exists to report. */
    document.documentElement.dataset.composerError = btoa(
      unescape(encodeURIComponent(String(value))),
    );
  };
  const runMeasurement = async () => {
    const doc = frame.contentDocument;
    const view = frame.contentWindow;
    const waitFor = async (predicate, label) => {
      for (let attempt = 0; attempt < 100; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => view.setTimeout(resolve, 25));
      }
      throw new Error(
        "Timed out waiting for " + label + ": " + JSON.stringify({
          appState: doc.querySelector("live-dashboard")?.dataset.state,
          composerHidden: doc.querySelector("[data-composer]")?.hidden,
          feedRows: doc.querySelectorAll("[data-feed-list] > li").length,
          pageText: doc.body?.innerText?.slice(0, 300),
        }),
      );
    };
    await waitFor(
      () => !doc.querySelector("[data-composer]")?.hidden &&
        doc.querySelectorAll("[data-feed-list] > li").length > 0,
      "the sample composer",
    );
    const input = doc.querySelector("[data-composer-input]");
    const list = doc.querySelector("[data-feed-list]");
    /* THE To: SET SURVIVES A SEND on purpose, so a step that needs a broadcast has to empty
       it. Doing that through the chip's own remove control makes this a live control of the
       affordance as well as a set-up step. */
    const chipNames = () => [...doc.querySelectorAll("[data-composer-to-chip]")]
      .map((chip) => chip.querySelector("[data-composer-to-promote]")?.textContent ?? "");
    const clearTo = async () => {
      for (let guard = 0; guard < 12; guard += 1) {
        const remove = doc.querySelector("[data-composer-to-remove]");
        if (!remove) break;
        remove.click();
      }
      await waitFor(() => chipNames().length === 0, "an empty To: set");
    };
    const type = (value) => {
      input.value = value;
      input.setSelectionRange(value.length, value.length);
      input.dispatchEvent(new view.InputEvent("input", { bubbles: true, inputType: "insertText" }));
    };
    const pressEnter = (extra = {}) => {
      const event = new view.KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
        ...extra,
      });
      input.dispatchEvent(event);
      return event;
    };
    const settle = async (predicate) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => view.setTimeout(resolve, 10));
      }
    };
    /* Type a partial name, open the picker, confirm with Enter. The tag must land in the body. */
    const choose = async (query, extra = {}) => {
      const before = input.value;
      input.value = before + "@" + query;
      input.setSelectionRange(input.value.length, input.value.length);
      input.dispatchEvent(new view.InputEvent("input", { bubbles: true, inputType: "insertText" }));
      await waitFor(() => !doc.querySelector("[data-mention-picker]")?.hidden, "mention picker");
      const beforeRows = list.children.length;
      const event = pressEnter(extra);
      await new Promise((resolve) => view.setTimeout(resolve, 0));
      return {
        enterPrevented: event.defaultPrevented,
        submitted: list.children.length !== beforeRows,
        value: input.value,
      };
    };
    const sendWith = async (modifier, body) => {
      type(body);
      const before = list.children.length;
      pressEnter({ [modifier]: true });
      await settle(() => list.children.length > before);
      const row = list.children.length === before + 1 ? list.lastElementChild : null;
      return {
        kind: row?.querySelector(".dashboard__message-kind")?.textContent?.trim() ?? "",
        recipient: row?.querySelector(".dashboard__message-target")?.textContent?.trim() ?? "",
        submitted: row?.querySelector(".dashboard__message-markdown")?.textContent === body,
      };
    };
    const sendWithStaleEmptyPicker = async () => {
      type("@orb");
      await waitFor(() => !doc.querySelector("[data-mention-picker]")?.hidden, "mention picker");
      /* Keep the rendered picker open while changing the query without an input event. This
         models the stale frame the keydown branch must handle: open UI, zero live candidates. */
      input.value = "@no-such-recipient";
      input.setSelectionRange(input.value.length, input.value.length);
      const before = list.children.length;
      pressEnter({ metaKey: true });
      await settle(() => list.children.length > before);
      return {
        pickerHidden: doc.querySelector("[data-mention-picker]")?.hidden === true,
        submitted: list.lastElementChild?.querySelector(".dashboard__message-markdown")?.textContent ===
          "@no-such-recipient",
      };
    };

    type("");
    const first = await choose("orb");
    const pick = {
      enterPrevented: first.enterPrevented,
      value: first.value,
      chips: chipNames(),
    };
    const second = await choose("lum");
    const secondPick = { value: second.value, chips: chipNames() };

    /* ONE SIGNAL for the whole set. Two names in To: used to be two rows; the row count and
       the single target are what would fail if the send went back to posting per tag. */
    const beforeSend = list.children.length;
    type(second.value + "ship it");
    pressEnter();
    await settle(() => list.children.length > beforeSend);
    await new Promise((resolve) => view.setTimeout(resolve, 60));
    const oneSignal = {
      added: list.children.length - beforeSend,
      target: list.lastElementChild?.querySelector(".dashboard__message-target")
        ?.textContent?.trim() ?? "",
      chipsAfterSend: chipNames(),
    };

    await clearTo();
    const cleared = {
      chips: chipNames(),
      note: doc.querySelector("[data-composer-to-note]")?.textContent ?? "",
    };

    const beforeBroadcast = list.children.length;
    type("no tags here, so this goes to the room");
    pressEnter();
    await settle(() => list.children.length > beforeBroadcast);
    const broadcast = {
      added: list.children.length - beforeBroadcast,
      target: list.lastElementChild?.querySelector(".dashboard__message-target")?.textContent?.trim() ?? "",
    };

    type("sent with enter");
    const beforePlain = list.children.length;
    const plain = pressEnter();
    await new Promise((resolve) => view.setTimeout(resolve, 0));
    const plainEnter = {
      prevented: plain.defaultPrevented,
      submitted: list.children.length === beforePlain + 1 &&
        list.lastElementChild?.querySelector(".dashboard__message-markdown")?.textContent === "sent with enter",
    };

    type("line one");
    const beforeShift = list.children.length;
    const shift = new view.KeyboardEvent("keydown", {
      bubbles: true,
      cancelable: true,
      key: "Enter",
      shiftKey: true,
    });
    const shiftDefaultAllowed = input.dispatchEvent(shift);
    if (shiftDefaultAllowed) {
      input.setRangeText("\\n", input.selectionStart, input.selectionEnd, "end");
      input.dispatchEvent(new view.InputEvent("input", { bubbles: true, inputType: "insertLineBreak" }));
    }
    const shiftEnter = {
      insertedNewline: input.value === "line one\\n",
      prevented: shift.defaultPrevented,
      submitted: list.children.length !== beforeShift,
    };
    const metaEnter = await sendWith("metaKey", "@River sent with command enter");
    const ctrlEnter = await sendWith("ctrlKey", "@River sent with control enter");
    /* River is in To: now and the picker never offers a name already addressed, so the
       shortcut steps below start from an empty set again. */
    await clearTo();
    type("");
    const metaMentionPick = await choose("orb", { metaKey: true });
    const metaMention = { submitted: metaMentionPick.submitted, value: metaMentionPick.value };
    type("");
    const ctrlMentionPick = await choose("lum", { ctrlKey: true });
    const ctrlMention = { submitted: ctrlMentionPick.submitted, value: ctrlMentionPick.value };
    await clearTo();
    const zeroCandidate = await sendWithStaleEmptyPicker();

    document.documentElement.dataset.composerMeasurement = btoa(unescape(encodeURIComponent(JSON.stringify({
      pick,
      secondPick,
      oneSignal,
      cleared,
      broadcast,
      plainEnter,
      shiftEnter,
      metaEnter,
      ctrlEnter,
      metaMention,
      ctrlMention,
      zeroCandidate,
    }))));
  };
  const start = () => void runMeasurement().catch((error) => reportError(error?.stack ?? error));
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
      response.writeHead(200, { "content-type": contentTypes[".html"] });
      response.end(`<!doctype html><html><body><iframe src="/app"></iframe>${frameScript}</body></html>`);
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
        const body = readFileSync(filePath, "utf8").replace(
          /PUBLIC_SUPABASE_URL:`https:\/\/api\.commonswarm\.com`/g,
          "PUBLIC_SUPABASE_URL:``",
        );
        response.writeHead(200, {
          "content-length": Buffer.byteLength(body),
          "content-type": contentTypes[".js"],
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
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  assert.ok(address && typeof address !== "string", "composer observer must bind a port");
  return {
    close: () => new Promise<void>((resolve, reject) => {
      server.close((error) => error ? reject(error) : resolve());
    }),
    origin: `http://127.0.0.1:${address.port}`,
  };
};

/* Three retired claims, kept because a reader may still meet them.
   "One visible recipient" went when the operator asked to address two agents out of four.
   "A person replaces the whole address" went with the old TO row.
   "Each gets its own signal with its own kind" went on 2026-09-05: the wire carries a
   recipient list, so the whole To: set is ONE signal with one kind, taken from recipient 0. */
test("rendered composer addresses several agents and preserves multiline keyboard input", async () => {
  const chrome = await findChrome();
  const server = await startDistServer();
  try {
    const { stdout, stderr } = await run(chrome, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--single-process",
      "--no-zygote",
      "--virtual-time-budget=8000",
      "--dump-dom",
      `${server.origin}/__measure`,
    ], {
      maxBuffer: 10 * 1024 * 1024,
      timeout: 20_000,
      killSignal: "SIGKILL",
    });
    const encoded = stdout.match(/data-composer-measurement="([^"]+)"/)?.[1];
    const encodedError = stdout.match(/data-composer-error="([^"]+)"/)?.[1];
    assert.ok(
      encoded,
      `headless Chrome returned no composer measurement\n` +
        `page error: ${encodedError ? Buffer.from(encodedError, "base64").toString("utf8") : "none"}\n` +
        `stderr: ${stderr.slice(-1_000)}\nDOM: ${stdout.slice(-2_000)}`,
    );
    const measured = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8"),
    ) as ComposerMeasurement;
    /* The pick is BOTH: a word in the message and a name in To:. The tag stays where it was
       typed, so the sentence still reads, and the chip is what the send addresses.
       RETIRED (2026-09-04): "nothing is lifted out of the text into a chip." */
    assert.deepEqual(measured.pick, {
      enterPrevented: true,
      value: "@Orbit ",
      chips: ["Orbit"],
    });
    /* A SECOND PICK ADDS. Ruling D2: a mention joins the To: set, it does not open a DM and
       it does not drop whoever was already addressed. */
    assert.deepEqual(measured.secondPick, {
      value: "@Orbit @Lumen ",
      chips: ["Orbit", "Lumen"],
    });
    /* Two names, ONE row. The target is recipient 0, which is the column the server fills;
       both names stay in To: for the next message. ~~"and the only recipient it wakes"~~
       Retired 2026-09-05: every agent in the set is woken wherever it sits, and this assertion
       is about the ARROW and the chips, neither of which is a wake claim. */
    assert.deepEqual(measured.oneSignal, {
      added: 1,
      target: "→ Orbit",
      chipsAfterSend: ["Orbit", "Lumen"],
    });
    /* Emptying the set through the chips leaves a NAMED broadcast, and the row says who is
       notified rather than leaving the reader to infer it. */
    assert.deepEqual(measured.cleared, {
      chips: [],
      note: "No agent is notified. Everyone here can read this.",
    }, "cleared: emptying To: through the chips leaves a named broadcast");
    /* No recipient is still one broadcast row, addressed to the room rather than to a listener. */
    assert.deepEqual(measured.broadcast, { added: 1, target: "→ everyone" });
    assert.deepEqual(measured.plainEnter, {
      prevented: true,
      submitted: true,
    });
    assert.deepEqual(measured.shiftEnter, {
      insertedNewline: true,
      prevented: false,
      submitted: false,
    });
    assert.deepEqual(measured.metaEnter, {
      kind: "Question",
      recipient: "→ River",
      submitted: true,
    });
    assert.deepEqual(measured.ctrlEnter, {
      kind: "Question",
      recipient: "→ River",
      submitted: true,
    });
    /* Command/Control+Enter with the picker open still CONFIRMS the pick rather than sending,
       so the shortcut cannot post a half-typed name. */
    assert.deepEqual(measured.metaMention, { submitted: false, value: "@Orbit " });
    assert.deepEqual(measured.ctrlMention, { submitted: false, value: "@Lumen " });
    assert.deepEqual(measured.zeroCandidate, { pickerHidden: true, submitted: true });
  } finally {
    await server.close();
  }
});
