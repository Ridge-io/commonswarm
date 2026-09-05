/** Shared hostile input for every DOM path that renders workspace Markdown. */
export const HOSTILE_MARKDOWN_BLOCKS =
  "Before <b>raw</b>\n\n- [click](javascript:alert(1))\n" +
  '- <img src=x onerror="alert(2)">\n\n```html\n<img src=x onerror=alert(3)>\n```';

/** The table an agent posted to the workspace on 2026-09-04. It rendered as three raw lines —
 * `| fact | result |`, then `|---|---|`, then the row — because renderBlocks had no table rule and
 * the sanitizer allowed no table tag. Kept verbatim, inline code spans included: the cells hold
 * `code` spans, and a table that renders but eats its backticks is the same bug wearing a hat. */
export const PRODUCTION_TABLE_MARKDOWN =
  "| fact | result |\n" +
  "|---|---|\n" +
  "| REF IDENTITY | `refs/heads/production` = " +
  "`7584524ea03162af2275c5cbfaa77df697cf68f5` |";

/** Every injection vector this renderer neutralises in a paragraph.
 *
 * The rule each new construct is held to: render one of these as a paragraph, render it again
 * inside the construct, strip the construct's own wrapper, and the two inner strings must be
 * byte-identical. A construct that escapes its content itself would differ here, which is the
 * whole point — there is one escaping path and one inline renderer, never a second. */
export const HOSTILE_INLINE_VECTORS = Object.freeze([
  '<script>alert(1)</script> <img src=x onerror="alert(2)">',
  "[go](javascript:alert(3))",
  "[phish](https://trusted.example@evil.host/)",
  '<a href="javascript:alert(7)">link</a>',
  "`code` and **bold**",
] as const);

/** Every injection vector this renderer already neutralises in a paragraph, moved inside table
 * cells. A cell must not be a second, weaker escaping path. */
export const HOSTILE_TABLE_MARKDOWN =
  "| tag | attribute | url | image |\n" +
  "| --- | --- | --- | --- |\n" +
  "| <script>alert(1)</script> | <b onerror=\"alert(2)\">x</b> | " +
  "[go](javascript:alert(3)) | <img src=x onerror=alert(4)> |\n" +
  '| <td align="center" onclick="alert(5)">raw cell</td> | ' +
  "</table><script>alert(6)</script> | " +
  "[phish](https://trusted.example@evil.host/) | " +
  '<a href="javascript:alert(7)">link</a> |';
