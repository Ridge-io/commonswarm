/**
 * Pure controls for idle poll bounds, backoff, and generated copy.
 *
 * Reached by `npm test` (named in the literal list).
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
  ARRIVAL_WATCH_POLL_MS,
  formatIdlePollDuration,
  idlePollBoundSentence,
  idlePollDurationHint,
  idlePollHelpSentence,
  idlePollStatusSentence,
  IDLE_POLL_DEFAULT_LABEL,
  IDLE_POLL_DEFAULT_MS,
  IDLE_POLL_DURATION_EXAMPLES,
  IDLE_POLL_MAX_LABEL,
  IDLE_POLL_MAX_MS,
  IDLE_POLL_MIN_LABEL,
  IDLE_POLL_MIN_MS,
  nextIdlePollMs,
  parseIdlePollIntervalMs,
} from "../src/cloud/idle-poll.js";
import { LISTENER_IDLE_POLL_MS, LISTENER_IDLE_POLL_MAX_MS } from "../src/listener/runtime.js";
import { listenerPollIntervalMs, usage } from "../src/cli.js";

test("idle poll constants are one set: default 15s, cap 60s, notify uses the cap", () => {
  assert.equal(IDLE_POLL_DEFAULT_MS, 15_000);
  assert.equal(IDLE_POLL_MAX_MS, 60_000);
  assert.equal(IDLE_POLL_MIN_MS, 1_000);
  assert.equal(LISTENER_IDLE_POLL_MS, IDLE_POLL_DEFAULT_MS);
  assert.equal(LISTENER_IDLE_POLL_MAX_MS, IDLE_POLL_MAX_MS);
  assert.equal(ARRIVAL_WATCH_POLL_MS, IDLE_POLL_MAX_MS);
  assert.equal(formatIdlePollDuration(IDLE_POLL_DEFAULT_MS), "15s");
  assert.equal(formatIdlePollDuration(IDLE_POLL_MAX_MS), "1m");
  assert.equal(IDLE_POLL_DEFAULT_LABEL, "15s");
  assert.equal(IDLE_POLL_MAX_LABEL, "1m");
  assert.equal(IDLE_POLL_MIN_LABEL, "1s");
});

test("empty polls double from the base until the cap, then stay there", () => {
  assert.equal(nextIdlePollMs(IDLE_POLL_DEFAULT_MS, 0), 15_000);
  assert.equal(nextIdlePollMs(IDLE_POLL_DEFAULT_MS, 1), 30_000);
  assert.equal(nextIdlePollMs(IDLE_POLL_DEFAULT_MS, 2), 60_000);
  assert.equal(nextIdlePollMs(IDLE_POLL_DEFAULT_MS, 3), 60_000);
  assert.equal(nextIdlePollMs(IDLE_POLL_DEFAULT_MS, 16), 60_000);
  assert.equal(nextIdlePollMs(5_000, 0), 5_000);
  assert.equal(nextIdlePollMs(5_000, 1), 10_000);
  assert.equal(nextIdlePollMs(5_000, 2), 20_000);
  assert.equal(nextIdlePollMs(5_000, 3), 40_000);
  assert.equal(nextIdlePollMs(5_000, 4), 60_000);
  assert.equal(nextIdlePollMs(IDLE_POLL_MAX_MS, 0), IDLE_POLL_MAX_MS);
  assert.equal(nextIdlePollMs(IDLE_POLL_MAX_MS, 3), IDLE_POLL_MAX_MS);
  assert.equal(nextIdlePollMs(0, 0), 0);
  assert.equal(nextIdlePollMs(0, 4), 0);
});

test("a delivery resets the wait to the configured base", () => {
  const afterTwoEmpty = nextIdlePollMs(IDLE_POLL_DEFAULT_MS, 2);
  assert.equal(afterTwoEmpty, IDLE_POLL_MAX_MS);
  assert.equal(nextIdlePollMs(IDLE_POLL_DEFAULT_MS, 0), IDLE_POLL_DEFAULT_MS);
});

test("--poll-interval parses the same duration shape the flag documents", () => {
  assert.equal(parseIdlePollIntervalMs(undefined), IDLE_POLL_DEFAULT_MS);
  assert.equal(parseIdlePollIntervalMs("15s"), 15_000);
  assert.equal(parseIdlePollIntervalMs("30s"), 30_000);
  assert.equal(parseIdlePollIntervalMs("1m"), 60_000);
  assert.equal(listenerPollIntervalMs("15s"), 15_000);
  assert.throws(
    () => parseIdlePollIntervalMs("90x"),
    /--poll-interval must be a duration such as 15s, 30s, 1m/,
  );
  assert.throws(
    () => parseIdlePollIntervalMs("2m"),
    /--poll-interval must be between 1s and 1m/,
  );
  assert.throws(
    () => parseIdlePollIntervalMs("0s"),
    /--poll-interval must be a duration such as 15s, 30s, 1m/,
  );
});

test("user-facing idle poll lists and bounds are generated from the constants that enforce them", () => {
  const hint = idlePollDurationHint();
  assert.equal(hint, IDLE_POLL_DURATION_EXAMPLES.join(", "));
  assert.match(hint, /15s/);
  assert.match(hint, /1m/);
  const bound = idlePollBoundSentence();
  assert.equal(bound, `between ${IDLE_POLL_MIN_LABEL} and ${IDLE_POLL_MAX_LABEL}`);
  const help = idlePollHelpSentence();
  assert.match(help, new RegExp(IDLE_POLL_DEFAULT_LABEL));
  assert.match(help, new RegExp(IDLE_POLL_MAX_LABEL));
  assert.match(help, /--poll-interval/);
  assert.equal(idlePollStatusSentence(15_000), "Current idle poll interval: 15s.");
  assert.equal(idlePollStatusSentence(30_000), "Current idle poll interval: 30s.");
  assert.equal(idlePollStatusSentence(60_000), "Current idle poll interval: 1m.");
  const usageText = usage();
  assert.match(usageText, /--poll-interval <duration>/);
  assert.ok(usageText.includes(help));
});
