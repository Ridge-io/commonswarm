import { writeFile } from "node:fs/promises";
import { templates } from "./templates.mjs";
import { renderTemplate } from "./render.mjs";

const fixtureValues = {
  ConfirmationURL: "https://example.test/auth/confirm",
  Email: "new@example.test",
  FactorType: "authenticator app",
  NewEmail: "new@example.test",
  OldEmail: "old@example.test",
  OldPhone: "+1 555 0100",
  Phone: "+1 555 0199",
  Provider: "GitHub",
  SiteURL: "https://example.test/start",
  Token: "123456",
};

const [key, outputPath] = process.argv.slice(2);
const template = templates.find((candidate) => candidate.key === key);

if (!template || !outputPath) {
  process.stderr.write("Usage: node site/emails/preview.mjs <template-key> <output.html>\n");
  process.exitCode = 2;
} else {
  const source = await renderTemplate(template);
  const preview = source.replace(
    /{{\s*\.([A-Za-z]+)\s*}}/g,
    (_whole, variable) => fixtureValues[variable],
  );
  await writeFile(outputPath, preview);
  process.stdout.write(`${outputPath}\n`);
}
