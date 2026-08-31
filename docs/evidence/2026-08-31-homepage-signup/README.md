# Clear homepage signup — 2026-08-31

Base: `e6cb5d768a41c42c91b0b87e3f3f6b3d34860103`.
Final code: `59c190bbd77ed352baf902cb50bf5e88eeda00f1`.
Branch: `codex/homepage-signup`.
Worktree: `/Users/yulanbot/Developer/Ridge.io/commonswarm-signup`.

## Request and change

Visitors could not tell whether to open a workspace or connect GitHub. The homepage
now says **Sign up** and **Log in**. Header, hero, closing CTA, and footer use the same
names. Repository links remain in the footer. Both buttons lead to `/app`, whose
existing email form creates an account for a new address and signs in an existing
account. Its heading now says **Sign up or log in**, with that shared behavior stated
below. GitHub remains an optional provider. No authentication code or backend changed.

The hero buttons are side by side above 480px and full width below that. On narrow
screens, the header offers Sign up with Log in in its menu; the hero shows both.
An independent review found overlapping header links at 481/520px with scripts off.
The no-JavaScript nav now reduces to one link through640px. All links stay in the footer.
The existing sidebar display and grid breakpoint were preserved.

## Checks

- Ten measured browser widths: 320,375,390,480,639,640,768,832,1024,1440px.
  `local-layout.json` records actual innerWidth, button and header boxes, and sidebar/feed
  bounds. Buttons stay inside the viewport and header items do not overlap. The sidebar
  remains hidden below 640px and to the left at 640px and above.
- Clicked Sign up from the header and Log in from the phone menu. Both reached the
  email form. Phone screenshot confirms the account form fits at 320px.
- In-app Browser's Escape key call did not dismiss the native dialog. The independent
  reviewer checked real keyboard Escape twice: dialog closes, focus returns to Menu,
  scroll lock clears, and aria-expanded becomes false. Click close also passed here.
  This is a tool limitation, not a reproduced site failure.
- Existing copy observers were updated; no new test files, dependencies, or routes.
  All edited observers are reached by the explicit `site/package.json` test globs.
- Final site test: 212 passed, zero failed, one existing diagnostic skip (`site-test.log`).
- The root gate has 656 tests. A default run passed on the first code version. Two
  default runs hit the unchanged OpenCode 1300ms process-time assertion (1858ms and1917ms),
  including one on the final SHA. Both failed logs are retained. Running the exact
  `package.json` test list with `--test-concurrency=1` on the final SHA passed all 656;
  see `root-final-serial.log`. The parallel timing limit remains a test limitation;
  no CLI or test threshold was changed for this site task.

## Limits

No account was created and no email was sent. Email delivery and live OAuth completion
were not tested. Existing authenticated workspace flows were not exercised manually.
No physical phone, Safari, or Firefox coverage. These are navigation/copy and CSS changes,
not a new authentication system. No CLI release or database migration is part of this work.

## Landing status

- Both D-036 arms approved final code SHA 59c190bbd77ed352baf902cb50bf5e88eeda00f1:
  independent Codex (`exact-review.md`) and Gemini 3.1 Pro (`gemini-review.md`).
  Codex checked 14 normal widths,16 script-free widths, actual installed Supabase
  request behavior, and an independent overlap fault control (exit 1, restored exit 0).
  Gemini's raw text calls the menu a sidebar; its wording is not evidence of the
  mock panel geometry. The measured panel bounds above and Codex review establish that.
- GitHub main was fast-forwarded to that exact reviewed code SHA. PR #2 is merged:
  https://github.com/Ridge-io/commonswarm/pull/2. No squash/rebase changed the reviewed SHA.
- LIVE at https://commonswarm.com. Vercel project coswarm-site, scope ridgedotio,
  deployment `dpl_tHg4twNBQJc9ovWSsnK4kA6PM5zq`.
- `production-check.json`: all 8 public page bodies,6 homepage/app assets, and the
  installer matched local build/source bytes (15 of 15 checks). Installer 200; missing
  `/nope.sh` control 404. `build-manifest.json` pins all 33 built files.
- `production-layout.json`: eight actual widths 320,390,480,481,640,641,832,1440
  passed containment, non-overlapping header, and mock sidebar bounds. The live
  Log in button opened the visible email form with the new title. No form submitted.
- One predeploy checksum invocation used root-relative paths from site/ and failed.
  The same check rerun from the worktree root validated all 33 files and project ID.
  Production byte comparisons independently validated the actual deployed output.
- The shared checkout has unrelated work in progress. It was not stashed, switched,
  or edited. Evidence and this handoff land in a separate ungated docs commit.

No remaining signup-copy or layout step. Before the next marketing edit, use an
isolated branch, read `docs/org/2026-08-29-RESUME-HERE.md`, and rerun the site build/test.
Existing open work and deferred items in that file remain unchanged.
