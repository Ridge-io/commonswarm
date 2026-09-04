/*
 * Message bodies cross a workspace trust boundary. Keep this renderer small enough to audit:
 * escape the complete input first, add only the supported markdown subset, then allowlist the
 * generated HTML before it reaches innerHTML. A full markdown engine would add HTML, URL, and
 * extension surfaces that this feed neither needs nor wants.
 */

/* A ceiling on how much HTML this renderer will build, raised from 20,000 characters / 1,000
 * lines — small enough for an ordinary brain topic to hit.
 *
 * Say what is true rather than what is comfortable: a signal body is capped at 8,000 characters
 * upstream and can never reach these numbers, but a brain topic is a FILE, and a file version may
 * be up to FILE_MAX_VERSION_BYTES (25 MB, src/cloud/files.ts). A topic past EITHER bound — the
 * characters or the lines, whichever it reaches first — IS shortened in the rendered view, and
 * the marker below says so. Rendering 25 MB of HTML would take the tab down instead.
 *
 * The stored text stays whole, and the Brain panel's Raw toggle reads it from the file rather
 * than from the rendered HTML (brain-view.ts). What the observer asserts today is Raw for an
 * ORDINARY topic, byte for byte; Raw for a SHORTENED one is the same code path but is not
 * exercised by a fixture, so it is stated here as design, not as a measured result. */
export const MESSAGE_MARKDOWN_LIMITS = Object.freeze({
  inputCharacters: 2_000_000,
  lines: 50_000,
  nestingDepth: 4,
  /* The most table cells one render pass will build. Every other block in this subset produces
   * output roughly the size of its input; a table does not, because a single "|" character can
   * produce a whole `<td align="center"></td>`. At the 2,000,000-character input ceiling a body of
   * nothing but pipes would otherwise reach tens of megabytes of HTML — the failure the ceiling
   * above exists to prevent. A table whose cells would cross this budget is not expanded at all:
   * its lines fall through to the paragraph path and stay the literal text they are today, so the
   * bound costs formatting and never a character of content. */
  tableCells: 20_000,
});

/* The height at which a message folds behind "Show more". It was 30 lines, which an ordinary
 * agent answer passes, so the fold was the normal case rather than the exception. */
export const MESSAGE_COLLAPSE_LINES = 60;

export const MESSAGE_MARKDOWN_TAGS = Object.freeze([
  "p", "br", "strong", "em", "code", "pre", "ul", "ol", "li", "blockquote", "a",
  "h2", "h3", "h4", "h5",
  "table", "thead", "tbody", "tr", "th", "td",
] as const);

/* The complete set of column alignments a delimiter row can ask for. The parser reads it and the
 * sanitizer checks against it, so neither can drift from the other. */
export const MESSAGE_MARKDOWN_ALIGNMENTS = Object.freeze(["left", "center", "right"] as const);

/* `align` rather than `style` or `class`: `sanitizeTag` drops every attribute on every tag but
 * `a[href]`, so alignment needs one of them widened. `style` is an arbitrary CSS sink and is not
 * on the table. `class` would put message content into the page's class namespace and would need
 * three new rules in a stylesheet this file does not own. `align` is a three-value enum the
 * sanitizer checks against MESSAGE_MARKDOWN_ALIGNMENTS, the browser maps it to `text-align`, and
 * it needs no stylesheet at all. */
export const MESSAGE_MARKDOWN_ATTRIBUTES = Object.freeze({
  a: ["href"] as const,
  th: ["align"] as const,
  td: ["align"] as const,
});
export const HARDENED_LINK_ATTRIBUTES = Object.freeze({
  rel: "noopener noreferrer",
  target: "_blank",
});

const ALLOWED_TAGS = new Set<string>(MESSAGE_MARKDOWN_TAGS);
const ALLOWED_ALIGNMENTS = new Set<string>(MESSAGE_MARKDOWN_ALIGNMENTS);
const TOKEN_OPEN = "\uE000";
const TOKEN_CLOSE = "\uE001";

type TableAlignment = (typeof MESSAGE_MARKDOWN_ALIGNMENTS)[number] | null;

/** How much table this render pass may still build. See MESSAGE_MARKDOWN_LIMITS.tableCells. */
interface RenderBudget {
  cells: number;
}

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
    /* Reachable for a brain topic past either bound — never for a signal, which is capped far
     * below both. It says what happened rather than ending mid-sentence, because a silent cut
     * reads as the author stopping there, and Raw still holds the whole stored text. */
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

/* GitHub-flavoured pipe tables: a header row, a delimiter row that fixes the column count and the
 * per-column alignment, then body rows until the first line that is not a pipe row.
 *
 * Cell text takes the same path as every other inline run — boundedLines has already escaped it,
 * and renderInline renders it. There is deliberately no second renderer and no second escape rule
 * for cells, so a cell cannot be safer or less safe than the paragraph next to it. */
const TABLE_DELIMITER_CELL = /^:?-+:?$/u;

