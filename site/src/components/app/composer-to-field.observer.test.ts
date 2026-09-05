/**
 * The To: field, measured in real Chrome against the built `/app` in sample mode, plus the
 * one source claim a browser cannot see: the exact bytes of the post.
 *
 * Reached by `npm --prefix site test` through the recursive component-observer glob.
 *
 * WHAT THIS FILE DOES NOT ESTABLISH. Nothing here touches production or a real workspace:
 * the page runs in sample mode, so a send is a local row and not a `post_signal`. The wire
 * claim below is therefore about the body this client BUILDS, taken from the exported
 * builder, not about what a server did with it. `tests/p1-server/chat-signals.test.ts` is
 * where the served edge answers for that shape.
 */
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createReadStream, readFileSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { promisify } from "node:util";
import { test } from "node:test";
import { findChrome } from "./participant-rail.fixture.js";
import { browserSignalCommand, browserSignalKind } from "../../lib/commonswarm.js";
import {
  COMPOSER_TO_MAX,
  composerDeliveryNote,
  notifiedRecipient,
} from "../../lib/composer-address.js";

const run = promisify(execFile);
const siteRoot = join(import.meta.dirname, "..", "..", "..");
const distRoot = process.env.COMMONSWARM_COMPOSER_TO_DIST_ROOT ?? join(siteRoot, "dist");

