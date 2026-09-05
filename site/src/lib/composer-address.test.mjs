/**
 * Reached by `npm --prefix site test` through the `src/lib/*.test.mjs` glob.
 *
 * These are the pure claims of the To: field: what the set holds, who the service wakes, and
 * what the reader is told about both. The rendered surface is measured in real Chrome by
 * `src/components/app/composer-to-field.observer.test.ts`; nothing here asserts pixels.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { SIGNAL_RECIPIENT_MAX } from "../../../supabase/functions/_shared/channels.js";
import {
  BROADCAST_CHIP_LABEL,
  COMPOSER_TO_MAX,
  NOTIFIED_POSITION,
  addComposerRecipients,
  composerAddressNotice,
  composerAmbiguousNotice,
  composerDeliveryNote,
  composerPromoteLabel,
  composerPrunedNotice,
  composerToFullNotice,
  deriveComposerAddress,
  mergeMentionRecipients,
  notifiedRecipient,
  positionWord,
  promoteComposerRecipient,
  pruneComposerRecipients,
  recipientKey,
  removeComposerRecipient,
  toWireRecipients,
} from "./composer-address.ts";

const wren = { kind: "agent", id: "agent-wren" };
const orbit = { kind: "agent", id: "agent-orbit" };
const dana = { kind: "person", id: "person-dana" };
const ada = { kind: "person", id: "person-ada" };

const names = new Map([
  [recipientKey(wren), "Wren"],
  [recipientKey(orbit), "Orbit"],
  [recipientKey(dana), "Dana"],
  [recipientKey(ada), "Ada"],
]);
const nameOf = (entity) => names.get(recipientKey(entity)) ?? entity.id;

test("the composer's cap is the server's cap, not a second opinion about it", () => {
  assert.equal(COMPOSER_TO_MAX, SIGNAL_RECIPIENT_MAX);
  /* One word per addressable position, so a sentence about the front of the list can be built
   * for any position the cap allows rather than falling back to "number N". */
  for (let position = 0; position < COMPOSER_TO_MAX; position += 1) {
    assert.doesNotMatch(
      positionWord(position),
      /^number /,
      `position ${position} has no word, so a generated sentence about it reads as a number`,
    );
  }
});

test("the wire list says user where the browser says person, and a broadcast sends no list", () => {
  assert.deepEqual(toWireRecipients([]), []);
  assert.deepEqual(toWireRecipients([dana, wren]), [
    { kind: "user", id: "person-dana" },
    { kind: "agent", id: "agent-wren" },
  ]);
  /* Key ORDER as well as value: the edge's isRecipientEntry sorts keys, but the byte-exact
   * body test in composer-to-field.observer.test.ts compares this shape literally. */
  assert.deepEqual(Object.keys(toWireRecipients([wren])[0]), ["kind", "id"]);
});

test("only the recipient at the notified position is woken, and only when it is an agent", () => {
  assert.equal(notifiedRecipient([]), null);
  assert.deepEqual(notifiedRecipient([wren, dana]), wren);
  /* THE BOUND. A person in front means the service wakes nobody, however many agents follow.
   * swarm.enqueue_signal_delivery reads one column and the edge fills it from this position. */
  assert.equal(notifiedRecipient([dana, wren]), null);
  assert.equal(notifiedRecipient([dana]), null);
  assert.equal(NOTIFIED_POSITION, 0);
});

