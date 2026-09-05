import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  brainLinkClickOutcome,
  createBrainTopicReader,
  BRAIN_LINK_ATTRIBUTE,
  BRAIN_LINK_CLASS,
  BRAIN_SLUG_SEPARATORS,
  brainLinkSegments,
  isSlugShapedTopic,
} from "./brain-links.ts";

/* Reached by site/package.json's 'src/lib/*.test.mjs' glob. */

/** The names the real workspace brain holds today, plus one that is an ordinary English word. */
const TOPICS = [
  "brain-how-to",
  "false-success-signals",
  "shared-host",
  "commonswarm-roadmap",
  "agent_restart",
  "v0.1.50",
  "releases",
  "roadmap",
];

/** Only the topics a text actually offers to open, in order. */
const linked = (text, topics = TOPICS, options = {}) =>
  brainLinkSegments(text, topics, options)
    .filter((segment) => segment.topic !== null)
    .map((segment) => segment.topic);

/** What the reader would see, with every control's own words in brackets. */
const shown = (text, topics = TOPICS, options = {}) =>
  brainLinkSegments(text, topics, options)
    .map((segment) => (segment.topic === null ? segment.text : `[${segment.text}]`))
    .join("");

test("a segment split never adds, drops, or reorders a character of the body", () => {
  /* The control on every case below: whatever the split decides, the reader still reads the
     sentence the author wrote. A rule that ate a space would pass its own case and fail here. */
  for (const text of [
    "See brain-how-to before you start.",
    "The roadmap slipped again, so the roadmap is the roadmap.",
    "Read `releases`, then commonswarm-roadmap; also https://example.com/roadmap.",
    "shared-host",
    "",
  ]) {
    assert.equal(
      brainLinkSegments(text, TOPICS).map((segment) => segment.text).join(""),
      text,
      `the split must reconstruct: ${JSON.stringify(text)}`,
    );
  }
});

test("a slug-shaped topic that exists links wherever it is written", () => {
  assert.deepEqual(linked("See brain-how-to before you start."), ["brain-how-to"]);
  assert.deepEqual(
    linked("There is a brain topic for commonswarm-roadmap now."),
    ["commonswarm-roadmap"],
  );
  assert.deepEqual(linked("agent_restart and v0.1.50 both apply."), [
    "agent_restart",
    "v0.1.50",
  ]);
  assert.deepEqual(
    linked("Read false-success-signals, then shared-host."),
    ["false-success-signals", "shared-host"],
  );
});

test("NEGATIVE CONTROL: a topic that does not exist never becomes a link", () => {
  /* The whole safety claim. If validation against the live list is removed, this is the
     assertion that fails: these names are slug-shaped, they are cued, and they are in code. */
  assert.deepEqual(linked("See made-up-topic before you start."), []);
  assert.deepEqual(linked("The brain topic for nonexistent-plan says so."), []);
  assert.deepEqual(
    linked("missing-thing", TOPICS, { codeSpan: "missing-thing" }),
    [],
  );
  assert.equal(shown("See made-up-topic."), "See made-up-topic.");
  /* And with no topics at all -- a workspace whose file list failed to load -- nothing links. */
  assert.deepEqual(brainLinkSegments("See brain-how-to.", []), [
    { text: "See brain-how-to.", topic: null },
  ]);
});

test("a one-word topic in ordinary prose stays ordinary prose", () => {
  /* A workspace with a topic literally named "roadmap" must not turn the English word into a
     link in every message that uses it. */
  assert.deepEqual(linked("The roadmap slipped, so the roadmap moved."), []);
  assert.deepEqual(linked("Two releases went out this week."), []);
  assert.equal(shown("The roadmap slipped."), "The roadmap slipped.");
});

test("an inline code span that IS the name admits a one-word topic", () => {
  /* codeSpan carries the whole span. The writer already said "this is a name". */
  assert.deepEqual(linked("releases", TOPICS, { codeSpan: "releases" }), ["releases"]);
  assert.deepEqual(linked("roadmap", TOPICS, { codeSpan: "roadmap" }), ["roadmap"]);
  assert.deepEqual(linked("  releases  ", TOPICS, { codeSpan: "  releases  " }), ["releases"]);
  assert.deepEqual(linked("Read releases first."), [], "outside code, it stays prose");
});