function splitTableCells(row: string): string[] {
  const cells: string[] = [];
  let current = "";
  for (let index = 0; index < row.length; index += 1) {
    const character = row[index] ?? "";
    if (character === "\\" && row[index + 1] === "|") {
      /* An escaped pipe is content. Without this it would split the cell and the author's text
       * would land in the wrong column. */
      current += "|";
      index += 1;
      continue;
    }
    if (character === "|") {
      cells.push(current);
      current = "";
      continue;
    }
    current += character;
  }
  cells.push(current);
  /* The border pipes are optional in GFM, and each one produces an empty cell that is punctuation
   * rather than content. Drop those two only; never a cell that holds text. */
  if (row.startsWith("|")) cells.shift();
  if (cells.length > 1 && cells[cells.length - 1] === "" && row.endsWith("|")) cells.pop();
  return cells;
}

function tableRowCells(line: string): string[] | null {
  const trimmed = line.trim();
  if (!trimmed.includes("|")) return null;
  return splitTableCells(trimmed);
}

function tableAlignments(line: string, columns: number): TableAlignment[] | null {
  const cells = tableRowCells(line);
  /* GFM requires the delimiter row to name exactly as many columns as the header. That equality is
   * what stops an ordinary sentence containing a pipe from becoming a table. */
  if (!cells || cells.length !== columns) return null;
  const alignments: TableAlignment[] = [];
  for (const cell of cells) {
    const marker = cell.trim();
    if (!TABLE_DELIMITER_CELL.test(marker)) return null;
    const left = marker.startsWith(":");
    const right = marker.endsWith(":");
    alignments.push(left && right ? "center" : right ? "right" : left ? "left" : null);
  }
  return alignments;
}

function tableHeaderAt(lines: string[], index: number): TableAlignment[] | null {
  const header = tableRowCells(lines[index] ?? "");
  if (!header || header.length === 0) return null;
  return tableAlignments(lines[index + 1] ?? "", header.length);
}

/* Ragged rows keep every character the author wrote.
 *
 * A row with FEWER cells than the header is padded with empty cells to the header width, so the
 * columns after it still line up under their headings. A row with MORE cells keeps every extra one
 * as an extra cell past the last column the header named — that row renders wider than the rest of
 * the table, which is visible and odd, and visible-and-odd beats silently deleting the author's
 * text. GFM drops those extra cells; this renderer does not. */
function renderTableRow(
  cells: string[],
  alignments: TableAlignment[],
  tag: "th" | "td",
): string {
  const width = Math.max(cells.length, alignments.length);
  let rendered = "";
  for (let column = 0; column < width; column += 1) {
    const alignment = alignments[column] ?? null;
    const attribute = alignment === null ? "" : ` align="${alignment}"`;
    rendered += `<${tag}${attribute}>${renderInline((cells[column] ?? "").trim())}</${tag}>`;
  }
  return `<tr>${rendered}</tr>`;
}

function renderBlocks(
  lines: string[],
  depth = 0,
  options: MessageMarkdownOptions = {},
  budget: RenderBudget = { cells: MESSAGE_MARKDOWN_LIMITS.tableCells },
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
      blocks.push(
        `<blockquote>${renderBlocks(quote, depth + 1, options, budget)}</blockquote>`,
      );
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

    const alignments = budget.cells > 0 ? tableHeaderAt(lines, index) : null;
    if (alignments) {
      /* Read the whole table before emitting any of it: the cell budget is a property of the
       * table, and a table that cannot be afforded must fall through to the paragraph path whole
       * rather than stop half-rendered. */
      const header = tableRowCells(lines[index] ?? "") ?? [];
      const rows: string[][] = [];
      let cells = Math.max(header.length, alignments.length);
      let cursor = index + 2;
      while (cursor < lines.length) {
        const row = tableRowCells(lines[cursor] ?? "");
        if (!row) break;
        rows.push(row);
        cells += Math.max(row.length, alignments.length);
        cursor += 1;
      }
      if (cells <= budget.cells) {
        budget.cells -= cells;
        const body = rows.map((row) => renderTableRow(row, alignments, "td")).join("");
        blocks.push(
          `<table><thead>${renderTableRow(header, alignments, "th")}</thead>` +
            `<tbody>${body}</tbody></table>`,
        );
        index = cursor;
        continue;
      }
      /* One table already wants more cells than the whole message may spend, so the budget is
       * gone: this table and every later one stay literal text for the rest of the pass. Spending
       * it here rather than re-measuring keeps the paragraph path below from having to ask a
       * second time whether a table is affordable. */
      budget.cells = 0;
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
      if (paragraph.length > 0 && budget.cells > 0 && tableHeaderAt(lines, index)) break;
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
  if (name === "th" || name === "td") {
    /* One attribute, checked against the same set the parser writes from, and dropped entirely
     * when it is anything else. A cell keeps its alignment; it cannot keep a style, a class, an
     * event handler, or an align value we did not name. */
    const align = /\salign\s*=\s*"([^"]*)"/iu.exec(source);
    const value = (align?.[1] ?? "").toLowerCase();
    return ALLOWED_ALIGNMENTS.has(value) ? `<${name} align="${value}">` : `<${name}>`;
  }
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
  /* A fresh budget per call. It is per-message state, never module state. */
  return sanitizeMessageHtml(
    renderBlocks(boundedLines(rawText), 0, options, {
      cells: MESSAGE_MARKDOWN_LIMITS.tableCells,
    }),
  );
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
