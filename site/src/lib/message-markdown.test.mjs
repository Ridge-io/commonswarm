import assert from "node:assert/strict";
import { test } from "node:test";
import {
  HARDENED_LINK_ATTRIBUTES,
  MESSAGE_COLLAPSE_LINES,
  MESSAGE_MARKDOWN_ALIGNMENTS,
  MESSAGE_MARKDOWN_ATTRIBUTES,
  MESSAGE_MARKDOWN_LIMITS,
  MESSAGE_MARKDOWN_TAGS,
  renderMessageMarkdown,
  safeMessageLink,
  sanitizeMessageHtml,
  setSanitizedMessageMarkdown,
} from "./message-markdown.ts";
import {
  MESSAGE_MARKDOWN_CLASSES,
  MESSAGE_TASK_CLASS,
  MESSAGE_TASK_MARKERS,
} from "./message-markdown.ts";
import {
  HOSTILE_INLINE_VECTORS,
  HOSTILE_MARKDOWN_BLOCKS,
  HOSTILE_TABLE_MARKDOWN,
  PRODUCTION_TABLE_MARKDOWN,
} from "./message-markdown-fixtures.ts";

/** The inner HTML the shared inline path produces for a source, with no construct around it. */
const asParagraph = (source) => renderMessageMarkdown(source).replace(/^<p>|<\/p>$/gu, "");

/** Assert a construct is not a second escaping path: identical source, identical inner bytes. */
function assertSharesTheParagraphPath(build, strip) {
  for (const vector of HOSTILE_INLINE_VECTORS) {
    const inner = renderMessageMarkdown(build(vector)).replace(strip, "");
    assert.equal(inner, asParagraph(vector), vector);
  }
}

test("without the offset a heading stays literal, which is why the feed passes it", () => {
  /* The two callers differ only in this option. The feed did not pass it, so an agent report
     full of "## Heading" arrived as raw text on a phone. */
  assert.equal(renderMessageMarkdown("## Two"), "<p>## Two</p>");
  assert.equal(renderMessageMarkdown("## Two", { headingOffset: 1 }), "<h3>Two</h3>");
  assert.equal(renderMessageMarkdown("# One", { headingOffset: 1 }), "<h2>One</h2>");
});

test("a message folds at the shared 60-line threshold", () => {
  assert.equal(MESSAGE_COLLAPSE_LINES, 60);
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
    "p", "br", "hr", "strong", "em", "del", "code", "pre", "ul", "ol", "li", "blockquote", "a",
    "h2", "h3", "h4", "h5",
    "table", "thead", "tbody", "tr", "th", "td",
  ]);
  assert.deepEqual(MESSAGE_MARKDOWN_ATTRIBUTES, {
    a: ["href"], th: ["align"], td: ["align"], li: ["class"],
  });
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

/* RETIRED (2026-09-04): "tables stay literal in v1". A pipe table now renders. What is still true,
   and what this pins, is the guard that keeps ordinary prose out of the table path: a pipe row with
   no delimiter row under it is not a table and stays the text the author typed. */
test("images stay literal, and a pipe row with no delimiter row is not a table", () => {
  const rendered = renderMessageMarkdown("# title\n![alt](https://example.com/a.png)\n| a | b |");
  assert.equal(rendered, "<p># title<br>![alt](https://example.com/a.png)<br>| a | b |</p>");
  assert.doesNotMatch(rendered, /<h\d|<img|<table/u);
  /* A delimiter row that names a different number of columns than the header is not a delimiter
     row, so a sentence that happens to contain pipes and dashes cannot become a table. */
  assert.doesNotMatch(renderMessageMarkdown("| a | b |\n|---|"), /<table/u);
  assert.doesNotMatch(renderMessageMarkdown("| a | b |\n| x | y |"), /<table/u);
  assert.doesNotMatch(renderMessageMarkdown("a - b\n- - -"), /<table/u);
});