test("NEGATIVE CONTROL: a code span that merely CONTAINS a one-word topic does not admit it", () => {
  /* Found by a review arm. canonicalBrainTopic permits a topic called "brain", or "the", or
     "get". A span-contains rule would put a control inside every command an agent quotes --
     `cswarm brain put` would gain one on the word "brain". The span must BE the name. */
  const withWordTopics = [...TOPICS, "brain", "get", "the"];
  const span = "cswarm brain put shared-host";
  assert.deepEqual(
    linked(span, withWordTopics, { codeSpan: span }),
    ["shared-host"],
    "only the slug-shaped name links inside a command",
  );
  assert.deepEqual(linked("cswarm brain get the roadmap", withWordTopics, {
    codeSpan: "cswarm brain get the roadmap",
  }), []);
  /* And the same word alone in its own span still links, so the rule is equality, not a ban. */
  assert.deepEqual(linked("brain", withWordTopics, { codeSpan: "brain" }), ["brain"]);
});

test("NEGATIVE CONTROL: the word 'brain' near a one-word name does not admit it", () => {
  /* An earlier version accepted a nearby "brain" as a cue. A review arm killed it: the word
     boundary in \bbrain\b falls INSIDE "brain-how-to", the topic agents cite most, so the first
     line below minted a link on "releases" that nobody marked. Every line here is a live
     one-word topic sitting next to the word "brain", and every one must stay plain text. */
  assert.deepEqual(linked("Read brain-how-to for the releases ritual."), ["brain-how-to"]);
  assert.deepEqual(linked("The brain panel lists releases."), []);
  assert.deepEqual(linked("The human brain is not the roadmap."), []);
  assert.deepEqual(linked("See the brain: the roadmap slipped."), []);
  assert.deepEqual(linked("There is a brain topic for roadmap."), []);
  assert.deepEqual(linked("Run cswarm brain get releases."), []);
});

test("a name inside a URL, a path, or an address is never offered", () => {
  /* The run keeps the URL punctuation, so a URL is ONE run that equals no topic. Without that,
     the last path segment of any link would look like a bare topic name. */
  assert.deepEqual(linked("See https://example.com/shared-host for the host."), []);
  assert.deepEqual(linked("docs/design/commonswarm-roadmap covers it."), []);
  assert.deepEqual(linked("Mail shared-host@example.com about it."), []);
  assert.deepEqual(linked("~/notes/brain-how-to has a copy."), []);
});

test("a query string or a fragment is part of the URL, not a mention", () => {
  /* Found by a review arm: the run stopped at "?" and "=", so a copy-pasteable curl command in a
     code span had a button dropped into the middle of it. The gate is open here (marked: true),
     so only the run can keep these plain. */
  const inCode = (text) => linked(text, TOPICS, { codeSpan: text });
  assert.deepEqual(inCode("curl https://example.com/api?topic=commonswarm-roadmap"), []);
  assert.deepEqual(inCode("https://example.com/x?a=1&b=roadmap"), []);
  assert.deepEqual(inCode("https://example.com/x#shared-host"), []);
  assert.deepEqual(inCode("https://example.com/x?q=50%25&t=releases"), []);
  assert.deepEqual(inCode("?topic=shared-host"), []);
  /* And the sentence forms those characters also end must still work. */
  assert.equal(shown("Is it shared-host?"), "Is it [shared-host]?");
  assert.equal(shown("Read shared-host# now"), "Read [shared-host]# now");
});

test("a name that is only part of a longer token is never offered", () => {
  assert.deepEqual(linked("The non-shared-host case is different."), []);
  assert.deepEqual(linked("brain-how-to-v2 is a different name."), []);
  assert.deepEqual(
    linked("roadmapping is a word.", TOPICS, { codeSpan: "roadmapping is a word." }),
    [],
  );
  /* A Windows path is one run too. Found by a review arm: the run split at the backslash. */
  assert.deepEqual(linked("C:\\notes\\shared-host\\file.txt"), []);
});

test("sentence punctuation stays outside the control", () => {
  assert.equal(shown("Read shared-host."), "Read [shared-host].");
  assert.equal(shown("Read shared-host, then stop."), "Read [shared-host], then stop.");
  assert.equal(shown("(see brain-how-to)"), "(see [brain-how-to])");
  assert.equal(shown("Read shared-host: it explains why."), "Read [shared-host]: it explains why.");
  assert.equal(shown("The shared-host's rule applies."), "The [shared-host]'s rule applies.");
});

