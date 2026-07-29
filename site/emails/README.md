# CommonSwarm auth emails

This directory contains the 13 Supabase Auth email templates used by CommonSwarm:
six authentication messages and seven security notifications. Each body is a separate
HTML file. `render.mjs` combines it with `layout.html`, which is deliberately built from
tables and inline styles for email clients.

Render one template locally:

```sh
node site/emails/render.mjs magic_link
```

Write a browser-ready preview with fixture values:

```sh
node site/emails/preview.mjs magic_link /tmp/commonswarm-magic-link.html
```

Run the rendered-output observer and the Management API script test:

```sh
node --test site/emails/*.test.mjs
```

Preview the Management API diff without changing the project:

```sh
SUPABASE_ACCESS_TOKEN=... \
SUPABASE_PROJECT_REF=... \
COMMONSWARM_SMTP_ADMIN_EMAIL=... \
COMMONSWARM_SMTP_SENDER_NAME=CommonSwarm \
scripts/push-email-templates.sh
```

The script is dry-run by default. The operator can add `--apply` after reviewing the
field-by-field diff. A second apply is a no-op when the project already matches.

The script configures template subjects, rendered HTML, the configurable
`smtp_sender_name` (default `CommonSwarm`), and the operator-supplied `smtp_admin_email`.
The recommended sender is `CommonSwarm <hello@commonswarm.com>`: `hello@` is warm and
reply-capable without implying a formal support channel. The script intentionally does not
enable security notifications: enabling a new class of account email is a separate product
decision from customizing the copy that is sent when one is enabled.
