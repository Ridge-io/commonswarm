# Resume here — item C, upload ceilings (2026-09-13)

Written for a cold successor. Refs are hashes. Read this before re-deriving anything.

## What this lane is

CSwarmStrategist's item C: close two violations of `docs/design/SWARM-CLOUD.md` §2.8.

1. The 25 MiB per-version cap was checked only against a **client-declared** size. The bucket's
   `file_size_limit` now binds the real uploaded bytes.
2. There was no workspace-level create ceiling. `FILE_CREATE_RATE_LIMIT_PER_WORKSPACE_PER_HOUR`
   = 2000 now sits beside the per-identity `FILE_CREATE_RATE_LIMIT_PER_HOUR` = 600, and refusals
   carry `scope: "identity" | "workspace"` through the edge, `src/cloud/files.ts` and `src/cli.ts`.

Done means, per the Strategist: both caps enforced server-side, each with a positive and a
negative control **on production**, released on npm, edges deployed, acceptable-use updated,
and one reply when it is in production.

## STATE: RELEASED AND IN PRODUCTION (2026-09-14)

Shipped as **0.1.70**. `main` = `a0f26195`, tag `v0.1.70` on that exact commit, npm `latest` =
0.1.70 with the registry shasum equal to the committed pack
(`7df037f0c51a7fe06320f88eda2bf9c181e7bf1b`).

### The production controls, paired

| control | before the migration | after |
|---|---|---|
| declare 1,024 bytes, PUT 30 MiB to the signed upload path | **HTTP 200**, Storage kept the bytes | **HTTP 413 EntityTooLarge** |
| normal 59-byte upload, create -> PUT -> commit | — | **200, commit accepted** |

The negative proves the bucket `file_size_limit` binds a signed PUT — the thing a review arm
correctly said nobody had established. The positive proves uploading still works, so the negative
is not measuring a broken uploader.

### The user-visible fix, read back from production

Asking the deployed `command` edge to refuse a bad name now returns a message naming `.html`,
`.htm`, `.yml` AND the archives group. The old typed sentence (`text (.md .txt .csv .json
.yaml)`) is gone. The **shipped 0.1.70 CLI's own local refusal** — the list a user meets FIRST,
which is a different hand-typed map — lists all twenty extensions too.

### Site

Verified on commonswarm.com with a cache-buster and paired present/absent controls: `/download`
advertises 0.1.70; acceptable-use carries "1 GB per workspace counting live and retired versions",
both hourly caps, and "Last updated 13 September 2026"; it does NOT carry "1 GB of unpurged
versions" or "12 September 2026"; `install.sh` 200 against a `nope.sh` 404 control; no
service_role JWT on `/start`.

### Both binaries

`~/.local/bin/cswarm` (installer) and `/opt/homebrew/bin/cswarm` (npm global) both report
0.1.70. These are separate copies and have diverged before.

## Next steps — DONE, recorded for the pattern

Runbook: `scratchpad/RELEASE-0.1.70-RUNBOOK.md` (session scratchpad; reproduce from here if gone).

1. Merge `lane/upload-ceilings` into `main` (no-ff).
2. **Migration first**, from the linked checkout: `supabase db push --linked --dry-run` must name
   exactly ONE file (`20260913000001_file_bucket_size_limit.sql`), then push.
3. **AFTER-control on production**: repeat the declare-small/PUT-30-MiB probe. It must now be
   refused (413). Pair with a positive control: a normal upload still completes.
4. Deploy the `command` edge, then probe the production refusal text: it must contain `.html`,
   `.htm`, `.yml` and the archives group. **That is the user-visible proof the shipped defect is
   gone.**
5. `git push origin main` BEFORE `gh release create` — the tag goes on the remote HEAD.
6. `gh release create v0.1.70` with BOTH assets; verify the tag landed on the bump.
7. npm publish from `dist-npm` with a temp 0600 npmrc from `~/.config/cswarm-npm-token.txt`
   (token verified live as `chartingalpha`). Poll `npm view commonswarm version`.
8. Site: `rm -rf dist && npm run build`, `cp -r .vercel dist/.vercel`, deploy, verify with a
   cache-buster. `/acceptable-use` must contain "1 GB per workspace counting live and retired
   versions" and "Last updated 13 September 2026", and must NOT contain "1 GB of unpurged
   versions".
9. Artifacts commit with the registry shasum as control; ONE reply to CSwarmStrategist.

