/*
 * Message bodies cross a workspace trust boundary. Keep this renderer small enough to audit:
 * escape the complete input first, add only the supported markdown subset, then allowlist the
 * generated HTML before it reaches innerHTML. A full markdown engine would add HTML, URL, and
 * extension surfaces that this feed neither needs nor wants.
 */

/* These are a guard against pathological input, NOT a display trim. Operator direction
 * 2026-09-04: nothing a workspace can legitimately hold may be shortened for display. A signal
 * body is capped at 8,000 characters upstream and a brain topic is a whole document, so both sit
 * far inside these numbers; the marker below can only appear for input no product path creates. */
export const MESSAGE_MARKDOWN_LIMITS = Object.freeze({
  inputCharacters: 2_000_000,
  lines: 50_000,
  nestingDepth: 4,
});

export const MESSAGE_MARKDOWN_TAGS = Object.freeze([
  "p", "br", "strong", "em", "code", "pre", "ul", "ol", "li", "blockquote", "a",
  "h2", "h3", "h4", "h5",
] as const);

export const MESSAGE_MARKDOWN_ATTRIBUTES = Object.freeze({ a: ["href"] as const });
export const HARDENED_LINK_ATTRIBUTES = Object.freeze({
  rel: "noopener noreferrer",
  target: "_blank",
});

const ALLOWED_TAGS = new Set<string>(MESSAGE_MARKDOWN_TAGS);
const TOKEN_OPEN = "\uE000";
const TOKEN_CLOSE = "\uE001";

export interface MessageMarkdownOptions {
  /** Shift h1-h4 down one level when Markdown lives below an existing panel heading. */
  headingOffset?: 1;
}

/** Escape untrusted input before any markdown rule can inspect or transform it. */
export function escapeMessageHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function decodeEscapedAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&#39;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

/** Accept only explicit HTTP(S) destinations with no hidden whitespace or control bytes. */
export function safeMessageLink(value: string): string | null {
  if (/\s|[\u0000-\u001f\u007f-\u009f]/u.test(value)) return null;
  if (/%(?:0[0-9a-f]|1[0-9a-f]|7f)/iu.test(value)) return null;
  if (!/^https?:\/\//iu.test(value)) return null;
  try {
    const parsed = new URL(value);
    if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
    /* Reject userinfo. https://trusted.example@evil.host parses fine, passes the scheme
     * check, and reads as the wrong destination to a human - the classic phishing shape.
     * Nothing legitimate in a chat message needs credentials embedded in a URL. */
    if (parsed.username !== "" || parsed.password !== "") return null;
    return value;
  } catch {
    return null;
  }
}

function boundedLines(rawText: string): string[] {
  const normalized = rawText
    .replaceAll(TOKEN_OPEN, "�")
    .replaceAll(TOKEN_CLOSE, "�")
    .replace(/\r\n?/gu, "\n");
  const shortened = normalized.length > MESSAGE_MARKDOWN_LIMITS.inputCharacters;
  const characterBounded = shortened
    ? normalized.slice(0, MESSAGE_MARKDOWN_LIMITS.inputCharacters)
    : normalized;
  const split = characterBounded.split("\n");
  const lineBounded = split.slice(0, MESSAGE_MARKDOWN_LIMITS.lines);
  if (shortened || split.length > MESSAGE_MARKDOWN_LIMITS.lines) {
    /* Only reachable for input no product path can store. It says what happened rather than
     * ending mid-sentence, because a silent cut reads as the author stopping there. */
    lineBounded.push("", "[Message shortened for safe display.]");
  }
  return escapeMessageHtml(lineBounded.join("\n")).split("\n");
}

function stashToken(tokens: string[], html: string): string {
  const index = tokens.push(html) - 1;
  return `${TOKEN_OPEN}${index}${TOKEN_CLOSE}`;
}

function restoreTokens(value: string, tokens: string[]): string {
  /* Tokens can nest: a link label containing inline code stashes the <code> first, then the
   * whole <a> - which still holds the inner placeholder - is stashed again. One pass left
   * private-use characters in the rendered label (found in review). Iterate until stable,
   * bounded by the token count so a cycle cannot spin. */
  let restored = value;
  for (let pass = 0; pass <= tokens.length; pass += 1) {
    const next = restored.replace(
      /\uE000(\d+)\uE001/gu,
      (_, index: string) => tokens[Number(index)] ?? "",
    );
    if (next === restored) break;
    restored = next;
  }
  return restored;
}

function renderEmphasis(value: string): string {
  return value
    .replace(/\*\*([^*\n]+)\*\*/gu, "<strong>$1</strong>")
    .replace(/__([^_\n]+)__/gu, "<strong>$1</strong>")
    .replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/gu, "$1<em>$2</em>")
    .replace(/(^|[^\p{L}\p{N}_])_([^_\n]+)_(?![\p{L}\p{N}_])/gu, "$1<em>$2</em>");
}