test("dots inside a name survive the trim that removes the sentence's own dot", () => {
  /* One text carries both: "v0.1.50" keeps its interior dots, and the final "." that ends the
     sentence stays outside the control. State what this does NOT cover: resolveRun tries the
     untrimmed run before the trimmed one, which only changes an answer for a topic whose name
     ENDS in a dot -- legal per canonicalBrainTopic, produced by nothing -- so that ordering is
     design, not a measured result. */
  assert.equal(shown("Ship v0.1.50."), "Ship [v0.1.50].");
  assert.deepEqual(linked("Ship v0.1.50 today."), ["v0.1.50"]);
});

test("the text a reader typed keeps its case; the topic it opens is canonical", () => {
  const segments = brainLinkSegments("See Brain-How-To first.", TOPICS);
  const control = segments.find((segment) => segment.topic !== null);
  assert.equal(control?.text, "Brain-How-To", "the sentence reads as written");
  assert.equal(control?.topic, "brain-how-to", "the panel opens the canonical topic");
});

test("the slug gate reads the same separator set the module exports", () => {
  assert.deepEqual([...BRAIN_SLUG_SEPARATORS], ["-", "_", "."]);
  for (const separator of BRAIN_SLUG_SEPARATORS) {
    assert.equal(isSlugShapedTopic(`a${separator}b`), true, `"${separator}" makes a slug`);
  }
  assert.equal(isSlugShapedTopic("roadmap"), false);
  assert.equal(isSlugShapedTopic("releases"), false);
});

test("the prose that describes the slug gate names the constant instead of listing it", () => {
  /*
   * BRAIN_SLUG_SEPARATORS is exported so that "the gate below and every sentence that describes
   * the gate read the same set" — its own words. The header comment did not: it typed the three
   * characters out beside the rule, which is the enumeration-inside-a-message defect AGENTS.md
   * records, one level down. A comment is not enforced by anything, so it needs a control.
   *
   * ONLY THE SECOND HALF IS BUILT FROM THE CONSTANT. Two review arms corrected an earlier
   * comment here that claimed both were. The first half cannot be: an identifier's own NAME is
   * not derivable from its value, so `BRAIN_SLUG_SEPARATORS` is typed in that pattern, once,
   * where a rename makes it fail loudly rather than silently.
   *
   * WHAT THIS CANNOT SEE, all named by the arms: a list in another shape ("- or _ or .", or
   * `` `-`, `_`, `.` `` with backticks, or the array's own `["-", "_", "."]` spelling, because
   * quotes break the run); and a reordered constant, because the pattern follows the array's
   * order. It catches the shape the defect actually had, `(-, _, .)`, and says so rather than
   * implying more.
   *
   * The header block is read whole rather than by line, so rewrapping the sentence is not a
   * failure. An arm found the first version pinned to one wrap of one line.
   */
  const source = readFileSync(new URL("./brain-links.ts", import.meta.url), "utf8");
  const header = source.slice(0, source.indexOf("export "));
  assert.ok(header.length > 500, "the header comment block is where the slug rule is stated");

  assert.match(
    header,
    /BRAIN_SLUG_SEPARATORS/,
    "the prose stating the slug rule must name BRAIN_SLUG_SEPARATORS, so a reader is sent " +
      "to the one place the set lives",
  );

  const typedList = new RegExp(
    BRAIN_SLUG_SEPARATORS.map((character) => `\\${character}`).join("\\s*,\\s*"),
  );
  assert.doesNotMatch(
    source,
    typedList,
    `brain-links.ts writes the separator set out as a list (${typedList}). Name ` +
      `BRAIN_SLUG_SEPARATORS instead: a second copy of the set drifts the day the first one ` +
      `changes, and nothing would fail.`,
  );
});

test("the control names it uses stay the ones the dashboard styles and queries", () => {
  assert.equal(BRAIN_LINK_CLASS, "dashboard__brain-link");
  /* Deliberately NOT brainTopic: brain-view.ts already puts data-brain-topic on its own list
     buttons, and one selector matching both would move the wrong control. */
  assert.equal(BRAIN_LINK_ATTRIBUTE, "brainLink");
});

