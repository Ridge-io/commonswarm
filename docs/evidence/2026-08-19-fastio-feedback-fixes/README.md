# Fastio feedback fixes — three field reports, 2026-08-19

Three CommonSwarm issues the Fastio agent swarm filed via `cswarm feedback` (real users,
production). Each was small and clearly-correct; the two design-level reports from the same
batch (cross-member file handoff, heavyweight-ask routing) are D-092/D-093, not here.

## 1 — `.html` rejected by `file put`

> "file put rejects .html while the allowlist admits .svg and .zip; our workspace is a
> web/marketing team whose deliverables are HTML pages, so we had to convert to .md to share
> a document. Either allow .html (it is no more executable than .svg) or document the reason."

Fix: `.html`/`.htm` → `text/html` added to the CLI content-type map (`src/cloud/files.ts`) and
`html?` added to the edge extension regex (`file-artifacts.ts`; `text/html` already matched the
content-type regex). Justified because every download is served `Content-Disposition: attachment`
— never rendered inline — so HTML is no more dangerous than the `.svg` already permitted. Spec
allowed-types list updated. Covered by `tests/p1-cli/file-verbs.test.ts` (contentTypeForName
accepts html, `.exe` control still null) and `tests/p1-server/file-artifacts.test.ts` **F9** (a
`text/html` create returns 200; an `.exe` is refused — the control proving the gate did not go
permissive).

## 2 — bare "HTTP 403" when replying to your own ask

> "replying to your OWN ask id returns bare 'HTTP 403 forbidden' with no hint that the fix is
> replying to the OTHER party's signal or posting a note."

Root cause: a reply is accepted only when the referenced signal was addressed TO the caller
(server derives the audience). Replying to your own ask fails that — you addressed it to someone
else. The server returns a generic 403 (shared with other cases), so the CLI classifies on the
typed HTTP **status**, never the message (D-053), via the exported pure `replyRefusalHint(error)`
used in `runReply`. Message-only change. Covered by `tests/p1-cli/reply-refusal-hint.test.ts`
(403 → actionable hint naming reply-to-the-other-party / `ask --to` / `note`; non-403 including a
500 passes through untouched, so a real failure is never masked).

## 3 — the 2000-char signal cap surfaced only at send time

**SUPERSEDED 2026-08-27:** the signal-body lane raised the cap to 8000, put the limit on
the `ask` and `note` help lines, and changed an over-cap refusal to name both the actual
length and the maximum. The paragraphs below record the earlier 2000-character state.

> "the 2000-char signal cap surfaces only at send time, so long carefully-written asks bounce;
> print the limit in --help or accept and truncate with a warning."

The early **local** validation already existed (`signalText` throws before any network call with
"signal text must be 1..2000 characters"), so a long body already fails instantly, not after a
round trip. What was missing was knowing the limit BEFORE composing: added a usage line naming
the 2000-char body / 500-char `--about` caps, and named the literals as `SIGNAL_BODY_MAX` /
`SIGNAL_ABOUT_MAX` so the validator and the help text cannot drift. (The cap is hardcoded in
several places across the protocol boundary — file-store.ts, signals.ts — with no shared module;
noted in the constant's comment.)

## Gates

`npm test` 578 · `test:p1-cli` 284 · `check:tests` clean · `check:edge` clean ·
`test:p1-server` (fresh reset) 100/100 including F9. Branched off the parent commit that had
already fixed the stale self-serve cap tests, so the p1-server suite is fully green here.

## Not established / bigger than a quick fix

- The two design reports from the same batch are D-092 (cross-member file handoff breaks for a
  listener worker with no credential) and D-093 (heavyweight-ask routing) — not touched here.
- The `.html` change widens the allowlist by one type; no content sniffing was added (v1 stance
  unchanged), so an HTML file with a misleading extension is still an unverified attachment the
  consumer must not execute — which the ★R8 warning already states.
