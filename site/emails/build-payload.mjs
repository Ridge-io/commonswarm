import { renderAllTemplates } from "./render.mjs";

const smtpAdminEmail = process.env.COMMONSWARM_SMTP_ADMIN_EMAIL;
if (!smtpAdminEmail) {
  throw new Error("COMMONSWARM_SMTP_ADMIN_EMAIL is required; do not invent a sender address");
}

const payload = {
  smtp_sender_name: "CommonSwarm",
  smtp_admin_email: smtpAdminEmail,
};

for (const template of await renderAllTemplates()) {
  payload[`mailer_subjects_${template.key}`] = template.subject;
  payload[`mailer_templates_${template.key}_content`] = template.html;
}

process.stdout.write(`${JSON.stringify(payload)}\n`);
