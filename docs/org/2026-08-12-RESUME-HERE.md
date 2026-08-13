# RESUME HERE — 2026-08-12

Supersedes `docs/org/2026-08-07-RESUME-HERE.md`. Written for someone reading the repo cold.

## PARKED 2026-08-12 by operator — read this block first

Work is parked deliberately, to be picked up in a day or two. **Nothing is mid-flight and nothing is
blocked.** v0.1.16 is shipped, verified live, and the tree is clean.

**Pick up here:** run the two-agent dogfood against 0.1.16. It is the only open item on this lane and
it is the first measurement of steady-state `--permissions allow`, which twelve review rounds could
not establish — the permission-boundary canary forces deny regardless of mode, so it proves the deny
path only.

**Repo state at parking:** `main` clean, 0 uncommitted, 0 unpushed. Worktrees reduced 17 → 2 (this
checkout and the `swarm` repo's active one). **No branch was deleted** — worktree removal leaves
branches intact, and `cloud-swarm-source` still has all 14.

**Two things found while parking, neither caused by this session:**

1. **`cloud-swarm-source` is CORRUPT.** `git fsck` reports 12 missing objects and invalid sha1
   pointers on `refs/remotes/origin/main`, `refs/remotes/origin/HEAD`, and four tags
   (`v0.0.1`, `v0.1.0`, `v0.1.1`, `pre-rebase-backup`). Seven branches cannot be walked at all, so
   they could not even be bundled. It is a clone of the **frozen, superseded** `Ridge-io/cloud-swarm`,
   so nothing current depends on it — but do not treat it as a backup of anything.
2. **`Ridge-io/cloud-swarm` still publicly serves an operator employer address** in
   `SUCCESSION-PLAN.md`. The same string was redacted from the live `commonswarm` repo at `4bb6158`
   and verified gone via the GitHub API. That repo has **0 forks**, which is the condition under
   which deletion actually purges — an operator decision, deliberately not taken.

## What this session was

The operator asked one question — *"why would the agent be on permissions deny? we want low
friction here by default"* — and it turned into a permission-default change plus nine D-036 review
rounds — twelve by the end — that found real defects in every single round, several of them inside
my own corrections, and one of which broke the repo (D-089).

## Refs, by hash

| ref | what it carries | state |
|---|---|---|
| `4844b4e` | the permission default flip (deny → allow), D-084 | landed |
| `de6ecee` | eleven strings the flip falsified | landed |
| `87fe7ed` | round-2 corrections: a false competitive claim, the canonical spec | landed |
| `8e666ab` | D-086 first session-scope fix | landed |
| `65527457` | **its message claims a reply-text fix the commit does NOT contain** | landed, corrected by `47dcddd` |
| `47dcddd` | the reply-text guard that `65527457` claimed | landed |
| `d20f81e` | session/load absent-vs-malformed | landed |
| `e487971` | three-way load outcomes; a FALSE redundancy claim, corrected by `da8d045` | landed |
| `da8d045` | injective canary key (the NUL collision) | landed |
| `e82e906` | duplicate optionIds, bare JSON-RPC frames | landed |
| `eed7701` | three false onboarding claims (ps/wake/codex) | landed |
| `6b56497` | the credential rule contradicted its own sanctioned form | landed |
| `0d743ba` | **JUNK — message `c0`, author `T`.** Built from a review arm's temp tree and pushed; it REVERTED `6b56497`. See D-089 | landed, superseded by `cfb9ca0` |
| `cfb9ca0` | provider bridges, D-088 sequencing, and D-089 itself | landed |
| `3309e19` | HEAD of `main`: "brief" was false for the fallback receiver | **LIVE on GitHub, NOT released** |

**RED, and read this before trusting any git output in this checkout:** a D-036 review arm set
`core.worktree` in this repo's local config while verifying "from a separate checkout". Every git
command then operated on its `/tmp` tree while `npm test`, `grep` and the editor read the real one —
`git status` reported clean over six modified files, `git add -f` did nothing, and a commit built
from that tree (`0d743ba`, message `c0`, author `T`) was pushed and **reverted a landed fix**.
Fixed and recorded as **D-089**. The one-command check is `git rev-parse --show-toplevel`; run it
before trusting a clean `git status` here. Review arms are now told explicitly not to touch this
repo's config, and the last two rounds left it clean.

**RED:** `65527457`'s commit message is wrong and cannot be edited. Three of its five claims are
true; the two about the reply-text path are false. See D-086 "round 3".

## What is LIVE vs merely written

- **LIVE — `main`** on GitHub, through the docs commits above.
- **LIVE — v0.1.16 is RELEASED.** `gh release` on `Ridge-io/commonswarm` with **both** `cswarm` and
  `cswarm.sha256`. Verified by a real cold install through the published installer
  (`curl -fsSL https://commonswarm.com/install.sh | CSWARM_INSTALL_DIR=… sh`), which reported
  `cswarm 0.1.16 (protocol 0.1.0)`. The installed binary was probed directly: the three retired
  strings absent, the new ones present, with a positive control on the same invocation.
- **LIVE — the site is DEPLOYED.** `commonswarm.com` 200, `/install.sh` 200 against a `/nope.sh` 404
  control, `/download` carries 0.1.16 and no 0.1.15, `/start` backend meta non-empty with zero
  service-role JWTs. The onboarding prompt is client-generated, so it was verified in the **deployed
  bundle** (`/_astro/AgentConnect…js`): `--permissions allow` and the codex bridge present, the false
  `ps` claim and "It is brief and it is real" absent, control present.
- **NOT run:** the two-agent dogfood against 0.1.16. Standing operator ask, and the first measurement
  of steady-state `allow`.

## The next concrete action

1. Confirm both D-036 arms are clean on the current HEAD. Twelve rounds have run; every one found
   something real, so do not assume the next is a formality. **Tell each arm not to touch this
   repo's config** — that instruction is what stopped D-089 recurring.
2. If nothing blocks: `bash scripts/build-release.sh`, then `gh release create v0.1.16` with **both**
   `dist-release/cswarm` AND `dist-release/cswarm.sha256` — v0.1.12 shipped without the sha256 and
   the installer refused every install.
3. Deploy the site: `cd site && rm -rf dist && npm run build && cp -r .vercel dist/.vercel && vercel
   deploy dist --prod --yes --scope ridgedotio`. The `cp -r .vercel` is load-bearing (see AGENTS.md
   trap 5). Then verify the DEPLOYED page, not the source.
4. Run the two-agent dogfood against 0.1.16 under the new `allow` default. **Steady-state `allow`
   has never been measured** — this run is its first measurement.

## Deliberately DEFERRED

- **D-085**: ~25 documents still describe the D-044 cross-owner sandbox as live. The enumeration is
  in the entry. `docs/evidence/**` is deliberately excluded — those are dated records and rewriting
  one destroys what it exists to be.
- **D-087**: an out-of-turn permission request is answered normally. Not fixed on purpose; the entry
  records why and what measurement the fix needs first.
- **Per-relation permissions** (allow `same_owner`, deny `cross_owner`). This is the honest fix for
  the posture D-084 traded away. Blocker: `prompt()` takes a rendered string, so the permission
  callback cannot see the relation. It would also partly reverse D-044, which is an operator
  decision, not a cleanup.
- Six known-confusing round-3 CLI items from earlier sessions remain unfixed (`"must be a UUID"`
  false for valid UUIDs, invite-link decode jargon, the 100-line `--help` wall, bare HTTP status on
  a refused credential, `token mint` handoff, agent-mode anon-key never validated).

## What was NOT established

- **Steady-state `--permissions allow` is unmeasured.** The permission-boundary canary forces deny
  regardless of mode, so it proves the deny path only. The CLI's own limit strings say so and are
  still true. This is the single biggest gap and the dogfood run is what closes it.
- **The direct real-provider probe did not complete a canary.** Against real `claude-agent-acp`, a
  session opens in ~1.3s with a real session id, but `runPermissionBoundaryCanary` returns
  `sawPermissionRequest: false` — **identically on `e82e906` and on the pre-change base `eef001e`**,
  so it is not a regression from this work. It is also **not evidence of a product defect**: that
  harness is not the production canary path (no retries, no adapter `workerCanary`), and `claude`
  reached ready twice in the last two-agent dogfood. Someone should still find out why.
- Whether any of the four providers request permission outside a prompt turn (D-087 needs this).
- The edge-function and database suites were not run this session; nothing in this range touches
  those surfaces.

## Corrections to claims already published

- **`65527457`'s message** claims the reply-text path was fixed and tested. It was not. Audited
  claim-by-claim in D-086 "round 3".
- **`e487971`'s message** claims the canary session-match and the reject key were a redundant pair so
  no single mutation could discriminate them. **False when written.** The key was not injective, so
  the guard was load-bearing. Corrected in `da8d045`; the redundancy is real *now* and was not real
  *then*.
- **My own first correction of the design doc** said the cross-owner sandbox was "never built". It
  was built and D-044 retired it on 2026-08-04. Corrected in place.

## The three things worth carrying forward

1. **When a default moves from closed to open, ask what it was suppressing.** D-084 was correct in
   isolation and armed a fail-open one layer down, in a different file. No test of the change could
   have found it.
2. **A correction banner at the top of a document does not correct its body.** Four sites in
   `AGENT-RECEIVE-MVP.md` kept asserting a retired design under a banner that had said so for a
   week. Anyone arriving by grep reads the dead version.
3. **Verify a fix landed by grepping the COMMITTED OBJECT, with a control.** A working tree is a
   claim about the future. And brace `"${sha}:path"` — the unbraced form silently manufactured two
   zeros while I was investigating whether something was absent, which is the one situation where a
   fake zero is indistinguishable from the answer.
