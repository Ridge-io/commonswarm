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
  composerToFullNotice,
  notifiedRecipients,
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
  secondTag: { chips: string[]; note: string };
  /** WHICH CHIPS CARRY THE NOTIFIED MARK, read without the mark's own selector. */
  notifiedMark: {
    afterSecondTag: { markedNames: string[]; note: string };
    afterPromotion: { markedNames: string[]; note: string };
  };
  /** An agent behind a person IS woken, and every chip says what its own control does.
      ~~"A person in front means the service wakes nobody, and the row says so with a remedy."~~
      Retired 2026-09-05: there is no remedy, because there is nothing left to remedy. */
  personFirst: {
    chips: string[];
    note: string;
    notifiedChip: string;
    /** What each chip's own control promises. ~~"A person's must not promise a wake."~~ NONE
        of them may promise a wake now: the row answers that in one place. */
    promoteTitles: string[];
  };
  /** Choosing a name puts it first, which is what the message shows as addressed to.
      ~~"which is the only control over who is woken"~~ retired 2026-09-05. */
  promoted: { chips: string[]; note: string };
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
  /** A broadcast draft survives a WORKSPACE SWITCH, which a reload cannot stand in for. */
  broadcastSurvivesSwitch: { chips: string[]; note: string; value: string };
  /** A chip edit and nothing else survives the same trip, with no keystroke to save it. */
  chipEditSurvivesSwitch: { chips: string[]; value: string };
  /** The second workspace has its own address, and the first one's chips do not follow. */
  switchedWorkspaceAddress: { chips: string[]; value: string };
  /** A name the cap has no room for is named on the row rather than dropped. */
  capRefused: { chips: string[]; note: string };
  /** And it joins the set as soon as the reader deletes a chip to make room for it. */
  capAfterRoom: { chips: string[]; note: string };
  /** A chip removed with NOTHING TYPED survives a switch: an address is a draft on its own. */
  emptyBodyEditSurvivesSwitch: { chips: string[]; value: string };
  /* ── AN IN-FLIGHT SEND ─────────────────────────────────────────────────────────────── */
  /** Refresh reopens the workspace on screen MID-SEND, and the composer comes back usable. */
  refreshMidSend: {
    /** THE POSITIVE CONTROL: the box really was read-only when the step pressed Refresh. */
    sawFlagUp: boolean;
    readOnly: boolean;
    busy: string | null;
    sendState: string;
    status: string;
    chips: string[];
    chipsAfterRemove: string[];
    chipsAfterTag: string[];
    postedRows: number;
  };
  /** A send that FAILS under one puts the body back rather than leaving an empty frozen box. */
  failedUnderRefresh: {
    sawFlagUp: boolean;
    readOnly: boolean;
    value: string;
    chips: string[];
    retryHidden: boolean;
    statusNamesTheFailure: boolean;
  };
  /** A workspace SWITCH under a failing send writes nothing into the box it lands on. */
  switchedUnderFailedSend: {
    sawFlagUp: boolean;
    readOnly: boolean;
    value: string;
    chips: string[];
    /** And the earlier send does not lower the flag of the send that composer is running. */
    ownSendStillHeld: boolean;
  };
  /** And the unsent message is still in the workspace it was written in, with its address. */
  unsentBodySurvivesSwitch: { value: string; chips: string[] };
  /** Sending it again posts it once. */
  resentOnce: { rows: number; value: string };
  /** A send whose composer was torn down does not write its body over what is in it now. */
  returnedBeforeItFailed: {
    sawFlagUp: boolean;
    restoredBeforeTyping: string;
    value: string;
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
        /* THE WORKSPACE AND THE FEED, because a switch step waits on both and a payload that
           named neither could not tell which half of it had not arrived. */
        workspace: doc.querySelector("[data-sidebar-workspace-name]")?.textContent,
        rows: doc.querySelectorAll("[data-feed-list] > li").length,
        panel: doc.querySelector("live-dashboard")?.dataset.state,
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
    const secondTag = { chips: chipNames(), note: noteText() };

    /* THE MARK ITSELF, ON ITS OWN CLAIM. The notifiedChip helper finds a chip BY the mark,
       so deleting the mark makes it return "" and every step that read it went red together —
       including secondTag, which is about a tag ADDING rather than replacing, and promoted,
       which is about order. A review arm found that: one mutation, several reds,
       none of them naming what broke. This reads the marked chips out of the chip list
       instead, so the mark answers for itself and the steps above answer for the set. */
    const readMark = () => {
      const marked = [...doc.querySelectorAll("[data-composer-to-chip]")]
        .filter((chip) => chip.dataset.composerToNotified !== undefined);
      return {
        /* EVERY MARKED CHIP, by name. ~~marked: marked.length plus markedName of the
           first~~ described a row where exactly one chip could carry the mark. Every agent
           carries it now, so the claim is about the SET of marked names. */
        markedNames: marked
          .map((chip) => chip.querySelector("[data-composer-to-promote]")?.textContent ?? ""),
        /* The sentence itself, so the two are compared rather than assumed equal. */
        note: noteText(),
      };
    };
    const markAfterSecondTag = readMark();

    /* A PERSON IN FRONT NO LONGER SILENCES THE AGENT BEHIND: ~~"A PERSON IN FRONT wakes
       nobody, whatever follows."~~ retired 2026-09-05. Kenji Ito is a MEMBER in the sample
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
    const promoted = { chips: chipNames(), note: noteText() };
    const notifiedMark = { afterSecondTag: markAfterSecondTag, afterPromotion: readMark() };

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

    /* ── THE WORKSPACE SWITCH ──────────────────────────────────────────────────────────
       A reload cannot stand in for this. On a reload the roster is in place before the first
       paint; on a SWITCH the composer is torn down while the old workspace is still current,
       the screen paints once with nothing known, and the roster arrives after that. Every
       round of this lane closed a door on one of those three moments and the next round found
       another, because the address and the body were kept in step by hand across them. */
    const switchTo = async (workspaceId, workspaceName) => {
      doc.querySelector("[data-workspace-menu-trigger]").click();
      await waitFor(
        () => doc.querySelector('[data-workspace-id="' + workspaceId + '"]') !== null,
        "the workspace menu",
      );
      doc.querySelector('[data-workspace-id="' + workspaceId + '"]').click();
      await waitFor(
        () => doc.querySelector("[data-sidebar-workspace-name]")?.textContent === workspaceName &&
          doc.querySelectorAll("[data-feed-list] > li").length > 0,
        "the workspace named " + workspaceName,
      );
      /* The roster lands a frame after the paint, exactly as a real one does. Read after it,
         or the measurement is of the gap rather than of what the reader ends up with. */
      await new Promise((resolve) => view.setTimeout(resolve, 400));
    };

    /* A BROADCAST DRAFT IS STILL A BROADCAST AFTER A ROUND TRIP. The last message went to
       Orbit, so anything that loses the draft's own address puts Orbit back on the row. */
    await switchTo("sample-field-lab", "Field lab");
    await switchTo("sample-design-studio", "Design studio");
    const broadcastSurvivesSwitch = {
      chips: chipNames(),
      note: noteText(),
      value: input().value,
    };

    /* AND A CHIP EDIT SURVIVES ONE, with nothing else changed to carry it. The removal is the
       last thing that happens before the switch: no keystroke follows it, and the switch
       cancels the pending draft write, so an edit that did not write itself down is gone. */
    type("@Orbit and @River will handle it");
    await settleChips(2, "two chips before a chip-only edit");
    [...doc.querySelectorAll("[data-composer-to-remove]")]
      .find((button) => button.getAttribute("aria-label") === "Remove River from To:")
      ?.click();
    await settle(1);
    await switchTo("sample-field-lab", "Field lab");
    /* The second workspace is not the first one's composer: its own address, its own draft. */
    const switchedWorkspaceAddress = { chips: chipNames(), value: input().value };
    await switchTo("sample-design-studio", "Design studio");
    const chipEditSurvivesSwitch = { chips: chipNames(), value: input().value };

    /* ── THE CAP, AND THE WAY BACK FROM IT ─────────────────────────────────────────────
       Reached in the larger workspace, because the first sample roster has five taggable
       names and the cap is eight. The set is filled by SENDING to eight, so the chips come
       from the remembered set and the tag that follows is refused by the To: set itself
       rather than by the parser's own ceiling. A refused name used to be written off, so
       deleting a chip to make room did nothing and the only way back was deleting the tag. */
    await switchTo("sample-field-lab", "Field lab");
    await clearTo();
    type("@Alto @Basalt @Cinder @Delta @Ember @Flint @Glint @Harrow ship it");
    await settleChips(8, "a full To: set");
    await send("shipping the field trial");
    type("@Inlet should see this too");
    await new Promise((resolve) => view.setTimeout(resolve, 400));
    const capRefused = { chips: chipNames(), note: noteText() };
    doc.querySelector("[data-composer-to-remove]")?.click();
    await settle(8);
    const capAfterRoom = { chips: chipNames(), note: noteText() };

    /* AN ADDRESS IS A DRAFT ON ITS OWN. Empty the box, take one name out of To:, and leave.
       There is no body and no attachment, so "nothing to save" used to be true and the edit
       was dropped: the reader came back to the name they had just removed. */
    type("");
    await new Promise((resolve) => view.setTimeout(resolve, 400));
    doc.querySelector("[data-composer-to-remove]")?.click();
    await settle(7);
    await switchTo("sample-design-studio", "Design studio");
    await switchTo("sample-field-lab", "Field lab");
    const emptyBodyEditSurvivesSwitch = { chips: chipNames(), value: input().value };

    /* ── AN IN-FLIGHT SEND, AND WHAT THE SCREEN MAY DO UNDER IT ───────────────────────
       Sample mode resolves a send with no await at all, so until now nothing in this file
       could act while a message was on the wire: both in-flight freezes were read out of the
       source, and the send's own teardown was never driven under a screen that moved.
       data-sample-send-delay gives the sample send a window and data-sample-send-fail
       makes it fail inside one. Both are sample-only.

       sawFlagUp IS THE POSITIVE CONTROL in every step below. It records that the box really
       was read-only at the moment the step acted, so a window that stopped opening fails on
       its own assertion instead of making the step vacuous. */
    /* THE IN-FLIGHT STEPS CLEAR WITHOUT THROWING. clearTo ends in settleChips, which aborts
       the whole measurement when the row will not empty — and a composer left frozen by a
       stuck send flag is exactly that state, so the defect these steps exist to catch would
       arrive as "no measurement" rather than on its own assertion. A review round measured
       that: the first mutation here reported RED, WRONG REASON for it. */
    const clearToSoft = async () => {
      type("");
      await new Promise((resolve) => view.setTimeout(resolve, 350));
      for (let guard = 0; guard < 12; guard += 1) {
        const remove = doc.querySelector("[data-composer-to-remove]");
        if (!remove) break;
        remove.click();
      }
      await settle(0);
    };
    const settleFor = async (predicate) => {
      for (let attempt = 0; attempt < 400; attempt += 1) {
        if (predicate()) return true;
        await new Promise((resolve) => view.setTimeout(resolve, 25));
      }
      return false;
    };
    const rowsCarrying = (needle) =>
      [...list().children].filter((row) => (row.textContent ?? "").includes(needle)).length;
    const pressRefresh = () => doc.querySelector("[data-refresh]").click();
    doc.documentElement.dataset.sampleSendDelay = "1500";

    /* REFRESH REOPENS THE WORKSPACE ALREADY ON SCREEN. It advances the generation and runs no
       teardown, so the composer is left standing with a send flag on it. While the lift asked
       about that generation, the flag never came down again: a read-only box, dead chips and
       a frozen To: row for the rest of the session. */
    await clearToSoft();
    type("@Alto refreshing under this one");
    await settle(1);
    doc.querySelector("[data-composer]").requestSubmit();
    const sawFlagUpOnRefresh = await settleFor(() => input().readOnly);
    pressRefresh();
    await settleFor(() => !input().readOnly);
    await new Promise((resolve) => view.setTimeout(resolve, 500));
    const refreshedChips = chipNames();
    const refreshedReadOnly = input().readOnly;
    const refreshedBusy = input().getAttribute("aria-busy");
    const refreshedSendState = doc.querySelector("[data-composer-send]").dataset.state ?? "";
    /* AND THE SENTENCE THE SEND PUT UP IS GONE. It was written at the END of the screen block,
       so a reopen left "Posting message..." standing over a composer that was finished. */
    const refreshedStatus = doc.querySelector("[data-composer-status]").textContent ?? "";
    /* THE CHIPS ANSWER A CLICK: a chip click returns early while the flag is up. */
    doc.querySelector("[data-composer-to-remove]")?.click();
    await settle(0);
    const refreshedChipsAfterRemove = chipNames();
    /* AND THE ROW IS NOT FROZEN: the derived pass holds while the flag is up, so a stuck flag
       stops every later tag, prune and edit from ever committing. */
    type("@Basalt is still addressable");
    await settle(1);
    const refreshedChipsAfterTag = chipNames();
    /* AND THE MESSAGE WAS POSTED ONCE. The landed row reaches the sample store whatever the
       screen did, so the next reopen paints it: one row, not none and not two. */
    pressRefresh();
    await settleFor(() => !doc.querySelector("[data-composer]").hidden);
    await new Promise((resolve) => view.setTimeout(resolve, 300));
    const refreshMidSend = {
      sawFlagUp: sawFlagUpOnRefresh,
      readOnly: refreshedReadOnly,
      busy: refreshedBusy,
      sendState: refreshedSendState,
      status: refreshedStatus,
      chips: refreshedChips,
      chipsAfterRemove: refreshedChipsAfterRemove,
      chipsAfterTag: refreshedChipsAfterTag,
      postedRows: rowsCarrying("refreshing under this one"),
    };

    /* AND A SEND THAT FAILS UNDER A REFRESH PUTS THE BODY BACK. The restore sat below the
       generation test at the top of the catch, so a reopen threw it away with the screen
       work: an empty read-only box, no error, and no Retry. */
    await clearToSoft();
    doc.documentElement.dataset.sampleSendFail = "";
    type("@Cinder this one fails under a refresh");
    await settle(1);
    doc.querySelector("[data-composer]").requestSubmit();
    const sawFlagUpOnFailure = await settleFor(() => input().readOnly);
    pressRefresh();
    await settleFor(() => !input().readOnly);
    await new Promise((resolve) => view.setTimeout(resolve, 500));
    const failedUnderRefresh = {
      sawFlagUp: sawFlagUpOnFailure,
      readOnly: input().readOnly,
      value: input().value,
      chips: chipNames(),
      retryHidden: doc.querySelector("[data-composer-retry]").hidden,
      statusNamesTheFailure: (doc.querySelector("[data-composer-status]")?.textContent ?? "")
        .includes("asked to fail this send"),
    };
    delete doc.documentElement.dataset.sampleSendFail;

    /* AND A WORKSPACE SWITCH UNDER A FAILING SEND WRITES NOTHING INTO THE BOX IT LANDS ON.
       That composer is not the send's. The message stays in the workspace it was written in,
       because the stored draft is frozen for the whole post — which is the freeze this file
       could only read out of the source until the window above existed. */
    await clearToSoft();
    doc.documentElement.dataset.sampleSendFail = "";
    doc.documentElement.dataset.sampleSendDelay = "3000";
    type("@Delta written in the field lab");
    await settle(1);
    doc.querySelector("[data-composer]").requestSubmit();
    const sawFlagUpOnSwitch = await settleFor(() => input().readOnly);
    await switchTo("sample-design-studio", "Design studio");
    /* The switch is faster than the window, so the send is still on the wire and the box in
       front of the reader is a different workspace's. */
    const studioUnderTheFailingSend = {
      readOnly: input().readOnly,
      value: input().value,
      chips: chipNames(),
    };
    /* A SECOND SEND, IN THE WORKSPACE THE READER MOVED TO, while the first is still going.
       The first raised its flag on a composer that has since been torn down and rebuilt, so
       when it finishes it must not lower THIS send's flag. The first window closes at about
       3s and this one at about 5s, and the read below sits between them. */
    delete doc.documentElement.dataset.sampleSendFail;
    doc.documentElement.dataset.sampleSendDelay = "5000";
    type("a message the studio is posting");
    doc.querySelector("[data-composer]").requestSubmit();
    await new Promise((resolve) => view.setTimeout(resolve, 3_500));
    const switchedUnderFailedSend = {
      sawFlagUp: sawFlagUpOnSwitch,
      ...studioUnderTheFailingSend,
      ownSendStillHeld: input().readOnly,
    };
    /* Let the studio's own send finish before moving on. */
    await settleFor(() => !input().readOnly);
    delete doc.documentElement.dataset.sampleSendDelay;
    await new Promise((resolve) => view.setTimeout(resolve, 300));
    await switchTo("sample-field-lab", "Field lab");
    const unsentBodySurvivesSwitch = { value: input().value, chips: chipNames() };
    /* AND SENDING IT AGAIN POSTS IT ONCE, which is the double-post this family produced twice:
       a message that came back as a draft and was sent a second time under a fresh command id. */
    const rowsBeforeResend = list().children.length;
    doc.querySelector("[data-composer]").requestSubmit();
    await settleFor(() => list().children.length > rowsBeforeResend);
    await new Promise((resolve) => view.setTimeout(resolve, 200));
    const resentOnce = {
      rows: rowsCarrying("written in the field lab"),
      value: input().value,
    };

    /* AND A SEND WHOSE COMPOSER WAS TORN DOWN DOES NOT COME BACK FOR IT. The reader can leave
       a workspace and return to it before the send finishes. The composer they return to was
       rebuilt from storage and may already have new text in it, and a failure from before
       must not write its old body over that. The teardown says so by retiring the send's
       token: coming back to the same workspace does not give a torn-down send its box back. */
    doc.documentElement.dataset.sampleSendFail = "";
    doc.documentElement.dataset.sampleSendDelay = "6000";
    type("@Ember one more from the field lab");
    await settle(1);
    doc.querySelector("[data-composer]").requestSubmit();
    const sawFlagUpOnReturn = await settleFor(() => input().readOnly);
    await switchTo("sample-design-studio", "Design studio");
    await switchTo("sample-field-lab", "Field lab");
    /* The draft is back, and the reader writes something else over it. */
    const restoredBeforeTyping = input().value;
    type("a new line typed after coming back");
    await new Promise((resolve) => view.setTimeout(resolve, 6_500));
    const returnedBeforeItFailed = {
      sawFlagUp: sawFlagUpOnReturn,
      restoredBeforeTyping,
      value: input().value,
    };
    delete doc.documentElement.dataset.sampleSendFail;
    delete doc.documentElement.dataset.sampleSendDelay;

    document.documentElement.dataset.toMeasurement = btoa(unescape(encodeURIComponent(JSON.stringify({
      atRest,
      midSentence,
      taggedThenSentAtOnce,
      retaggedAfterSend,
      secondTag,
      notifiedMark,
      personFirst,
      promoted,
      removed,
      afterSend,
      afterReload,
      afterReloadWithDraft,
      removalSurvivesReload,
      broadcastSurvivesReload,
      broadcastSurvivesSwitch,
      switchedWorkspaceAddress,
      chipEditSurvivesSwitch,
      capRefused,
      capAfterRoom,
      emptyBodyEditSurvivesSwitch,
      refreshMidSend,
      failedUnderRefresh,
      switchedUnderFailedSend,
      unsentBodySurvivesSwitch,
      resentOnce,
      returnedBeforeItFailed,
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
    /* ONE RETRY, AND ONLY WHEN THE BROWSER DIED ON A SIGNAL. `--single-process --no-zygote` is
       cheap and is also the configuration that takes a SIGSEGV when this host is under memory
       pressure: measured 2026-09-05, one crash in 58 mutation runs, in a RESTORE run whose
       source was pristine. A crash is not a measurement, so retrying it does not weaken any
       control here — a real defect fails on both attempts, and anything that is not a signal
       death (an assertion, a timeout we asked for, a non-zero exit) is rethrown untouched. */
    const runChrome = async (attempt = 0): Promise<{ stdout: string; stderr: string }> => {
      try {
        return await run(chrome, [
          "--headless=new",
          "--disable-gpu",
          "--no-sandbox",
          "--single-process",
          "--no-zygote",
          /* RAISED FROM 60000 for the in-flight steps: four sends hold windows open, the waits
             around them are virtual-clock time too, and a MUTATED build leaves a frozen
             composer in which every settleFor runs to its own ceiling instead of returning
             early. */
          "--virtual-time-budget=240000",
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
       ~~"Orbit is still first, so Orbit is still the one the service wakes."~~ Retired
       2026-09-05: River is an agent too, so BOTH are woken and order decides neither. */
    /* ~~"Orbit is notified. River can read this and reply."~~ Retired 2026-09-05: River is an
       agent in the sample roster, and both agents are woken now, so the sentence counts them
       and neither is described as a reader who is not notified. */
    assert.deepEqual(measured.secondTag, {
      chips: ["Orbit", "River"],
      note: "2 agents are notified.",
    }, "secondTag: a second tag adds rather than replacing");

    /* ~~"EXACTLY ONE CHIP IS MARKED, and it is the one the sentence names."~~ and ~~"Read
       twice, because promoting is the one control the reader has over the mark."~~ Both
       retired 2026-09-05. What still holds, and is the reason this is read at all: the mark is
       the only thing on the row that says who the service wakes, so a chip and the sentence
       under it cannot be allowed to disagree. It is still read twice, for the OPPOSITE reason —
       order is what the reader can change, and the mark must not follow it.

       EVERY AGENT CHIP IS MARKED, and the sentence under them says the same number.
       ~~`{ marked: 1, markedName: "Orbit", noteNames: "Orbit" }`~~ described the row where one
       chip could carry the mark. Read twice, before and after a promotion, because order is
       the one thing the reader can change and the mark must not follow it any more. */
    assert.deepEqual(measured.notifiedMark, {
      afterSecondTag: { markedNames: ["Orbit", "River"], note: "2 agents are notified." },
      /* The promotion step runs on a DIFFERENT set — Kenji Ito, a person, and Orbit — so one
         chip is marked there. That is the point of reading the mark twice: order changed and
         the marked set did not. Under the retired rule this step was the one that proved a
         person in front silenced nobody's mark; it now proves the mark ignores order. */
      afterPromotion: {
        markedNames: ["Orbit"],
        note: "Orbit is notified. Kenji Ito can read this and reply.",
      },
    }, "notifiedMark: the chips carrying the notified mark and the sentence under them disagree");
    /* AND THE MARK IS THE SENTENCE'S OWN SUBJECT, compared rather than assumed: the count in
       the sentence is the number of marked chips. */
    for (const step of [measured.notifiedMark.afterSecondTag, measured.notifiedMark.afterPromotion]) {
      assert.match(
        step.note,
        step.markedNames.length === 0
          ? /^No agent is notified\./
          : step.markedNames.length === 1
          ? new RegExp(`^${step.markedNames[0]} is notified\\.`)
          : new RegExp(`^${step.markedNames.length} agents are notified\\.`),
        `the mark and the sentence disagree: ${JSON.stringify(step)}`,
      );
    }

    /* THE BOUND, ON SCREEN. Every agent is woken wherever it sits, so a person in front is
       simply a person in front. ~~"A person in front means nobody is woken, however many
       agents follow, and the row says that plainly with the one remedy that exists."~~
       Retired 2026-09-05, with the remedy it named. */
    assert.deepEqual(measured.personFirst, {
      chips: ["Kenji Ito", "Orbit"],
      /* ~~"No agent is notified. 2 recipients can read this and reply. Only the first
         recipient is notified. Choose a name to put it first."~~ Retired 2026-09-05: a person
         in front no longer silences the agent behind, so the sentence names Orbit and the
         remedy clause is gone with the rule it described. */
      note: "Orbit is notified. Kenji Ito can read this and reply.",
      /* ~~`notifiedChip: ""`~~ Retired 2026-09-05: under the old rule a person at the front
         meant NO chip carried the mark, however many agents followed. Orbit is woken now and
         its chip says so, from behind a person. */
      notifiedChip: "Orbit",
      /* THE CHIP AND THE SENTENCE ANSWER DIFFERENT QUESTIONS NOW, which is why they cannot
         disagree: the sentence owns the wake and no chip mentions it. ~~"Promoting a person
         wakes nobody, so the person's own control says that rather than promising a wake the
         trigger cannot give."~~ Retired 2026-09-05. */
      /* ~~"Put Kenji Ito first. No agent is notified while a person is first"~~ and
         ~~"Put Orbit first, so Orbit is notified"~~. Both retired: promoting decides nothing
         about the wake now, so both chips say the one thing promoting still does. */
      promoteTitles: [
        /* Kenji Ito is already at the front here, so that chip states the fact rather than
           offering the move. ~~"Put Kenji Ito first. No agent is notified while a person is
           first"~~ was its old label, and it was about a wake this control no longer decides. */
        "This message shows as addressed to Kenji Ito",
        "Put Orbit first, so the message shows as addressed to Orbit",
      ],
    }, "personFirst: an agent behind a person is woken, and every chip says what it does");
    assert.deepEqual(measured.promoted, {
      chips: ["Orbit", "Kenji Ito"],
      note: "Orbit is notified. Kenji Ito can read this and reply.",
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

    /* AND IT SURVIVES A WORKSPACE SWITCH, which the reload above cannot stand in for. The
       last message went to Orbit, so any transition that loses the draft's own address puts
       Orbit back on the row: the empty set on screen would be residue rather than a choice,
       and the reader would broadcast-by-intent to one agent instead. */
    assert.deepEqual(measured.broadcastSurvivesSwitch, {
      chips: [],
      note: "No agent is notified. Everyone here can read this.",
      value: "everyone should see this",
    }, "broadcastSurvivesSwitch: a workspace switch put the last-sent set back over a draft");

    /* THE SECOND WORKSPACE IS ITS OWN COMPOSER. Nothing from the first one follows it there,
       which is what makes the round trip above a real one rather than a repaint. */
    assert.deepEqual(measured.switchedWorkspaceAddress, {
      chips: [],
      value: "",
    }, "switchedWorkspaceAddress: one workspace's address followed the reader into another");

    /* A CHIP EDIT AND NOTHING ELSE SURVIVES THE SAME TRIP. The removal is the last thing the
       reader does: no keystroke follows it to carry it into storage, and the switch cancels
       the pending draft write. An edit that did not write itself down came back undone, so
       the reader met a recipient they had just taken out. */
    assert.deepEqual(measured.chipEditSurvivesSwitch, {
      chips: ["Orbit"],
      value: "@Orbit and @River will handle it",
    }, "chipEditSurvivesSwitch: a chip edit made with nothing else did not reach storage");

    /* THE CAP NAMES WHAT DID NOT FIT, and the sentence is the module's own. */
    assert.deepEqual(
      measured.capRefused.chips,
      ["Alto", "Basalt", "Cinder", "Delta", "Ember", "Flint", "Glint", "Harrow"],
      "capRefused: the set stopped at the cap",
    );
    assert.equal(measured.capRefused.chips.length, COMPOSER_TO_MAX);
    assert.ok(
      measured.capRefused.note.endsWith(composerToFullNotice(["Inlet"])),
      `capRefused: the row does not name the recipient the cap turned away: ${measured.capRefused.note}`,
    );

    /* AND MAKING ROOM IS THE WAY BACK. Deleting one chip lets the tag still in the sentence
       join the set. It used to be written off as applied the moment it was refused, so the
       only recovery was deleting the tag and typing it again, which nothing said. */
    assert.deepEqual(
      measured.capAfterRoom.chips,
      ["Basalt", "Cinder", "Delta", "Ember", "Flint", "Glint", "Harrow", "Inlet"],
      "capAfterRoom: a refused name did not join the set when the reader made room for it",
    );
    assert.ok(
      !measured.capAfterRoom.note.includes("Remove one to make room"),
      "capAfterRoom: the row still says the set is full after the reader made room",
    );

    /* AN ADDRESS IS A DRAFT ON ITS OWN, with nothing typed to carry it. */
    assert.deepEqual(measured.emptyBodyEditSurvivesSwitch, {
      chips: ["Cinder", "Delta", "Ember", "Flint", "Glint", "Harrow", "Inlet"],
      value: "",
    }, "emptyBodyEditSurvivesSwitch: an address edited with nothing typed was not written down");

    /* ── THE IN-FLIGHT SEND ────────────────────────────────────────────────────────────
       REFRESH REOPENS THE WORKSPACE ON SCREEN. It advances the generation and tears nothing
       down, and the send's teardown used to ask that generation whether it still owned the
       composer. It did not, so the flag stayed up: the box stayed read-only, the send button
       stayed disabled, chip clicks returned at their own guard, and the derived pass held
       for the rest of the session. A review arm found it on the round before this one. */
    /* EACH CLAIM ANSWERS FOR ITSELF. One deepEqual over the whole payload would put four
       different defects on one message, which is what the mutation harness cannot tell apart. */
    assert.equal(
      measured.refreshMidSend.sawFlagUp,
      true,
      "refreshMidSend: the step did not act inside the send's window, so nothing below it is " +
        "about an in-flight send",
    );
    assert.deepEqual({
      readOnly: measured.refreshMidSend.readOnly,
      busy: measured.refreshMidSend.busy,
      sendState: measured.refreshMidSend.sendState,
    }, {
      readOnly: false,
      busy: null,
      sendState: "ready",
    }, "refreshMidSend: a refresh during a post left the send flag up");
    /* AND THE SENTENCE WITH IT. A composer that is finished and writable must not still say it
       is posting: the status line is the send's, and it was coming down at the END of the
       screen block that a reopen never reaches. */
    assert.equal(
      measured.refreshMidSend.status,
      "",
      "refreshMidSend: a refresh during a post left the posting sentence standing",
    );
    assert.deepEqual({
      chips: measured.refreshMidSend.chips,
      chipsAfterRemove: measured.refreshMidSend.chipsAfterRemove,
      chipsAfterTag: measured.refreshMidSend.chipsAfterTag,
    }, {
      chips: ["Alto"],
      chipsAfterRemove: [],
      chipsAfterTag: ["Basalt"],
    }, "refreshMidSend: a refresh during a post left the To: row frozen");
    assert.equal(
      measured.refreshMidSend.postedRows,
      1,
      "refreshMidSend: the message posted during a refresh is missing from the feed, or twice in it",
    );

    /* AND A FAILURE UNDER THE SAME REFRESH PUTS THE MESSAGE BACK. The restore, the error and
       the Retry all sat below the generation test at the top of the catch. */
    assert.equal(
      measured.failedUnderRefresh.sawFlagUp,
      true,
      "failedUnderRefresh: the failing step did not act inside the send's window",
    );
    assert.deepEqual({
      readOnly: measured.failedUnderRefresh.readOnly,
      value: measured.failedUnderRefresh.value,
      chips: measured.failedUnderRefresh.chips,
      retryHidden: measured.failedUnderRefresh.retryHidden,
      statusNamesTheFailure: measured.failedUnderRefresh.statusNamesTheFailure,
    }, {
      readOnly: false,
      value: "@Cinder this one fails under a refresh",
      chips: ["Cinder"],
      retryHidden: false,
      statusNamesTheFailure: true,
    }, "failedUnderRefresh: a send that failed during a refresh lost the message and said nothing");

    /* A WORKSPACE SWITCH UNDER A FAILING SEND IS THE OTHER HALF: that composer belongs to
       another workspace, so the failure writes nothing into it. The studio shows its own
       draft, exactly as it did before the send that failed elsewhere. */
    assert.equal(
      measured.switchedUnderFailedSend.sawFlagUp,
      true,
      "switchedUnderFailedSend: the switching step did not act inside the send's window",
    );
    assert.deepEqual({
      readOnly: measured.switchedUnderFailedSend.readOnly,
      value: measured.switchedUnderFailedSend.value,
      chips: measured.switchedUnderFailedSend.chips,
    }, {
      readOnly: false,
      value: "@Orbit and @River will handle it",
      chips: ["Orbit"],
    }, "switchedUnderFailedSend: a failure wrote into the box the reader had moved to");
    /* AND A SEND THAT LOST ITS COMPOSER DOES NOT LOWER THE NEXT SEND'S FLAG. The studio's own
       message is on the wire while the field lab's failure arrives; a flag lowered by the
       wrong send would make the box writable and the chips editable under a live post. */
    assert.equal(
      measured.switchedUnderFailedSend.ownSendStillHeld,
      true,
      "switchedUnderFailedSend: a send from another workspace lowered this composer's flag",
    );

    /* AND THE UNSENT MESSAGE IS WHERE IT WAS WRITTEN, with the address it was addressed to.
       The stored draft is frozen for the whole post, so the switch's flush did not read the
       box the send had emptied and write that over it. This is the first browser control on
       that freeze; it was a source claim until the window above existed. */
    assert.deepEqual(measured.unsentBodySurvivesSwitch, {
      value: "@Delta written in the field lab",
      chips: ["Delta"],
    }, "unsentBodySurvivesSwitch: a message unsent under a workspace switch was lost");

    /* AND SENDING IT AGAIN POSTS IT ONCE. Nothing landed, so this send is the only one. */
    assert.deepEqual(measured.resentOnce, {
      rows: 1,
      value: "",
    }, "resentOnce: the restored message posted more than once");

    /* AND A SEND THAT LOST ITS COMPOSER DOES NOT COME BACK FOR IT when the reader returns to
       the workspace it was sent from. The box has newer text in it by then; the failure's
       restore would overwrite live work with a body the reader had already moved past. */
    assert.equal(
      measured.returnedBeforeItFailed.sawFlagUp,
      true,
      "returnedBeforeItFailed: the returning step did not act inside the send's window",
    );
    assert.equal(
      measured.returnedBeforeItFailed.restoredBeforeTyping,
      "@Ember one more from the field lab",
      "returnedBeforeItFailed: coming back mid-post did not restore the message being sent",
    );
    assert.equal(
      measured.returnedBeforeItFailed.value,
      "a new line typed after coming back",
      "returnedBeforeItFailed: a torn-down send wrote its old body over what the reader typed",
    );
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

  /* THE KIND FOLLOWS RECIPIENT 0. ~~"because the delivery trigger does. A person in front
     makes this a note, so no agent behind them is woken and the row already said so."~~ is
     retired 2026-09-05: the wake no longer follows a position, and BOTH `ask` and `note` are
     delivered, so the kind cannot contradict the row whatever it picks. The BEHAVIOUR is
     unchanged on purpose — moving it would move a body every installed client compares byte
     for byte — and the pair of assertions below is what says the two facts are now separate. */
  assert.equal(
    browserSignalCommand("x", [river, orbit], browserSignalKind([river, orbit])).signal_kind,
    "note",
    "signal_kind: recipient 0 still decides the kind",
  );
  assert.deepEqual(
    notifiedRecipients([river, orbit]),
    [orbit],
    "and the agent behind the person IS woken, which the kind no longer says anything about",
  );
});

test("one pass owns the address, and every handler goes through it", () => {
  /* A SOURCE CLAIM, and it says why. Four review rounds found one class: the To: set and the
     record of which tags produced it are state that must follow the body, and they were being
     kept in step BY HAND across separate handlers. Each round closed one door and the next
     round found another. The fix both arms named is this: ONE derived pass, called by every
     handler, which writes the pair and the stored draft in the same call.

     BOUND: this counts call sites in one file and reads the pass's own guards out of it. It
     does not prove no other module moves the set, and nothing else imports these functions.
     What the pass DOES with those inputs is driven directly in
     `src/lib/composer-address.test.mjs`, which reaches the same function. */
  const dashboard = readFileSync(
    new URL("./LiveDashboard.astro", import.meta.url),
    "utf8",
  );
  /* EVERY WRITER OF THE PAIR, named. The list and the assertions come from one array, so a
     handler that stops calling the pass fails on its own name. */
  const writers = [
    ["the entry restore", "const restoreComposerOnEntry = (): void => {", "\n    };"],
    ["the typing pause", "const scheduleComposerToPass = (): void => {", "\n    };"],
    ["the mention pick", "const selectMention = (mention: EntityRef): void => {", "\n    };"],
    [
      "the submit flush",
      'one<HTMLFormElement>("[data-composer]")?.addEventListener("submit"',
      "const workspaceId = activeWorkspaceId;",
    ],
    [
      "the chip edit",
      'one<HTMLElement>("[data-composer-to-chips]")?.addEventListener',
      "\n    });",
    ],
    ["the roster paint", "const renderRoster = (): void => {", "\n    };"],
  ] as const;
  for (const [where, anchor, close] of writers) {
    const start = dashboard.indexOf(anchor);
    assert.ok(start > 0, `${where}: anchor not found`);
    const block = dashboard.slice(start, dashboard.indexOf(close, start));
    assert.match(block, /syncComposerAddress\(/, `${where} must go through the one pass`);
  }
  /* AND NOBODY ELSE CALLS IT. The count is the writers above plus TWO:

       1. the send's own settle, which runs in the submit's `finally` after the freeze lifts
          and is inside the submit block already counted, so it adds a call rather than a
          writer;
       2. `setThreadReplyRoot`, added by `lane/chat-app-threads` (2026-09-05). Opening or
          closing a reply changes what the To: row shows, and the pass HOLDS while a reply is
          in progress, so the row has to be re-derived when that hold starts and ends. It is
          one WRITER for both directions — the reply control and the cancel button both go
          through it — which is why it adds one call and not two.

     ~~`writers.length + 1`~~ was the count while the thread surface was cut. Any further call
     is a second writer of the pair, which is the shape every round of this lane found.

     The count excludes the definition, which reads `syncComposerAddress = (`. */
  assert.equal(
    dashboard.split("syncComposerAddress(").length - 1,
    writers.length + 2,
    "the pass is called from somewhere new, or a handler stopped calling it",
  );
  /* AND THE REPLY'S CALL IS THE ONE NAMED ABOVE, not some other new caller that happens to
     bring the count back. Without this the count alone would accept a swap. */
  const replyWriter = dashboard.slice(
    dashboard.indexOf("const setThreadReplyRoot = ("),
    dashboard.indexOf("\n    };", dashboard.indexOf("const setThreadReplyRoot = (")),
  );
  assert.match(replyWriter, /syncComposerAddress\(\);/, "the reply writer must run the pass");
  assert.doesNotMatch(
    replyWriter,
    /composerTo = |composerToApplied = |rememberComposerTo\(/,
    "opening or closing a reply must not write the pair itself",
  );
  const passStart = dashboard.indexOf("const syncComposerAddress = (");
  assert.ok(passStart > 0, "the pass is not in this file");
  const pass = dashboard.slice(passStart, dashboard.indexOf("\n    };", passStart));
  /* THE PAIR AND THE STORED DRAFT ARE WRITTEN BY THE SAME CALL. A chip edit used to reach
     storage only on the next keystroke, and a workspace switch cancels that write. */
  assert.match(
    pass,
    /composerToApplied = state\.applied;/,
    "the pass no longer writes the applied record",
  );
  assert.match(
    pass,
    /persistComposerDraft\(\);/,
    "a live edit no longer writes the stored pair",
  );
  /* AND NOTHING COMMITS UNTIL THE PASS SAYS SO. */
  assert.match(
    pass,
    /if \(!state\.committed\) \{/,
    "the pass assigns whether or not it committed",
  );
  /* AND IT IS TOLD WHEN THE MESSAGE IT ADDRESSES IS ON THE WIRE. A SOURCE claim, and it says
     why: what this freeze protects is a PRUNE arriving mid-post, and no sample transition loses
     a recipient, so removing it changes nothing a browser step can see. What the freeze DOES is
     driven directly in src/lib/composer-address.test.mjs and what the dashboard feeds it is
     read here.

     RETIRED reason (2026-09-05, round eight): "a sample send has no in-flight window for a
     browser step to act inside". It has one now — `sampleSendWindow`, driven by the in-flight
     steps in the browser test above. That is why the stored draft's freeze below no longer
     shares this bound. A review arm found this sentence still standing. */
  assert.match(
    pass,
    /sending: composerSending,/,
    "the pass is not told when a send is in flight, so a prune can move the address under it",
  );
  /* AND THE STORED DRAFT IS FROZEN FOR THE SAME REASON, which is not the same code. A send
     empties the box before it awaits, so while that flag is up the textarea is the send's
     state and not the reader's. Writing it down destroyed the draft that still held their
     text: a workspace switch mid-post flushed, read the emptied box, and either overwrote the
     good draft with an empty body or removed it, and the post then took its changed-workspace
     early return without putting the body back. A review arm found it.

     THIS ONE NOW HAS A BROWSER CONTROL: `unsentBodySurvivesSwitch` in the test above switches
     workspace inside a real in-flight window and comes back to the message, and a mutation
     removes this guard to turn it red. The guard is still read out of the source here because
     it must be the FIRST thing the write does, so nothing between the flag and the write can
     read the emptied box.

     RETIRED wording: "SAME BOUND as the freeze above: no browser control, because a sample send
     never stays in flight." A review arm found it after round eight made it false. */
  const persist = dashboard.slice(
    dashboard.indexOf("const persistComposerDraft = (): void => {"),
  );
  const persistHead = persist.slice(0, persist.indexOf("const key = composerDraftKey();"));
  assert.match(
    persistHead,
    /if \(composerSending\) return;/,
    "the stored draft is written from a box a send emptied, so a switch mid-post loses the text",
  );
  /* AND A LANDED POST CLEARS ITS OWN DRAFT, which takes BOTH halves. Being ungated is one:
     the removal must run while the send's own flag is still up. Naming the key is the other,
     and it is the half a previous round claimed it did not need. Every clear sat behind the
     send's changed-workspace return, so a post that landed after the reader switched away
     cleared nothing — and had it run, `composerDraftKey()` would have named the workspace now
     on screen. The reader came back to the message they had already sent, sitting in the box
     with a null intent, and sending it again minted a second command id. A review arm found
     it, and found that the control here had been green against the false half. */
  const clearBody = dashboard.slice(
    dashboard.indexOf("const clearComposerDraft = ("),
    dashboard.indexOf("const persistComposerDraft = ("),
  );
  assert.doesNotMatch(
    clearBody,
    /if \(composerSending\) return;/,
    "a landed post cannot clear its own draft while its send flag is still up",
  );
  /* THE SEND CAPTURES ITS OWN STORAGE, with its workspace, the way it already captures its
     recipients, its body and its command id. */
  const submitBlock = dashboard.slice(
    dashboard.indexOf('one<HTMLFormElement>("[data-composer]")?.addEventListener("submit"'),
  );
  assert.match(
    submitBlock.slice(0, submitBlock.indexOf("} finally {")),
    /const sendDraftKey = composerDraftKey\(workspaceId\);\s*\n\s*const sendToKey = composerToStorageKey\(workspaceId\);/,
    "the send addresses its storage through a live global instead of capturing it",
  );
  /* And it finishes that storage BEFORE the guard that protects the screen, so a landed post
     under a changed workspace still remembers its set and removes its draft. */
  const landed = submitBlock.slice(submitBlock.indexOf("await postBrowserSignal("));
  const storageAt = landed.indexOf("rememberComposerTo(recipients, sendToKey);");
  const guardAt = landed.indexOf("if (version !== requestVersion || workspaceId !== activeWorkspaceId) {");
  assert.ok(storageAt > 0 && guardAt > 0, "the landed path has no storage or no guard to order");
  assert.ok(
    storageAt < guardAt,
    "a send that outlived its workspace skips its own remember and clear",
  );
  assert.match(
    landed.slice(storageAt, guardAt),
    /clearComposerDraft\(sendDraftKey\);/,
    "the landed post clears a draft it did not name",
  );
  /* THE RENDER DRAWS AND DECIDES NOTHING. Pruning used to live in it, which is how a paint
     the reader had not caused came to move the address. */
  const renderStart = dashboard.indexOf("const renderComposerTo = (): void => {");
  const render = dashboard.slice(renderStart, dashboard.indexOf("\n    };", renderStart));
  assert.doesNotMatch(
    render,
    /pruneComposerRecipients|composerTo = /,
    "the render moves the address instead of drawing it",
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

test("the body and the address are restored as one transaction", () => {
  /* A SOURCE CLAIM, and it says why. renderWorkspace paints before the roster request
     settles, so `agents` and `members` are briefly empty for a workspace that has both.
     A restore that committed there pruned every chip and marked itself done, and the paint
     that did have a roster then wrote the last-sent set over the draft. The browser observer
     above reaches this on a WORKSPACE SWITCH, where the sample roster arrives a frame after
     the paint; it cannot reach it on a reload, where the roster is there first.

     BOUND: this reads the guard, the single restore key, and the pass's own gate out of one
     file. It does not prove the roster is empty at any particular moment. */
  const dashboard = readFileSync(
    new URL("./LiveDashboard.astro", import.meta.url),
    "utf8",
  );
  assert.match(
    dashboard,
    /const composerRosterKnown = \(\): boolean => agents\.length > 0 \|\| members\.length > 0;/,
    "empty-roster guard: the predicate that separates 'not fetched yet' from 'nobody here'",
  );
  /* ONE KEY. Two keys is what let a switch satisfy the body's restore and refuse the
     address's, which is the split that produced the class. Five mentions and no more: the
     declaration, the guard that reads it, the one place that marks it, the workspace switch
     that clears it, and the sign-out teardown that clears it. */
  assert.equal(
    dashboard.split("restoredComposerKey").length - 1,
    5,
    "the restore key is read or written somewhere new",
  );
  assert.doesNotMatch(
    dashboard,
    /restoredComposerToKey|restoreComposerToOnEntry|restoreComposerDraft\b/,
    "the second restore is back, so the body and the address can commit apart again",
  );
  const restoreStart = dashboard.indexOf("const restoreComposerOnEntry = (): void => {");
  assert.ok(restoreStart > 0, "the entry restore is not in this file");
  const restore = dashboard.slice(restoreStart, dashboard.indexOf("\n    };", restoreStart));
  /* ONE GATE, IN THE PASS. A second copy of the roster rule here would be a rule with no
     control on it: the pass already refuses to commit, so a guard here could be deleted and
     no measurement would change. What the restore must not do is decide the address itself. */
  assert.doesNotMatch(
    restore,
    /composerRosterKnown\(\)|pruneComposerRecipients|composerTo = /,
    "the entry restore decides the address instead of asking the pass",
  );
  assert.match(
    restore,
    /syncComposerAddress\(\);/,
    "the entry restore does not run the pass, so an entry commits nothing",
  );
  /* AND THE PASS HOLDS FOR BOTH REASONS IT MUST. */
  const source = readFileSync(
    new URL("../../lib/composer-address.ts", import.meta.url),
    "utf8",
  );
  /* ~~`if (!input.rosterKnown || input.sending) return held;`~~ gained a third reason on
     2026-09-05 (`lane/chat-app-threads`): a thread reply is not addressed by this pair at all,
     so deriving one against a reply's body would let an @tag inside a reply edit the address
     of the message the reader goes back to when they cancel. */
  assert.match(
    source,
    /if \(!input\.rosterKnown \|\| input\.sending \|\| input\.replying === true\) return held;/,
    "the pass commits against an unknown roster, a message already on the wire, or a reply",
  );
});

test("a chosen address is a draft, even before anything is typed", () => {
  /* A SOURCE CLAIM about ONE line, and it says why. "Nothing to save" used to mean an empty
     box and no attachment, which threw away the one edit that writes nothing else: taking a
     name out of To:, or emptying it to a broadcast, before writing the message. The reader
     came back to the set they had just removed. The browser observer reaches the with-a-body
     half of this on a switch; this reads the condition itself. */
  const dashboard = readFileSync(
    new URL("./LiveDashboard.astro", import.meta.url),
    "utf8",
  );
  assert.match(
    dashboard,
    /const addressChosen = composerToLive &&\s*\n\s*composerAddressIsChosen\(\s*\n\s*composerTo,\s*\n\s*readRememberedComposerTo\(\),\s*\n\s*composerRecipientKnown,\s*\n\s*\);/,
    "an address the reader chose is not what decides whether the draft is worth keeping",
  );
  assert.match(
    dashboard,
    /if \(body === "" && !hadAttachments && !addressChosen\) \{/,
    "the draft is dropped for an empty body whatever the reader did to the address",
  );
  /* AND THE SWITCH FLUSHES BEFORE IT CLEARS. It used to cancel the pending write, which is
     right about the timer and wrong about the draft: an edit made inside the debounce window
     went with it. The flush is FIRST, before the box is emptied and while the old workspace
     is still current, or it would write an empty body against the wrong key. */
  const resetStart = dashboard.indexOf("const resetComposer = (): void => {");
  const reset = dashboard.slice(resetStart, dashboard.indexOf("\n    };", resetStart));
  assert.ok(
    reset.indexOf("persistComposerDraft();") < reset.indexOf('input.value = "";'),
    "the workspace switch empties the box before it writes the draft down",
  );
  assert.doesNotMatch(
    reset,
    /cancelComposerDraftTimer\(\);/,
    "the switch cancels the pending draft write instead of flushing it",
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
  assert.doesNotMatch(
    submit,
    /composerToApplied = \[\];/,
    "the submit clears the applied record by hand instead of letting the pass derive it",
  );
  /* AND THE SETTLE IS WHAT ANSWERS FOR IT, in the `finally`, after the freeze lifts. The body
     is empty on success and restored on failure, and the pass reads whichever one is there:
     a record whose tag has left the body is dropped by the same rule that drops it on any
     keystroke, and a record whose tag came back with the body is kept. Neither is a rule
     anybody has to remember, which is the point. */
  const settle = submit.slice(submit.indexOf("} finally {"));
  assert.match(
    settle,
    /syncComposerAddress\(\);/,
    "the send never settles the address, so the applied record is whatever the post left",
  );
});

test("a tag the parser gave up on is named, not dropped out of the message", () => {
  /* A SOURCE CLAIM, and it says why. A tag can be over the cap in two places: the To: set
     refusing an entity it has no room for, and `addressFromBody` stopping after
     MENTION_MAX_RECIPIENTS and handing back bare names it never resolved. Reading only the
     first dropped a name out of the message with nothing said about it.

     BOUND: the sample rosters have five and eleven taggable names against a cap of eight, so
     the observer above reaches the To: set's refusal and not the parser's ceiling: the two
     ceilings are the same number, so a body cannot pass one without passing the other. This
     reads the source instead, and the sentence itself is measured in composer-address.test.mjs. */
  const source = readFileSync(
    new URL("../../lib/composer-address.ts", import.meta.url),
    "utf8",
  );
  assert.match(
    source,
    /const overCap = \[\.\.\.state\.refused\.map\(nameOf\), \.\.\.parsed\.overflow\];/,
    "both ways a tag can be over the cap must reach the notice",
  );
  assert.match(
    source,
    /if \(overCap\.length > 0\) clauses\.push\(composerToFullNotice\(overCap\)\);/,
  );
  /* And the dashboard hands the pass's own result to that builder, rather than assembling a
     second sentence beside it. */
  const dashboard = readFileSync(
    new URL("./LiveDashboard.astro", import.meta.url),
    "utf8",
  );
  assert.match(
    dashboard,
    /composerToNotice = composerAddressNotice\(state, parsed, composerRecipientName\);/,
    "the row's notice is built somewhere other than from the pass",
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
      /* ~~["wake position", /NOTIFIED_POSITION = SCALAR_POSITION/]~~ and
         ~~["wake sentence", /\$\{positionWord\(NOTIFIED_POSITION\)\} recipient is notified/]~~
         and ~~["chip label position", /const front = positionWord\(NOTIFIED_POSITION\);/]~~.
         All three named a constant that is gone: the wake follows no position now. What
         replaces them is the wake sentence being built from the same function the chip mark
         reads, and the COUNT in it coming from that function's result rather than a number. */
      ["wake set", /const notified = notifiedRecipients\(recipients\);/],
      ["wake count", /\$\{notified\.length\} agents are notified\./],
      ["chip label position", /const front = positionWord\(SCALAR_POSITION\);/],
      ["cap sentence", /\$\{COMPOSER_TO_MAX\}/],
    ] as const;
  for (const [name, pattern] of generated) {
    assert.match(source, pattern, `${name} is not built from the constant`);
  }
  assert.equal(COMPOSER_TO_MAX, 8, "the cap moved; the numbers in this file's comments have not");
  /* AND THE SENTENCE NAMES THE AGENTS AND ONLY THE AGENTS, for every set the cap allows.
     ~~`/are notified|everyone is notified|all recipients/`~~ was this sweep and it had to
     change: "2 agents are notified" is now the true sentence for a set with two agents. The
     forbidden claims are about EVERYONE, about the whole set, or about recipients rather than
     agents — and the number the sentence gives is checked against the function the chip mark
     reads, so it cannot be a number typed here either. */
  const nameOf = (entity: { kind: string; id: string }) => entity.id;
  for (let size = 0; size <= COMPOSER_TO_MAX; size += 1) {
    const set = Array.from({ length: size }, (_unused, index) => ({
      kind: index % 2 === 0 ? "agent" as const : "person" as const,
      id: `r${index}`,
    }));
    const note = composerDeliveryNote(set, nameOf);
    assert.doesNotMatch(
      note,
      /everyone is notified|all recipients|recipients are notified/i,
      `a set of ${size} is told somebody is woken who is not an agent: ${note}`,
    );
    const woken = notifiedRecipients(set);
    assert.match(
      note,
      woken.length === 0
        ? /^No agent is notified\./
        : woken.length === 1
        ? new RegExp(`^${nameOf(woken[0]!)} is notified\\.`)
        : new RegExp(`^${woken.length} agents are notified\\.`),
      `a set of ${size} names the wrong number of woken agents: ${note}`,
    );
  }
});
