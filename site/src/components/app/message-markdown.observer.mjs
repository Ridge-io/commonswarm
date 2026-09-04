import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dashboard = readFileSync(new URL("./LiveDashboard.astro", import.meta.url), "utf8");

/* An agent report is written in Markdown with headings. The feed passed no headingOffset, so
 * headingMatch returned null and every "## Heading" rendered as literal text — reported from a
 * phone as "the markdown didn't get rendered". A message sits under the channel title, so its
 * "#" must become an h2, exactly as the Brain panel already does. */
test("a heading in a message renders as a heading, shifted below the channel title", () => {
  assert.match(
    dashboard,
    /setSanitizedMessageMarkdown\(markdown, signal\.body, \{ headingOffset: 1 \}\)/u,
  );
});

test("feed message bodies cross the sanitizer boundary instead of writing innerHTML directly", () => {
  const start = dashboard.indexOf("const renderFeed =");
  const end = dashboard.indexOf("const syncConnectWorkspace =", start);
  assert.notEqual(start, -1, "renderFeed start anchor is missing");
  assert.notEqual(end, -1, "renderFeed end anchor is missing");
  const feed = dashboard.slice(start, end);
  assert.match(dashboard, /import \{[\s\S]*setSanitizedMessageMarkdown[\s\S]*\} from "\.\.\/\.\.\/lib\/message-markdown"/u);
  assert.match(feed, /setSanitizedMessageMarkdown\(markdown, signal\.body, \{ headingOffset: 1 \}\)/u);
  assert.doesNotMatch(feed, /signal\.body[\s\S]{0,100}innerHTML|innerHTML[\s\S]{0,100}signal\.body/u);
  assert.doesNotMatch(feed, /text\.append\(signal\.body\)|textContent\s*=\s*signal\.body/u);
});

/** Reads the declaration block itself, so a later edit that puts `white-space: pre` back fails
 * here instead of shipping a sideways scrollbar to a phone. */
test("fenced blocks in a rendered message wrap instead of scrolling sideways", () => {
  const anchor = ".dashboard__message-markdown pre {";
  const start = dashboard.indexOf(anchor);
  assert.notEqual(start, -1, "the fenced-block rule is missing");
  const end = dashboard.indexOf("}", start);
  assert.notEqual(end, -1, "the fenced-block rule is unterminated");
  const rule = dashboard.slice(start + anchor.length, end);
  assert.match(rule, /white-space:\s*pre-wrap;/u);
  assert.match(rule, /overflow-wrap:\s*anywhere;/u);
  assert.doesNotMatch(rule, /white-space:\s*(pre|nowrap);/u);
});

test("long rendered bodies get one measured show-more control", () => {
  assert.match(dashboard, /MESSAGE_COLLAPSE_LINES/u);
  assert.match(dashboard, /markdown\.scrollHeight > markdown\.clientHeight \+ 1/u);
  assert.match(dashboard, /toggle\.textContent = expandedAtRender \? "Show less" : "Show more"/u);
  assert.match(dashboard, /dashboard__message-markdown--collapsed/u);
});

/** RETIRED (2026-09-04): "clips at a line boundary". A pixel max-block-size is a whole number of
 * lines for ordinary prose only — a fenced block has a smaller line height and blocks carry
 * margins, so a mixed message can be cut through a line. What IS true, and what this pins: the
 * cut is hard, at full contrast, with no gradient of any kind over the text, and its height comes
 * from the shared constant rather than a number typed here. A faded line is unreadable; a cut
 * line is readable up to the cut, and the link underneath says there is more.
 *
 * Scope, stated so it is not read as wider than it is: this reads ONE rule, the collapsed block.
 * A gradient reintroduced on a sibling ::after, on the parent, or as an inset box-shadow would
 * not be seen here. It binds the shape the fade actually had. */
test("a folded message is cut hard, never faded, at the shared height", () => {
  const anchor = ".dashboard__message-markdown--collapsed {";
  const start = dashboard.indexOf(anchor);
  assert.notEqual(start, -1, "the collapsed rule is missing");
  const end = dashboard.indexOf("}", start);
  assert.notEqual(end, -1, "the collapsed rule is unterminated");
  const rule = dashboard.slice(start + anchor.length, end);
  assert.doesNotMatch(rule, /mask-image/u);
  assert.match(rule, /max-block-size:\s*calc\(var\(--message-collapse-lines\) \* var\(--lh-base\) \* 1em\);/u);
  assert.match(rule, /overflow:\s*hidden;/u);
  /* The properties the fade actually used, and no second copy of the threshold: the CSS must
   * read the variable the script sets, with no fallback number. */
  assert.doesNotMatch(rule, /mask|gradient|opacity/u);
  assert.doesNotMatch(rule, /--message-collapse-lines,/u);
  assert.match(dashboard, /setProperty\(\s*"--message-collapse-lines",\s*String\(MESSAGE_COLLAPSE_LINES\),?\s*\)/u);
  assert.doesNotMatch(dashboard, /message-collapse-height/u);
});
