/**
 * Pins the connect flow's DEFAULT key lifetime.
 *
 * Operator ruling 2026-08-27: the default is 30 days. It was 24 hours, which meant an
 * agent connected through this page stopped working the next day — the most common way a
 * working setup died, and it reads as a product fault rather than a deliberate expiry.
 *
 * This is a DEFAULT, not a maximum, and nothing here relaxes the ceiling: 30d is already
 * the renewal horizon enforced elsewhere, so defaulting to it grants nothing an operator
 * could not already select. The test exists because a `selected` attribute is one
 * character and no other gate reaches it — the previous value was never pinned, which is
 * why it survived a ruling that had already been made.
 *
 * Reached by `npm --prefix site test` via the glob 'src/components/**\/*.observer.test.ts'.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const SOURCE = readFileSync(
  fileURLToPath(new URL("./AgentConnect.astro", import.meta.url)),
  "utf8",
);

const DAY_MS = 86_400_000;
const OPTION_RE = /<option value="(\d+)"([^>]*)>([^<]+)<\/option>/g;

interface Option {
  valueMs: number;
  selected: boolean;
  label: string;
}

function lifetimeOptions(): Option[] {
  // Scope to the key-lifetime select so an unrelated <select> cannot satisfy this test.
  const start = SOURCE.indexOf('id="ac-ttl"');
  assert.notEqual(start, -1, "the key-lifetime select must still exist");
  const end = SOURCE.indexOf("</select>", start);
  assert.notEqual(end, -1, "the key-lifetime select must be closed");
  const block = SOURCE.slice(start, end);

  const options: Option[] = [];
  for (const match of block.matchAll(OPTION_RE)) {
    options.push({
      valueMs: Number(match[1]),
      selected: /\bselected\b/.test(match[2] ?? ""),
      label: (match[3] ?? "").trim(),
    });
  }
  return options;
}

test("the connect flow defaults the key lifetime to 30 days", () => {
  const options = lifetimeOptions();
  assert.ok(options.length > 0, "the key-lifetime select must offer options");

  const selected = options.filter((option) => option.selected);
  assert.equal(selected.length, 1, "exactly one lifetime option may be preselected");
  assert.equal(
    selected[0]?.valueMs,
    30 * DAY_MS,
    `default lifetime must be 30 days; found ${selected[0]?.label}`,
  );
});

test("24 hours is still offered, just no longer the default", () => {
  const options = lifetimeOptions();
  const day = options.find((option) => option.valueMs === DAY_MS);
  assert.ok(day, "a 24-hour option must remain available");
  assert.equal(day?.selected, false, "24 hours must not be preselected");
});

test("no option exceeds the 30-day renewal horizon", () => {
  // The default moved; the ceiling did not. A longer option would be a real relaxation,
  // and this test is what makes that a deliberate change rather than a quiet one.
  for (const option of lifetimeOptions()) {
    assert.ok(
      option.valueMs <= 30 * DAY_MS,
      `${option.label} (${option.valueMs}ms) exceeds the 30-day horizon`,
    );
  }
});

test("the hint no longer tells the reader that shorter is safer without saying what the max is", () => {
  // The old hint read "Shorter is safer; pick longer if setup ... may take a while",
  // which argued for the 24h default it shipped with. With a 30d default that sentence
  // pushes against the shipped behaviour, so it must not survive unchanged.
  const start = SOURCE.indexOf('id="ac-ttl"');
  const hint = SOURCE.slice(start, start + 800);
  assert.doesNotMatch(
    hint,
    /Shorter is safer; pick longer if setup on the other machine may take a while/,
  );
  assert.match(hint, /30 days is the maximum/);
});
