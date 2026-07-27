# Worktree and branch prune — 2026-07-27 (Lead6)

Local repo went from **11 worktrees / 55 branches** to **1 worktree / 10 branches**.
Every deleted ref is recorded below with its SHA so it can be restored
(`git branch <name> <sha>`) for as long as the objects survive gc.

## What was established first

- `main` was fast-forwarded from the stale local `c61d2d7` to `origin/main`.
  The consumer UX sprint (`aa84f34`) was **already on `origin/main`** — an earlier
  claim in this session that it was unpushed was wrong, caused by misreading
  `git branch --contains` (it listed `remotes/origin/main`; only the local branch
  was reported). Corrected here rather than only in chat, per the doctrine.
- All 10 non-primary worktrees were clean except `/private/tmp/l6-deploy`, which
  held one uncommitted line: `.vercel` in `site/.gitignore`. That change was real
  (main did not ignore it; positive control confirmed the grep worked) and was
  salvaged to `main` as `ab9babb` before the worktree was removed.
- The 8 sprint worktree branches are **content-absorbed** by the squash `aa84f34`.
  `git cherry` cannot see this — a squash has different patch-ids by construction.
  The decisive check was tree containment: `aa84f34` is a strict superset of
  `integration/site`'s `site/` tree (every file present, additions only).
- Two files existed on branches but not in the squash:
  `landing/SiteFoot.astro` and `download/PageFoot.astro`. These were **deliberately**
  consolidated — `site/src/layouts/Base.astro` says so in its own header comment
  ("the forks are gone"). Not lost work.

## Survivors (10) — kept because each is the only copy of unabsorbed work

All verified present on `origin` at the same SHA, so none is a single-copy risk.

| Branch | Unabsorbed commits |
|---|---|
| `main` | 0 (tip) |
| `ferry/r1-go-runbook` | 45 |
| `vane/launch-audit` | 16 |
| `vane/friction` | 9 |
| `ledger/epoch-binding-test` | 6 |
| `vane/site-audit` | 5 |
| `l6/verify-f1f2` | 4 |
| `quill/p3-1-signals` | 4 |
| `atlas/binding-deletion` | 3 |
| `quill/current-target-followup` | 1 |

## Deleted (45)

Grouped by the evidence that made deletion safe.

**A — tip is an ancestor of `origin/main`** (unambiguous; work is literally on main):
`l6/d10` `l6/d12` `l6/d14fix` `l6/d16` `l6/d16b` `l6/docs` `l6/docs3` `l6/domain`
`l6/htmlcomment` `l6/land-ledger2` `l6/live` `l6/prune` `l6/row` `l6/sprint`
`l6/sprint-squash` `l6/twoaudiences` `l6/unb9rk` `l6/verbs` `l6/zsh3` `l6/zshtrap`
`sable/d19-enumerate` `sable/d19-frame-label` `sable/handoff-heading-fix`
`sable/ledger-applied` `sable/pushed-landed-applied` `sable/runid-residual-closed`
`sable/site-residual-closed`

**B — `scripts/branch-audit.sh` reports UNABS 0** (patch content landed via squash):
`l6/land-ledger` `l6/safe` `quill/cli-first-errors` `quill/current-target`
`quill/preauth-audit` `swarm/lead/p0-github-and-supabase-scaffold`
`vane/launch-2-and-4` `vane/prepare-files`

**C — sprint branches, tree-containment verified against `aa84f34`:**
`app/dashboard` `shell/app-shell` `design/foundation` `ui/download` `landing/page`
`onboarding/start` `ui/primitives` `scribe/agent-instructions` `integration/site`
`l6/land-sprint`

## Deployment state at time of prune

A clean `rm -rf dist && npm run build` from `main` reproduced the live site
**byte-for-byte (md5) on all four routes** — `/`, `/download`, `/start`, `/app` —
against `https://coswarm-site.vercel.app` (200, not the 302 a per-deployment URL
gives). Positive control: `coswarm` appears 12x on the live homepage. Negative
control: the retired "on the record" framing appears 0x.

`ab9babb` changes only `site/.gitignore`, which does not affect built output, so
production remained current without a redeploy.

## What this does NOT establish

- Nothing was run against the *runtime* behaviour of the four pages — this is a
  static-content comparison only.
- The survivors' 93 unabsorbed commits were **not** reviewed for whether they are
  still worth landing. They were kept because they are unique, not because they
  were judged correct or current.
- `site/src/components/HowItWorks.astro`, `Install.astro` and `styles/hero.css` are
  carried on `main` but were deleted on `integration/site`. They may be dead files
  the squash re-introduced. Not investigated; flagged for whoever touches the site next.