test("the note names who is notified and who only reads, and never says everyone is", () => {
  assert.equal(
    composerDeliveryNote([], nameOf),
    "No agent is notified. Everyone here can read this.",
  );
  assert.equal(composerDeliveryNote([wren], nameOf), "Wren is notified.");
  assert.equal(
    composerDeliveryNote([wren, dana], nameOf),
    "Wren is notified. Dana can read this and reply.",
  );
  assert.equal(
    composerDeliveryNote([wren, dana, ada], nameOf),
    "Wren is notified. 2 recipients can read this and reply.",
  );
  assert.equal(
    composerDeliveryNote([dana], nameOf),
    "No agent is notified. Dana can read this and reply.",
  );
  /* The remedy clause appears only when there is an agent to put first. */
  assert.equal(
    composerDeliveryNote([dana, wren], nameOf),
    "No agent is notified. 2 recipients can read this and reply. " +
      "Only the first recipient is notified. Choose a name to put it first.",
  );
  for (const set of [[], [wren], [wren, dana], [dana, wren], [dana, ada]]) {
    assert.doesNotMatch(
      composerDeliveryNote(set, nameOf),
      /everyone is notified|all .* notified|are notified/i,
      `the note claims more than one recipient is woken: ${JSON.stringify(set)}`,
    );
  }
});

test("the empty set is named as a broadcast rather than shown as nothing", () => {
  assert.equal(BROADCAST_CHIP_LABEL, "Everyone here");
  assert.match(composerDeliveryNote([], nameOf), /Everyone here can read this\./);
});

test("adding keeps order, adds nobody twice, and names what the cap refused", () => {
  assert.deepEqual(addComposerRecipients([], [wren, dana]).recipients, [wren, dana]);
  assert.deepEqual(addComposerRecipients([wren], [wren]).recipients, [wren]);
  const full = Array.from({ length: COMPOSER_TO_MAX }, (_unused, index) => ({
    kind: "agent",
    id: `agent-${index}`,
  }));
  const change = addComposerRecipients(full, [dana]);
  assert.equal(change.recipients.length, COMPOSER_TO_MAX);
  assert.deepEqual(change.refused, [dana]);
  assert.equal(
    composerToFullNotice(change.refused.map(nameOf)),
    `To: holds ${COMPOSER_TO_MAX} recipients, so Dana is not in it. Remove one to make room.`,
  );
  /* The same sentence serves the parser's overflow, which hands back bare names it never
   * resolved. Both places have to be said or a name in the message reaches nobody in
   * silence. */
  assert.equal(
    composerToFullNotice(["Ada", "Kenji Ito"]),
    `To: holds ${COMPOSER_TO_MAX} recipients, so Ada and Kenji Ito are not in it. ` +
      "Remove one to make room.",
  );
});

test("a chip's own control never promises a wake a person cannot get", () => {
  /* Promoting a person puts a user id in the scalar column and leaves the agent column
   * null, so nobody is woken. The chip used to say "so Dana is notified" while the sentence
   * directly under it said "No agent is notified". A review arm found the pair. */
  assert.equal(
    composerPromoteLabel(wren, [wren, dana], nameOf),
    "Wren is notified",
    "chip label: the notified agent's own chip says so",
  );
  assert.equal(
    composerPromoteLabel(wren, [dana, wren], nameOf),
    "Put Wren first, so Wren is notified",
    "chip label: promoting an agent notifies it",
  );
  assert.equal(
    composerPromoteLabel(dana, [wren, dana], nameOf),
    "Put Dana first. No agent is notified while a person is first",
    "chip label: promoting a person must not promise a wake",
  );
  /* And the label agrees with the note it sits above, for every set. */
  for (const set of [[wren, dana], [dana, wren], [dana, ada], [wren, orbit]]) {
    for (const entity of set) {
      const label = composerPromoteLabel(entity, set, nameOf);
      const wouldNotify = notifiedRecipient(promoteComposerRecipient(set, entity));
      /* Does the label name THIS recipient as the notified one? A bare
       * `includes("is notified")` was wrong: the person label carries the clause
       * "No agent is notified", which contains that substring and passed. */
      assert.equal(
        label.includes(`${nameOf(entity)} is notified`),
        wouldNotify !== null && recipientKey(wouldNotify) === recipientKey(entity),
        `${label} disagrees with what promoting ${nameOf(entity)} does`,
      );
    }
  }
});

