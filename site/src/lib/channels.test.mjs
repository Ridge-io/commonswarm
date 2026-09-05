import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  CHANNEL_PURPOSE_MAX,
  CHANNEL_SLUG_MAX,
  CHANNEL_SLUG_RULE_TEXT,
  RESERVED_CHANNEL_SLUGS,
  RESERVED_CHANNEL_SLUG_TEXT,
  isReservedChannelSlug,
} from "../../../supabase/functions/_shared/channels.js";
import {
  ALL_SIGNALS_SLUG,
  CHANNEL_ARCHIVED_TEXT,
  CHANNEL_EMPTY_TEXT,
  CHANNEL_REACH_TEXT,
  channelById,
  channelLabel,
  channelNameHint,
  channelPurposeHint,
  channelPurposeInputMax,
  channelRefusalMessage,
  channelSlugInputMax,
  channelSubmitProblem,
  channelSubmitSlug,
  liveChannels,
} from "./channels.js";

/*
 * The browser's channel helpers. What this file is FOR is the seam between the app and the
 * command edge: every bound and every list the app shows a reader has to be the one the edge
 * refuses with, or the sentence drifts the day the edge changes and nothing fails.
 */

const channel = (over = {}) => ({
  channelId: "11111111-1111-4111-8111-111111111111",
  workspaceId: "22222222-2222-4222-8222-222222222222",
  slug: "mobile",
  purpose: null,
  createdByPrincipal: "33333333-3333-4333-8333-333333333333",
  createdByKind: "user",
  createdAt: "2026-09-05T00:00:00.000Z",
  archivedAt: null,
  ...over,
});

test("the unfiltered view's name is one the edge refuses for a real channel", () => {
  /* all-signals is not a row in swarm.channels: it is the whole feed. If the edge stopped
     reserving that name a member could create a channel that shadows the one place unfiled
     messages are readable, and the rail would show two entries with the same name. This is
     the assertion rather than a comment saying it, because the app depends on it. */
  assert.ok(isReservedChannelSlug(ALL_SIGNALS_SLUG));
  assert.ok(RESERVED_CHANNEL_SLUGS.includes(ALL_SIGNALS_SLUG));
  assert.equal(channelLabel(ALL_SIGNALS_SLUG), "#all-signals");
});

test("every rule sentence the app shows is the edge's own, not a copy", () => {
  const hint = channelNameHint();
  assert.ok(hint.includes(CHANNEL_SLUG_RULE_TEXT), hint);
  assert.ok(hint.includes(RESERVED_CHANNEL_SLUG_TEXT), hint);
  /* The bound reaches the reader through the edge's generated sentence, so raising
     CHANNEL_SLUG_MAX changes what the app says with no edit here. */
  assert.ok(hint.includes(String(CHANNEL_SLUG_MAX)), hint);
  assert.ok(channelPurposeHint().includes(String(CHANNEL_PURPOSE_MAX)));
  assert.equal(channelSlugInputMax(), CHANNEL_SLUG_MAX);
  assert.equal(channelPurposeInputMax(), CHANNEL_PURPOSE_MAX);
});

test("the app refuses a name for exactly the reasons the edge does", () => {
  assert.equal(channelSubmitProblem("mobile"), null);
  assert.equal(channelSubmitProblem("MOBILE"), null, "normalized before the rule runs");
  assert.equal(channelSubmitProblem("-nope"), CHANNEL_SLUG_RULE_TEXT);
  assert.equal(channelSubmitProblem("not a slug"), CHANNEL_SLUG_RULE_TEXT);
  assert.equal(channelSubmitProblem("x".repeat(CHANNEL_SLUG_MAX + 1)), CHANNEL_SLUG_RULE_TEXT);
  assert.equal(channelSubmitProblem("x".repeat(CHANNEL_SLUG_MAX)), null);
  assert.match(String(channelSubmitProblem(ALL_SIGNALS_SLUG)), /reserved/);
  assert.equal(channelSubmitSlug("  MoBiLe  "), "mobile");
});

test("a refusal shows the server's sentence and is never read for meaning", () => {
  assert.equal(
    channelRefusalMessage(409, { error: "channel_exists", message: "already has a channel" }, "fallback"),
    "already has a channel",
  );
  /* No message: the status is named so the reader can say what happened, and nothing is
     invented about WHY. Branching on a message string is D-053's measured failure. */
  assert.equal(
    channelRefusalMessage(500, {}, "CommonSwarm did not create the channel"),
    "CommonSwarm did not create the channel (HTTP 500). Nothing was changed.",
  );
  assert.equal(
    channelRefusalMessage(400, { message: "   " }, "fallback"),
    "fallback (HTTP 400). Nothing was changed.",
  );
});

test("the rail lists live channels in one order and hides the archived", () => {
  const rows = [
    channel({ channelId: "b", slug: "zulu" }),
    channel({ channelId: "a", slug: "alpha" }),
    channel({ channelId: "c", slug: "gone", archivedAt: "2026-09-05T01:00:00.000Z" }),
  ];
  assert.deepEqual(liveChannels(rows).map((row) => row.slug), ["alpha", "zulu"]);
  /* An archived channel is still READ: a permalink into it has to resolve and its messages
     still render. It is only absent from the list. */
  assert.equal(channelById(rows, "c")?.slug, "gone");
  assert.equal(channelById(rows, null), null);
  assert.equal(channelById(rows, "missing"), null);
});

test("the two facts the design puts in the UI say what they mean", () => {
  /* Both are claims about what a channel IS, and both must hold for the hosted app and for
     an agent posting through the CLI: a channel is an address, and it is not a scope. */
  assert.match(CHANNEL_REACH_TEXT, /Every member of this workspace reads every channel\./);
  assert.match(CHANNEL_REACH_TEXT, /not who gets woken/);
  assert.match(CHANNEL_EMPTY_TEXT, /before this channel existed stay in all-signals/);
  assert.match(CHANNEL_ARCHIVED_TEXT, /Its messages still read/);
  for (const sentence of [CHANNEL_REACH_TEXT, CHANNEL_EMPTY_TEXT, CHANNEL_ARCHIVED_TEXT]) {
    assert.doesNotMatch(sentence, /—/, "no em-dashes in user-facing copy");
    assert.doesNotMatch(
      sentence,
      /only .* sees|private|secret/i,
      "a channel is not private and no copy may imply it is",
    );
  }
});

test("the module imports its rules and does not restate them", () => {
  /*
   * A source sweep, with its bound stated: it reads ONLY site/src/lib/channels.ts, and it
   * looks ONLY for the four literals below appearing outside an import or an export
   * statement. It cannot tell you the file is free of every possible restatement; it can
   * tell you these four specific rules are imported rather than typed, which is the drift
   * that has actually happened here before.
   */
  const source = readFileSync(new URL("./channels.ts", import.meta.url), "utf8");
  const imported = ["CHANNEL_SLUG_MAX", "CHANNEL_PURPOSE_MAX", "CHANNEL_SLUG_RULE_TEXT", "RESERVED_CHANNEL_SLUG_TEXT"];
  const importBlock = source.slice(
    source.indexOf("import {"),
    source.indexOf('} from "../../../supabase/functions/_shared/channels.js"'),
  );
  for (const name of imported) {
    assert.ok(importBlock.includes(name), `${name} must come from the edge's module`);
  }
  assert.doesNotMatch(source, /A channel name uses lowercase/, "the rule sentence is generated");
  assert.doesNotMatch(source, /Reserved names:/, "the reserved list sentence is generated");
  assert.doesNotMatch(source, /= 32\b|= 500\b/, "the bounds are the edge's numbers");
});
