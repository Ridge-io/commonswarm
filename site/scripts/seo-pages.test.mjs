import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

const ROOT = path.resolve(import.meta.dirname, "..");

const PAGES = [
  {
    route: "/guides/claude-code-subagents",
    title: "Claude Code Subagents: A Practical Guide",
    description:
      "Learn how Claude Code subagents work, when to use worktrees or agent teams, and how to coordinate multiple agents without file collisions.",
    schema: "Article",
  },
  {
    route: "/orchestration",
    title: "AI Agent Orchestration: A Practical Guide",
    description:
      "Learn what AI agent orchestration does, when you need it, and how frameworks, workflow tools, and shared coordination workspaces differ.",
    schema: "Article",
  },
  {
    route: "/alternatives/langgraph",
    title: "LangGraph Alternatives: 6 Practical Options",
    description:
      "Compare six LangGraph alternatives by control model, language, model support, run mode, and licence, plus a clear LangGraph vs LangChain guide.",
    schema: "ItemList",
  },
  {
    route: "/alternatives/crewai",
    title: "CrewAI Alternatives: 6 Practical Options",
    description:
      "Compare six CrewAI alternatives by control model, language, model support, run mode, and licence, with concise CrewAI vs LangGraph and AutoGen guides.",
    schema: "ItemList",
  },
];

function builtHtml(route) {
  return fs.readFileSync(path.join(ROOT, "dist", route, "index.html"), "utf8");
}

function attribute(html, selector) {
  const match = html.match(selector);
  assert.ok(match, `missing metadata matching ${selector}`);
  return match[1];
}

test("SEO pages emit exact metadata, canonicals, OpenGraph, and structured data", () => {
  for (const page of PAGES) {
    const html = builtHtml(page.route);
    const canonical = `https://commonswarm.com${page.route}`;

    assert.equal(attribute(html, /<title>([^<]+)<\/title>/), page.title);
    assert.ok(page.title.length <= 60, `${page.route} title is too long`);
    assert.equal(attribute(html, /<meta name="description" content="([^"]+)"/), page.description);
    assert.ok(page.description.length <= 155, `${page.route} description is too long`);
    assert.equal(attribute(html, /<link rel="canonical" href="([^"]+)"/), canonical);
    assert.equal(attribute(html, /<meta property="og:title" content="([^"]+)"/), page.title);
    assert.equal(attribute(html, /<meta property="og:description" content="([^"]+)"/), page.description);
    assert.equal(attribute(html, /<meta property="og:url" content="([^"]+)"/), canonical);

    const json = JSON.parse(
      attribute(html, /<script type="application\/ld\+json">([^<]+)<\/script>/),
    );
    assert.equal(json["@type"], page.schema);
    assert.notEqual(json["@type"], "FAQPage");
    if (page.schema === "ItemList") {
      assert.equal(json.numberOfItems, 6);
      assert.equal(json.itemListElement.length, 6);
    }
  }
});

test("every SEO page keeps the category boundary and links the full cluster", () => {
  const boundary = "It does not run agents, schedule them, or define their control flow";
  const routes = PAGES.map((page) => page.route);

  for (const page of PAGES) {
    const html = builtHtml(page.route);
    const article = attribute(html, /(<article class="seo-page">[\s\S]+<\/article>)/);

    assert.match(article, new RegExp(boundary));
    assert.match(article, /https:\/\/github\.com\/Ridge-io\/commonswarm/);
    assert.match(article, /<code>cswarm<\/code>/);
    assert.match(article, /joins by pasting one generated prompt/);
    assert.match(article, /Free for 10 workspaces, no card/);
    assert.doesNotMatch(article, /—|&mdash;|&#8212;/);
    assert.equal((article.match(/<h1/g) ?? []).length, 1);
    assert.match(html, /<nav class="ft__col" aria-label="Guides"[^>]*>/);
    assert.match(article, /href="\/"/);

    for (const route of routes) {
      if (route !== page.route) assert.match(article, new RegExp(`href="${route}"`));
    }
  }
});

test("the generated sitemap includes every SEO route", () => {
  const index = fs.readFileSync(path.join(ROOT, "dist", "sitemap-index.xml"), "utf8");
  const sitemap = fs.readFileSync(path.join(ROOT, "dist", "sitemap-0.xml"), "utf8");

  assert.match(index, /https:\/\/commonswarm\.com\/sitemap-0\.xml/);
  for (const page of PAGES) {
    assert.match(sitemap, new RegExp(`https://commonswarm\\.com${page.route}/`));
  }
});