test("several mentions in one body each get their own control", () => {
  assert.equal(
    shown("Read brain-how-to, then shared-host, then brain-how-to again."),
    "Read [brain-how-to], then [shared-host], then [brain-how-to] again.",
  );
  assert.deepEqual(linked("Read brain-how-to, then shared-host, then brain-how-to again."), [
    "brain-how-to",
    "shared-host",
    "brain-how-to",
  ]);
});

/** A read whose settling this test controls. */
const deferred = () => {
  let settle;
  const promise = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });
  return { promise, ...settle };
};

test("a click on a topic that still exists resolves to opening it", () => {
  assert.deepEqual(brainLinkClickOutcome("shared-host", TOPICS, true, true), {
    kind: "open",
    topic: "shared-host",
  });
});

test("a click on a topic DELETED since the control rendered says so, and does not open", () => {
  /* The control is rendered from a snapshot. A review arm found what happened when a topic was
     deleted after that render: the click reached brainView.open, which found the stale row, and
     the failure surfaced from inside the download as "The topic could not be loaded." This is
     that case, decided against the list the click re-read. */
  const afterDelete = TOPICS.filter((topic) => topic !== "shared-host");
  const outcome = brainLinkClickOutcome("shared-host", afterDelete, true, true);
  assert.equal(outcome.kind, "missing", "it must not resolve to open");
  assert.equal(outcome.topic, "shared-host");
  assert.match(outcome.message, /shared-host/u, "the message names the topic");
  assert.match(
    outcome.message,
    /not in this workspace any more/u,
    "it says the topic is gone, in those words",
  );
  assert.match(
    outcome.message,
    /list here is current/u,
    "and it says where the reader now is -- a true state word with no next step is not enough",
  );
  assert.doesNotMatch(
    outcome.message,
    /could not be loaded/u,
    "the download failure is what this replaces, so it must not be the message",
  );
});

test("an empty list resolves every click to missing, never to a silent open", () => {
  assert.equal(brainLinkClickOutcome("shared-host", [], true, true).kind, "missing");
});

test("a list that could NOT be refreshed authorizes NOTHING, even for a topic it holds", () => {
  /* DEFENCE IN DEPTH. The serialization in createBrainTopicReader is meant to guarantee the list
     is fresh at click time, and it has already been wrong once. This is the second lock: a read
     that failed did not establish "this topic exists", so it may not authorize an open even
     though the stale list still contains the name. */
  const stale = brainLinkClickOutcome("shared-host", TOPICS, false, true);
  assert.equal(stale.kind, "missing", "present in a STALE list is still not an open");
  assert.doesNotMatch(stale.message, /list here is current/u);
  assert.match(stale.message, /could not be refreshed just now/u);
  assert.match(stale.message, /cannot tell whether it is still here/u);
  assert.match(stale.message, /open it again/u, "it says what to do next");
  /* Absent from a stale list gets the same answer and the same words: the list is what is
     untrustworthy, not the name. */
  assert.deepEqual(brainLinkClickOutcome("shared-host", [], false, true), stale);
});

test("a click issued while a refresh is in flight resolves against the FRESH list", async () => {
  /* End to end over the two pieces: the reader waits out the running read and takes its own, and
     the outcome is computed from what that read produced. The topic is deleted while the cadence
     read is in flight, so a click that decided against the snapshot would answer "open". */
  let topics = ["shared-host", "releases"];
  const gate = deferred();
  let reads = 0;
  const reader = createBrainTopicReader({
    read: async () => {
      reads += 1;
      if (reads === 1) await gate.promise;
      /* Whatever the second read sees is the truth at that moment. */
      return true;
    },
    staleAfterMs: 30_000,
    now: () => 1_000_000,
  });

  const tick = reader.refresh(false);
  assert.equal(reads, 1, "the cadence read is in flight");

  const click = reader.refresh(true).then((fresh) =>
    brainLinkClickOutcome("shared-host", topics, fresh, true)
  );

  /* The delete lands while the cadence read is still open. */
  topics = ["releases"];
  gate.resolve();
  await tick;

  const outcome = await click;
  assert.equal(reads, 2, "the click took its own read after the running one finished");
  assert.equal(
    outcome.kind,
    "missing",
    "the click must answer from the list as of the click, not the snapshot behind it",
  );
});

