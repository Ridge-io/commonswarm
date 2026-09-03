import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const dashboard = readFileSync(new URL("./LiveDashboard.astro", import.meta.url), "utf8");

test("feed message bodies cross the sanitizer boundary instead of writing innerHTML directly", () => {
  const start = dashboard.indexOf("const renderFeed =");
  const end = dashboard.indexOf("const syncConnectWorkspace =", start);
  assert.notEqual(start, -1, "renderFeed start anchor is missing");
  assert.notEqual(end, -1, "renderFeed end anchor is missing");
  const feed = dashboard.slice(start, end);
  assert.match(dashboard, /import \{[\s\S]*setSanitizedMessageMarkdown[\s\S]*\} from "\.\.\/\.\.\/lib\/message-markdown"/u);
  assert.match(feed, /setSanitizedMessageMarkdown\(markdown, signal\.body\)/u);
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

/** A collapsed message cannot scroll, so any text the clip leaves half-visible is unreachable.
 * The clip must be hard, and its height must come from the same line-height token the text uses. */
test("a collapsed message clips at a line boundary and fades nothing", () => {
  const anchor = ".dashboard__message-markdown--collapsed {";
  const start = dashboard.indexOf(anchor);
  assert.notEqual(start, -1, "the collapsed rule is missing");
  const end = dashboard.indexOf("}", start);
  assert.notEqual(end, -1, "the collapsed rule is unterminated");
  const rule = dashboard.slice(start + anchor.length, end);
  assert.doesNotMatch(rule, /mask-image/u);
  assert.match(rule, /max-block-size:\s*calc\(var\(--message-collapse-lines[^)]*\) \* var\(--lh-base\) \* 1em\);/u);
  assert.match(dashboard, /setProperty\(\s*"--message-collapse-lines",\s*String\(MESSAGE_COLLAPSE_LINES\),?\s*\)/u);
  assert.doesNotMatch(dashboard, /message-collapse-height/u);
});