test("a recipient the roster lost is reported, and the count carries its own noun", () => {
  /* The name cannot be in this sentence: the roster no longer holds them. The count is what
   * is left, so the count and its noun are built together. */
  assert.equal(
    composerPrunedNotice(1),
    "1 recipient left this workspace, so it is no longer in To:.",
  );
  assert.equal(
    composerPrunedNotice(2),
    "2 recipients left this workspace, so they are no longer in To:.",
  );
});

test("removing, promoting and pruning are the whole edit surface", () => {
  assert.deepEqual(removeComposerRecipient([wren, dana], wren), [dana]);
  assert.deepEqual(promoteComposerRecipient([dana, wren], wren), [wren, dana]);
  /* Promoting a name that is not there does not add it: promote edits, it never addresses. */
  assert.deepEqual(promoteComposerRecipient([dana], wren), [dana]);
  const known = (entity) => entity.id !== "agent-wren";
  assert.deepEqual(pruneComposerRecipients([dana, wren], known), [dana]);
});

test("a tag adds to the set, and a removed chip does not come back while the tag stays", () => {
  const first = mergeMentionRecipients({ current: [dana], tagged: [wren], applied: [] });
  assert.deepEqual(first.recipients, [dana, wren], "the tag joined the set; it did not replace it");
  assert.deepEqual(first.applied, [recipientKey(wren)]);
  /* The reader removes the chip but leaves "@Wren" in the sentence. */
  const afterRemoval = removeComposerRecipient(first.recipients, wren);
  const second = mergeMentionRecipients({
    current: afterRemoval,
    tagged: [wren],
    applied: first.applied,
  });
  assert.deepEqual(second.recipients, [dana], "the removed chip came back on the next keystroke");
  /* Deleting the tag forgets it, so typing it again addresses again. */
  const cleared = mergeMentionRecipients({ current: [dana], tagged: [], applied: second.applied });
  assert.deepEqual(cleared.applied, []);
  const retyped = mergeMentionRecipients({
    current: [dana],
    tagged: [wren],
    applied: cleared.applied,
  });
  assert.deepEqual(retyped.recipients, [dana, wren]);
});

test("a tag the cap refused joins the set as soon as the reader makes room", () => {
  /* THE REFUSAL IS NOT A VERDICT. A refused tag used to be written into `applied` so the
   * full-set notice would not repeat, which made the refusal permanent: deleting a chip to
   * make room did nothing, and the only recovery was deleting the tag from the sentence and
   * typing it again, which nothing on screen said. The notice is DERIVED from `refused` on
   * every pass now, so it stays on the row without being repeated and the name stays
   * eligible. */
  const full = Array.from({ length: COMPOSER_TO_MAX }, (_unused, index) => ({
    kind: "agent",
    id: `agent-${index}`,
  }));
  const merged = mergeMentionRecipients({ current: full, tagged: [dana], applied: [] });
  assert.deepEqual(merged.refused, [dana]);
  assert.equal(
    merged.applied.includes(recipientKey(dana)),
    false,
    "a name the cap refused was written off as applied, so making room cannot bring it back",
  );
  /* The tag is still in the sentence and the set is still full: the same sentence, rebuilt. */
  const again = mergeMentionRecipients({
    current: merged.recipients,
    tagged: [dana],
    applied: merged.applied,
  });
  assert.deepEqual(again.refused, [dana], "the row stopped saying which name did not fit");
  /* The reader deletes one chip. The tag has not moved; the pass does. */
  const room = mergeMentionRecipients({
    current: removeComposerRecipient(again.recipients, full[0]),
    tagged: [dana],
    applied: again.applied,
  });
  assert.deepEqual(room.refused, [], "the set has room and the name is still being refused");
  assert.equal(
    room.recipients.at(-1)?.id,
    dana.id,
    "a refused name did not join the set after the reader made room for it",
  );
});

test("an ambiguous tag is reported rather than guessed at", () => {
  assert.equal(
    composerAmbiguousNotice(["Dana"]),
    '"Dana" names more than one person or agent here, so it is not in To:. ' +
      "Rename one of them, or choose the name from the mention list.",
  );
  assert.match(composerAmbiguousNotice(["Dana", "Ada"]), /"Dana" and "Ada" name more than one/);
});

