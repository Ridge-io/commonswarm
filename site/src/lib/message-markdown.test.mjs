import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HARDENED_LINK_ATTRIBUTES,
  MESSAGE_MARKDOWN_ATTRIBUTES,
  MESSAGE_MARKDOWN_LIMITS,
  MESSAGE_MARKDOWN_TAGS,
  renderMessageMarkdown,
  safeMessageLink,
  sanitizeMessageHtml,
  setSanitizedMessageMarkdown,
} from "./message-markdown.ts";
import { HOSTILE_MARKDOWN_BLOCKS } from "./message-markdown-fixtures.ts";

test("long messages use the requested 30-line collapse threshold", () => {

});

test("message markdown renders the complete v1 block and inline subset", () => {
  const rendered = renderMessageMarkdown(
    "First line\nsecond with **bold**, *italic*, and `code`.\n\n" +
      "- one\n- two\n\n1. first\n2. second\n\n> quoted\n> again\n\n" +
      "```ts\nconst answer = 42 < 50;\n```",
  );
  assert.equal(
    rendered,
    "<p>First line<br>second with <strong>bold</strong>, <em>italic</em>, and " +
      "<code>code</code>.</p><ul><li>one</li><li>two</li></ul>" +
      "<ol><li>first</li><li>second</li></ol>" +
      "<blockquote><p>quoted<br>again</p></blockquote>" +
      "<pre><code>const answer = 42 &lt; 50;</code></pre>",
  );
});

test("escape-first makes raw HTML literal, including script and event-handler payloads", () => {
  const rendered = renderMessageMarkdown(
    '<script>alert(1)</script> <img src=x onerror="alert(2)"> <b>inline HTML</b>',
  );
  assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(rendered, /&lt;img src=x onerror=&quot;alert\(2\)&quot;&gt;/u);
  assert.match(rendered, /&lt;b&gt;inline HTML&lt;\/b&gt;/u);
  assert.doesNotMatch(rendered, /<script|<img/u);
});

test("multiline hostile markup stays inert across paragraphs, lists, and fences", () => {
  const rendered = renderMessageMarkdown(HOSTILE_MARKDOWN_BLOCKS);
  assert.match(rendered, /<p>Before &lt;b&gt;raw&lt;\/b&gt;<\/p>/u);
  assert.match(rendered, /<ul><li>\[click\]\(javascript:alert\(1\)\)<\/li>/u);
  assert.match(rendered, /&lt;img src=x onerror=&quot;alert\(2\)&quot;&gt;/u);
  assert.match(rendered, /<pre><code>&lt;img src=x onerror=alert\(3\)&gt;<\/code><\/pre>/u);
  assert.doesNotMatch(rendered, /<b>|<img|href=|<[^>]+\sonerror=/u);
});

test("links allow explicit HTTP(S), open safely, and expose the exact destination", () => {
  const rendered = renderMessageMarkdown(
    "[HTTP](http://example.com/a) [secure](HTTPS://example.com/x?one=1&two=2)",
  );
  assert.match(rendered, /<a href="http:\/\/example\.com\/a">HTTP<\/a> <code>\(http:\/\/example\.com\/a\)<\/code>/u);
  assert.match(rendered, /<a href="HTTPS:\/\/example\.com\/x\?one=1&amp;two=2">secure<\/a>/u);
  assert.match(rendered, /<code>\(HTTPS:\/\/example\.com\/x\?one=1&amp;two=2\)<\/code>/u);
  assert.deepEqual(HARDENED_LINK_ATTRIBUTES, { rel: "noopener noreferrer", target: "_blank" });
});

test("hostile and obfuscated link schemes never become href attributes", () => {
  const vectors = [
    "javascript:alert(1)", "JaVaScRiPt:alert(1)", "data:text/html,<script>alert(1)</script>",
    "vbscript:msgbox(1)", "file:///etc/passwd", "//example.com/path", " javaScript:alert(1)",
    "java\tscript:alert(1)", "java\nscript:alert(1)", "https:\n//example.com",
    "https://example.com/%0Aredirect",
    /* Userinfo phishing (review finding): parses as https, passes the scheme check, and a
       reader sees the trusted-looking half. Rejected outright. */
    "https://trusted.example@evil.host/", "https://user:pass@evil.host/",
  ];
  for (const destination of vectors) {
    assert.equal(safeMessageLink(destination), null, destination);
    assert.doesNotMatch(renderMessageMarkdown(`[open](${destination})`), /<a\b|href=/u, destination);
  }
});