type ToMeasurement = {
  /** The row at rest, before anything is typed: a named broadcast, on one line at 1440px. */
  atRest: {
    label: string;
    chips: string[];
    broadcastChip: string;
    note: string;
    oneLine: boolean;
  };
  /** A tag mid-sentence adds a chip and leaves the sentence alone. */
  midSentence: { value: string; chips: string[]; note: string };
  /** A second tag ADDS. The first recipient stays, and stays first. */
  secondTag: { chips: string[]; note: string; notifiedChip: string };
  /** A person in front means the service wakes nobody, and the row says so with a remedy. */
  personFirst: {
    chips: string[];
    note: string;
    notifiedChip: string;
    /** What each chip's own control promises. A person's must not promise a wake. */
    promoteTitles: string[];
  };
  /** Choosing a name puts it first, which is the only control over who is woken. */
  promoted: { chips: string[]; note: string; notifiedChip: string };
  /** Removing a chip removes the recipient, and the still-typed tag does not put it back. */
  removed: { chips: string[]; valueStillHasTag: boolean; afterKeystroke: string[] };
  /** A tag typed and sent in the same breath is still a recipient. */
  taggedThenSentAtOnce: { chips: string[]; rowTarget: string };
  /** The same name, removed after that send and typed again, addresses again. */
  retaggedAfterSend: { chips: string[] };
  /** The set survives a send and is what the next message opens addressed to. */
  afterSend: { chips: string[]; rowTarget: string; rowsAdded: number };
  /** A reload opens addressed to the recipients of the last message that was sent. */
  afterReload: { chips: string[]; note: string };
  /** A saved draft's own tags are on the row after a reload, before anything is sent. */
  afterReloadWithDraft: { chips: string[]; value: string };
  /** A recipient removed by hand stays removed across a reload, tag still in the body. */
  removalSurvivesReload: { chips: string[]; value: string };
  /** Emptying To: to a broadcast survives a reload too, rather than reverting to last-sent. */
  broadcastSurvivesReload: { chips: string[]; note: string; value: string };
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
    document.documentElement.dataset.toError = btoa(unescape(encodeURIComponent(String(value))));
  };
  const runMeasurement = async () => {
    let doc = frame.contentDocument;
    let view = frame.contentWindow;
    const waitFor = async (predicate, label) => {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if (predicate()) return;
        await new Promise((resolve) => view.setTimeout(resolve, 25));
      }
      throw new Error("Timed out waiting for " + label + ": " + JSON.stringify({
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
        "the sample composer and its To: row",
      );
    };
    await ready();
    const input = () => doc.querySelector("[data-composer-input]");
    const list = () => doc.querySelector("[data-feed-list]");
    const noteText = () => doc.querySelector("[data-composer-to-note]")?.textContent ?? "";
    const chipNames = () => [...doc.querySelectorAll("[data-composer-to-chip]")]
      .map((chip) => chip.querySelector("[data-composer-to-promote]")?.textContent ?? "");
    const notifiedChip = () =>
      doc.querySelector("[data-composer-to-chip][data-composer-to-notified] [data-composer-to-promote]")
        ?.textContent ?? "";
    const type = (value) => {
      const field = input();
      field.value = value;
      field.setSelectionRange(value.length, value.length);
      field.dispatchEvent(new view.InputEvent("input", { bubbles: true, inputType: "insertText" }));
    };
    /* The chip pass is debounced off the keystroke path, so every step that types a tag has
       to wait for the row rather than read it in the same tick.

       settleChips THROWS and is for structural steps only, where a wrong count means the
       harness itself is broken. Claim steps use settle instead: a step that aborts the
       whole measurement makes two different defects arrive at the same timeout, and the
       mutation harness then cannot tell them apart. */
    const settleChips = async (count, label) => {
      await waitFor(() => chipNames().length === count, label);
    };
    const settle = async (count) => {
      for (let attempt = 0; attempt < 60; attempt += 1) {
        if (chipNames().length === count) return;
        await new Promise((resolve) => view.setTimeout(resolve, 25));
      }
    };
    const send = async (body) => {
      const before = list().children.length;
      type(body);
      doc.querySelector("[data-composer]").requestSubmit();
      await waitFor(() => list().children.length > before, "the posted row");
      await new Promise((resolve) => view.setTimeout(resolve, 80));
      return {
        rowsAdded: list().children.length - before,
        rowTarget: list().lastElementChild?.querySelector(".dashboard__message-target")
          ?.textContent?.trim() ?? "",
      };
    };
    /* EMPTY THE BODY FIRST, then the chips. A tag whose chip was removed is remembered as
       already applied so it cannot come back on the next keystroke, and that memory is only
       forgotten when the tag leaves the body. Clearing the chips alone would leave the next
       step typing tags the composer has been told to ignore. */
    const clearTo = async () => {
      type("");
      await new Promise((resolve) => view.setTimeout(resolve, 350));
      for (let guard = 0; guard < 12; guard += 1) {
        const remove = doc.querySelector("[data-composer-to-remove]");
        if (!remove) break;
        remove.click();
      }
      await settleChips(0, "an empty To: set");
    };

    /* AT REST. Nothing typed, nothing remembered: the row names the broadcast. */
    const toRow = doc.querySelector("[data-composer-to]");
    const atRest = {
      label: doc.querySelector("[data-composer-to-label]")?.textContent ?? "",
      chips: chipNames(),
      broadcastChip: doc.querySelector("[data-composer-to-broadcast]")?.textContent ?? "",
      note: noteText(),
      /* ONE LINE, measured as "nothing in the row is stacked": the row is no taller than its
         tallest child. Counting line-heights was wrong here -- a chip is a control with its
         own padding and border, so a single-line row is already several note line-heights
         tall and that arithmetic reported four lines for one. */
      oneLine: toRow.getBoundingClientRect().height <=
        Math.max(...[...toRow.children].map((child) => child.getBoundingClientRect().height)) + 1,
    };

    /* MID-SENTENCE. The tag stays in the prose; the chip is what gets addressed. */
    type("as @Orbit said, ship it");
    await settleChips(1, "one chip from a mid-sentence tag");
    const midSentence = { value: input().value, chips: chipNames(), note: noteText() };

    /* A SECOND TAG ADDS (ruling D2). Orbit stays, and stays the notified one. */
    type("as @Orbit said, ship it with @River");
    await settleChips(2, "two chips");
    const secondTag = { chips: chipNames(), note: noteText(), notifiedChip: notifiedChip() };

    /* A PERSON IN FRONT wakes nobody, whatever follows. Kenji Ito is a MEMBER in the sample
       roster; River, Orbit and Lumen are all agents, so a person has to be named by name. */
    await clearTo();
    type("@Kenji Ito and @Orbit, please look");
    await settleChips(2, "a person-first set");
    const personFirst = {
      chips: chipNames(),
      note: noteText(),
      notifiedChip: notifiedChip(),
      promoteTitles: [...doc.querySelectorAll("[data-composer-to-promote]")]
        .map((button) => button.getAttribute("title") ?? ""),
    };

    /* CHOOSING A NAME PUTS IT FIRST. The remedy the row names is one click. */
    [...doc.querySelectorAll("[data-composer-to-promote]")]
      .find((button) => button.textContent === "Orbit")
      .click();
    await waitFor(() => chipNames()[0] === "Orbit", "Orbit at the front");
    const promoted = { chips: chipNames(), note: noteText(), notifiedChip: notifiedChip() };

    /* REMOVING holds, even with the tag still in the sentence. */
    [...doc.querySelectorAll("[data-composer-to-remove]")]
      .find((button) => button.getAttribute("aria-label") === "Remove Kenji Ito from To:")
      .click();
    await settleChips(1, "one chip after a removal");
    const beforeKeystroke = input().value;
    type(beforeKeystroke + " ok");
    await new Promise((resolve) => view.setTimeout(resolve, 400));
    const removed = {
      chips: chipNames(),
      valueStillHasTag: input().value.includes("@Kenji Ito"),
      afterKeystroke: chipNames(),
    };

    /* TYPED AND SENT IN ONE BREATH. The chip pass is debounced, so a reader who types a tag
       and presses Enter inside that window would send to a set that had not caught up unless
       the submit runs the pass first. */
    await clearTo();
    const beforeAtOnce = list().children.length;
    type("@Lumen ship it now");
    doc.querySelector("[data-composer]").requestSubmit();
    await waitFor(() => list().children.length > beforeAtOnce, "the row sent straight after a tag");
    await new Promise((resolve) => view.setTimeout(resolve, 80));
    const taggedThenSentAtOnce = {
      chips: chipNames(),
      rowTarget: list().lastElementChild?.querySelector(".dashboard__message-target")
        ?.textContent?.trim() ?? "",
    };

    /* AND THE SEND FORGETS WHICH TAGS IT HAD ALREADY LIFTED. The body that held them is
       gone, so the same name typed again after the send has to address again. Removing the
       chip here WITHOUT emptying the box is the point: emptying it would clear that record
       on its own and the step would pass whether the send cleared it or not. */
    /* Defensive: a defect that leaves no chip here must fail its OWN assertion, not throw a
       TypeError that takes the whole measurement with it. */
    doc.querySelector("[data-composer-to-remove]")?.click();
    await settle(0);
    type("@Lumen hello again");
    await settle(1);
    const retaggedAfterSend = { chips: chipNames() };

    /* THE SET SURVIVES A SEND, and the row's target is recipient 0. */
    await clearTo();
    type("as @Orbit said, ship it");
    await settle(1);
    const sent = await send("shipping this");
    const afterSend = { chips: chipNames(), rowTarget: sent.rowTarget, rowsAdded: sent.rowsAdded };

    /* AND A RELOAD OPENS ADDRESSED TO IT. */
    await new Promise((resolve) => {
      frame.addEventListener("load", resolve, { once: true });
      frame.contentWindow.location.reload();
    });
    doc = frame.contentDocument;
    view = frame.contentWindow;
    await ready();
    /* SETTLE, do not wait for a count. Waiting for one aborts the whole measurement, so two
       different defects would arrive at the same timeout and the mutation harness could not
       tell them apart. Record what is there and let each assertion answer for itself. */
    await new Promise((resolve) => view.setTimeout(resolve, 400));
    const afterReload = { chips: chipNames(), note: noteText() };

    /* A DRAFT'S OWN TAGS ARE ON THE ROW AFTER A RELOAD, not lifted in at send time. The
       remembered set goes in first, the draft body second, and the draft's tags join the set
       third; restoring the draft before the set overwrote them, and the send then posted to
       a name the row had never shown. */
    type("and @Lumen should see it");
    await settle(2);
    await new Promise((resolve) => view.setTimeout(resolve, 500));
    await new Promise((resolve) => {
      frame.addEventListener("load", resolve, { once: true });
      frame.contentWindow.location.reload();
    });
    doc = frame.contentDocument;
    view = frame.contentWindow;
    await ready();
    await new Promise((resolve) => view.setTimeout(resolve, 400));
    const afterReloadWithDraft = { chips: chipNames(), value: input().value };

    /* AND A REMOVAL SURVIVES ONE TOO. The reader takes Lumen out of To: and leaves "@Lumen"
       in the sentence. The record of which tags have already been lifted travels with the
       draft, so the reload does not read that tag as fresh and address Lumen again. */
    [...doc.querySelectorAll("[data-composer-to-remove]")]
      .find((button) => button.getAttribute("aria-label") === "Remove Lumen from To:")
      ?.click();
    await settle(1);
    await new Promise((resolve) => view.setTimeout(resolve, 500));
    await new Promise((resolve) => {
      frame.addEventListener("load", resolve, { once: true });
      frame.contentWindow.location.reload();
    });
    doc = frame.contentDocument;
    view = frame.contentWindow;
    await ready();
    await new Promise((resolve) => view.setTimeout(resolve, 500));
    const removalSurvivesReload = { chips: chipNames(), value: input().value };

    /* AND SO DOES AN EMPTY SET. A draft with no recipients is a broadcast the reader chose,
       not "no set was saved": storing the two the same way sent them back to whoever they
       last messaged. The removal step above cannot reach this, because it always leaves one
       chip behind. */
    await clearTo();
    type("everyone should see this");
    await new Promise((resolve) => view.setTimeout(resolve, 500));
    await new Promise((resolve) => {
      frame.addEventListener("load", resolve, { once: true });
      frame.contentWindow.location.reload();
    });
    doc = frame.contentDocument;
    view = frame.contentWindow;
    await ready();
    await new Promise((resolve) => view.setTimeout(resolve, 500));
    const broadcastSurvivesReload = {
      chips: chipNames(),
      note: noteText(),
      value: input().value,
    };

    document.documentElement.dataset.toMeasurement = btoa(unescape(encodeURIComponent(JSON.stringify({
      atRest,
      midSentence,
      taggedThenSentAtOnce,
      retaggedAfterSend,
      secondTag,
      personFirst,
      promoted,
      removed,
      afterSend,
      afterReload,
      afterReloadWithDraft,
      removalSurvivesReload,
      broadcastSurvivesReload,
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
      response.writeHead(200, { "content-type": contentTypes[".html"] });
      /* A STATED WIDTH. The default iframe is 300px, which is narrower than any phone this
         app supports, and the To: row wraps there for a reason that has nothing to do with
         the design. 1440x900 is the width the "one line" claim below is about; the phone
         widths are measured with screenshots in docs/evidence/2026-09-05-composer-to. */
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

test("the To: row is the address, and it says who is notified", async () => {
  const chrome = await findChrome();
  const server = await startDistServer();
  try {
    const { stdout, stderr } = await run(chrome, [
      "--headless=new",
      "--disable-gpu",
      "--no-sandbox",
      "--single-process",
      "--no-zygote",
      "--virtual-time-budget=12000",
      "--dump-dom",
      `${server.origin}/__measure`,
    ], { maxBuffer: 10 * 1024 * 1024, timeout: 30_000, killSignal: "SIGKILL" });
    const encoded = stdout.match(/data-to-measurement="([^"]+)"/)?.[1];
    const encodedError = stdout.match(/data-to-error="([^"]+)"/)?.[1];
    assert.ok(
      encoded,
      "headless Chrome returned no To: measurement\n" +
        `page error: ${encodedError ? Buffer.from(encodedError, "base64").toString("utf8") : "none"}\n` +
        `stderr: ${stderr.slice(-1_000)}`,
    );
    const measured = JSON.parse(
      Buffer.from(encoded, "base64").toString("utf8"),
    ) as ToMeasurement;

    /* BROADCAST IS SHOWN, never implied by an empty row, and it fits on one line. */
    assert.deepEqual(measured.atRest, {
      label: "To:",
      chips: [],
      broadcastChip: "Everyone here",
      note: "No agent is notified. Everyone here can read this.",
      oneLine: true,
    }, "atRest: the row at rest is a named broadcast on one line");

    /* AN @TAG MID-SENTENCE ADDS A CHIP and leaves the sentence exactly as typed. */
    assert.deepEqual(measured.midSentence, {
      value: "as @Orbit said, ship it",
      chips: ["Orbit"],
      note: "Orbit is notified.",
    }, "midSentence: a tag mid-sentence adds a chip and leaves the sentence alone");

    /* A SECOND TAG ADDS (ruling D2): it does not replace the set and does not open a DM.
       Orbit is still first, so Orbit is still the one the service wakes. */
    assert.deepEqual(measured.secondTag, {
      chips: ["Orbit", "River"],
      note: "Orbit is notified. River can read this and reply.",
      notifiedChip: "Orbit",
    }, "secondTag: a second tag adds rather than replacing");

    /* THE BOUND, ON SCREEN. A person in front means nobody is woken, however many agents
       follow, and the row says that plainly with the one remedy that exists. */
    assert.deepEqual(measured.personFirst, {
      chips: ["Kenji Ito", "Orbit"],
      note: "No agent is notified. 2 recipients can read this and reply. " +
        "Only the first recipient is notified. Choose a name to put it first.",
      notifiedChip: "",
      /* THE CHIP AND THE SENTENCE AGREE. Promoting a person wakes nobody, so the person's
         own control says that rather than promising a wake the trigger cannot give. */
      promoteTitles: [
        "Put Kenji Ito first. No agent is notified while a person is first",
        "Put Orbit first, so Orbit is notified",
      ],
    }, "personFirst: a person in front wakes nobody, and every chip says what it does");
    assert.deepEqual(measured.promoted, {
      chips: ["Orbit", "Kenji Ito"],
      note: "Orbit is notified. Kenji Ito can read this and reply.",
      notifiedChip: "Orbit",
    }, "promoted: choosing a name puts it first");

    /* REMOVING A CHIP REMOVES THE RECIPIENT and the tag left in the prose does not undo it.
       Without that the reader could not unaddress anybody they had mentioned. */
    assert.deepEqual(measured.removed, {
      chips: ["Orbit"],
      valueStillHasTag: true,
      afterKeystroke: ["Orbit"],
    }, "removed: a removed chip stays removed while its tag stays in the body");

    /* ONE SIGNAL, and the chips stay: the next message opens addressed to this one's
       recipients, which is what stops the reader losing who they were talking to.

       ASSERTED FIRST of the three send claims, and that order is load-bearing for the
       mutation harness rather than for the reader: a send that stopped reading the chips
       breaks only this one, while the two below break for several different reasons. Put
       the narrow claim first and each defect fails on its own message. */
    assert.deepEqual(measured.afterSend, {
      chips: ["Orbit"],
      rowTarget: "→ Orbit",
      rowsAdded: 1,
    }, "afterSend: one signal, addressed to the chips, and the chips stay");

    assert.deepEqual(measured.taggedThenSentAtOnce, {
      chips: ["Lumen"],
      rowTarget: "→ Lumen",
    }, "taggedThenSentAtOnce: a tag typed just before Enter is still a recipient");

    assert.deepEqual(
      measured.retaggedAfterSend,
      { chips: ["Lumen"] },
      "retaggedAfterSend: the same tag typed again after a send addresses again",
    );
    assert.deepEqual(measured.afterReload, {
      chips: ["Orbit"],
      note: "Orbit is notified.",
    }, "afterReload: a reload opens addressed to the last message's recipients");
    assert.deepEqual(measured.afterReloadWithDraft, {
      chips: ["Orbit", "Lumen"],
      value: "and @Lumen should see it",
    }, "afterReloadWithDraft: a saved draft's own tags are on the row after a reload");
    assert.deepEqual(measured.removalSurvivesReload, {
      chips: ["Orbit"],
      value: "and @Lumen should see it",
    }, "removalSurvivesReload: a recipient removed by hand stays removed across a reload");
    assert.deepEqual(measured.broadcastSurvivesReload, {
      chips: [],
      note: "No agent is notified. Everyone here can read this.",
      value: "everyone should see this",
    }, "broadcastSurvivesReload: an emptied To: is a broadcast the reader chose, not a missing set");
  } finally {
    await server.close();
  }
});

test("the posted body carries the To: set and leaves both scalar fields null", () => {
  const orbit = { kind: "agent", id: "11111111-1111-4111-8111-111111111111" } as const;
  const river = { kind: "person", id: "22222222-2222-4222-8222-222222222222" } as const;

  /* BYTE FOR BYTE. `to` replaces the scalar pair, and the edge refuses a body that sets one
     as well ("to_user_id names a recipient and so does to"); it writes recipient 0 into that
     column itself, so an old reader still sees a real recipient. */
  assert.deepEqual(
    browserSignalCommand("ship it", [orbit, river], browserSignalKind([orbit, river])),
    {
      kind: "post_signal",
      signal_kind: "ask",
      body: "ship it",
      to_user_id: null,
      to_agent_principal_id: null,
      in_reply_to: null,
      about: null,
      to: [
        { kind: "agent", id: "11111111-1111-4111-8111-111111111111" },
        { kind: "user", id: "22222222-2222-4222-8222-222222222222" },
      ],
    },
    "directed body: `to` carries the set and both scalar fields stay null",
  );

  /* AN EMPTY SET SENDS NO `to` KEY AT ALL. This is byte for byte the body every installed
     client has always sent, which is what keeps a broadcast working on any edge. */
  assert.deepEqual(browserSignalCommand("hello", [], browserSignalKind([])), {
    kind: "post_signal",
    signal_kind: "note",
    body: "hello",
    to_user_id: null,
    to_agent_principal_id: null,
    in_reply_to: null,
    about: null,
  }, "broadcast body: an empty set sends no `to` key at all");

  /* THE KIND FOLLOWS RECIPIENT 0, because the delivery trigger does. A person in front makes
     this a note, so no agent behind them is woken and the row already said so. */
  assert.equal(
    browserSignalCommand("x", [river, orbit], browserSignalKind([river, orbit])).signal_kind,
    "note",
    "signal_kind: a person in front makes this a note, so the agent behind is not woken",
  );
  assert.equal(notifiedRecipient([river, orbit]), null);
});

test("nothing but the reader moves the address", () => {
  /* A SOURCE CLAIM, and it says why. The tag pass rewrites both the To: set and the record
     of which tags produced it, so it may run only where the reader acted: a keystroke, a
     pick from the mention list, a draft restore, and the flush the submit does before it
     reads the set.

     It was called from `renderRoster` for one round. A roster paint then re-parsed whatever
     was in the box — including the empty box a send leaves behind while it waits for the
     server — which wiped the applied record and let a recipient the reader had removed come
     back under the retry, at a new command id. A review arm found it.

     BOUND: this counts call sites in one file. It does not prove no other module moves the
     set, and nothing else imports these functions. */
  const dashboard = readFileSync(
    new URL("./LiveDashboard.astro", import.meta.url),
    "utf8",
  );
  const callSites = dashboard.split("applyComposerMentions()").length - 1;
  assert.equal(
    callSites,
    4,
    "the tag pass is called from somewhere new; every call site must be an action of the reader",
  );
  for (const [where, anchor, close] of [
    ["the draft restore", "const restoreComposerDraft = (): void => {", "\n    };"],
    ["the typing pause", "const scheduleComposerToPass = (): void => {", "\n    };"],
    ["the mention pick", "const selectMention = (mention: EntityRef): void => {", "\n    };"],
    [
      "the submit flush",
      'one<HTMLFormElement>("[data-composer]")?.addEventListener("submit"',
      "const workspaceId = activeWorkspaceId;",
    ],
  ] as const) {
    const start = dashboard.indexOf(anchor);
    assert.ok(start > 0, `${where}: anchor not found`);
    const block = dashboard.slice(start, dashboard.indexOf(close, start));
    assert.match(block, /applyComposerMentions\(\)/, `${where} must run the tag pass`);
  }
  const roster = dashboard.slice(
    dashboard.indexOf("const renderRoster = (): void => {"),
  );
  assert.doesNotMatch(
    roster.slice(0, roster.indexOf("\n    };")),
    /applyComposerMentions\(\)/,
    "a roster paint moves the address",
  );
  /* And the address is not editable while its own message is on the wire. */
  const chipClicks = dashboard.slice(
    dashboard.indexOf('one<HTMLElement>("[data-composer-to-chips]")?.addEventListener'),
  );
  assert.match(
    chipClicks.slice(0, 1_600),
    /if \(composerSending\) return;/,
    "a chip can be edited while the message it addresses is being posted",
  );
});

test("an empty roster is not read as a workspace with nobody in it", () => {
  /* A SOURCE CLAIM, and it says so. renderWorkspace runs before the roster request settles,
     so `agents` and `members` are briefly empty for a workspace that has both. Pruning the
     chips against that empty roster would drop every one of them, and the restore runs once
     per workspace, so nothing would put them back. The browser observer above cannot reach
     this: sample mode has its roster before the first render.

     BOUND: this reads the guard and its two call sites out of one file. It does not prove
     the roster is empty at any particular moment; it proves the two places that would act
     on an empty one refuse to. */
  const dashboard = readFileSync(
    new URL("./LiveDashboard.astro", import.meta.url),
    "utf8",
  );
  assert.match(
    dashboard,
    /const composerRosterKnown = \(\): boolean => agents\.length > 0 \|\| members\.length > 0;/,
    "empty-roster guard: the predicate that separates 'not fetched yet' from 'nobody here'",
  );
  assert.match(
    dashboard,
    /restoredComposerToKey === key \|\| !composerRosterKnown\(\)\) return;/,
    "the remembered set is restored against a roster that is not known yet",
  );
  assert.match(
    dashboard,
    /if \(composerRosterKnown\(\)\) \{\s*\n\s*const pruned = pruneComposerRecipients\(composerTo, composerRecipientKnown\);/,
    "the chips are pruned against a roster that is not known yet",
  );
  /* And when it does prune, it says so. A chip that vanishes while the reader is writing to
     that person is the one thing the row exists to prevent. */
  assert.match(
    dashboard,
    /composerToNotice = composerPrunedNotice\(composerTo\.length - pruned\.length\);/,
    "a recipient the roster lost is removed without a word about it",
  );
});

test("a failed send does not change the address under the retry", () => {
  /* A SOURCE-ORDER CLAIM, and it says why. Sample mode's send cannot fail, so no browser
     step in this file can reach the catch; the failure model itself is measured in
     composer-sprint.observer.test.ts.

     The record of which tags had already become chips must follow the BODY. Clearing it
     before the post looked right and was not: a failed send puts the body back, an empty
     record reads every tag in it as fresh, and a chip the reader had removed comes back.
     The address then differs from the one the message was sent to, which changes
     `audienceKey`, which mints a SECOND command id for a message the server may already
     hold. Both arms found it. */
  const dashboard = readFileSync(
    new URL("./LiveDashboard.astro", import.meta.url),
    "utf8",
  );
  const submit = dashboard.slice(
    dashboard.indexOf('one<HTMLFormElement>("[data-composer]")?.addEventListener("submit"'),
  );
  const beforeThePost = submit.slice(0, submit.indexOf("await postBrowserSignal("));
  assert.ok(beforeThePost.length > 0, "the submit path has no post seam to measure against");
  assert.doesNotMatch(
    beforeThePost,
    /composerToApplied = \[\];/,
    "the applied record is cleared before the post is known to have landed",
  );
  /* And it IS cleared, inside the success block: after the post seam and before the catch.
     Landmarking this on a neighbouring call was wrong — a mutation of that neighbour turned
     this control red for a claim it does not make, which the harness read as its own. */
  const cleared = submit.indexOf("        composerToApplied = [];");
  assert.ok(cleared > 0, "the applied record is never cleared on success");
  assert.ok(
    cleared > submit.indexOf("await postBrowserSignal(") &&
      cleared < submit.indexOf("} catch (caught) {"),
    "the applied record is cleared outside the success block",
  );
});

test("a tag the parser gave up on is named, not dropped out of the message", () => {
  /* A SOURCE CLAIM, and it says why. A tag can be over the cap in two places: the To: set
     refusing an entity it has no room for, and `addressFromBody` stopping after
     MENTION_MAX_RECIPIENTS and handing back bare names it never resolved. Reading only the
     first dropped a name out of the message with nothing said about it.

     BOUND: the sample roster has five taggable names and the cap is eight, so no browser
     step in this file can reach the parser's overflow. This reads the source instead, and
     the sentence itself is measured in composer-address.test.mjs. */
  const dashboard = readFileSync(
    new URL("./LiveDashboard.astro", import.meta.url),
    "utf8",
  );
  assert.match(
    dashboard,
    /const overCap = \[\s*\n\s*\.\.\.merged\.refused\.map\(composerRecipientName\),\s*\n\s*\.\.\.address\.overflow,\s*\n\s*\];/,
    "both ways a tag can be over the cap must reach the notice",
  );
  assert.match(dashboard, /if \(overCap\.length > 0\) notices\.push\(composerToFullNotice\(overCap\)\);/);
});

test("the note is generated from the cap and the wake position, not typed beside them", () => {
  const source = readFileSync(
    new URL("../../lib/composer-address.ts", import.meta.url),
    "utf8",
  );
  /* BOUND OF THIS SWEEP, stated: it reads ONE file and looks for a digit or the word
     "everyone is notified" in the sentences that file builds. It does not prove the app has
     no other typed cap or wake claim anywhere else, and it cannot: a source regex has no
     complete set to run over. What it does prove is that the module that builds the To:
     sentences takes both numbers from the server's own constants.

     The list it iterates and the assertions below come from the same array. */
    const generated = [
      ["cap", /COMPOSER_TO_MAX = SIGNAL_RECIPIENT_MAX/],
      ["wake position", /NOTIFIED_POSITION = SCALAR_POSITION/],
      ["cap sentence", /\$\{COMPOSER_TO_MAX\}/],
      /* The note's own clause, not merely the call anywhere in the file: the chip label
         below also calls positionWord, so a bare call pattern stopped discriminating. */
      ["wake sentence", /\$\{positionWord\(NOTIFIED_POSITION\)\} recipient is notified/],
      /* The chip's own control names the same position. Typing "first" there while the note
         generated it was half of a round-one finding that the first fix did not cover. */
      ["chip label position", /const front = positionWord\(NOTIFIED_POSITION\);/],
    ] as const;
  for (const [name, pattern] of generated) {
    assert.match(source, pattern, `${name} is not built from the constant`);
  }
  assert.equal(COMPOSER_TO_MAX, 8, "the cap moved; the numbers in this file's comments have not");
  /* And the sentence never claims the whole set is woken, for any set the cap allows. */
  const nameOf = (entity: { kind: string; id: string }) => entity.id;
  for (let size = 0; size <= COMPOSER_TO_MAX; size += 1) {
    const set = Array.from({ length: size }, (_unused, index) => ({
      kind: index % 2 === 0 ? "agent" as const : "person" as const,
      id: `r${index}`,
    }));
    assert.doesNotMatch(
      composerDeliveryNote(set, nameOf),
      /are notified|everyone is notified|all recipients/i,
      `a set of ${size} is told more than one of them is woken`,
    );
  }
});
