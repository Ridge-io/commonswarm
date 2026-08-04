# Execution orders — MVP gap-closure plan for Lead7

> **Current-state note, 2026-08-04 (D-044):** the cross-owner local-isolation orders below are
> superseded. Current turns share the operator's worker and cwd and carry provenance in the prompt.

> **Correction, 2026-08-03.** This document names the listener adapter boundary `ListenerHostAdapter`. **No such symbol exists in the tree** — the real boundary is `ListenerModel` at `src/listener/types.ts:71`, a single `prompt()` method, with adapters `grok-model.ts` and `opencode-model.ts`. Anyone grepping the name written here gets a confident zero, which is exactly the failure mode this repo's doctrine warns about. The superseded name is left in place below rather than rewritten, because this is a historical record; use `ListenerModel` when acting.


Author: AdvisorClaude2 (advisor seat, analysis-only mandate)
Date: 2026-07-31, ~15:10 CDT
Basis: the five dossier files in this directory + ADVISOR-REVIEW.md, all anchors
independently re-measured today (git heads, tag/release/checksum, 10 routes + 404
control, `/download` 0.1.4 ×2, Sable diff, worktree counts 19+9, live ledger,
deploy-input split). Operator decisions recorded below are final.

**Goal:** close every remaining MVP gap as quickly and safely as possible. Legal
work is explicitly deferred (see decisions), which removes one whole lane from
the critical path — the plan below is the shortest remaining route.

---

## 0. Operator decisions (final, 2026-07-31 — do not re-ask)

| # | Decision |
|---|---|
| 1 | **Clone A** (`/Users/yulanbot/Developer/Ridge.io/cloud-swarm`) is the permanent operator/deploy clone. |
| 2 | **Land `.gstack/` in `.gitignore`** — yes, one explicit commit. |
| 3–5 | **Legal (dates, drafts, counsel, DMCA, trademark): DEFERRED to post-MVP.** Do not spend any lane on it now. Record as a post-MVP TODO block (see §6). Do NOT remove the draft banners; do NOT activate anything. |
| 6 | Cross-owner canary accounts **already exist**: `tlangridge` (this mac mini) and `Ridgeio` (operator's laptop). Use them. |
| 7 | **Browser QA may open a controlled Chrome window/profile anytime.** The QA lane is unblocked permanently. |
| 8 | **Branch audit commissioned** — bounded read-only pass after consolidation. Remote deletion remains operator-only. |
| 9 | **Sable rollback: preserve diff as evidence, then discard** the dirty file and remove the worktree. Operator wants clean folders. |

## 1. Stop-the-line rules (unchanged, re-verified today)

1. **No deploy from any clone until Slice 1 completes and its F-1 gate is green.**
   Clone A working tree still reads `CSWARM_VERSION=0.1.3` (`site/src/lib/install.ts:36`,
   measured today); a deploy would roll `/download` back 0.1.4→0.1.3.
2. **Never merge Sable's dirty `supabase/functions/read/index.ts`** (−112 lines,
   removes `sender_owner_relation` + cursor; re-measured today). Disposition per
   decision #9: `git -C <sable-wt> diff > scratchpad/2026-07-31-common-swarm-handoff/sable-rollback.diff`,
   then discard and remove the worktree.
3. **No worktree/branch deletion outside the audited passes in §4 lanes W/X.**
4. **Every SHA-changing lane needs Grok + Gemini via `agy` on the exact SHA.**
   Empty PASS is not a review; SHA moves → both rerun. Claude reviews only where
   §4 explicitly says so.
5. Keep the fleet quiet: no ack pings, checkpoint only on blockers/completion,
   reap workers immediately after landing. **Nobody messages AdvisorClaude2 except
   Lead7, and only when genuinely stuck** (operator directive).

## 2. Slice 1 — preserve, then consolidate (Lead7 alone, first, today)

Nobody else touches either clone until this lands.

1. **Push the dossier branch NOW** (cheapest, highest-value single command):
   clone B is on `advisor/2026-07-31-handoff-durable` at `ccf7f3d` (docs-only,
   7 files under `docs/evidence/2026-07-31-handoff/`), **unpushed** — verified
   today via `git ls-remote origin 'refs/heads/advisor/*'` → empty.
   `git -C /Users/yulanbot/Developer/Ridge.io/cloud-swarm-source push -u origin advisor/2026-07-31-handoff-durable`
   Then run Grok+Gemini on `ccf7f3d` and land it to main. Add this file
   (EXECUTION-ORDERS.md) and `sable-rollback.diff` to that evidence dir in a
   follow-up commit on the same branch before landing, so the whole handoff is durable.
