/*
 * Prints, per provider state, every sentence on the built pages that mentions signing in and
 * names a provider. Run from the worktree root:
 *   node --import tsx docs/evidence/2026-09-06-google-copy/dump-copy.mjs
 *
 * This is the human-readable form of what the sweep asserts. It builds the same three fixtures
 * the suite builds, so what it prints is what a reader of that build would see.
 */
import { readdir, readFile } from "node:fs/promises";
import { AUTH_PROVIDERS } from "../../../site/src/lib/auth-providers.js";
import { providerFixtures } from "../../../site/scripts/provider-fixtures.js";

const NUL = String.fromCharCode(0);
const SIGNIN_WORDS = /\bsign(?:ing|ed)?[ -]?(?:in|up)\b|\blog[ -]?in\b/i;
const UNIT_END =
  /<\/(?:p|li|h[1-6]|div|button|td|th|option|label|figcaption|blockquote|nav|section|footer)>|<br\s*\/?>/gi;
const META_COPY =
  /<meta[^>]*(?:name="description"|property="og:description"|name="twitter:description")[^>]*content="([^"]*)"/gi;
const ABBREVIATIONS = [
  ...new Set(
    AUTH_PROVIDERS.flatMap((provider) =>
      [...provider.legalEntity.matchAll(/\b([A-Za-z]+)\./g)].map((match) => match[1]),
    ),
  ),
];
const SENTENCE_END = new RegExp(`(?<!\\b(?:${ABBREVIATIONS.join("|")})\\.)(?<=[.!?])\\s+`);

const decode = (text) =>
  text
    .replace(/&amp;/g, "&")
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/&nbsp;/g, " ");

const metaUnits = (html) =>
  [...html.matchAll(META_COPY)]
    .flatMap((match) => decode(match[1] ?? "").split(SENTENCE_END))
    .map((unit) => unit.replace(/\s+/g, " ").trim())
    .filter(Boolean);

const copyUnits = (html) =>
  decode(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, " ")
      .replace(/<style[\s\S]*?<\/style>/gi, " ")
      .replace(UNIT_END, NUL)
      .replace(/<[^>]+>/g, " "),
  )
    .split(NUL)
    .flatMap((chunk) => chunk.split(SENTENCE_END))
    .concat(metaUnits(html))
    .map((unit) => unit.replace(/\s+/g, " ").trim())
    .filter(Boolean);

async function pages(dir) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) found.push(...(await pages(child)));
    else if (entry.name.endsWith(".html")) found.push(child);
  }
  return found;
}

for (const fixture of await providerFixtures()) {
  const rendered = AUTH_PROVIDERS.filter((provider) => fixture.enabled.includes(provider.id))
    .map((provider) => provider.name)
    .sort();
  console.log(`\n===== state "${fixture.state}"  buttons rendered: [${rendered.join(", ")}] =====`);
  for (const page of await pages(fixture.dir)) {
    const html = (await readFile(page, "utf8"))
      .replace(/<([a-z]+)[^>]*data-signin-provider=[\s\S]*?<\/\1>/g, " ")
      .replace(/<[a-z]+[^>]*data-signin-provider=[^>]*\/>/g, " ");
    const name = page.pathname.split(`/${fixture.state}/`)[1];
    for (const unit of copyUnits(html)) {
      if (!SIGNIN_WORDS.test(unit)) continue;
      const named = AUTH_PROVIDERS.filter((provider) =>
        new RegExp(`\\b${provider.name}\\b`, "i").test(unit),
      ).map((provider) => provider.name);
      if (named.length === 0) continue;
      const verdict = named.sort().join(",") === rendered.join(",") ? "ok " : "RED";
      console.log(`  ${verdict} ${name}: ${unit}`);
    }
  }
}