test("the production table that rendered as raw text now renders as a table", () => {
  /* The measured bug: an agent posted this and the reader saw "| fact | result |" and "|---|---|"
     as literal lines. The inline code spans inside the cells must survive too. */
  assert.equal(
    renderMessageMarkdown(PRODUCTION_TABLE_MARKDOWN),
    "<table><thead><tr><th>fact</th><th>result</th></tr></thead>" +
      "<tbody><tr><td>REF IDENTITY</td><td><code>refs/heads/production</code> = " +
      "<code>7584524ea03162af2275c5cbfaa77df697cf68f5</code></td></tr></tbody></table>",
  );
  assert.doesNotMatch(renderMessageMarkdown(PRODUCTION_TABLE_MARKDOWN), /\|---\||\| fact \|/u);
});

test("a delimiter row carries alignment as an align attribute, never as a style", () => {
  assert.deepEqual(MESSAGE_MARKDOWN_ALIGNMENTS, ["left", "center", "right"]);
  const rendered = renderMessageMarkdown(
    "| l | r | c | plain |\n|:---|---:|:---:|---|\n| 1 | 2 | 3 | 4 |",
  );
  assert.equal(
    rendered,
    '<table><thead><tr><th align="left">l</th><th align="right">r</th>' +
      '<th align="center">c</th><th>plain</th></tr></thead>' +
      '<tbody><tr><td align="left">1</td><td align="right">2</td>' +
      '<td align="center">3</td><td>4</td></tr></tbody></table>',
  );
  assert.doesNotMatch(rendered, /style=|class=/u);
});

/* The rule, stated where it can fail: a SHORT row is padded with empty cells to the header width;
   a LONG row keeps every extra cell as an extra cell past the last named column. Neither shape
   throws and neither loses a character. GFM drops the extras; this renderer does not, because a
   silently deleted value in a table of facts is the worst outcome available. */
test("a ragged row is padded when short and keeps its extra cells when long", () => {
  const rendered = renderMessageMarkdown(
    "| a | b | c |\n|---|---|---|\n| 1 |\n| 1 | 2 | 3 | keeps me |\n|  |  |  |",
  );
  assert.match(rendered, /<tr><td>1<\/td><td><\/td><td><\/td><\/tr>/u);
  assert.match(
    rendered,
    /<tr><td>1<\/td><td>2<\/td><td>3<\/td><td>keeps me<\/td><\/tr>/u,
  );
  assert.match(rendered, /keeps me/u);
  assert.equal((rendered.match(/<tr>/gu) ?? []).length, 4);
});

test("a table is a block: it ends a paragraph, sits in a quote, and ends at a blank line", () => {
  const rendered = renderMessageMarkdown(
    "intro line\n| a |\n|---|\n| 1 |\nafter\n\n> | q |\n> |---|\n> | v |",
  );
  assert.match(rendered, /^<p>intro line<\/p><table>/u);
  assert.match(rendered, /<\/table><p>after<\/p>/u);
  assert.match(rendered, /<blockquote><table><thead><tr><th>q<\/th>/u);
});

test("an escaped pipe stays inside its cell instead of splitting the column", () => {
  const rendered = renderMessageMarkdown("| a | b |\n|---|---|\n| x \\| y | z |");
  assert.match(rendered, /<tr><td>x \| y<\/td><td>z<\/td><\/tr>/u);
});

