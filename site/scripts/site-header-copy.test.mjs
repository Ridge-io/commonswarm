import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const SITE = join(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(SITE, "dist");

const SHELL_ROUTES = [
  ["home", "index.html"],
  ["start", "start/index.html"],
  ["download", "download/index.html"],
  ["terms", "terms/index.html"],
  ["privacy", "privacy/index.html"],
  ["acceptable use", "acceptable-use/index.html"],
];

const RETIRED_HEADER =
  "Signup is not switched on for everyone yet, so the flow is a preview.";
const RETIRED_FOOTER =
  "Early access. Access is by invitation while we run CommonSwarm on our own work. Self-serve signup is built but is not open on this deployment yet.";
const CURRENT_HEADER = "Free — three workspaces, no card. Signup is open.";
const CURRENT_FOOTER = "Signup is open. Free — three workspaces, no card.";

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
    for (const retired of [RETIRED_HEADER, RETIRED_FOOTER]) {
      assert.equal(
        text.includes(retired),
        false,
        `${route}: retired signup-unavailable claim remains: ${JSON.stringify(retired)}`
      );
    }
  }
});
