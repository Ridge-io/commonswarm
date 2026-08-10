# commonswarm migration — state as of 2026-08-10

**Operator-assigned via Spark. Steps 1–9 authorised; step 10 (deleting `cloud-swarm`) is NOT.**
Nothing irreversible has been done. `Ridge-io/cloud-swarm` is untouched and still serving.

## DONE and VERIFIED

| | |
|---|---|
| `Ridge-io/commonswarm` | created **PRIVATE** |
| history | rewritten, **881 commits on main**, both branches, 13 tags |
| pushed | `main` = `5be8730a` |
| verified | **fresh clone from GitHub**: `employer-a-domain` 0, `employer-b-domain` 0, positive control 902 email-bearing / 897 `yulanbot@gmail.com` |

## ★ THE SCOPE IS LARGER THAN THE HANDOFF SAID — READ THIS BEFORE GOING PUBLIC

**Spark's brief covered ONE address in commit metadata. Measured, there are three problems.**

**1. A SECOND employer address.** `<employer-b-address REDACTED 2026-08-10>` — 5 as author, 5 as committer,
2026-07-22, *earlier* in history than the employer-a-domain block. Not in the handoff. Found by
enumerating `%ae`/`%ce` rather than grepping for the address we were told about, which is Spark's
own "allowlist not blocklist" rule proving itself within minutes of being written down. **Both are
now rewritten.**

**2. THE ADDRESSES ARE ALSO IN COMMITTED FILE CONTENT, and the rewrite did not touch that.**
The history rewrite fixes *authorship*. It does not redact documents. Five files in the current
tree still contain the addresses as live references:

```
docs/design/contracts/WREN-LAPTOP-DOGFOOD-GOAL.md    invite recipient
docs/evidence/2026-08-02-v015-execution/…            invite fixture
docs/org/2026-07-26-simplification-state.md          the July analysis OF THIS VERY PROBLEM
docs/org/DEFECT-REGISTER.md                          D-… email routing
docs/org/charters/2026-07-29-dns-to-cloudflare.md    Cloudflare Email Routing DESTINATION
```

Plus **5 commit-message lines**, and a third identity — `tlangridge@gmail.com` in
`DEFECT-REGISTER.md`.

**⛔ MAKING `commonswarm` PUBLIC TODAY WOULD RE-EXPOSE EXACTLY WHAT THE REWRITE REMOVED.**
This is the single most important sentence in this file.

**3. `docs/org/2026-07-26-simplification-state.md` already documented this in July** — it counts
the rows and calls one *"a seat that set its own email"*. The problem was seen, written down, and
not remediated for two weeks.

## Decisions the operator still owns

- **Redact the documents, or accept them?** The Cloudflare one is an operational fact (a real
  routing destination). Redacting edits evidence documents, which this repo treats as durable.
- **`tlangridge@gmail.com`** — personal, not employer. In scope or not?
- **Commit messages** — 5 lines. Rewriting them is another history pass.

## Remaining steps, in order (4–9 of Spark's plan)

1. **Resolve the content question above.** Blocks going public.
2. **Remap SHA citations.** 220 real commit SHAs are cited in committed docs; **172 are on main
   and remappable** from `scratchpad/migrate/commit-map.tsv` (881 rows, pairing verified by
   message at 5 positions). The other **48 point at commits that were never on origin** — origin
   has exactly ONE branch — so they were **already** unresolvable to anyone cloning from GitHub.
   The migration does not worsen them.
3. **Re-cut the 13 releases.** ⚠️ Local tags stop at **v0.1.8**; releases run to **v0.1.11**. The
   tags for 0.1.9–0.1.11 are not in the clone and must come from GitHub before the old repo dies.
4. `install.sh:16` `REPO="${CSWARM_REPO:-Ridge-io/cloud-swarm}"` → commonswarm. **22 files**
   reference the old URL.
5. **CI allowlist guard** (not a hook — every offending push used `--no-verify`). Allowlist,
   measured: `yulanbot@gmail.com`, `tom@ridge.io`, `noreply@github.com`, `*@cloud-swarm.local`.
6. Make public, prove a real install from the new URL, **then** re-check `forks=0` and delete.

## What was preserved that a naive migration would have destroyed

- `advisor/2026-07-31-handoff-durable` — **2 commits that existed only on this laptop**. Origin has
  one branch. A clone-from-GitHub migration loses them silently. Carried in via a local fetch.
- `cloud-swarm-source` also holds **1 uncommitted file** (`.gitignore`), not carried — it is
  someone's WIP and not mine to commit.
- Dropped deliberately: 5 `refs/cmux/*` and `refs/codex/*` tooling refs.

## Tooling note

**`git filter-repo` HANGS on this repo** — 0% CPU, 0:00 CPU time, never starts. Not load; a probe
repo completes in 0.09s, so the tool is fine. `git fast-export` alone works instantly, so the
stall is inside filter-repo. Worked around with
`fast-export | perl (ident lines only) | fast-import`, restricted to lines beginning `author `/
`committer ` — verified content-safe first: **0** file-content lines start with those words AND
contain the addresses. BSD `sed` cannot express that restriction; perl can.
