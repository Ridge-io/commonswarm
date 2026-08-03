# Site test gate coverage

Executed by Transom on 2026-08-03 from frozen base
`3603b417366975153eaee786eb806ee3ade99897` on
`lead7/mvp-release-0.1.5`.

## Reachability repair and count

The original `site/package.json` test command reached neither email test file. A baseline run of
`npm --prefix site test` passed **94/94**. Adding the package-script pattern
`emails/*.test.mjs` made both files reachable without changing either test file.

The two files contain six source-level test blocks. All six passed:

1. `email body directory matches the explicit Supabase contract` — **PASS**.
2. `<template> renders as a complete email` — **PASS** for all 13 enumerated Supabase templates.
3. `push script diffs before PATCH, defaults dry, and becomes a no-op when current` — **PASS**.
4. `push script sends sender fields only with the complete SMTP block` — **PASS**.
5. `push script surfaces Supabase's HTTP 401 validation body` — **PASS**.
6. `push script rejects a multi-document auth response before PATCH` — **PASS**.

The template loop expands the second source-level block into 13 runtime subtests. Consequently the
email files add **18 runtime tests** in total: 14 from `email-templates.test.mjs` and 4 from
`push-script.test.mjs`.

`site/scripts/test-gate-coverage.test.mjs` adds one more runtime test. The accepted site suite is
therefore **113/113**, accounting exactly for the change from 94:

```
94 baseline + 18 newly reachable email tests + 1 gate-coverage observer = 113
```

## Structural observer

The observer recursively enumerates the required test-shaped suffixes under `site/`, excluding
`node_modules`, `dist`, and Astro's generated `.astro` output. It reads and tokenizes
`site/package.json`'s `scripts.test`, extracts the arguments to `--test`, and evaluates the
enumerated filenames against those extracted patterns. It does not contain a hard-coded copy of
the site's test globs. In the restored configuration it printed:

```text
site test gate coverage: unreachable = []
```

The file self-gates through the existing `scripts/*.test.mjs` package-script pattern.

## Printed mutation control

I temporarily removed only `emails/*.test.mjs` from `site/package.json`, then ran:

```sh
cd site
node --import tsx --test scripts/test-gate-coverage.test.mjs
```

The observer exited 1 and named both newly orphaned files:

```text
site test gate coverage: unreachable = ["emails/email-templates.test.mjs","emails/push-script.test.mjs"]
AssertionError [ERR_ASSERTION]: unreachable site test files:
- emails/email-templates.test.mjs
- emails/push-script.test.mjs
+ actual - expected

+ [
+   'emails/email-templates.test.mjs',
+   'emails/push-script.test.mjs'
+ ]
- []
```

The removed glob was then restored exactly. A direct observer run returned to 1/1 with
`unreachable = []`, and the full site suite reached both email files.

## Gates

- Pre-change baseline: `npm --prefix site test` — **94/94 PASS**.
- Email glob wired, before observer: `npm --prefix site test` — **112/112 PASS**.
- Observer added: `npm --prefix site test` — **113/113 PASS**.
- Clean build: `cd site && rm -r -- dist && npm run build` — **PASS**, 8 static pages built.
- Fresh-output site gate: `npm --prefix site test` — **113/113 PASS** with
  `unreachable = []`.
- Root pure gate: `npm test` — **365/365 PASS**.
- `git diff --check` — **PASS**.

## Commit identity

This evidence is committed in the same single commit as the package-script and observer changes.
Its commit SHA is therefore resolved from the committed artifact itself:

```sh
git log -1 --format=%H -- docs/evidence/2026-08-02-v015-execution/site-gate-coverage.md
```

The resolved SHA and successful push are recorded in the handoff after the commit is created.

## Not established

This work did not deploy the site, inspect or change production, exercise a live Supabase project,
apply email templates to Supabase, validate real email delivery, or establish browser/provider
behavior beyond the existing pure test fixtures and static build. It did not run database-backed
suites. It did not land on `main`; it produced and pushed one commit on
`lead7/mvp-release-0.1.5`.
