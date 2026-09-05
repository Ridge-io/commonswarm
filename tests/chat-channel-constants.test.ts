import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
  CHANNEL_PURPOSE_MAX,
  CHANNEL_SLUG_MAX,
  CHANNEL_SLUG_CLASSES,
  CHANNEL_SLUG_RE,
  CHANNEL_SLUG_RULE_TEXT,
  channelSlugProblem,
  isReservedChannelSlug,
  normalizeChannelSlug,
  parseSignalRecipients,
  RESERVED_CHANNEL_SLUG_TEXT,
  RESERVED_CHANNEL_SLUGS,
  SIGNAL_RECIPIENT_KINDS,
  SIGNAL_RECIPIENT_MAX,
  SIGNAL_RECIPIENT_RULE_TEXT,
  signalRecipientListProblem,
  unknownChannelMessage,
} from "../supabase/functions/_shared/channels.js";

/**
 * Two enforcement points, two languages: the database CHECK on
 * swarm.channels.slug and the edge validator. They must move together or the
 * edge accepts a name the database refuses, which surfaces as a 500 on an
 * otherwise valid command. This gate reads BOTH artifacts.
 *
 * Gate: `npm test` (a literal file list — this path is named in package.json).
 */

const migration = readFileSync(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20260905000001_channels.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

test("the database CHECK and the edge regex are the same slug rule", () => {
  assert.ok(
    migration.includes(`slug ~ '${CHANNEL_SLUG_RE.source}'`),
    `20260905000001_channels.sql must CHECK the exact pattern ${CHANNEL_SLUG_RE.source}`,
  );
  /* The BOUNDS are read as numbers, not substring-matched. A substring test
   * passes on a longer number that starts with the same digits ("BETWEEN 1 AND
   * 320" contains "BETWEEN 1 AND 32"), so it cannot pin a bound at all. A
   * review arm found this shape on the recipient cap below; it was here too. */
  const slugBound = /char_length\(slug\) BETWEEN 1 AND (\d+)/.exec(migration);
  assert.ok(slugBound, "the slug length CHECK must be findable");
  assert.equal(
    Number(slugBound![1]),
    CHANNEL_SLUG_MAX,
    `the slug length CHECK must use ${CHANNEL_SLUG_MAX}`,
  );
  const purposeBound = /char_length\(purpose\) <= (\d+)/.exec(migration);
  assert.ok(purposeBound, "the purpose length CHECK must be findable");
  assert.equal(
    Number(purposeBound![1]),
    CHANNEL_PURPOSE_MAX,
    `the purpose CHECK must use ${CHANNEL_PURPOSE_MAX}`,
  );
  /* Control: the file really was read and really can miss a pattern, so a
   * passing assertion above is about the content and not about a truthy
   * substring test that would accept anything. */
  assert.equal(
    migration.includes("slug ~ '^this-is-not-the-pattern$'"),
    false,
  );
});

test("the slug regex accepts a usable name and refuses the shapes the rule names", () => {
  for (const good of ["mobile", "a", "team-1", "x9", "all-hands-2026"]) {
    assert.equal(CHANNEL_SLUG_RE.test(good), true, `${good} must be accepted`);
  }
  for (
    const bad of ["-lead", "trail-", "Two Words", "UPPER", "under_score", ""]
  ) {
    assert.equal(CHANNEL_SLUG_RE.test(bad), false, `${bad} must be refused`);
  }
});

test("channelSlugProblem refuses over-length, reserved and non-text names", () => {
  assert.equal(channelSlugProblem("mobile"), null);
  assert.equal(channelSlugProblem("  MOBILE  "), null, "trimmed and lowercased");
  assert.equal(channelSlugProblem("a".repeat(CHANNEL_SLUG_MAX)), null);
  assert.notEqual(channelSlugProblem("a".repeat(CHANNEL_SLUG_MAX + 1)), null);
  assert.notEqual(channelSlugProblem(""), null);
  assert.notEqual(channelSlugProblem(42), null);
  for (const reserved of RESERVED_CHANNEL_SLUGS) {
    assert.notEqual(
      channelSlugProblem(reserved),
      null,
      `${reserved} is reserved and must be refused`,
    );
    assert.equal(isReservedChannelSlug(reserved.toUpperCase()), true);
  }
});

test("every refusal sentence is generated from the constant the validator reads", () => {
  /* The measured failure this guards: a sentence that lists what the code
   * enforces, typed by hand, and drifting the moment the enforcement changes.
   * Each assertion below fails if the sentence stops being derived. */
  assert.ok(
    CHANNEL_SLUG_RULE_TEXT.includes(String(CHANNEL_SLUG_MAX)),
    "the slug rule sentence must name the bound the validator applies",
  );
  for (const reserved of RESERVED_CHANNEL_SLUGS) {
    assert.ok(
      RESERVED_CHANNEL_SLUG_TEXT.includes(reserved),
      `the reserved sentence must name ${reserved}`,
    );
  }
  /* Counting is the half that catches a sentence that names the right slugs
   * and silently drops a new one: a typed list keeps its old length. */
  assert.equal(
    RESERVED_CHANNEL_SLUG_TEXT.split(",").length,
    RESERVED_CHANNEL_SLUGS.length,
    "the reserved sentence lists exactly the reserved slugs, no more and no fewer",
  );
  const over = channelSlugProblem("a".repeat(CHANNEL_SLUG_MAX + 1));
  assert.equal(over, CHANNEL_SLUG_RULE_TEXT);
  const reservedProblem = channelSlugProblem(RESERVED_CHANNEL_SLUGS[0]!);
  assert.ok(reservedProblem!.includes(RESERVED_CHANNEL_SLUG_TEXT));
});

test("the unknown-channel message lists the channels that exist, and says so when none do", () => {
  const message = unknownChannelMessage("mobile", ["design", "alpha"]);
  assert.ok(message.includes("mobile"));
  assert.ok(message.includes("alpha, design"), "listed and sorted");
  /* Control: the same builder with an empty set must NOT claim a list. Without
   * this arm the test passes on a function that always appends a stale
   * hardcoded list. */
  const empty = unknownChannelMessage("mobile", []);
  assert.ok(empty.includes("no channel has been created yet"));
  assert.equal(empty.includes("alpha"), false);
});

test("normalizeChannelSlug is what the unique index compares", () => {
  assert.equal(normalizeChannelSlug("  Mobile "), "mobile");
  assert.equal(normalizeChannelSlug("MOBILE"), "mobile");
});

test("the slug sentence and the slug regex are built from one table of character classes", () => {
  /* An arm found the BOUND interpolated while the character class beside it was
   * typed prose: change the regex and the sentence stays behind. Both are now
   * generated from CHANNEL_SLUG_CLASSES, and this pins that they agree. */
  const edge = CHANNEL_SLUG_CLASSES.edge.map((c) => c.fragment).join("");
  const inner = edge + CHANNEL_SLUG_CLASSES.inner.map((c) => c.fragment).join("");
  assert.equal(
    CHANNEL_SLUG_RE.source,
    `^[${edge}]([${inner}]*[${edge}])?$`,
    "the regex must be the table's alphabet",
  );

  /* Every class the regex allows is named in the sentence... */
  for (const entry of [...CHANNEL_SLUG_CLASSES.edge, ...CHANNEL_SLUG_CLASSES.inner]) {
    assert.ok(
      CHANNEL_SLUG_RULE_TEXT.includes(entry.words),
      `the rule text must name ${entry.words}`,
    );
  }
  /* ...and nothing else is: a word class the table does not carry must be
   * absent, or the sentence promises an alphabet the regex refuses. */
  for (const absent of ["uppercase", "underscore", "spaces", "dots", "slashes"]) {
    assert.equal(
      CHANNEL_SLUG_RULE_TEXT.includes(absent),
      false,
      `the rule text must not name ${absent}, which the regex refuses`,
    );
  }

  /* Behavioural control on the same table: one character from each class is
   * accepted where the class allows it, and the inner-only class is refused at
   * the edges. This is what makes the two assertions above about the alphabet
   * and not about two strings that merely match. */
  assert.equal(CHANNEL_SLUG_RE.test("a0"), true);
  assert.equal(CHANNEL_SLUG_RE.test("a-0"), true);
  assert.equal(CHANNEL_SLUG_RE.test("-a"), false);
  assert.equal(CHANNEL_SLUG_RE.test("a-"), false);
  assert.equal(CHANNEL_SLUG_RE.test("A"), false);
  assert.equal(CHANNEL_SLUG_RE.test("a_b"), false);
});

/* ---------------------------------------------------------------------------
 * The recipient cap. Three artifacts hold this number, in three languages, and
 * none of them can import the others: the migration's CHECK, the edge
 * constant, and the composer's own ceiling under site/. The two below are read
 * as TEXT for exactly that reason.
 * ------------------------------------------------------------------------- */

const recipientsMigration = readFileSync(
  fileURLToPath(
    new URL(
      "../supabase/migrations/20260905000010_signal_recipients.sql",
      import.meta.url,
    ),
  ),
  "utf8",
);

const mentionAddress = readFileSync(
  fileURLToPath(new URL("../site/src/lib/mention-address.ts", import.meta.url)),
  "utf8",
);

test("the recipient cap is the same number in the migration, the edge and the composer", () => {
  /* The CHECK bounds the POSITION, which is what caps the row count: positions
   * are unique per signal, so the highest legal position is the cap minus one.
   * Asserting the derived number rather than the constant is deliberate -- it
   * is the number actually written in the SQL, and it moves with the cap. */
  /* READ THE NUMBER, do not substring-match it. A review arm found the first
   * version of this assertion using includes("position BETWEEN 0 AND 7"),
   * which is satisfied by "BETWEEN 0 AND 75" -- so the cap could be raised
   * nine-fold and the gate that exists to pin it would stay green. Extract the
   * bound and compare it as a number; there is no prefix it can hide behind. */
  const positionBound = /position BETWEEN 0 AND (\d+)/.exec(recipientsMigration);
  assert.ok(
    positionBound,
    "20260905000010 must CHECK the recipient position bound",
  );
  assert.equal(
    Number(positionBound![1]),
    SIGNAL_RECIPIENT_MAX - 1,
    `the position bound must be ${SIGNAL_RECIPIENT_MAX - 1}, one below the cap of ${SIGNAL_RECIPIENT_MAX}`,
  );
  /* Control on the extractor itself: it really can read a different number out
   * of the same shape, so the equality above is about the migration's value. */
  assert.equal(
    Number(/position BETWEEN 0 AND (\d+)/.exec("position BETWEEN 0 AND 75")![1]),
    75,
  );

  /* The composer refuses tags past its own ceiling. If it were higher than the
   * server's, a person would compose a message the server then refuses; if it
   * were lower, chips would be dropped for no reason the server would give.
   * BOUND OF THIS CHECK, stated: it reads one exported constant by name from
   * one file. It does not prove the composer has no other ceiling elsewhere. */
  const declared = /MENTION_MAX_RECIPIENTS\s*=\s*(\d+)/.exec(mentionAddress);
  assert.ok(declared, "site/src/lib/mention-address.ts must export MENTION_MAX_RECIPIENTS");
  assert.equal(
    Number(declared![1]),
    SIGNAL_RECIPIENT_MAX,
    "the composer's ceiling and the server's cap are one number",
  );
});

test("the recipient rules refuse each shape they name, and the sentences are generated", () => {
  const uuid = "22222222-2222-4222-8222-222222222222";
  const other = "33333333-3333-4333-8333-333333333333";
  assert.equal(signalRecipientListProblem(undefined), null, "absent is fine");
  assert.equal(signalRecipientListProblem(null), null, "null means absent");
  assert.equal(
    signalRecipientListProblem([{ kind: "user", id: uuid }]),
    null,
    "one well-formed recipient is fine",
  );

  /* Every kind in the constant is accepted, so the list and the check cannot
   * drift: adding a kind to SIGNAL_RECIPIENT_KINDS makes this loop cover it. */
  for (const kind of SIGNAL_RECIPIENT_KINDS) {
    assert.equal(signalRecipientListProblem([{ kind, id: uuid }]), null, kind);
  }
  /* And the sentence names all of them. */
  for (const kind of SIGNAL_RECIPIENT_KINDS) {
    assert.ok(
      SIGNAL_RECIPIENT_RULE_TEXT.includes(kind),
      `the rule text must name ${kind}`,
    );
  }
  assert.ok(
    SIGNAL_RECIPIENT_RULE_TEXT.includes(String(SIGNAL_RECIPIENT_MAX)),
    "the rule text carries the cap it enforces",
  );

  assert.match(
    String(signalRecipientListProblem([])),
    /at least one recipient/,
    "an empty list is refused as an empty list, not as a bad shape",
  );
  /* GENERATED, not typed. This asserted /kind is user or agent/, which is
   * today's classList output written out by hand in a test -- the same drift
   * one level down that the rule text exists to prevent. */
  assert.ok(
    String(signalRecipientListProblem([{ kind: "nobody", id: uuid }]))
      .includes(
        `kind is ${SIGNAL_RECIPIENT_KINDS.slice(0, -1).join(", ")} or ${
          SIGNAL_RECIPIENT_KINDS[SIGNAL_RECIPIENT_KINDS.length - 1]
        }`,
      ),
    "the kind list in the refusal is the constant's own list",
  );
  assert.match(
    String(signalRecipientListProblem([{ kind: "user", id: "nope" }])),
    /id is a UUID/,
  );
  assert.match(
    String(signalRecipientListProblem([{ kind: "user", id: uuid, extra: 1 }])),
    /Each one is \{kind, id\}/,
    "an extra key on an entry is refused",
  );
  assert.match(
    String(signalRecipientListProblem("everyone")),
    /to is a list of recipients/,
  );
  assert.match(
    String(
      signalRecipientListProblem([
        { kind: "user", id: uuid },
        { kind: "user", id: uuid.toUpperCase() },
      ]),
    ),
    /same recipient twice/,
    "the duplicate check folds case, because the database compares uuids",
  );
  /* Control on the duplicate rule: the SAME id under a different kind is two
   * different recipients, so the check is about the pair and not about the id. */
  assert.equal(
    signalRecipientListProblem([
      { kind: "user", id: uuid },
      { kind: "agent", id: uuid },
    ]),
    null,
  );

  /* The cap, at its boundary. The generated sentence carries the number. */
  const atCap = Array.from({ length: SIGNAL_RECIPIENT_MAX }, (_unused, i) => ({
    kind: "user" as const,
    id: `${String(i).repeat(8)}-2222-4222-8222-222222222222`.slice(-36),
  }));
  assert.equal(
    signalRecipientListProblem(atCap),
    null,
    "exactly the cap is accepted",
  );
  const overCap = [...atCap, { kind: "agent" as const, id: other }];
  assert.match(
    String(signalRecipientListProblem(overCap)),
    new RegExp(`at most ${SIGNAL_RECIPIENT_MAX} recipients`),
  );
});

test("parseSignalRecipients lower-cases ids and refuses what the rules refuse", () => {
  const upper = "22222222-2222-4222-8222-22222222222A";
  assert.deepEqual(
    parseSignalRecipients([{ kind: "agent", id: upper }]),
    [{ kind: "agent", id: upper.toLowerCase() }],
    "ids reach the database in the form Postgres stores",
  );
  assert.equal(parseSignalRecipients(undefined), null);
  assert.equal(parseSignalRecipients(null), null);
  assert.equal(parseSignalRecipients("nope"), null);
  assert.equal(parseSignalRecipients([{ kind: "user", id: "nope" }]), null);
  assert.deepEqual(parseSignalRecipients([]), []);
});
