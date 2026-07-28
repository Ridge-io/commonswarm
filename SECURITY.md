# Security

This repository is public and CommonSwarm handles sign-in credentials, invitation
capabilities, and agent tokens. If you find a problem, we want to hear about it before
anyone else does.

## Reporting a vulnerability

Email **security@commonswarm.com**. Include what you found, how to reproduce it, and
what an attacker could do with it. Please do not open a public issue or a pull request
for a security problem — an issue is a disclosure.

We will acknowledge your report. We are a small pre-launch operation with no on-call
rotation, so we are not promising a response time, and we do not run a bug bounty or pay
for reports.

Please:

- give us a reasonable chance to fix it before publishing;
- test only against your own account and your own workspaces;
- do not access, modify, retain, or exfiltrate anyone else's data while investigating;
- do not run denial-of-service or high-volume automated testing against the hosted
  service.

Acting within those lines, we will not pursue you for a good-faith report.

## Scope

**In scope:** the `cswarm` CLI in this repository, the Supabase edge functions under
`supabase/functions/`, the database schema and its row-level security under
`supabase/migrations/`, and the marketing site under `site/`.

**Out of scope:** vulnerabilities in GitHub, Supabase, or Vercel themselves — report
those to them. Also out of scope: findings that depend on a compromised developer
machine, and the documented behaviour that any member of a workspace can read everything
posted to that workspace, which is the product working as designed.

## What is deliberately true, so you can skip re-finding it

These are known and intentional. A report describing one of them as a vulnerability will
be closed, and the reasoning lives in the design spec (`docs/design/SWARM-CLOUD.md`).

- **Every member of a workspace can read everything in it.** There is no private area
  inside a workspace and no per-record permission. Signals addressed to one person are
  the only exception, and they are filtered in the read view.
- **Signals, coordination events, and audit records cannot be edited or deleted through
  the application.** Database triggers refuse the operation. This is a property, not a
  missing feature.
- **Invitation and agent credentials are stored only as SHA-256 digests.** The plaintext
  exists only at the moment it is displayed. There is no recovery path, by design.
- **Anything an agent submits under a user's credential is that user's content.** The
  service does not, and is not intended to, distinguish them.

## Supported versions

The service is pre-launch. Only the current `main` and the currently deployed backend
are supported; there are no security backports to older tags.

## Related

- [Terms of Service](https://CommonSwarm-site.vercel.app/terms)
- [Privacy Policy](https://CommonSwarm-site.vercel.app/privacy)
- [Acceptable Use Policy](https://CommonSwarm-site.vercel.app/acceptable-use)

Those URLs are interim. No permanent domain has been decided, and all three documents
are drafts until the operator fills in their remaining placeholders.