test("hostile cell content is neutralised exactly as the same text is in a paragraph", () => {
  const rendered = renderMessageMarkdown(HOSTILE_TABLE_MARKDOWN);
  assert.match(rendered, /<table>/u);
  /* Every vector, inert. */
  assert.match(rendered, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/u);
  assert.match(rendered, /&lt;b onerror=&quot;alert\(2\)&quot;&gt;x&lt;\/b&gt;/u);
  assert.match(rendered, /\[go\]\(javascript:alert\(3\)/u);
  assert.match(rendered, /&lt;img src=x onerror=alert\(4\)&gt;/u);
  assert.match(rendered, /&lt;td align=&quot;center&quot; onclick=&quot;alert\(5\)&quot;&gt;/u);
  assert.match(rendered, /&lt;\/table&gt;&lt;script&gt;alert\(6\)&lt;\/script&gt;/u);
  assert.match(rendered, /&lt;a href=&quot;javascript:alert\(7\)&quot;&gt;/u);
  assert.doesNotMatch(rendered, /<script|<img|<b |<a /u);
  /* `onerror=` survives as literal text inside `&lt;b onerror=&quot;...`, which is the point — it
     is content, not markup. So the control reads the TAGS, not the whole string: every generated
     tag must be one this renderer emits, and no tag may carry a handler, an href, or a style. */
  const tags = rendered.match(/<[^>]*>/gu) ?? [];
  assert.ok(tags.length > 0, "no tags to check");
  for (const tag of tags) {
    assert.match(tag, /^<\/?(?:table|thead|tbody|tr|th|td|p|br|code|strong|em)(?:\s|>)/u, tag);
    assert.doesNotMatch(tag, /\son[a-z]+\s*=|\shref\s*=|\sstyle\s*=|\sclass\s*=/iu, tag);
  }
  /* The point of the whole design: a cell is not a second escaping path. The same source text
     rendered as a paragraph and as a cell produces byte-identical inner HTML. */
  for (const vector of HOSTILE_INLINE_VECTORS) {
    const asCell = renderMessageMarkdown(`| h |\n|---|\n| ${vector} |`)
      .replace(/^.*<tbody><tr><td>|<\/td><\/tr><\/tbody><\/table>$/gu, "");
    assert.equal(asCell, asParagraph(vector), vector);
  }
});

test("the sanitizer keeps table tags and only the three align values", () => {
  assert.equal(
    sanitizeMessageHtml(
      '<table class="x"><thead onclick="x"><tr><th align="center">a</th>' +
        '<th align="expression(alert(1))">b</th><th align="CENTER">c</th>' +
        '<th style="color:red">d</th><th align="center" onmouseover="x">e</th>' +
        "</tr></thead><tbody><tr><td>1</td></tr></tbody></table>",
    ),
    '<table><thead><tr><th align="center">a</th><th>b</th><th align="center">c</th>' +
      '<th>d</th><th align="center">e</th></tr></thead>' +
      "<tbody><tr><td>1</td></tr></tbody></table>",
  );
  /* A tag the renderer never emits is still not allowed through. */
  assert.equal(sanitizeMessageHtml("<caption>x</caption><colgroup><col></colgroup>"), "x");
});

test("a table cannot spend more than the shared cell budget", { timeout: 5_000 }, () => {
  const rows = Math.ceil(MESSAGE_MARKDOWN_LIMITS.tableCells / 2);
  const body = (count) => `| a | b |\n|---|---|\n${"| 1 | 2 |\n".repeat(count)}`;
  /* Positive control on the same shape: one row under the budget still renders as a table. */
  const affordable = renderMessageMarkdown(body(rows - 2));
  assert.match(affordable, /<table>/u);
  const overBudget = renderMessageMarkdown(body(rows + 1));
  assert.doesNotMatch(overBudget, /<table>|<td>/u);
  /* Bounded, and not by dropping the author's text: it is still there, literally. */
  assert.match(overBudget, /\| 1 \| 2 \|/u);
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

/* ---- constructs an ordinary agent message uses that used to degrade to plain text ---- */

test("~~text~~ renders as del, and del is not a second escaping path", () => {
  assert.equal(renderMessageMarkdown("~~gone~~ stays"), "<p><del>gone</del> stays</p>");
  /* A lone run of tildes is not a delimiter pair and stays the text the author typed. */
  assert.equal(renderMessageMarkdown("~~~"), "<p>~~~</p>");
  assert.equal(renderMessageMarkdown("a ~ b"), "<p>a ~ b</p>");
  assertSharesTheParagraphPath(
    (vector) => `~~${vector}~~`,
    /^<p><del>|<\/del><\/p>$/gu,
  );
});

/* The ordering hazard, pinned: `---` is the thematic break AND the table delimiter row AND the
   marker `- - -` that the list rule used to eat. THEMATIC_BREAK excludes `|`, and a GFM delimiter
   row cannot exist without one, so the break check can run before the table check. This test fails
   if either half of that stops being true. */
test("--- is a rule, and a table delimiter row is never eaten as one", () => {
  for (const source of ["---", "***", "___", "- - -", "*  *  *", "-----"]) {
    assert.equal(renderMessageMarkdown(source), "<hr>", source);
  }
  /* Two markers is not a rule, and a mixed run is not a rule. */
  assert.equal(renderMessageMarkdown("--"), "<p>--</p>");
  assert.equal(renderMessageMarkdown("-*-"), "<p>-*-</p>");
  /* Positive control on the same invocation: the table still renders, so a green "no <hr>" below
     is evidence about the delimiter row rather than about a table that never formed. */
  const table = renderMessageMarkdown("| a | b |\n|---|---|\n| 1 | 2 |");
  assert.match(table, /<table><thead><tr><th>a<\/th><th>b<\/th><\/tr><\/thead>/u);
  assert.doesNotMatch(table, /<hr>/u);
  /* And a delimiter row alone, with no header above it, is still not a rule. */
  assert.equal(renderMessageMarkdown("|---|---|"), "<p>|---|---|</p>");
  /* A rule is a block: it ends the paragraph above it and sits inside a quote. */
  assert.equal(renderMessageMarkdown("text\n---\nmore"), "<p>text</p><hr><p>more</p>");
  assert.equal(renderMessageMarkdown("> a\n>\n> ---"), "<blockquote><p>a</p><hr></blockquote>");
});

test("a task item is an enum-checked class and a ballot marker, never an input", () => {
  assert.deepEqual(MESSAGE_MARKDOWN_CLASSES, [MESSAGE_TASK_CLASS]);
  const rendered = renderMessageMarkdown("- [ ] open\n- [x] done\n- [X] also done\n- plain");
  assert.equal(
    rendered,
    `<ul><li class="${MESSAGE_TASK_CLASS}">${MESSAGE_TASK_MARKERS.unchecked} open</li>` +
      `<li class="${MESSAGE_TASK_CLASS}">${MESSAGE_TASK_MARKERS.checked} done</li>` +
      `<li class="${MESSAGE_TASK_CLASS}">${MESSAGE_TASK_MARKERS.checked} also done</li>` +
      "<li>plain</li></ul>",
  );
  assert.doesNotMatch(rendered, /<input|checkbox|disabled|checked=/u);
  /* A bracketed link label at the head of an item is not a task box. */
  assert.equal(
    renderMessageMarkdown("- [click](javascript:alert(1))"),
    "<ul><li>[click](javascript:alert(1))</li></ul>",
  );
  assertSharesTheParagraphPath(
    (vector) => `- [ ] ${vector}`,
    new RegExp(
      `^<ul><li class="${MESSAGE_TASK_CLASS}">${MESSAGE_TASK_MARKERS.unchecked} |</li></ul>$`,
      "gu",
    ),
  );
});

test("an indented list item nests instead of flattening, and the nesting stays bounded", () => {
  /* Measured before this lane: "- one\n  - one a" produced one flat <ul> with both items, so a
     two-level plan read as a single list of unrelated points. */
  assert.equal(
    renderMessageMarkdown("- one\n  - one a\n  - one b\n- two"),
    "<ul><li>one<ul><li>one a</li><li>one b</li></ul></li><li>two</li></ul>",
  );
  /* A sublist may change kind; the outer list keeps its own. */
  assert.equal(
    renderMessageMarkdown("1. a\n   - b\n2. c"),
    "<ol><li>a<ul><li>b</li></ul></li><li>c</li></ol>",
  );
  /* A change of kind at the SAME indent still ends the list, as it did before. */
  assert.equal(
    renderMessageMarkdown("- a\n1. b"),
    "<ul><li>a</li></ul><ol><li>b</li></ol>",
  );
  /* An indent ladder cannot recurse past the shared bound: past it the deeper items join the
     deepest list rather than opening another one, and nothing is lost. */
  const ladder = Array.from({ length: 10 }, (_, level) => `${"  ".repeat(level)}- level${level}`);
  const deep = renderMessageMarkdown(ladder.join("\n"));
  assert.equal((deep.match(/<ul>/gu) ?? []).length, MESSAGE_MARKDOWN_LIMITS.nestingDepth);
  for (let level = 0; level < 10; level += 1) assert.match(deep, new RegExp(`level${level}<`, "u"));
  assertSharesTheParagraphPath(
    (vector) => `- top\n  - ${vector}`,
    /^<ul><li>top<ul><li>|<\/li><\/ul><\/li><\/ul>$/gu,
  );
});

test("a bare URL becomes a link through the same guard a written link uses", () => {
  assert.equal(
    renderMessageMarkdown("see https://example.com/x now."),
    '<p>see <a href="https://example.com/x">https://example.com/x</a> now.</p>',
  );
  /* Sentence punctuation and a wrapping bracket belong to the sentence, not the destination. */
  assert.equal(
    renderMessageMarkdown("(https://example.com/x)"),
    '<p>(<a href="https://example.com/x">https://example.com/x</a>)</p>',
  );
  /* A query separator is inside the URL; an escaped quote is around it. */
  assert.match(
    renderMessageMarkdown("https://example.com/x?a=1&b=2"),
    /<a href="https:\/\/example\.com\/x\?a=1&amp;b=2">https:\/\/example\.com\/x\?a=1&amp;b=2<\/a>/u,
  );
  assert.equal(
    renderMessageMarkdown('"https://example.com/x"'),
    '<p>&quot;<a href="https://example.com/x">https://example.com/x</a>&quot;</p>',
  );
  /* Underscores in a path used to become <em>. The stash now protects them. */
  assert.equal(
    renderMessageMarkdown("https://example.com/a_b_c_d"),
    '<p><a href="https://example.com/a_b_c_d">https://example.com/a_b_c_d</a></p>',
  );
  /* No second scheme guard: everything safeMessageLink rejects stays literal text. */
  for (const source of [
    "javascript:alert(1)", "vbscript:msgbox(1)", "file:///etc/passwd",
    "data:text/html,<script>alert(1)</script>", "//example.com/path",
    "https://trusted.example@evil.host/", "https://example.com/%0Aredirect",
  ]) {
    assert.doesNotMatch(renderMessageMarkdown(`go ${source} now`), /<a\b|href=/u, source);
  }
  /* A written link is not linked twice, and an image's destination is not linked at all. */
  const written = renderMessageMarkdown("[docs](https://example.com/x)");
  assert.equal((written.match(/<a /gu) ?? []).length, 1);
  assert.equal(
    renderMessageMarkdown("![alt](https://example.com/a.png)"),
    "<p>![alt](https://example.com/a.png)</p>",
  );
  /* Raw HTML around a URL stays literal. The URL inside it links, which is the same outcome as
     writing the URL on its own — no tag, no attribute, nothing new reachable. */
  const raw = renderMessageMarkdown('<img src="https://evil.example/t.png">');
  assert.doesNotMatch(raw, /<img/u);
  assert.match(raw, /&lt;img src=&quot;<a href="https:\/\/evil\.example\/t\.png">/u);
});

test("the sanitizer allows del and hr, and only the one class this renderer emits", () => {
  assert.equal(
    sanitizeMessageHtml(
      '<del onclick="x">gone</del><hr onerror="x"></hr>' +
        `<li class="${MESSAGE_TASK_CLASS}">a</li><li class="dashboard__app">b</li>` +
        '<li class="md-task evil">c</li><li class="">d</li><li style="x">e</li>',
    ),
    `<del>gone</del><hr><li class="${MESSAGE_TASK_CLASS}">a</li><li>b</li>` +
      "<li>c</li><li>d</li><li>e</li>",
  );
});

test("unclosed fences, a 10k line, and deep nesting stay bounded and do not crash", { timeout: 1_000 }, () => {
  assert.equal(renderMessageMarkdown("```\nunclosed"), "<pre><code>unclosed</code></pre>");
  const longLine = "x".repeat(10_000);
  assert.equal(renderMessageMarkdown(longLine), `<p>${longLine}</p>`);
  const nested = renderMessageMarkdown(`${"> ".repeat(12_000)}bottom`);
  assert.equal((nested.match(/<blockquote>/gu) ?? []).length, MESSAGE_MARKDOWN_LIMITS.nestingDepth);
  /* 24,000 characters is a normal-sized brain topic, not something to shorten. The marker belongs
     to input no product path can store, so the control is built FROM the limit. */
  assert.doesNotMatch(nested, /Message shortened for safe display/u);
  const overLimit = renderMessageMarkdown("x".repeat(MESSAGE_MARKDOWN_LIMITS.inputCharacters + 1));
  assert.match(overLimit, /Message shortened for safe display/u);
  const overLines = renderMessageMarkdown("a\n".repeat(MESSAGE_MARKDOWN_LIMITS.lines + 1));
  assert.match(overLines, /Message shortened for safe display/u);
});
