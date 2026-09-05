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
  composerAmbiguousNotice,
  composerDeliveryNote,
  composerToFullNotice,
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
    composerToFullNotice(change.refused, nameOf),
    `To: holds ${COMPOSER_TO_MAX} recipients, so Dana is not in it. Remove one to make room.`,
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

test("a tag past the cap is named once, not on every keystroke", () => {
  const full = Array.from({ length: COMPOSER_TO_MAX }, (_unused, index) => ({
    kind: "agent",
    id: `agent-${index}`,
  }));
  const merged = mergeMentionRecipients({ current: full, tagged: [dana], applied: [] });
  assert.deepEqual(merged.refused, [dana]);
  const again = mergeMentionRecipients({
    current: merged.recipients,
    tagged: [dana],
    applied: merged.applied,
  });
  assert.deepEqual(again.refused, [], "the same full-set notice fired twice for one tag");
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
