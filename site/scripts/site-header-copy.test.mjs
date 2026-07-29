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

const RETIRED =
  "Signup is not switched on for everyone yet, so the flow is a preview.";
const CURRENT = "Free — three workspaces, no card. Signup is open.";

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

test("D-023: rendered shell says signup is open and never publishes the retired preview claim", () => {
  for (const [route, output] of SHELL_ROUTES) {
    const text = renderedText(output);
    assert.ok(
      text.includes(CURRENT),
      `${route}: positive control missing from rendered text: ${JSON.stringify(CURRENT)}`
    );
    assert.equal(
      text.includes(RETIRED),
      false,
      `${route}: retired signup-unavailable claim remains in rendered text`
    );
  }
});