test("the module states the wake bound where the constant is declared", () => {
  /* A CLAIM CONTROL, not a style check. The reason NOTIFIED_POSITION is 0 lives in the
   * database, and a later reader who cannot find that reason will treat the index as a
   * preference and change it. Name the trigger beside the constant or this fails. */
  const source = readFileSync(new URL("./composer-address.ts", import.meta.url), "utf8");
  assert.match(source, /enqueue_signal_delivery/);
  assert.match(source, /to_agent_principal_id/);
});

/* ────────────────────────────────────────────────────────────────────────────────────────
 * THE DERIVED PASS, DRIVEN THROUGH THE TRANSITIONS THAT USED TO BREAK IT.
 *
 * These reach the same function the dashboard calls. A browser cannot drive some of them:
 * sample mode has no send that stays in flight long enough to change a roster underneath,
 * and a real roster is never unknown there. What a browser CAN reach is measured in
 * `src/components/app/composer-to-field.observer.test.ts`, which switches workspace mid-draft
 * and edits a chip before switching.
 *
 * BOUND: these drive the pass. That the dashboard calls it at every one of its handlers is a
 * separate claim, counted out of the source in that observer file.
 * ──────────────────────────────────────────────────────────────────────────────────────── */

/** Everyone the tests below can address. Anybody not here has left the workspace. */
const roster = [wren, orbit, dana, ada];
const inRoster = (entity) =>
  roster.some((candidate) => recipientKey(candidate) === recipientKey(entity));

const derive = (overrides) =>
  deriveComposerAddress({
    rosterKnown: true,
    sending: false,
    known: inRoster,
    live: null,
    draft: null,
    remembered: [],
    tagged: [],
    ...overrides,
  });

test("a pass against an unknown roster commits nothing and keeps what is on screen", () => {
  /* THE WORKSPACE SWITCH. The screen paints once before the roster request settles. A pass
   * that committed there pruned the draft's set to empty against a roster that only looked
   * empty, marked the restore done, and let the next paint write the last-sent set over a
   * draft the reader had already addressed. */
  const held = derive({
    rosterKnown: false,
    draft: { to: [wren, orbit], applied: [recipientKey(wren)] },
    remembered: [dana],
    tagged: [wren],
  });
  assert.equal(held.committed, false, "a pass committed against a roster it does not know");
  assert.deepEqual(held.recipients, [], "an unknown roster produced a set anyway");
  /* And the same inputs one paint later, with the roster known, restore the draft's own set
   * rather than the last-sent one. */
  const settled = derive({
    draft: { to: [wren, orbit], applied: [recipientKey(wren)] },
    remembered: [dana],
    tagged: [wren],
  });
  assert.equal(settled.committed, true);
  assert.equal(settled.source, "draft");
  assert.deepEqual(settled.recipients, [wren, orbit], "the draft's address did not survive");
});

test("a draft that recorded an empty set is a broadcast, not a set nobody wrote down", () => {
  const chosen = derive({ draft: { to: [], applied: [] }, remembered: [wren] });
  assert.deepEqual(chosen.recipients, [], "an emptied To: came back addressed to last-sent");
  assert.equal(chosen.source, "draft");
  const nothingRecorded = derive({ draft: { to: null, applied: [] }, remembered: [wren] });
  assert.deepEqual(nothingRecorded.recipients, [wren]);
  assert.equal(nothingRecorded.source, "remembered");
});

test("a live set beats both stores, because it is what the reader is looking at", () => {
  const state = derive({
    live: { to: [ada], applied: [] },
    draft: { to: [wren], applied: [] },
    remembered: [orbit],
  });
  assert.deepEqual(state.recipients, [ada]);
  assert.equal(state.source, "live");
});

