/** Shared hostile input for every DOM path that renders workspace Markdown. */
export const HOSTILE_MARKDOWN_BLOCKS =
  "Before <b>raw</b>\n\n- [click](javascript:alert(1))\n" +
  '- <img src=x onerror="alert(2)">\n\n```html\n<img src=x onerror=alert(3)>\n```';
