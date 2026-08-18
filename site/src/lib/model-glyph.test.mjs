import assert from "node:assert/strict";
import { test } from "node:test";
import { modelFamily, modelGlyphSvg } from "./model-glyph.ts";

test("modelFamily: claude and anthropic map to claude", () => {
  assert.equal(modelFamily("claude"), "claude");
  assert.equal(modelFamily("anthropic"), "claude");
});

test("modelFamily: openai, gpt, and codex map to openai", () => {
  assert.equal(modelFamily("openai"), "openai");
  assert.equal(modelFamily("gpt"), "openai");
  assert.equal(modelFamily("codex"), "openai");
});

test("modelFamily: gemini and google map to gemini", () => {
  assert.equal(modelFamily("gemini"), "gemini");
  assert.equal(modelFamily("google"), "gemini");
});

test("modelFamily: matching is case-insensitive and substring", () => {
  assert.equal(modelFamily("CLAUDE-OPUS-4"), "claude");
  assert.equal(modelFamily("Anthropic"), "claude");
  assert.equal(modelFamily("GPT-4o"), "openai");
  assert.equal(modelFamily("OpenAI"), "openai");
  assert.equal(modelFamily("Gemini-Pro"), "gemini");
  assert.equal(modelFamily("GOOGLE"), "gemini");
});

test("modelFamily: closed-default is null", () => {
  assert.equal(modelFamily("mystery-model-9000"), null);
  assert.equal(modelFamily(null), null);
  assert.equal(modelFamily(undefined), null);
  assert.equal(modelFamily(""), null);
});

test("modelGlyphSvg: each family has its distinguishing attribute", () => {
  const claude = modelGlyphSvg("claude");
  const openai = modelGlyphSvg("openai");
  const gemini = modelGlyphSvg("gemini");
  const unknown = modelGlyphSvg(null);

  assert.match(claude, /aria-hidden/);
  assert.match(openai, /aria-hidden/);
  assert.match(gemini, /aria-hidden/);
  assert.match(unknown, /aria-hidden/);

  assert.match(claude, /#D97757/);
  assert.match(openai, /evenodd/);
  assert.match(gemini, /#3186FF/);

  assert.doesNotMatch(unknown, /#D97757/);
  assert.doesNotMatch(unknown, /evenodd/);
  assert.doesNotMatch(unknown, /#3186FF/);
});
