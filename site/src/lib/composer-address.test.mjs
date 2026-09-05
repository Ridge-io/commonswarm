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
  notifiedRecipients,
  addComposerRecipients,
  composerAddressIsChosen,
  composerAddressNotice,
  composerAmbiguousNotice,
  composerDeliveryNote,
  composerPromoteLabel,
  composerPrunedNotice,
  composerToFullNotice,
  deriveComposerAddress,
  mergeMentionRecipients,
  positionWord,
  promoteComposerRecipient,
  pruneComposerRecipients,
  recipientKey,
  removeComposerRecipient,
  toWireRecipients,
} from "./composer-address.ts";

const wren = { kind: "agent", id: "agent-wren" };
const orbit = { kind: "agent", id: "agent-orbit" };
/* A THIRD AGENT, added 2026-09-05: the wake sentence counts agents above two, and two
   fixtures could not tell "the count is the set's" from "the count is 2". */
const lumen = { kind: "agent", id: "agent-lumen" };
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

test("every agent in the set is woken, at any position, and no person ever is", () => {
  /* CORRECTED 2026-09-05 by `lane/wake-all-recipients`. The retired rule, and the retired test
     that pinned it, because a reader may still meet both:

       ~~"only the recipient at the notified position is woken, and only when it is an agent"~~
       ~~assert.equal(notifiedRecipient([dana, wren]), null)~~
       ~~"THE BOUND. A person in front means the service wakes nobody, however many agents
         follow."~~

     `swarm.agent_delivery_is_wakeable` now sits behind both enqueue paths and a trigger on
     `swarm.signal_recipients` gives every agent recipient its own delivery row. A set whose
     position 0 is a person wakes the agents named after that person. */
  const woke = "the woken set is not every agent in the set, and only the agents";
  assert.deepEqual(notifiedRecipients([]), [], woke);
  assert.deepEqual(notifiedRecipients([wren, dana]), [wren], woke);
  /* THE CASE THE OLD RULE GOT WRONG: a person in front no longer silences the agents behind. */
  assert.deepEqual(notifiedRecipients([dana, wren]), [wren], woke);
  assert.deepEqual(notifiedRecipients([dana]), [], woke);
  /* AND EVERY AGENT, not just one of them, in the order they sit in the set. */
  assert.deepEqual(notifiedRecipients([dana, wren, ada, orbit]), [wren, orbit], woke);
  /* A PERSON IS NEVER WOKEN, whatever position they take. The predicate joins
     swarm.agent_principals, so a user id cannot satisfy it. */
  for (const set of [[dana], [dana, ada], [wren, dana], [dana, wren]]) {
    for (const woken of notifiedRecipients(set)) {
      assert.equal(woken.kind, "agent", `a person was reported as woken in ${JSON.stringify(set)}`);
    }
  }
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
  /* THE CASE THE OLD RULE GOT WRONG, and the reason this sentence had to change:
     ~~"Wren is notified. 2 recipients can read this and reply."~~ counted the woken agent among
     the readers, and ~~"No agent is notified. 2 recipients can read this and reply. Only the
     first recipient is notified. Choose a name to put it first."~~ said nobody was woken while
     naming an agent. Both are retired with the position rule. */
  assert.equal(
    composerDeliveryNote([wren, dana, ada], nameOf),
    "Wren is notified. 2 recipients can read this and reply.",
  );
  assert.equal(
    composerDeliveryNote([dana], nameOf),
    "No agent is notified. Dana can read this and reply.",
  );
  /* A PERSON IN FRONT no longer silences the agent behind. */
  assert.equal(
    composerDeliveryNote([dana, wren], nameOf),
    "Wren is notified. Dana can read this and reply.",
  );
  /* AND THE COUNT IS COMPUTED FROM THE CHIPS. Two or more agents are counted rather than
     listed, the way the reach clause already counted. */
  assert.equal(
    composerDeliveryNote([wren, orbit], nameOf),
    "2 agents are notified.",
    "the count in the sentence is not the number of agents in the set",
  );
  assert.equal(
    composerDeliveryNote([dana, wren, orbit], nameOf),
    "2 agents are notified. Dana can read this and reply.",
  );
  /* THE COUNT IS THE SET'S, not a constant: three agents say three. */
  assert.match(
    composerDeliveryNote([wren, orbit, lumen, dana], nameOf),
    /^3 agents are notified\./,
  );
  /* IT NEVER CLAIMS A PERSON IS WOKEN. ~~/are notified/~~ was in this sweep and had to leave
     it: "2 agents are notified" is now the true sentence for a set with two agents. What is
     still forbidden is a claim about EVERYONE or about a recipient rather than an agent. */
  for (const set of [[], [wren], [wren, dana], [dana, wren], [dana, ada], [wren, orbit]]) {
    assert.doesNotMatch(
      composerDeliveryNote(set, nameOf),
      /everyone is notified|all .* notified|recipients are notified/i,
      `the note claims somebody is woken who is not an agent: ${JSON.stringify(set)}`,
    );
  }
  /* AND THE NUMBER IT NAMES IS THE NUMBER OF AGENTS, checked against the function the mark on
     each chip reads rather than against a list typed here. */
  for (const set of [[], [wren], [dana], [wren, dana], [dana, wren], [wren, orbit], [dana, wren, orbit]]) {
    const woken = notifiedRecipients(set);
    const note = composerDeliveryNote(set, nameOf);
    if (woken.length === 0) assert.match(note, /^No agent is notified\./, note);
    else if (woken.length === 1) assert.match(note, new RegExp(`^${nameOf(woken[0])} is notified\\.`), note);
    else assert.match(note, new RegExp(`^${woken.length} agents are notified\\.`), note);
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

test("a chip's own control promises what promoting now does, which is not a wake", () => {
  /* CORRECTED 2026-09-05 by `lane/wake-all-recipients`. Promoting decides NOTHING about the
     wake any more: every agent in the set is woken wherever it sits. The three retired labels,
     kept because a reader may still meet them in an older screenshot of this row:

       ~~"Wren is notified"~~
       ~~"Put Wren first, so Wren is notified"~~
       ~~"Put Dana first. No agent is notified while a person is first"~~

     What promoting still does is fill the SCALAR column, which is the target a reader who knows
     only that column sees and the name the feed row prints after its arrow. */
  assert.equal(
    composerPromoteLabel(wren, [wren, dana], nameOf),
    "This message shows as addressed to Wren",
    "chip label: the chip already at the front says so",
  );
  assert.equal(
    composerPromoteLabel(wren, [dana, wren], nameOf),
    "Put Wren first, so the message shows as addressed to Wren",
    "chip label: promoting moves the shown address",
  );
  /* A PERSON GETS THE SAME LABEL, because promoting one does the same thing. The asymmetry the
     old label carried existed only because the wake followed the front. */
  assert.equal(
    composerPromoteLabel(dana, [wren, dana], nameOf),
    "Put Dana first, so the message shows as addressed to Dana",
    "chip label: promoting a person moves the shown address like any other",
  );
  /* AND NO LABEL PROMISES A WAKE, for any set. This is the claim the whole control family
     turns on: the row says who is woken in ONE place, and a chip must not answer it too. */
  for (const set of [[wren, dana], [dana, wren], [dana, ada], [wren, orbit], [wren]]) {
    for (const entity of set) {
      const label = composerPromoteLabel(entity, set, nameOf);
      assert.doesNotMatch(
        label,
        /notif/i,
        `${label} answers a question the note under the chips owns`,
      );
      /* And it agrees with what promoting actually does: the promoted name is the one the
         scalar column would hold. */
      const front = promoteComposerRecipient(set, entity)[0];
      assert.equal(recipientKey(front), recipientKey(entity));
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

test("every retired wake phrase this lane lists sits inside a strikethrough, in six files", () => {
  /* THE CLAIM THIS MAKES CHECKABLE, and the third version of it. `lane/wake-all-recipients`'
     copy commit said every retired sentence was kept beside its replacement; an arm found five
     that were not. The commit that fixed those five claimed "no retired claim stands as
     current"; the next arm found four more. THIS test's first version claimed the same thing in
     its own title, and the next arm found a fifth — in a file the sweep already named, in words
     the phrase list missed by one adjective, in a file with no strikethrough anywhere for a reader
     to notice. (The two: ~~`the only recipient it wakes`~~ against a listed
     ~~`one recipient the service wakes`~~.)

     Three rounds, one class. So the title now claims exactly what the loop does and no more,
     and the three things that let it pass while a sentence stood are closed:

       1. MATCHING IS CASE- AND SPACE-INSENSITIVE over a normalised form, so
          ~~`the only control over WHO IS WOKEN`~~ and ~~`one control over who is woken`~~ are
          the same phrase to it. Exact `indexOf` was how a sentence in the family of a listed
          phrase went unseen.
       2. EVERY LISTED PHRASE MUST MATCH SOMETHING. Three of the eleven matched nothing, so the
          README's claim that adding to the list changes what runs was false for those three. A
          dead phrase is now a red, which is the only way that claim can be true.
       3. EVERY NAMED FILE MUST CONTRIBUTE. `scanned > 200_000` was satisfied by
          `LiveDashboard.astro` alone, so five wrong paths pointed at that one file would have
          gone green. Each file is asserted individually.

     BOUND, AND IT IS THE WHOLE BOUND. This reads SIX named files and normalises them. It
     catches a listed phrase, in any casing or spacing, standing outside a `~~ ~~` span. It
     CANNOT see a retired claim written in words no listed phrase covers, and it cannot see one
     in a file not on this list. Both lists are below and both are iterated, so adding to either
     changes what runs — which item 2 above is what makes true.

     ~~"no retired wake sentence stands as current, anywhere the wake copy lives"~~ was this
     test's title, and it claimed the second half of that sentence without establishing it. */
  const files = [
    "./composer-address.ts",
    /* Added round five: it is where the wake copy's own tests live, and it carried a retired
       sentence in an assertion message that no earlier list covered. */
    "./composer-address.test.mjs",
    "../components/app/composer-to-field.observer.test.ts",
    "../components/app/composer.observer.test.ts",
    "../components/app/composer-addressing.observer.test.ts",
    "../components/app/LiveDashboard.astro",
  ];
  /* NORMALISED FORMS. Written the way the retired sentences read, and matched against a
     lowercased, whitespace-collapsed copy of each file so a line break or an adjective's casing
     inside a comment cannot hide one. */
  const retired = [
    "wakes nobody",
    "nobody is woken",
    "woken, however many",
    "control over who is woken",
    /* Both retired forms of the same claim, and both narrow on purpose: the CURRENT sentence
       in this module is "every recipient the service wakes", so a phrase of
       "recipient the service wakes" matched the correct copy and reported it as retired. A
       sweep that fires on the sentence it is protecting is worse than none. */
    "only recipient it wakes",
    "one recipient the service wakes",
    "first recipient is notified",
    "no agent is notified while",
    "exactly one chip is marked",
    /* ~~"is the one the service wakes"~~ matched nothing: the sentence it was for reads
       "Orbit is STILL the one the service wakes", so the "is" is two words earlier. A phrase
       that matches nothing is a line in a list that changes no behaviour, which is what the
       dead-phrase check below exists to say out loud. */
    "the one the service wakes",
    "way a reader can change who is woken",
    "changes who is woken",
  ];
  const normalise = (text) => text.toLowerCase().replace(/\s+/g, " ");
  let matchedSomewhere = new Set();
  for (const file of files) {
    /* THE PHRASE LIST IS NOT ITS OWN SUBJECT. This file is on the list, and the literals below
       are in it, so the sweep reported its own list as thirteen standing sentences. The list's
       own span is removed before scanning — precisely, by its declaration rather than by
       skipping the file, so everything else in this file IS scanned, which is how the round-four
       leftover in an assertion message a few hundred lines down is caught. */
    const source = readFileSync(new URL(file, import.meta.url), "utf8")
      .replace(/const retired = \[[\s\S]*?\n {2}\];/, "const retired = [];");
    /* EVERY FILE CONTRIBUTES. Five paths aimed at one big file would satisfy a total. */
    assert.ok(source.length > 2_000, `${file}: read only ${source.length} characters`);
    /* Character spans, not line matching: a strikethrough in this repo routinely wraps across
       several lines, and comparing a line against a concatenation of spans reported a struck
       sentence as standing. The spans are located in the NORMALISED text, so the offsets the
       phrase search returns are in the same coordinate system. */
    const flat = normalise(source);
    const struck = [];
    for (const match of flat.matchAll(/~~[\s\S]*?~~/g)) {
      struck.push([match.index, match.index + match[0].length]);
    }
    const inside = (at) => struck.some(([from, to]) => at >= from && at < to);
    for (const phrase of retired) {
      let at = flat.indexOf(phrase);
      while (at !== -1) {
        matchedSomewhere.add(phrase);
        assert.ok(
          inside(at),
          `${file}: "${phrase}" stands as current at offset ${at}: ` +
            JSON.stringify(flat.slice(Math.max(0, at - 110), at + 110)),
        );
        at = flat.indexOf(phrase, at + 1);
      }
    }
  }
  /* AND EVERY LISTED PHRASE IS LIVE. A phrase that matches nothing is a line in a list that
     changes no behaviour, and three of them were exactly that. This is what makes "adding to
     the list changes what runs" a fact rather than a hope. */
  const dead = retired.filter((phrase) => !matchedSomewhere.has(phrase));
  assert.deepEqual(
    dead,
    [],
    `these phrases match nothing, so listing them changes nothing: ${JSON.stringify(dead)}`,
  );
});

test("the module states the wake bound, and names the predicate that now enforces it", () => {
  /* A CLAIM CONTROL, not a style check. The reason the wake is what it is lives in the
     database, and a later reader who cannot find that reason will treat it as a preference.

     ~~`assert.match(source, /enqueue_signal_delivery/)`~~ and ~~`/to_agent_principal_id/`~~
     were the old pair, and they named the trigger and the column the RETIRED rule read. The
     rule now lives in `swarm.agent_delivery_is_wakeable`, so that is what has to be named. */
  const source = readFileSync(new URL("./composer-address.ts", import.meta.url), "utf8");
  assert.match(source, /agent_delivery_is_wakeable/);
  assert.match(source, /20260905000020_wake_all_recipients\.sql/);
  /* WHAT THIS CANNOT CHECK, said rather than implied. The migration it names is `lane/
     wake-all-recipients`' and is NOT on this branch — `supabase/migrations/` here ends at
     `20260905000010_signal_recipients.sql`. So this is a citation control and not a
     cross-file one: it asserts the module names the predicate rather than the retired trigger,
     and it cannot assert the predicate exists. It will become checkable when that lane merges,
     and a reader who finds no such file has found the two lanes out of order, not a bad
     citation. */
  /* AND THE RETIRED TRIGGER IS NAMED ONLY INSIDE THE RETIRED WORDING. It has to stay — a
     reader may still meet the old rule in `20260905000010_signal_recipients.sql` — but it must
     not be explaining the CURRENT one. Asserted as: the name appears exactly once, and that
     once is between the strikethrough markers this repo retires wording with. */
  const strikethroughs = [...source.matchAll(/~~[\s\S]*?~~/g)].map((match) => match[0]).join("");
  assert.equal(source.split("enqueue_signal_delivery").length - 1, 1);
  assert.equal(
    strikethroughs.split("enqueue_signal_delivery").length - 1,
    1,
    "the module explains the current wake with the trigger the retired rule read",
  );
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

test("a set arrival pruned is not a set the reader chose", () => {
  /* ONLY A CHOICE IS WORTH STORING. Comparing the set on screen with the LAST-SENT set said
   * yes to a set nobody had touched: arrival prunes that set, so a workspace that lost a
   * member produced a difference on its own. Writing that down made the prune permanent —
   * the stored draft answered on the next arrival, before the remembered set could, so a
   * member who left and came back stayed out of To: for good. That is the invariant this lane
   * exists to hold, in its other direction: a set on screen must be a choice, never residue.
   */
  const gone = { kind: "agent", id: "agent-departed" };
  const known = (entity) => entity.id !== gone.id;
  assert.equal(
    composerAddressIsChosen([wren], [wren, gone], known),
    false,
    "a set that is only the remembered one, pruned, was stored as a choice the reader made",
  );
  /* What the reader actually did still counts, in each of its shapes. */
  assert.equal(composerAddressIsChosen([], [wren, gone], known), true, "emptied to a broadcast");
  assert.equal(
    composerAddressIsChosen([wren, orbit], [wren, gone], known),
    true,
    "a name added",
  );
  assert.equal(
    composerAddressIsChosen([orbit, wren], [wren, orbit], () => true),
    true,
    /* ~~"which changes who is woken and so changes the set"~~ Retired 2026-09-05: promoting
       changes which recipient the message shows as addressed to, and no longer changes the
       wake. The boolean this pins was always about the SET's order, so it is unmoved. */
    "a name promoted, which changes the order the set was chosen in",
  );
  /* And an unpruned set that matches is still not a choice. */
  assert.equal(composerAddressIsChosen([wren, orbit], [wren, orbit], () => true), false);
});