test("a prune is announced while the reader is looking at the set and silent on arrival", () => {
  const gone = { kind: "agent", id: "agent-departed" };
  const live = derive({ live: { to: [wren, gone], applied: [] } });
  assert.deepEqual(live.recipients, [wren], "a name the roster lost stayed on the row");
  assert.equal(live.announcedPrune, 1, "a chip vanished from under the reader with no word");
  /* AND THE SENTENCE SURVIVES A REDRAW. It is carried, not recomputed from nothing, or the
   * next keystroke would take it off the row before it had been read. */
  const redrawn = derive({
    live: { to: live.recipients, applied: [] },
    announcedPrune: live.announcedPrune,
  });
  assert.equal(redrawn.announcedPrune, 1);
  /* On arrival it is silent: people leave a workspace between messages, and a notice about a
   * set the reader has not looked at yet is noise. */
  const arriving = derive({ remembered: [wren, gone] });
  assert.deepEqual(arriving.recipients, [wren]);
  assert.equal(arriving.announcedPrune, 0, "arriving in a workspace announced an old prune");
});

test("nothing moves the address while the message it addresses is on the wire", () => {
  /* THE SEND CAPTURED ITS RECIPIENTS ALREADY. A prune that moved the chips mid-post would
   * leave the row showing one set and the post naming another, which is the hidden recipient
   * this row exists to rule out. The set is frozen for the whole post and settles after it. */
  const gone = { kind: "agent", id: "agent-departed" };
  const during = derive({ sending: true, live: { to: [wren, gone], applied: [] } });
  assert.equal(during.committed, false, "the address was rewritten mid-send");
  assert.deepEqual(during.recipients, [wren, gone], "the row stopped showing what was sent");
  const after = derive({ live: { to: [wren, gone], applied: [] } });
  assert.equal(after.committed, true);
  assert.deepEqual(after.recipients, [wren], "the prune never landed once the send was over");
  assert.equal(after.announcedPrune, 1);
});

test("a tag whose chip was removed stays removed, and the record travels with the pair", () => {
  const removed = derive({
    live: { to: [orbit], applied: [recipientKey(wren)] },
    tagged: [wren],
  });
  assert.deepEqual(removed.recipients, [orbit], "a removed chip came back on the next pass");
  assert.deepEqual(removed.applied, [recipientKey(wren)]);
  /* The same pair read back out of a draft behaves the same way, which is what a reload and a
   * workspace switch both depend on. */
  const reloaded = derive({
    draft: { to: [orbit], applied: [recipientKey(wren)] },
    tagged: [wren],
  });
  assert.deepEqual(reloaded.recipients, [orbit]);
});

test("the row's sentences about names it could not honour are built from the pass", () => {
  const full = Array.from({ length: COMPOSER_TO_MAX }, (_unused, index) => ({
    kind: "agent",
    id: `agent-${index}`,
  }));
  const state = deriveComposerAddress({
    rosterKnown: true,
    sending: false,
    known: () => true,
    live: { to: full, applied: [] },
    draft: null,
    remembered: [],
    tagged: [dana],
  });
  const nameOf = (entity) => names.get(recipientKey(entity)) ?? entity.id;
  assert.equal(
    composerAddressNotice(state, { overflow: [], ambiguous: [] }, nameOf),
    composerToFullNotice(["Dana"]),
  );
  /* Both ways a tag can be over the cap reach one sentence: the set having no room, and the
   * parser stopping at its own ceiling with bare names it never resolved. */
  assert.equal(
    composerAddressNotice(state, { overflow: ["Ada"], ambiguous: [] }, nameOf),
    composerToFullNotice(["Dana", "Ada"]),
  );
  assert.equal(
    composerAddressNotice(
      { refused: [], announcedPrune: 2 },
      { overflow: [], ambiguous: ["Dana"] },
      nameOf,
    ),
    `${composerAmbiguousNotice(["Dana"])} ${composerPrunedNotice(2)}`,
  );
  assert.equal(
    composerAddressNotice({ refused: [], announcedPrune: 0 }, { overflow: [], ambiguous: [] }, nameOf),
    "",
  );
});