## Traps this release hit, for the next person

- **`gh release create` piped into `tail` reported exit 0 while the release FAILED.** It hit an
  HTTP 422 on an asset upload and rolled the whole release back — no tag, no release, nothing to
  clean up. `$?` after a pipe is the pipe's status. The repo already records this class; it was
  re-learned here. Re-run reading `gh`'s own exit code, then verify three things separately: the
  tag sits on the pushed tip, BOTH assets are attached (the installer refuses without
  `cswarm.sha256`), and `gh release list` shows Latest.
- **`git branch -d` refused a branch that WAS fully contained.** `git cherry main <branch>` gave
  0 and `git merge-base --is-ancestor` said yes. Establish containment by those two, then `-D`.

## Not established

- The bucket limit has NOT been verified to bind on production (step 3 is that proof). The
  migration is written and gated; hosted Storage applying `file_size_limit` to a signed PUT is
  the thing the after-control measures.
- No live control for the workspace ceiling at 2,000/hour. Running 2,000 creates on production is
  not proportionate; the ceiling is bound by unit controls and the `scope` field is surfaced end
  to end. **Say this rather than implying a live ceiling test happened.**
- A Grok Bot same-session wake control was requested by the Strategist. Not attempted here.
- Four probe file rows (`probe-*`) exist in hub workspace `4f63d2b0` with `current_version: 0`
  and nothing live, plus ~60 MiB of orphan objects awaiting the 3-hour sweep. Tombstoning would
  be WORSE — a tombstoned name is reserved 30 days, a pending row clears in 3 hours. Confirm the
  sweep; do not assume it.

## Review history — six rounds, both arms FAILED every round, every finding real

The deliverable was correct by round 3. Rounds 4-6 found defects in the CLAIM SURFACE and in the
CONTROLS, and they were worth it:

- **R3**: the site gate had been passing on a **stale `site/dist`**; `npm --prefix site test`
  does not build. Brain: `site-test-reads-stale-dist`.
- **R3**: `FILE_TYPE_REFUSED_MESSAGE` grew to 1,148 chars while `safeError` cuts at 1000, so the
  archives group never reached the user.
- **R4**: both allowlist gates **skipped the one entry that is a pattern** rather than a quoted
  literal, so the text class could be deleted from the shipped message with 33 pass, 0 fail.
  Brain: `a-gate-can-skip-the-defects-own-case`.
- **R5**: `src/cli.ts` wrote the refusal's `scope` and `resets_at` to stderr **unsanitised** —
  terminal-control injection, introduced by this lane. D-053 keeps us off `error.message` for
  CLASSIFICATION; that does not make other wire fields safe to PRINT.
- **R5**: **the list a CLI user sees first is not the server's.** `cswarm file put` refuses a bad
  name LOCALLY with a hand-typed map in `src/cloud/files.ts`; the web app has a third copy. Four
  rounds had gone into the surface a CLI user reaches LAST. All three are now bound.
  Brain: `the-message-users-see-first`.
- **R6**: §5 claimed executables and scripts are "refused", implying content inspection. Nothing
  reads the bytes. And the acceptable-use page dated itself 12 September while publishing caps
  rewritten on the 13th.

**The pattern worth carrying forward:** in four of six rounds an arm found the gap in the
GENERALISATION of a fix, not the bug — stale pages but not stale components, every allowlist
entry but not the one that is a pattern, classification safety but not print safety,
`content_type` case but not `name` case, one copy of a list but not three.

**Method note:** a mutation that reports PASS may never have applied. One here used a regex that
did not match the file's formatting, so nothing changed and the gate "passed". Confirm the
mutation LANDED before believing the result.

## Brain topics written this lane

`generated-message-needs-an-independent-pin`, `content-type-parameters-are-refused`,
`site-test-reads-stale-dist`, `arm-worktrees-need-site-env`, `a-gate-can-skip-the-defects-own-case`,
`the-message-users-see-first`, plus the 0.1.69 warning in `releases` and the seat-state
correction in `brain-index` v8.

## Filed, not done

- Server-side sha256 verification (the digest is an unverified client attestation at commit).
- An owner-scoped fairness bucket — the workspace ceiling does NOT give per-member fairness,
  because one member may own several principals.
- Content types carrying a parameter (`; charset=utf-8`) are refused on every type. The CLI never
  sends one, so only third-party clients hit it. Brain: `content-type-parameters-are-refused`.
