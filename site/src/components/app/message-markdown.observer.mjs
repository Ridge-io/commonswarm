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
