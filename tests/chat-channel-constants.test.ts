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
  RESERVED_CHANNEL_SLUG_TEXT,
  RESERVED_CHANNEL_SLUGS,
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
  assert.ok(
    migration.includes(`char_length(slug) BETWEEN 1 AND ${CHANNEL_SLUG_MAX}`),
    `the slug length CHECK must use ${CHANNEL_SLUG_MAX}`,
  );
  assert.ok(
    migration.includes(`char_length(purpose) <= ${CHANNEL_PURPOSE_MAX}`),
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