function renderInline(value: string): string {
  const tokens: string[] = [];
  let rendered = value.replace(/`([^`\n]+)`/gu, (_, code: string) =>
    stashToken(tokens, `<code>${code}</code>`)
  );

  /* Images are outside v1. Stash the full source so its link-shaped tail cannot become a link. */
  rendered = rendered.replace(/!\[([^\]\n]*)\]\(([^)\n]*)\)/gu, (source: string) =>
    stashToken(tokens, source)
  );

  rendered = rendered.replace(
    /\[([^\]\n]{1,1000})\]\(([^)\n]{1,2048})\)/gu,
    (source: string, label: string, escapedDestination: string) => {
      const destination = decodeEscapedAttribute(escapedDestination);
      const safe = safeMessageLink(destination);
      if (!safe) return stashToken(tokens, source);
      return stashToken(
        tokens,
        `<a href="${escapeMessageHtml(safe)}">${renderEmphasis(label)}</a> ` +
          `<code>(${escapeMessageHtml(destination)})</code>`,
      );
    },
  );

  return restoreTokens(renderEmphasis(rendered), tokens);
}

function isFence(line: string): boolean {
  return /^ {0,3}```/u.test(line);
}

function isQuote(line: string): boolean {
  return /^ {0,3}&gt;(?: |$)/u.test(line);
}

function listMatch(line: string): { kind: "ul" | "ol"; content: string } | null {
  const unordered = /^ {0,12}[-+*] +(.*)$/u.exec(line);
  if (unordered) return { kind: "ul", content: unordered[1] ?? "" };
  const ordered = /^ {0,12}\d{1,6}[.)] +(.*)$/u.exec(line);
  if (ordered) return { kind: "ol", content: ordered[1] ?? "" };
  return null;
}

