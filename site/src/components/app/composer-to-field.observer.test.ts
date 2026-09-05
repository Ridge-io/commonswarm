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
  personFirst: { chips: string[]; note: string; notifiedChip: string };
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
       to wait for the row rather than read it in the same tick. */
    const settleChips = async (count, label) => {
      await waitFor(() => chipNames().length === count, label);
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
    const personFirst = { chips: chipNames(), note: noteText(), notifiedChip: notifiedChip() };

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
    doc.querySelector("[data-composer-to-remove]").click();
    await settleChips(0, "the chip removed after the send");
    type("@Lumen hello again");
    await settleChips(1, "Lumen addressed again by the same tag");
    const retaggedAfterSend = { chips: chipNames() };

    /* THE SET SURVIVES A SEND, and the row's target is recipient 0. */
    await clearTo();
    type("as @Orbit said, ship it");
    await settleChips(1, "Orbit back in To: for the send");
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
    await waitFor(() => chipNames().length === 1, "the remembered To: set");
    const afterReload = { chips: chipNames(), note: noteText() };

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
    });

    /* AN @TAG MID-SENTENCE ADDS A CHIP and leaves the sentence exactly as typed. */
    assert.deepEqual(measured.midSentence, {
      value: "as @Orbit said, ship it",
      chips: ["Orbit"],
      note: "Orbit is notified.",
    });

    /* A SECOND TAG ADDS (ruling D2): it does not replace the set and does not open a DM.
       Orbit is still first, so Orbit is still the one the service wakes. */
    assert.deepEqual(measured.secondTag, {
      chips: ["Orbit", "River"],
      note: "Orbit is notified. River can read this and reply.",
      notifiedChip: "Orbit",
    });

    /* THE BOUND, ON SCREEN. A person in front means nobody is woken, however many agents
       follow, and the row says that plainly with the one remedy that exists. */
    assert.deepEqual(measured.personFirst, {
      chips: ["Kenji Ito", "Orbit"],
      note: "No agent is notified. 2 recipients can read this and reply. " +
        "Only the first recipient is notified. Choose a name to put it first.",
      notifiedChip: "",
    });
    assert.deepEqual(measured.promoted, {
      chips: ["Orbit", "Kenji Ito"],
      note: "Orbit is notified. Kenji Ito can read this and reply.",
      notifiedChip: "Orbit",
    });

    /* REMOVING A CHIP REMOVES THE RECIPIENT and the tag left in the prose does not undo it.
       Without that the reader could not unaddress anybody they had mentioned. */
    assert.deepEqual(measured.removed, {
      chips: ["Orbit"],
      valueStillHasTag: true,
      afterKeystroke: ["Orbit"],
    });

    assert.deepEqual(measured.taggedThenSentAtOnce, {
      chips: ["Lumen"],
      rowTarget: "→ Lumen",
    });

    assert.deepEqual(measured.retaggedAfterSend, { chips: ["Lumen"] });

    /* ONE SIGNAL, and the chips stay: the next message opens addressed to this one's
       recipients, which is what stops the reader losing who they were talking to. */
    assert.deepEqual(measured.afterSend, {
      chips: ["Orbit"],
      rowTarget: "→ Orbit",
      rowsAdded: 1,
    });
    assert.deepEqual(measured.afterReload, {
      chips: ["Orbit"],
      note: "Orbit is notified.",
    });
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
  });

  /* THE KIND FOLLOWS RECIPIENT 0, because the delivery trigger does. A person in front makes
     this a note, so no agent behind them is woken and the row already said so. */
  assert.equal(browserSignalCommand("x", [river, orbit], browserSignalKind([river, orbit])).signal_kind, "note");
  assert.equal(notifiedRecipient([river, orbit]), null);
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
      ["wake sentence", /positionWord\(NOTIFIED_POSITION\)/],
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
