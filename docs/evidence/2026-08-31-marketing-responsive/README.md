# Marketing responsive repair — 2026-08-31

Base: `820a9e32cf68fed914afd1031946f078352b0e7c` on GitHub `main` when work began.
Code: `77f701bc3c8b20df4c57eb2feec42620d86f33d1` on `codex/marketing-responsive`.
Worktree: `/Users/yulanbot/Developer/Ridge.io/commonswarm-responsive`.
The shared checkout was clean and stayed on `main`; no other agent branch was edited.

## Findings and fixes

- The preview rail was shown at every width, but `.chat` still had one grid column.
  The restored panel commit `787929d` carried that mismatch. The rail now shows beside
  the feed from 40rem (640px at the default font size). Below that, the feed uses the
  full width; message metadata keeps the agent, model, and owner names.
- The preview margin used undefined `--s-7`. Computed margin was 0px. It now uses
  `--s-8`, measured as 32px.
- The base `.chat__list` rule reset the agent-list margin and padding. The modifier
  now follows the base rule, so agents are indented under their owner.
- The panel header now wraps its two labels into separate rows on narrow screens.
- Header, phone menu, and footer links to `/#how-it-works` and `/#install` had no
  targets. Their inner section headers now carry those IDs, so the section padding does not
  add empty space above the heading after a click.

## Verification

- Clean site build: all eight pages generated. Prior build output was moved into
  ignored scratch space before building.
- `npm --prefix site test`: 212 passed, 0 failed, one existing diagnostic skip
  (`baseline audit prints common rendered geometry`). See `site-test-final.txt` (rerun on the final source).
- `npm test`: 656 passed, 0 failed, no skips. See `root-test-final.txt` (rerun on the final source).
- Browser viewport measurements at 320, 375, 390, 480, 639, 640, 768, 832, 1024,
  and 1440px. Each row includes the measured `innerWidth`. See `before.json` and
  `after-final.json`. Before: rail above feed at every width. After: rail hidden below
  640 and aligned beside the feed at 640 and above. No page overflow or missing
  homepage anchor targets at the measured widths.
- Desktop “How it works” click reaches its section. Phone “See the prompt” click
  reaches its section, closes the dialog, and releases the scroll lock. Both target
  tops sit about 96px below the viewport top, below the 65px sticky header.
- Before/after screenshots are included at 390 and 1440px.
- `build-check-final.json` records the eight final built page hashes. Every page has the
  expected backend URL and a public `anon` credential. No key is recorded here.
  The built installer matches the root installer byte for byte.

## Reviews

- Initial target: `834a703727bc3c3168751e47e688ace9539ca149`. Gemini identified the
  extra anchor offset from the section padding. Fixed at `77f701b`; both reviews
  rerun on that replacement SHA. Its proposed right alignment for the wrapped label
  was declined: both labels intentionally share the left edge on a phone.
- Final Gemini 3.1 Pro review: PASS, with reasoning in `gemini-review.txt`.
  This is source review. Its approximate 640px feed-width estimate is not a browser
  measurement; use `after-final.json` for geometry.
- Final Codex exact review: PASS. See `codex-review.md` for ten independently
  measured widths, clipped-text checks, six anchor jumps, and both non-author
  mutation controls. Forced stacking and hidden text clipping each fail with exit 1;
  restoring the page returns exit 0.
- No CSS-only test files were added. The independent review uses temporary mutation
  probes; the existing test suites and recorded browser checks provide verification.
- PR: https://github.com/Ridge-io/commonswarm/pull/1.

## Extra checks

The install page fits at 390 and 1440px. Its footer link reaches the homepage heading
at about 96px below the top. No install-page source was changed. An unrelated existing
copy mismatch (Node 22 heading versus Node 24 in one instruction) was noticed and left
outside this layout repair.

## Scope and limits

Only two homepage components changed. No new test files, dependencies, auth, database,
or CLI changes. The CLI remains 0.1.40; this site-only repair does not create a CLI release.
No real iPhone/Android device, WebKit, or Firefox verification was performed. Signed-in
workspace flows and the mobile keyboard case were not exercised by this repair.
The current record of unrelated open work remains `docs/org/2026-08-29-RESUME-HERE.md`.

## Landed and live

- GitHub `main` was fast-forwarded from `820a9e3` to the exact reviewed code commit
  `77f701bc3c8b20df4c57eb2feec42620d86f33d1`. PR #1 is merged at that same SHA;
  no squash, rebase, or merge commit changed the reviewed code ref.
- Production deployment: `dpl_3JtXhJBHcyGQd62pxLnyyPGzZyGp`, Vercel project
  `coswarm-site`, scope `ridgedotio`, alias `https://commonswarm.com`.
- `production-check.json`: all eight public route bodies match the final build
  byte for byte; both homepage CSS assets match; `/install.sh` is 200 and matches
  source; `/nope.sh` is 404. The unchanged public backend config is included in
  those exact page matches.
- `production-geometry.json`: all ten requested widths were reached and passed.
  Rail hidden below 640, side-by-side at 640 and above, 32px panel gap, no page
  overflow, and both anchor nodes are HEADER elements.
- `production-390.png` and `production-1440.png` show the deployed page.
- Probe correction: `production-geometry-invalid.json` is NOT ten-width evidence.
  The viewport override affected the selected local tab while the probe read a
  different tab, so all ten rows report 1440px. The actual-width control caught it.
  A fresh production tab was selected and each requested width was asserted before
  recording the replacement results in `production-geometry.json`.
- Evidence and this handoff are a separate docs-only commit under the repository's
  ungated docs rule. No application source changed after the two review passes.