/* ---- createBrainTopicReader: the race a review arm found ------------------------------- */

test("A FORCED refresh waits out a read already running, then takes its own", () => {
  /* THE DEFECT THIS PINS. The first version guarded with a plain in-flight boolean and returned
     early when it was set, so a click landing while the cadence tick was in flight returned
     without awaiting anything and decided against the OLD snapshot. Here the cadence read is
     deliberately left in flight when the click arrives. */
  const started = [];
  const gates = [deferred(), deferred()];
  const reader = createBrainTopicReader({
    read: async () => {
      const gate = gates[started.length];
      started.push(gate);
      await gate.promise;
      return true;
    },
    staleAfterMs: 30_000,
    now: () => 1_000_000,
  });

  const tick = reader.refresh(false);
  assert.equal(started.length, 1, "the cadence tick started a read");

  let clickSettled = false;
  const click = reader.refresh(true).then(() => {
    clickSettled = true;
  });

  return Promise.resolve()
    .then(() => {
      assert.equal(clickSettled, false, "the click must not resolve while a read is running");
      assert.equal(started.length, 1, "and must not start a second read on top of the first");
      gates[0].resolve();
      return tick;
    })
    .then(() => new Promise((resolve) => setTimeout(resolve, 0)))
    .then(() => {
      assert.equal(
        started.length,
        2,
        "after the running read finishes the click takes a FRESH one -- joining is not enough, " +
          "because a read that started before the click can predate what was clicked",
      );
      assert.equal(clickSettled, false, "and still has not resolved");
      gates[1].resolve();
      return click;
    })
    .then(() => assert.equal(clickSettled, true));
});

test("a forced refresh with nothing running still takes a read before it returns", async () => {
  let reads = 0;
  const reader = createBrainTopicReader({
    read: async () => {
      reads += 1;
      return true;
    },
    staleAfterMs: 30_000,
    now: () => 1_000_000,
  });
  assert.equal(await reader.refresh(true), true);
  assert.equal(reads, 1);
  /* And again: a click is never throttled, however recently the list was read. */
  assert.equal(await reader.refresh(true), true);
  assert.equal(reads, 2);
});

test("the UNforced cadence is throttled, so the feed tick cannot poll the file list", async () => {
  let reads = 0;
  let clock = 1_000_000;
  const reader = createBrainTopicReader({
    read: async () => {
      reads += 1;
      return true;
    },
    staleAfterMs: 30_000,
    now: () => clock,
  });
  await reader.refresh(false);
  assert.equal(reads, 1);
  clock += 29_999;
  await reader.refresh(false);
  assert.equal(reads, 1, "inside the window it does not read again");
  clock += 2;
  await reader.refresh(false);
  assert.equal(reads, 2, "past the window it does");
});

test("a failed read reports the list as NOT fresh and keeps trying", async () => {
  let ok = false;
  const reader = createBrainTopicReader({
    read: async () => {
      if (!ok) throw new Error("network");
      return true;
    },
    staleAfterMs: 30_000,
    now: () => 1_000_000,
  });
  assert.equal(await reader.refresh(true), false, "a rejection is not a fresh list");
  ok = true;
  assert.equal(await reader.refresh(true), true, "and the next click reads again");
});

test("a read that did NOT apply leaves the list stale, however cleanly it resolved", async () => {
  /* THE DEFECT THIS PINS. readBrainTopics returns early -- resolving, not throwing -- when the
     workspace changed under it or when there is nothing to read. The first reader marked the list
     fresh on ANY resolution, so a click after a workspace switch was authorized against the
     previous workspace's names. Resolving false is how "I did not read" is told apart from
     "the list is current". */
  let applied = false;
  const reader = createBrainTopicReader({
    read: async () => applied,
    staleAfterMs: 30_000,
    now: () => 1_000_000,
  });
  assert.equal(await reader.refresh(true), false, "a read that bailed is not a fresh list");
  applied = true;
  assert.equal(await reader.refresh(true), true, "one that applied is");
});

