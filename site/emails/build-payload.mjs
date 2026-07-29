import { renderAllTemplates } from "./render.mjs";

const smtpFields = {
  smtp_admin_email: ["COMMONSWARM_SMTP_ADMIN_EMAIL", process.env.COMMONSWARM_SMTP_ADMIN_EMAIL],
  smtp_host: ["COMMONSWARM_SMTP_HOST", process.env.COMMONSWARM_SMTP_HOST],
  smtp_port: ["COMMONSWARM_SMTP_PORT", process.env.COMMONSWARM_SMTP_PORT],
  smtp_user: ["COMMONSWARM_SMTP_USER", process.env.COMMONSWARM_SMTP_USER],
  smtp_pass: ["COMMONSWARM_SMTP_PASS", process.env.COMMONSWARM_SMTP_PASS],
};

const payload = {};
const smtpEntries = Object.entries(smtpFields);
const senderName = process.env.COMMONSWARM_SMTP_SENDER_NAME;
const hasValue = (value) => value !== undefined && value.trim() !== "";
const smtpRequested =
  smtpEntries.some(([, [environmentName]]) => Object.hasOwn(process.env, environmentName)) ||
  Object.hasOwn(process.env, "COMMONSWARM_SMTP_SENDER_NAME");

if (smtpRequested) {
  const missing = smtpEntries
    .filter(([, [, value]]) => !hasValue(value))
    .map(([, [environmentName]]) => environmentName);
  if (missing.length > 0) {
    throw new Error(
      `Custom SMTP is all-or-none; missing required environment: ${missing.join(", ")}`,
    );
  }

  for (const [fieldName, [, value]] of smtpEntries) {
    payload[fieldName] = value;
  }
  payload.smtp_sender_name = hasValue(senderName) ? senderName : "CommonSwarm";
}

for (const template of await renderAllTemplates()) {
  payload[`mailer_subjects_${template.key}`] = template.subject;
  payload[`mailer_templates_${template.key}_content`] = template.html;
}

process.stdout.write(`${JSON.stringify(payload)}\n`);
