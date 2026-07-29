import assert from "node:assert/strict";
import test from "node:test";
import { templates } from "./templates.mjs";
import { renderTemplate } from "./render.mjs";

const fixtureValues = {
  ConfirmationURL: "https://example.test/auth/v1/verify?token=fixture-token&type=magiclink",
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

const expectedKeys = [
  "confirmation",
  "email_change",
  "email_changed_notification",
  "identity_linked_notification",
  "identity_unlinked_notification",
  "invite",
  "magic_link",
  "mfa_factor_enrolled_notification",
  "mfa_factor_unenrolled_notification",
  "password_changed_notification",
  "phone_changed_notification",
  "reauthentication",
  "recovery",
];

function templateVariables(value) {
  return [...value.matchAll(/{{\s*\.([A-Za-z]+)\s*}}/g)].map((match) => match[1]);
}

function renderSupabaseVariables(value, template) {
  const found = [...new Set(templateVariables(value))].sort();
  assert.deepEqual(
    found,
    [...template.variables].sort(),
    `${template.key} must use exactly its documented Supabase variables`,
  );

  const rendered = value.replace(
    /{{\s*\.([A-Za-z]+)\s*}}/g,
    (_whole, variable) => fixtureValues[variable],
  );
  assert.doesNotMatch(rendered, /{{|}}/, `${template.key} left a Go template marker behind`);
  return rendered;
}

function visibleText(html) {
  return html
    .replace(/<[^>]+>/g, " ")
    .replaceAll("&amp;", "&")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&quot;", '"')
    .replace(/\s+/g, " ")
    .trim();
}

assert.deepEqual(
  templates.map((template) => template.key).sort(),
  expectedKeys,
  "the observer must enumerate all 13 Supabase templates",
);

for (const template of templates) {
  test(`${template.key} renders as a complete email`, async () => {
    const source = await renderTemplate(template);
    assert.doesNotMatch(source, /%%[A-Z]+%%/, `${template.key} left a render slot behind`);

    const ctas = source.match(/<a\b/gi) ?? [];
    assert.equal(ctas.length, 1, `${template.key} must render exactly one CTA`);

    const renderedHtml = renderSupabaseVariables(source, template);
    const subjectVariables = [...new Set(templateVariables(template.subject))];
    for (const variable of subjectVariables) {
      assert.ok(
        template.variables.includes(variable),
        `${template.key} subject uses undocumented variable ${variable}`,
      );
    }
    const renderedSubject = template.subject.replace(
      /{{\s*\.([A-Za-z]+)\s*}}/g,
      (_whole, variable) => fixtureValues[variable],
    );
    assert.doesNotMatch(renderedSubject, /{{|}}/, `${template.key} subject left a marker behind`);
    assert.ok(renderedSubject.length > 10, `${template.key} needs a useful subject`);

    const rawUrl = fixtureValues[template.cta.urlVariable];
    assert.ok(
      renderedHtml.includes(`href="${rawUrl}"`),
      `${template.key} CTA must use its rendered Supabase URL`,
    );
    assert.ok(
      visibleText(renderedHtml).includes(rawUrl),
      `${template.key} must show the raw URL outside the button`,
    );

    assert.match(renderedHtml, /<table\b/i, `${template.key} must use table layout`);
    assert.match(renderedHtml, /max-width:600px/i, `${template.key} must stay near 600px`);
    assert.match(
      renderedHtml,
      /name="color-scheme" content="light dark"/i,
      `${template.key} must declare dark-mode support`,
    );
    assert.doesNotMatch(renderedHtml, /<style\b/i, `${template.key} may not depend on a style block`);
    assert.doesNotMatch(renderedHtml, /display\s*:\s*(flex|grid)/i, `${template.key} may not use web layout`);
    assert.doesNotMatch(renderedHtml, /<link\b|@import|url\s*\(/i, `${template.key} may not load external assets`);
    assert.doesNotMatch(
      renderedHtml,
      /<(script|iframe|object|embed)\b/i,
      `${template.key} may not embed active or remote content`,
    );

    const images = renderedHtml.match(/<img\b[^>]*>/gi) ?? [];
    for (const image of images) {
      assert.match(image, /\balt=(?:"[^"]*"|'[^']*')/i, `${template.key} image needs alt text`);
    }

    const plainText = visibleText(renderedHtml);
    assert.ok(plainText.includes("CommonSwarm"), `${template.key} needs visible branding`);
    assert.ok(plainText.length > 180, `${template.key} needs a readable text fallback`);
  });
}