test("a click abandoned by a workspace switch opens nothing and says nothing", async () => {
  /* THE DEFECT THIS PINS, in the exact sequence a review arm walked. The PREVIOUS version of this
     test held its read in the "bailing" state for EVERY read, so the forced read never applied and
     the path below was never reached -- removing the guard could not turn it red. Here read 1 (the
     cadence read, workspace A) bails, the reader switches to B, and read 2 (the click's own,
     against B) APPLIES. So the list IS fresh and the names ARE real -- they are just the wrong
     workspace's. Only contextIsCurrent can catch it. */
  let onWorkspaceA = true;
  const namesOfB = ["shared-host", "changelog"];
  const reader = createBrainTopicReader({
    read: async () => !onWorkspaceA,
    staleAfterMs: 30_000,
    now: () => 1_000_000,
  });
  const cadence = await reader.refresh(false);
  assert.equal(cadence, false, "the cadence read bailed, as it does mid-switch");

  onWorkspaceA = false;
  const listIsFresh = await reader.refresh(true);
  assert.equal(listIsFresh, true, "the click's own read APPLIED -- against B");

  /* "shared-host" exists in B too, so every other gate says open. */
  assert.ok(namesOfB.includes("shared-host"));
  const outcome = brainLinkClickOutcome("shared-host", namesOfB, listIsFresh, false);
  assert.equal(
    outcome.kind,
    "abandoned",
    "a click made in A must not open B's copy of the slug; the reader clicked nothing in B",
  );
  assert.equal(outcome.topic, "shared-host");
  assert.ok(!("message" in outcome), "and it must carry no notice to show in B");
});

test("a name missing from the NEW workspace is still abandoned, not reported", () => {
  /* The other half: without the context check this yanks the reader to Brain and shows a notice
     naming a slug from a workspace they have left. */
  const outcome = brainLinkClickOutcome("shared-host", ["changelog"], true, false);
  assert.equal(outcome.kind, "abandoned");
  assert.ok(!("message" in outcome));
});

test("context still current leaves every other gate deciding as before", () => {
  /* The guard must not swallow the ordinary answers. */
  assert.equal(brainLinkClickOutcome("shared-host", TOPICS, true, true).kind, "open");
  assert.equal(brainLinkClickOutcome("shared-host", [], true, true).kind, "missing");
  assert.equal(brainLinkClickOutcome("shared-host", TOPICS, false, true).kind, "missing");
});

test("a URL keeps its sub-delimiters, so no control lands inside one", () => {
  /* Found by a review arm: ";" and "," are valid URL sub-delimiters and were outside the run, so
     the slug after one became its own run and was offered from the middle of a URL. */
  assert.deepEqual(linked("See https://example.com/a;commonswarm-roadmap"), []);
  assert.deepEqual(linked("Check https://example.com/page,commonswarm-roadmap"), []);
  assert.deepEqual(linked("See https://example.com/api;topic=commonswarm-roadmap"), []);
  assert.deepEqual(
    linked("curl https://x/a,shared-host;b", TOPICS, { codeSpan: "curl https://x/a,shared-host;b" }),
    [],
  );
});

test("a comma or semicolon that ENDS a sentence still leaves the name linked", () => {
  /* The other half of adding them to the run: the trailing-punctuation fallback has to strip
     them, or every name followed by a comma would have stopped linking. */
  assert.equal(shown("see shared-host, then stop"), "see [shared-host], then stop");
  assert.equal(shown("see shared-host; then stop"), "see [shared-host]; then stop");
  assert.equal(shown("read brain-how-to, shared-host, and releases"),
    "read [brain-how-to], [shared-host], and releases");
});

test("a code span carrying the sentence's own punctuation still links", () => {
  /* `roadmap.` -- the writer ended the sentence inside the backticks. resolveRun already trimmed
     the run; the equality check did not, so the intended link was missed. Both trim now. */
  assert.deepEqual(linked("roadmap.", TOPICS, { codeSpan: "roadmap." }), ["roadmap"]);
  assert.deepEqual(linked("releases,", TOPICS, { codeSpan: "releases," }), ["releases"]);
  /* And the rule it must not weaken: a span with other WORDS in it still offers no bare name. */
  assert.deepEqual(
    linked("cswarm brain get releases.", [...TOPICS, "brain", "get"], {
      codeSpan: "cswarm brain get releases.",
    }),
    [],
  );
});