function headingMatch(
  line: string,
  options: MessageMarkdownOptions,
): { level: 2 | 3 | 4 | 5; content: string } | null {
  if (options.headingOffset !== 1) return null;
  const heading = /^ {0,3}(#{1,4})[ \t]+(.+?)[ \t]*#*[ \t]*$/u.exec(line);
  if (!heading) return null;
  return {
    level: (heading[1]!.length + options.headingOffset) as 2 | 3 | 4 | 5,
    content: heading[2] ?? "",
  };
}

function renderBlocks(
  lines: string[],
  depth = 0,
  options: MessageMarkdownOptions = {},
): string {
  const blocks: string[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (line.trim() === "") {
      index += 1;
      continue;
    }

    if (isFence(line)) {
      index += 1;
      const code: string[] = [];
      while (index < lines.length && !isFence(lines[index] ?? "")) {
        code.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      blocks.push(`<pre><code>${code.join("\n")}</code></pre>`);
      continue;
    }

    if (depth < MESSAGE_MARKDOWN_LIMITS.nestingDepth && isQuote(line)) {
      const quote: string[] = [];
      while (index < lines.length && isQuote(lines[index] ?? "")) {
        quote.push((lines[index] ?? "").replace(/^ {0,3}&gt; ?/u, ""));
        index += 1;
      }
      blocks.push(`<blockquote>${renderBlocks(quote, depth + 1, options)}</blockquote>`);
      continue;
    }

    const heading = headingMatch(line, options);
    if (heading) {
      blocks.push(`<h${heading.level}>${renderInline(heading.content)}</h${heading.level}>`);
      index += 1;
      continue;
    }

    const firstListItem = listMatch(line);
    if (firstListItem) {
      const items: string[] = [];
      const kind = firstListItem.kind;
      while (index < lines.length) {
        const item = listMatch(lines[index] ?? "");
        if (!item || item.kind !== kind) break;
        items.push(`<li>${renderInline(item.content)}</li>`);
        index += 1;
      }
      blocks.push(`<${kind}>${items.join("")}</${kind}>`);
      continue;
    }

    const paragraph: string[] = [];
    while (index < lines.length) {
      const candidate = lines[index] ?? "";
      if (candidate.trim() === "") break;
      if (
        paragraph.length > 0 &&
        (isFence(candidate) || headingMatch(candidate, options) || listMatch(candidate))
      ) break;
      if (paragraph.length > 0 && depth < MESSAGE_MARKDOWN_LIMITS.nestingDepth && isQuote(candidate)) break;
      paragraph.push(renderInline(candidate));
      index += 1;
    }
    blocks.push(`<p>${paragraph.join("<br>")}</p>`);
  }
  return blocks.join("");
}

function sanitizeTag(source: string): string {
  const tag = /^<\/?([a-z][a-z0-9]*)\b[^<>]*>$/iu.exec(source);
  if (!tag) return "";
  const rawName = tag[1] ?? "";
  const name = rawName.toLowerCase();
  if (!ALLOWED_TAGS.has(name)) return "";
  const closing = /^<\//u.test(source);
  if (closing) return name === "br" ? "" : `</${name}>`;
  if (name === "br") return "<br>";
  if (name !== "a") return `<${name}>`;
  const hrefMatch = /\shref\s*=\s*"([^"]*)"/iu.exec(source);
  if (!hrefMatch) return "";
  const destination = safeMessageLink(decodeEscapedAttribute(hrefMatch[1] ?? ""));
  return destination === null ? "" : `<a href="${escapeMessageHtml(destination)}">`;
}

/** Remove every tag and attribute outside the message-body allowlist. */
export function sanitizeMessageHtml(html: string): string {
  /* The renderer's literal angle brackets are already entities, so every remaining <...>
   * segment is generated markup. Consume the whole segment before parsing its tag name; this
   * also closes the classic nested-angle/srcdoc hole in regexes that skip malformed tags. */
  let sanitized = "";
  let cursor = 0;
  for (const match of html.matchAll(/<[^>]*>/gu)) {
    const index = match.index ?? cursor;
    sanitized += html.slice(cursor, index).replaceAll("<", "&lt;").replaceAll(">", "&gt;");
    sanitized += sanitizeTag(match[0]);
    cursor = index + match[0].length;
  }
  return sanitized + html.slice(cursor).replaceAll("<", "&lt;").replaceAll(">", "&gt;");
}

/** Render the audited subset: bound, escape, transform, then sanitize. */
export function renderMessageMarkdown(
  rawText: string,
  options: MessageMarkdownOptions = {},
): string {
  return sanitizeMessageHtml(renderBlocks(boundedLines(rawText), 0, options));
}

/** Put a message body in the DOM only through the renderer and its final sanitizer. */
export function setSanitizedMessageMarkdown(
  element: HTMLElement,
  rawText: string,
  options: MessageMarkdownOptions = {},
): void {
  element.innerHTML = renderMessageMarkdown(rawText, options);
  for (const link of element.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    link.rel = HARDENED_LINK_ATTRIBUTES.rel;
    link.target = HARDENED_LINK_ATTRIBUTES.target;
  }
}