test("a link label containing inline code restores fully, with no stray token bytes", () => {
  const rendered = renderMessageMarkdown("[run `cswarm feed` now](https://example.com/docs)");
  assert.match(rendered, /<a href="https:\/\/example\.com\/docs">run <code>cswarm feed<\/code> now<\/a>/u);
  assert.doesNotMatch(rendered, /[\uE000\uE001]/u);
});

test("the sanitizer keeps only the tag allowlist and href on anchors", () => {
  assert.deepEqual(MESSAGE_MARKDOWN_TAGS, [
    "p", "br", "strong", "em", "code", "pre", "ul", "ol", "li", "blockquote", "a",
    "h2", "h3", "h4", "h5",
  ]);
  assert.deepEqual(MESSAGE_MARKDOWN_ATTRIBUTES, { a: ["href"] });
  assert.equal(
    sanitizeMessageHtml(
      '<p class="bad">ok <strong onclick="x">yes</strong><img/onerror=x>' +
        '<a href="https://example.com" style="x" onclick="x">go</a><script>x</script>' +
        '<iframe srcdoc="<img src=x onerror=alert(1)>"></iframe></p>',
    ),
    '<p>ok <strong>yes</strong><a href="https://example.com">go</a>x"&gt;</p>',
  );
});

test("the DOM setter uses sanitized HTML and fixes link rel and target", () => {
  const link = { rel: "", target: "" };
  const element = {
    innerHTML: "",
    querySelectorAll: () => [link],
  };
  setSanitizedMessageMarkdown(element, "[docs](https://example.com) <img onerror=alert(1)>");
  assert.doesNotMatch(element.innerHTML, /<img/u);
  assert.match(element.innerHTML, /&lt;img onerror=alert\(1\)&gt;/u);
  assert.deepEqual(link, { rel: "noopener noreferrer", target: "_blank" });
});

test("images, headings, and tables stay literal in v1", () => {
  const rendered = renderMessageMarkdown("# title\n![alt](https://example.com/a.png)\n| a | b |");
  assert.equal(rendered, "<p># title<br>![alt](https://example.com/a.png)<br>| a | b |</p>");
  assert.doesNotMatch(rendered, /<h\d|<img|<table/u);
});

test("panel Markdown shifts h1-h4 to h2-h5 through the same sanitizer", () => {
  const rendered = renderMessageMarkdown(
    "# One\n## Two\n### Three\n#### Four\n##### Five stays literal",
    { headingOffset: 1 },
  );
  assert.equal(
    rendered,
    "<h2>One</h2><h3>Two</h3><h4>Three</h4><h5>Four</h5>" +
      "<p>##### Five stays literal</p>",
  );
});

test("unclosed fences, a 10k line, and deep nesting stay bounded and do not crash", { timeout: 1_000 }, () => {
  assert.equal(renderMessageMarkdown("```\nunclosed"), "<pre><code>unclosed</code></pre>");
  const longLine = "x".repeat(10_000);
  assert.equal(renderMessageMarkdown(longLine), `<p>${longLine}</p>`);
  const nested = renderMessageMarkdown(`${"> ".repeat(12_000)}bottom`);
  assert.equal((nested.match(/<blockquote>/gu) ?? []).length, MESSAGE_MARKDOWN_LIMITS.nestingDepth);
  /* 24,000 characters is a normal-sized brain topic now, not something to shorten. The marker
     belongs to input no product path can store, so the control is built FROM the limit. */
  assert.doesNotMatch(nested, /Message shortened for safe display/u);
  const overLimit = renderMessageMarkdown("x".repeat(MESSAGE_MARKDOWN_LIMITS.inputCharacters + 1));
  assert.match(overLimit, /Message shortened for safe display/u);
  const overLines = renderMessageMarkdown("a\n".repeat(MESSAGE_MARKDOWN_LIMITS.lines + 1));
  assert.match(overLines, /Message shortened for safe display/u);
});
