import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { templates } from "./templates.mjs";

const emailDir = dirname(fileURLToPath(import.meta.url));

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

function ctaHtml(cta) {
  const url = `{{ .${cta.urlVariable} }}`;
  return `<table role="presentation" cellspacing="0" cellpadding="0" border="0" style="border-collapse:collapse; margin:24px 0 18px 0;">
  <tr>
    <td style="border-radius:10px; background-color:#195b43;">
      <a href="${url}" style="display:inline-block; padding:13px 20px; color:#ffffff; font-size:15px; font-weight:700; line-height:20px; text-decoration:none; border-radius:10px;">${escapeHtml(cta.label)}</a>
    </td>
  </tr>
</table>
<p style="margin:0 0 22px 0; color:#667067; font-size:12px; line-height:18px;">
  If the button does not work, copy and paste this link into your browser:<br>
  <span style="color:#31483d; overflow-wrap:anywhere; word-break:break-all;">${url}</span>
</p>`;
}

export async function renderTemplate(template) {
  const [layout, body] = await Promise.all([
    readFile(join(emailDir, "layout.html"), "utf8"),
    readFile(join(emailDir, `${template.key}.html`), "utf8"),
  ]);

  return layout
    .replace("%%PREHEADER%%", escapeHtml(template.preheader))
    .replace("%%BODY%%", body.replace("%%CTA%%", ctaHtml(template.cta)));
}

export async function renderAllTemplates() {
  return Promise.all(
    templates.map(async (template) => ({
      ...template,
      html: await renderTemplate(template),
    })),
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const key = process.argv[2];
  const template = templates.find((candidate) => candidate.key === key);
  if (!template) {
    process.stderr.write(`Unknown template: ${key ?? "(missing)"}\n`);
    process.exitCode = 1;
  } else {
    process.stdout.write(await renderTemplate(template));
  }
}