2. **Sable quarantine** (decision #9): save the diff (path above), then
   `git -C <sable-wt> checkout -- supabase/functions/read/index.ts` and
   `git worktree remove` it. Record in the cleanup manifest.
3. **Consolidate clone A**: save `.gitignore` edit as a patch file outside the
   tree → stash → `git merge --ff-only origin/main` → reapply → commit the
   `.gstack/` ignore line (decision #2). Never `reset`/`checkout --` over user edits.
4. **Structural re-verify** (no values printed): `site/.env` (both `PUBLIC_*`
   keys, zero service-role markers), `site/.vercel/project.json`,
   `supabase/.temp/project-ref` all present.
5. **Clean site build + F-1 gate** on BUILT output, same invocation:
   `grep -c '0\.1\.4' site/dist/download/index.html`   → must be ≥ 2 (positive control)
   `grep -c 'CSWARM_VERSION=0\.1\.3' site/dist/download/index.html` → must be 0
6. **Baseline gates on the consolidated tree**: `npm test`, `npm run check:tests`,
   `npm run build`, `npm run check:edge`, `npm --prefix site test`.

Acceptance: `git rev-parse HEAD` == `git ls-remote origin main` in clone A; F-1
gate green; deploy inputs present; status clean or only the named commits;
worktree counts 19 + 9 minus Sable only.
Rollback: ff-only creates no objects — `git reset --hard af87f8a` restores exactly.
Stop: any ff conflict beyond `.gitignore`, or any deploy input goes missing.

## 3. Sequence after Slice 1

```
Slice 1 (Lead7, serial)
  ├── Lane Q: authenticated production QA  ── UNBLOCKED (decisions 6+7) — start immediately
  ├── Lane R: ledger/doc reconciliation    ── docs-only, parallel
  └── Lane H: host protocol matrix         ── writes nothing, parallel (can even start during Slice 1)
Lane Q results ──► fix lane(s) for anything QA finds (incl. pending-access refresh, credential copy)
Lane H matrix  ──► Lane A2: second host adapter (one owner)
Lane H + A2    ──► Lane D: durable delivery/ack spec ── Claude security review ── implement
Lane Q done    ──► cross-owner canary (tlangridge ↔ Ridgeio) + start 24h/7d longevity canaries
after all code lanes land ──► one release/deploy cycle per §14 of NEXT-EXECUTION-PLAN.md
last ──► Lane W (worktree cleanup) then Lane X (branch audit)
```

Rationale: QA is now the only lane that validates the actual customer journey and
it is fully unblocked — start it the moment the clone is safe. Legal's removal
from the critical path means the next deploy is driven by QA findings + adapter
work, not copy. Cleanup stays last: irreversible, blocks nothing.

## 4. Lanes (quiet-swarm, ≤3 workers + Lead7 at any time)

| Lane | Owner/model | Scope (files owned) | Blocked by | Review |
|---|---|---|---|---|
| **Q. Authenticated production QA** | Wren or Grok, controlled Chrome profile (decision 7) | Phase-3 journey from NEXT-EXECUTION-PLAN §6 verbatim: cold-browser magic link, workspace create, add-own-agent, prompt auto-close/Done/Back, roster, live feed ≤5 s, teammate invite consumption + pending-access refresh check, remove/revoke, mobile 390×844, a11y. Use disposable inbox + existing `tlangridge` account. Evidence to `.gstack/qa-reports/` + summary committed to `docs/evidence/`. Diagnose, do NOT fix. | Slice 1 | Kimi K3 reads the consumer-design findings |
| **R. Ledger/doc reconciliation** | Grok, docs-only worktree | Live ledger (`swarm task list`): close the 5 awaiting_review + landed actives **on main/release evidence anchors, never branch names** (measured counterexample: `grok-acp-host-core` is Lattice's in the ledger, Lead7's by branch name). Docs: `TODO.md`, `docs/org/CHARTER.md`, `DEFECT-REGISTER.md` (D-003, D-019, D-020, D-022/023, D-034 statuses), invite-spec checkboxes, roster evidence header. Superseded lines stay, marked dead. Add the post-MVP legal TODO block (§6). | Slice 1 | Grok+Gemini on exact SHA |
| **H. Host protocol matrix** | Grok measure + Gemini/AGY inversion | Writes nothing. Measure Codex CLI/app-server, Claude Code, Gemini CLI/AGY/opencode, Grok (reference) against the Phase-4 matrix fields: start/resume, persistence, isolation, forced tool denial + canary, cancellation, auth discovery, structured output, concurrency, failure modes, honest fallback. Deliver matrix + ONE recommended adapter, chosen by measured safety × user value, not brand. | nothing | Gemini inversion of the matrix |
| **A2. Second host adapter** | Grok impl, fresh worktree | `src/cloud/` host adapter behind `ListenerHostAdapter` boundary + tests + docs. Provider code may not infer sender ownership. Full acceptance list in NEXT-EXECUTION-PLAN §7: deny canary before ready, isolated cross-owner path, one-winner concurrency, credential absent from argv/env/status/logs, revocation stop bound. | Lead7 accepts H's matrix | Grok+Gemini on exact SHA |
| **D. Durable delivery/ack** | Senior lane (Grok spec, Lead7 integrates) | Phase-5 spec: first prove `swarm.inbox_deliveries` unused (schema/count query only), then rule evolve-vs-new-table; claim/ack/lease at the command boundary, at-least-once semantics, additive migration, capability `delivery_ack: 1`, full test list in §8 of the plan. | H (matrix informs adapter interplay) | **The one Claude review**: single adversarial security pass over combined D+A2 design before implementation. Then Grok+Gemini on the implementation SHA. |
| **C. Cross-owner canary + longevity** | Lead7 with operator's two machines | Phase-6 script: `tlangridge` ↔ `Ridgeio`, hostile cross-owner ask, verify fresh session/zero tools/no context, same-owner control arm, revocation stop. Start 24 h and 7 d listener canaries; 30 d timer starts now and elapses on its own. | Q done; A2 optional | evidence doc under `docs/evidence/` |
| **W. Worktree cleanup** | Grok, batched | The 27 remaining registered worktrees per SWARM-AND-WORKTREES §10, in its suggested order (#21/#22/#23/#26 first; legal #13 last — retain until legal work resumes post-MVP). Re-verify `git cherry`/status per tree immediately before removal; complete before/after enumeration is the evidence. | after all code lanes land | manifest reviewed by Lead7 |
| **X. Branch audit** (decision 8) | Grok, read-only | All 67 remote branches: `scripts/branch-audit.sh` + per-branch disposition vs `origin/main` recorded to a committed manifest. **No deletions** — output is a recommendation list for the operator. Note: count was 68 at dossier time, 67 today; find which branch moved. Worktree-less branches (7 known: 6× `quill/*`, `swarm/Forge/agent-connect-panel-hidden-fix`) are highest-risk = retain-unassessed until dispositioned. | after W | Lead7 reads manifest |

Fleet/token discipline: one `/goal` per worker containing files-owned, non-goals,
acceptance, stop conditions; Grok for all routine lanes; Kimi K3 only for Lane Q
design read; Claude only for the single Lane-D security review; reap on completion.

## 5. Definition of MVP-done (adapted from NEXT-EXECUTION-PLAN §1, legal removed)

1. One authoritative deploy clone, current, gated (Slice 1). ✅ when landed
2. Ledger/docs agree with main and production (Lane R).
3. Fresh signed-in production walkthrough passes desktop + mobile, including
   cold-browser magic link and pending-access refresh (Lane Q + fixes).
4. A second CLI host receives asks natively, or the matrix proves why
   foreground NDJSON is its honest mode (Lanes H/A2).
5. Durable delivery/ack designed and preferably shipped (Lane D).
6. Real two-human cross-owner canary passed (Lane C).
7. Release evidence states established AND not-established.
8. Clean folders: Sable discarded, worktrees reaped, branch manifest delivered (W/X).

## 6. Post-MVP TODO (operator-deferred — record, do not work)

- Legal: resolve elapsed proposed-effective date (27 Jul 2026), fact errors
  (GitHub-only auth, static/no-third-party claim, missing Resend, `~/.CommonSwarm`
  → `~/.cswarm`, GitHub-derived identity), stale-date build guard, counsel review,
  activation, DMCA filing, trademark search. All operator-owned.
- Credential-lifetime copy ("lasts a few hours" → 30-day rotating outcome) —
  fold into Lane Q's fix wave only if QA confirms it confuses; otherwise post-MVP.
- 30-day wall-clock canary completion; telemetry decision; self-serve
  export/delete; realtime wake hints; rich avatars; billing.

## 7. Advisor protocol

AdvisorClaude2 is on standby. Only Lead7 may message it, and only when genuinely
stuck on a decision this document and the dossier do not answer. Include the exact
measurement that blocked you. No status pings, no review requests (reviews go to
Grok/Gemini per §1 rule 4).
