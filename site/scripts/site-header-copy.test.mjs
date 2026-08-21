import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(SITE, "dist");

const SHELL_ROUTES = [
  ["home", "index.html"],
  ["download", "download/index.html"],
  ["terms", "terms/index.html"],
  ["privacy", "privacy/index.html"],
  ["acceptable use", "acceptable-use/index.html"],
];
const ALL_ROUTES = [
  ...SHELL_ROUTES,
  ["start handoff", "start/index.html"],
  ["dashboard", "app/index.html"],
];

const RETIRED_HEADER =
  "Signup is not switched on for everyone yet, so the flow is a preview.";
const RETIRED_FOOTER =
  "Early access. Access is by invitation while we run CommonSwarm on our own work. Self-serve signup is built but is not open on this deployment yet.";
/* POSITIVE CONTROLS, not copy controls. Their job is to prove the retired-claim greps below
 * run against real rendered text — a suite that greps an empty string passes every absence
 * check. They are re-pinned when the sentence legitimately changes.
 *
 * Changed 2026-08-09: "three" -> "10". The AVAILABILITY CLAIM — "Signup is open." — is
 * untouched and is the half D-023 exists to protect. What moved is the free-tier COUNT,
 * because FREE_TIER_WORKSPACE_LIMIT went 3 -> 10 in command v17 the same day, and the copy
 * had gone stale against the server within hours. That is D-023's own lesson applied to a
 * number instead of an availability state: copy asserts deployment state, so grep every
 * surface when a gate flips. This one was found in EIGHT shipping places across two
 * spellings ("3" and "three"), one of which was dead code. */
const CURRENT_HEADER = "Free for 10 workspaces, no card. Signup is open.";
const CURRENT_FOOTER = "Signup is open. Free for 10 workspaces, no card.";

function decodeEntities(value) {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#([0-9]+);/g, (_, decimal) =>
      String.fromCodePoint(Number.parseInt(decimal, 10))
    )
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'");
}

function renderedText(relativePath) {
  const html = readFileSync(join(DIST, relativePath), "utf8");
  return decodeEntities(
    html
      .replace(/<(script|style|template)\b[^>]*>[\s\S]*?<\/\1>/gi, " ")
      .replace(/<!--[\s\S]*?-->/g, " ")
      .replace(/<[^>]+>/g, " ")
  )
    .replace(/\s+/g, " ")
    .trim();
}

test("D-023: rendered shell says signup is open and never publishes retired access claims", () => {
  for (const [route, output] of SHELL_ROUTES) {
    const text = renderedText(output);
    assert.ok(
      text.includes(CURRENT_HEADER),
      `${route}: header positive control missing: ${JSON.stringify(CURRENT_HEADER)}`
    );
    assert.ok(
      text.includes(CURRENT_FOOTER),
      `${route}: footer positive control missing: ${JSON.stringify(CURRENT_FOOTER)}`
    );
  }

  for (const [route, output] of ALL_ROUTES) {
    const text = renderedText(output);
    for (const retired of [RETIRED_HEADER, RETIRED_FOOTER]) {
      assert.equal(
        text.includes(retired),
        false,
        `${route}: retired signup-unavailable claim remains: ${JSON.stringify(retired)}`
      );
    }
  }
});
