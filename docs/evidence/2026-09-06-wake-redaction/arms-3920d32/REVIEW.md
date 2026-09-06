# Adversarial review — lane/wake-redaction (L2c) at 3920d3217448de5f59553369c9a55d3460b47eee

You are an independent Gemini arm. You did not write this lane. Do not praise it.
Work from the files named below. Change no files.

- Checkout: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-redaction`
- SHA: `3920d3217448de5f59553369c9a55d3460b47eee`
- Base: `a86d73d5e4a124c168c65a3b79857faa21edbfb3`
- Diff: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-redaction/arms-3920d3217448de5f59553369c9a55d3460b47eee/DIFF.patch`
- Spec: `docs/design/2026-09-06-PUSH-DELIVERY.md` §2.2 W1 and §6 row L2c

Before any finding, quote back the first `diff --git` line of DIFF.patch exactly. If you cannot, stop and FAIL.

Read any file on this SHA with `git show 3920d3217448de5f59553369c9a55d3460b47eee:<path>`. Do not edit anything. You may run read-only commands (grep, git show, tests). You may not mutate the tree.

## What the lane claims

1. One exported `SECRET_SHAPE_RE` in `src/host/credential-redaction.ts` matches both `swm_(?:agt|inv|cap)_` plus the existing separator class, and `cswarm-wake:` plus exactly 43 base64url characters.
2. Every previous copy of the token shape now reads that constant: `redactCredentialText`, `localDiagnostic` (`src/listener/supervisor.ts`), and the three literals in `src/listener/control.ts` at lastErrorDetail, lastWorkerStderrTail, and the events.ndjson string scan.
3. A wake topic in stderr or a tool title is rendered `[redacted-credential]`. A wake topic in `lastErrorDetail` is replaced with `[redacted]` by `localDiagnostic`. A wake topic in an events.ndjson string is refused (`listener event contains unsafe text`). A status row carrying one in `lastErrorDetail` or the stderr tail is rejected as malformed.
4. `swm_agt_` still matches at all five sites. `npm run check:edge` stays green because `activity/index.ts` imports the module.

## Six checks (attack each; attempted refutation required)

1. **One constant, five sites.** Grep `src/` and `supabase/` for `swm_(?:agt|inv|cap)_`. The only remaining hit under those trees must be the definer. Confirm `control.ts` `:436`, `:473`, `:829` and `supervisor.ts` `localDiagnostic` read `SECRET_SHAPE_RE` (or its `.source`), not a private copy. A leftover literal is a DEFECT. `CREDENTIAL_PREFIX_RE` must have no remaining importer.

2. **lastIndex.** `SECRET_SHAPE_RE` is exported with `i` only; replace sites compile `gi` from `.source`. `redactCredentialText` keeps a module-level `SECRET_SHAPE_GLOBAL_RE` with `g`. Show a reachable pair of calls where leftover `lastIndex` lets a second secret through `.test()` or `.replace()`. If you cannot, say so. A shared `/g` used with `.test()` on `control.ts` is a DEFECT.

3. **The `{43}` bound.** Spec W1: `wake_id` is 32 random bytes as 43 base64url characters via `translate(encode(extensions.gen_random_bytes(32), 'base64'), '+/=', '-_')`. Can that generator emit a length other than 43? If yes, and the regex would miss it, that is a DEFECT. A 42-character `cswarm-wake:` suffix must not match (the tests pin this on the redact path). `{43,}` or `+` in place of `{43}` would be a DEFECT against the spec.

4. **Tests reach the named site.** For each of: redactCredentialText (stderr and tool title), localDiagnostic, control `:829`, `:436`, `:473` — name the assertion that goes red if that site ignores the topic alternative. A negative that fails even when the site works is a DEFECT. The source sweep's bound is `src/` and `supabase/functions/` (`.ts`/`.js`); it does not claim `tests/` or `docs/`. Ask whether the sweep does what it says, not whether it is complete.

5. **Replacement split.** `redactCredentialText` replaces with `[redacted-credential]`. `localDiagnostic` replaces with `[redacted]`. The status parser rejects `SECRET_SHAPE_RE`, not the marker. Find a string that `localDiagnostic` would write into `lastErrorDetail` and that `parseStatus` would then reject, or a topic that survives `localDiagnostic` and is then accepted by `parseStatus`. The old localDiagnostic class was `[^\s"'\\]*`; the new one uses the separator class from `SECRET_SHAPE_RE`. Is that a leak or a widening? A leak is a DEFECT.

6. **Sixth path.** `sanitize.ts` and `activity/index.ts` call `redactCredentialText`; they are not extra copies of the token regex. Find a path that can put a `cswarm-wake:` topic into `events.ndjson`, `lastErrorDetail`, the stderr tail, or an activity tool title without passing one of the five sites. `STATUS_SENSITIVE_KEYS` rejecting a *key* named `topic` is not this lane. A reachable write of the 43-character topic into status or the event log is a DEFECT.

## Output

- Concrete `path:line` for every finding.
- DEFECT vs NIT.
- Last line exactly `VERDICT: PASS` or `VERDICT: FAIL`. FAIL on any DEFECT.
