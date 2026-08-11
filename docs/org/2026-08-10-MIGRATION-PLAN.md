# commonswarm migration — GOAL and PLAN

Supersedes the status in `2026-08-10-COMMONSWARM-MIGRATION.md`, which records what was already
done. This file is the goal, the plan, and the ordering constraints.

## THE GOAL, stated so it can be measured

> **`Ridge-io/commonswarm` is the public home of CommonSwarm, carrying no employer-address
> contamination in ANY surface, serving every release so that `curl … | sh` works from the new
> URL — with `Ridge-io/cloud-swarm` deleted and NO WINDOW in which a stranger's install breaks.**

Five success criteria, each a measurement with a positive control, not a judgement:

| # | criterion | how it is proven |
|---|---|---|
| 1 | No contamination in **metadata** | fresh clone from GitHub, `%ae`/`%ce` grep = 0, control = total email-bearing commits |
| 2 | No contamination in **commit messages** | `git log --format=%B` grep = 0, control = a string known present |
| 3 | No contamination in **file content** | `git grep` over the tree = 0, control = a string known present |
| 4 | The installer works from the new URL | real `curl … \| sh` into an isolated prefix, `--version` and **sha256** both match |
| 5 | The old repo is gone, safely | `forks=0` re-checked **immediately** before deletion, and criteria 1–4 already green |

**Criterion 5 is the only irreversible step and it is LAST.** Deleting a repo *with* forks
promotes a fork to root and the data survives — so `forks=0` is the fact that makes deletion an
actual purge, and it is the one fact that can change under us.

## The state right now, measured 2026-08-10

```
cloud-swarm    888 commits on main, 14 releases, PUBLIC, forks 0     <- live, serving
commonswarm    main 5be8730a, 0 releases, PRIVATE                    <- STALE by 7 commits
contamination on current main:  44 metadata fields, 5 message lines, 6 files
```

**The earlier rewrite is stale and must be redone.** Everything from today — v0.1.12, D-083, the
onboarding-prompt fix, D-081's mitigation — landed after it. That is not waste: the pipeline is
mechanical and re-running it over a longer history costs minutes.

## THE ORDERING CONSTRAINT THAT BITES, and it is not the obvious one

`site/package.json` has `"sync:installer": "cp ../install.sh public/install.sh"`, wired into
`build`. **Every site build republishes repo-root `install.sh`.**

So the constraint is NOT on releasing — it is on **landing the repoint commit**. If
`install.sh:16` is changed to `Ridge-io/commonswarm` before that repo is public and serving
releases, then the *next unrelated site deploy* ships it and **every install 404s**. The repoint
must land only after criterion 4 is green.

`install.sh` currently reads `Ridge-io/cloud-swarm`, deliberately.

## STATUS: criteria 1–4 GREEN. Only criterion 5 (deletion) remains, and it is NOT authorised.

```
commonswarm  PUBLIC, main 4931e0a, 891 commits, 14 releases      <- the live home
cloud-swarm  PUBLIC, untouched, still serving, forks 0           <- frozen, awaiting the call
```

| # | criterion | result |
|---|---|---|
| 1 | metadata | **0**, control 912 email-bearing commits |
| 2 | commit messages | **0**, control 912 subjects |
| 3 | file content, ALL history | **0**, control 6 files carry the REDACTED marker |
| 4 | real install from the new URL | **0.1.12**, sha256 `224e40bd…455bb5`, no override |
| 5 | old repo deleted | **NOT DONE — operator's call** |

Criteria 1–3 measured on a **fresh clone from GitHub**, not on my working copy. That mattered:
my own checkout read **44** after the cut-over, because `git fetch` does not force-update existing
tags — every `v0.*` tag and the advisor branch still pointed at pre-rewrite commits. Deleting and
re-fetching them brought it to 0 against a control of 912. **A working checkout that still
reaches the old objects is a live hazard**: one careless `push --all` republishes them.

### Order that was followed, and why

The repoint landed **after** the new repo was proven to serve, not before — verified first with
`CSWARM_REPO=Ridge-io/commonswarm` as an override, then again with **no override** against the
deployed installer. `sync:installer` copies repo-root `install.sh` into `site/public/` on every
build, so that line ships on the next site deploy regardless of what the deploy was for.

All 14 releases were mirrored and checked **per release** for both `cswarm` and `cswarm.sha256` —
not in aggregate — because a release missing its checksum is refused by the installer, and that
exact failure happened earlier the same day behind a green deploy log.

### Still to do, in order

1. Remap the SHA citations (172 of 220 are remappable; the other 48 point at commits that were
   never on origin, so they were already unresolvable to anyone cloning from GitHub).
2. The CI identity guard.
3. **Criterion 5.** Re-check `forks=0` immediately before, then delete. Irreversible.

## PLAN

### Phase 1 — prepare (no operator decision, nothing irreversible)

1. **Redact the three content surfaces** in `cloud-swarm` first, so the rewrite carries clean
   content. Method: replace the address, **keep the fact**, e.g.
   `<operator work address — redacted 2026-08-10>`. This satisfies the repo's evidence doctrine
   (the analysis survives, the superseded value is marked) and removes the exposure. The
   Cloudflare charter names a real routing destination; it gets
   `<destination address — held by the operator>` so the operational fact is not lost.
2. **Re-run the rewrite** over current main with the mailmap covering BOTH addresses, plus a
   commit-message pass. Produce a fresh commit-map.
3. **Remap the SHA citations** — 172 of 220 cited SHAs are on main and remappable; the other 48
   point at commits that were never on origin, so they were already unresolvable to anyone
   cloning from GitHub and the migration does not worsen them.
4. **Write the CI identity guard** — mine, not ported. Allowlist derived by measurement.

### Phase 2 — cut over (reversible until 6)

5. Force-push the rewritten history to `commonswarm`, all branches and tags.
6. **Re-cut all 14 releases** with binary **and** `cswarm.sha256`. A release without its checksum
   is refused by the installer — measured today, it is how the first v0.1.12 attempt failed.
7. Verify criteria 1–3 on a **fresh clone from GitHub**.
8. Make `commonswarm` public.
9. Land the `install.sh` repoint + doc references, deploy the site, and verify **criterion 4** by
   a real install.

### Phase 3 — the irreversible step

10. Re-check `forks=0`, then delete `cloud-swarm`. **Only after 1–9 are green.**

## Swarm usage

**cloud-swarm swarm only. No agent messages the PromptEden swarm; Spark only if unavoidable.**
The rewrite and the deletion are single-writer by nature and stay with me. What is delegable is
read-only and independent:

- classify the 22 files referencing the old URL: LOAD-BEARING vs HISTORICAL
- inventory every release's assets, so re-cutting reproduces them exactly
- independently verify criteria 1–3 against my clone, with their own controls

## What could still go wrong, named in advance

- **A release re-cut without its `.sha256`** breaks every install and the deploy log looks green.
- **Landing the repoint early** 404s installs on the next unrelated site deploy.
- **Deleting with forks > 0** promotes a fork and purges nothing.
- **GitHub keeps unreachable objects fetchable by SHA**, so a force-push on the OLD repo would not
  purge anything — which is why this is a new repo and not a rewrite in place.
