# Swarm, agent lanes, task ledger, and worktree inventory

Snapshot: **2026-07-31 08:57 CDT**  
Comparison base for every ahead/behind figure: `origin/main` at
`a21db3f59864c1142d6d270d2aa309f98b75ed07`.

## 1. Current swarm state

★ **THIS ENTIRE SECTION WENT STALE WITHIN ~20 MINUTES. READ THE CORRECTION FIRST (F-6).**

~~The CommonSwarm coding swarm is intentionally **paused**. This is an explicit user direction to
conserve model credits for another project. Do not restart agents just to collect acknowledgements
or update stale task states.~~

~~The current primary process is not joined to the local `cloud-swarm` registry:~~

```text
swarm whoami --swarm cloud-swarm
→ Not joined
```

~~Because it is not joined, `swarm inbox` and `swarm task list` are unavailable from this process.~~

★ **SUPERSEDED — DEAD (2026-07-31 09:45).** Measured membership at review time:

```text
Anvil         [a2a]              — Hermes/Anvil provisioning agent, operator authority
Wren          [a2a, xai]         — GUI-origin uxtest endpoint
Lead7         [cmux/codex]       — CommonSwarm lead, JOINED and issuing goals
AdvisorClaude [cmux/claude-code] — adversarial review seat
```

`swarm task list --swarm cloud-swarm` **works and returns the full ledger** — see §4, which is
corrected accordingly.

**Why this line is kept rather than rewritten.** The error is not that someone got the facts
wrong; the facts were right when written. The error is *architectural*: **transcribing live
process state into a static document guarantees it rots, and a zero-context reader cannot tell a
stale transcription from a current one.** This section is the proof. Do not re-transcribe swarm
state here when you update this dossier. Point at the instrument:

```sh
swarm members --swarm cloud-swarm
swarm task list --swarm cloud-swarm
```

The standing intent — keep the fleet small and quiet, do not wake agents merely to collect
acknowledgements — still holds and is good policy. "The swarm is paused" is a *measurement* of
that policy, and it is currently false.

A read-only `swarm members --swarm cloud-swarm` at authoring time enumerated exactly two remote
A2A members:

| Agent | Transport/family | Endpoint | Current role/state |
|---|---|---|---|
| Anvil | A2A / UNKNOWN | `http://127.0.0.1:18790/` | Hermes/Anvil provisioning agent on the mini, has operator authority; no continuation lane assigned |
| Wren | A2A / xAI | `http://100.95.177.37:18791` | GUI-origin UX-test endpoint; no continuation lane assigned |

There are no resident local coding agents in the registry, no unacknowledged message count was
observed for the two members in the last joined snapshot, and cross-family review is currently not
available from these two members alone. Neither was messaged or woken during this dossier pass.

Vesper, the temporary Claude adversarial reviewer, is absent from current membership as requested;
there is no continuing Claude token burn from that seat.

## 2. Collaboration subagents attached to this thread

These are Codex collaboration agents, distinct from the local `swarm` registry.

| Lane | Agent | Status | Result | Remaining work |
|---|---|---|---|---|
| Adapter contract/idempotency/supervisor audit | Schrodinger (`adapter_contract_audit`) | completed | Specified deterministic reply IDs, persisted exact reply effects, bounded retries, credential-safe detached supervisor, and audience/RLS behavior | None in that lane. The recommendations were implemented in v0.1.4. Re-check only when adding another host adapter or changing delivery semantics. |
| Wake security seam | Fermat (`wake_security_seam`) | completed | Correctly blocked tool-enabled wake until server-proven sender ownership existed; specified `same_owner`/`cross_owner`/`unknown` contract and fail-closed behavior | None in that lane. Server relation landed in `24ec0f9` and v0.1.4. |
| Host protocol matrix | Lorentz (`host_protocol_matrix`) | interrupted | No final matrix was delivered | This remains real next-phase work: measure Codex, Claude, Gemini/AGY/opencode, ChatGPT/Cowork/desktop integration surfaces and identify native vs foreground-only support. |

No collaboration agent is currently running. There was no in-flight work to wait for before this
dossier was written.

## 3. Historical swarm lanes and what became of them

This section reconstructs the meaningful work lanes from branches, task state, messages, and
landed commits. Names not present in the current member list are historical; do not assume their
processes still exist.

| Agent/lane | Purpose | Outcome | Current status/blocker |
|---|---|---|---|
| Lead7 | Overall orchestration, integration, release, deploy, production canaries | Workspace-first UX, invite flow, roster, receive v0.1.2–0.1.4 landed and deployed | Paused. Next job is repository/legal/task-state reconciliation, not more feature coding. |
| Kimi K3 design agent via opencode/cmux | Consumer redesign from homepage through first workspace; later header roster repair using user screenshots | Design intent is reflected in live consumer pages and header-roster implementation | No live process/registration remains. Future design review should be a new bounded lane with exact screenshots and acceptance sizes. |
| Onyx | Dogfood CommonSwarm from inside Dogfood Workspace; test whether agents could converse | Exposed transient read/ask 500s, short-token/session confusion, and the fundamental idle-host problem; Onyx messages appeared in the feed | No current lane. Do not treat Onyx's earlier idle CLI as a product receive success; v0.1.4 later supplied the detached listener. |
| Kepler | Server sender-owner relation contract | Absorbed into main as `24ec0f9` and follow-up parser/cursor commits | Complete; clean historical worktree remains. |
| Sable | Receiver hardening | Branch commits were superseded by main's `7c0f7c5`/`55f445e`; worktree now contains a dangerous uncommitted rollback | Quarantine; never merge dirty file. Remove only after preserving evidence and explicitly discarding the rollback. |
| Nori | Hosted remove-member/revocation UI/server integration | Relevant lifecycle behavior is on main; its branch is behind with no unique patch | Complete in code, but the task ledger was not closed. Worktree has only the shared `.gitignore` edit. |
| Juniper | Runtime fixes and start/onramp landing | Changes are absorbed on main | Worktrees are cleanup candidates; one has an untracked `.gstack` artifact. |
| Cinder | D-025 cold-start/runtime-readiness diagnostics | Current main contains the readiness support/tests under later history | Branch still has one patch-unique historical commit. Compare exact tree before removal. |
| Kestrel | Email/custom SMTP and legal copy | Email sender path and legal pages landed | Cold-browser email return leg and legal activation remain; old worktrees are otherwise absorbed. |
| Lumen | Dashboard and download consumer surfaces; header roster implementation ownership | Landed on main and production | Historical worktrees clean/absorbed. |
| Mica | Spend-breaker tests, browser deadlines, metadata/docs | Landed or superseded on main | Historical worktrees clean/absorbed. Reassess open defect statuses separately. |
| Tundra | Swarm communication/status support during the cycle | Messages informed orchestration; no unique active branch in the registered inventory | No current lane. |
| Vesper/Claude | One-time adversarial plan/situation review | Review was requested sparingly and the seat was told to exit | Exited; no remaining work. |

★ **INCOMPLETE — SEVEN AGENTS MISSING (F-5, added 2026-07-31).**

The table above was reconstructed from branches, messages, and landed commits. The **live task
ledger** — which this dossier wrongly reported as unqueryable (see §4) — names seven more agents
that own lanes and appear nowhere above:

| Agent | Lanes owned in the live ledger |
|---|---|
| **Forge** | `hosted-agent-revocation`, `agent-prompt-min-version`, `agent-receive-release-copy`, `agent-receive-cli` |
| **Lattice** | `grok-acp-host-core` |
| **Delta** | `signal-follow-resilience` |
| **Iris** | `consumer-flow-redesign` |
| **Quill** | `quill-current-target`, `p3-1-phase-a-seam`, `p3-1-signals-phase-b`, `uxtest-gate-relax`, `uxtest-reset-lifecycle` |
| **Mason** | `uxtest-harness` |
| **Fjord** | `read-edge-diagnostics` |

**One measured misattribution, and it is the instructive one.** This dossier attributes the Grok
ACP host core to Lead7, on the strength of the worktree `Lead7--grok-acp-host-core` and branch
`swarm/Lead7/grok-acp-host-core`. **The ledger says the task `grok-acp-host-core` is owned by
Lattice.** Branch naming and ledger ownership disagree.

**Operative rule this produces:** a branch prefix records *which seat pushed*, not *who owned the
work*. When reconciling the ledger (Phase 2), **close each task against its main commit and
evidence path — never against a branch name.** Closing `grok-acp-host-core` as Lead7's because
the branch says so would write a false ownership record into the durable ledger, which is exactly
the class of irreversible-record error the project's authority model exists to prevent.

## 4. Last durable task-ledger snapshot

~~The ledger could not be queried after the lead left the swarm.~~ ★ **SUPERSEDED — DEAD
(F-5, 2026-07-31 09:45). The ledger queries fine.** `swarm task list --swarm cloud-swarm`
returned the full set: **5 `awaiting_review`, 18 `active`, 7 `done`.**

The snapshot below is **shape-accurate** — it matches the live ledger's categories and the
reconciliation ruling that follows it is still the right ruling. But it is a *transcription*,
and transcriptions rot (see §1). **Reconcile against the live instrument, not against this
table**, and note that the live ledger carries owner names and attempt counts this snapshot
drops — including the seven agents §3 omits entirely.

The following is the last captured
snapshot and is known to be stale. It is included so the next lead can reconcile rather than
silently abandon it.

### Marked `awaiting_review`

- `juniper-l7a-runtime-fixes`
- `hosted-remove-member-integrate`
- `legal-draft-date-guard`
- `workspace-first-live-e2e`
- `hosted-agent-revocation`

### Marked active/stalled

- `uxtest-harness`
- `uxtest-gate-relax`
- `uxtest-reset-lifecycle`
- `p3-1-phase-a-seam`
- `p3-1-signals-phase-b`
- `quill-current-target`
- `d034-signal-fetch-deadline`
- `hosted-remove-member-v2`
- `hosted-remove-member-final`
- `truthful-legal-draft-band`
- `app-first-front-door`
- `consumer-flow-redesign`
- `agent-credential-ttl`
- `agent-prompt-min-version`
- `signal-follow-resilience`
- `grok-acp-host-core`
- `wake-relation-contract`
- `wake-receiver-hardening`

### Reconciliation ruling

- Workspace-first, consumer-flow, invite, header roster, prompt minimum version, signal follow,
  sender relation, Grok host core, receiver hardening, and revocation functionality are on main
  and/or released. Their ledger entries should be closed with exact main/release evidence.
- The legal draft **guard** is shipped; legal review/activation is not. Close the engineering guard
  task and open a separate externally blocked legal-truth/activation task.
- UX-harness/reset/gate tasks and old P3 seam tasks need an evidence audit. Do not assign work from
  their titles until checking current tests and `origin/main`.
- D-003 renewal-test review, D-006 membership cleanup, D-016 archive semantics, and tooling-pattern
  defects may still be real. Reproduce them on current main before reopening implementation.
- The host protocol matrix remains genuinely open and should become a new, bounded planning task.

An older global swarm census reported 164 worktrees, 59 detached heads, 62 unpushed branches, and
71 strays. That census spans more roots/state than this repository's two Git common directories.
The authoritative repository-specific inventory below contains **28 registered worktrees**. Do
not use the global counts as deletion targets.

## 5. How to read the worktree inventory

- `behind`/`ahead` are commit graph counts against `origin/main` at `a21db3f`.
- `patch unique` is the count of `git cherry origin/main HEAD` lines marked `+`. A nonzero count
  does not prove useful unmerged work; rebases and rewritten commits can be semantically present
  on main under another hash.
- `clean` means tracked/untracked status was empty at the snapshot.
- No worktree was removed or pruned in this pass.
- Both root clones have independent Git common directories. A branch/worktree in one is not
  registered in the other even when its path naming overlaps.

## 6. All registered worktrees — clone A

Git common directory: `/Users/yulanbot/Developer/Ridge.io/cloud-swarm/.git`.

| # | Worktree | Branch | HEAD | behind/ahead | patch unique | Dirty state | Recommended disposition |
|---:|---|---|---|---:|---:|---|---|
| 1 | `/Users/yulanbot/Developer/Ridge.io/cloud-swarm` | `main` | `af87f8a` | 8 / 0 | 0 | `.gitignore` adds `.gstack/` | **Keep and consolidate.** It holds deploy configuration. Preserve the edit, then fast-forward to current main. |
| 2 | `/Users/yulanbot/.swarm/wt/cloud-swarm-source/Lead7--l7a-landing` | `lead7/l7a-landing` | `c0dc2ca` | 50 / 0 | 0 | clean | Absorbed; cleanup candidate after branch audit. |
| 3 | `/Users/yulanbot/.swarm/wt/cloud-swarm-source/Lead7--remote-friend-invite` | `lead7/remote-friend-invite` | `02929c9` | 23 / 0 | 0 | clean | Invite commit is on main; cleanup candidate. |
| 4 | `/Users/yulanbot/.swarm/wt/cloud-swarm-source/Lead7--workspace-first-entry` | `codex/workspace-first-entry` | `fb1dfdf` | 37 / 0 | 0 | clean | Absorbed; cleanup candidate. |
| 5 | `/Users/yulanbot/.swarm/wt/cloud-swarm-source/Lead7--workspace-first-final` | `codex/workspace-first-final` | `65af846` | 44 / 1 | 1 | clean | Unique commit is “tolerate fresh-auth clock skew.” Current main contains the same 5-second skew constant/tests under later history. Compare tree, then discard as superseded. |
| 6 | `/Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cinder-d011` | `cinder/d025-p1server-coldstart` | `8dcdce5` | 98 / 1 | 1 | clean | D-025 historical patch. Current main has cold-start/readiness handling; run exact tree/test comparison before discard. |
| 7 | `/Users/yulanbot/Developer/Ridge.io/swarm-worktrees/juniper-l7a-runtime-fixes` | `juniper/l7a-runtime-fixes` | `75e032d` | 60 / 0 | 0 | clean | Absorbed; cleanup candidate. |
| 8 | `/Users/yulanbot/Developer/Ridge.io/swarm-worktrees/juniper-landing` | `juniper/l7b-start-onramp` | `906875e` | 87 / 1 | 0 | untracked `.gstack/` | Patch-equivalent content absorbed. Inspect/preserve the local `.gstack/claude-available.json` only if it has value, then remove worktree. |
| 9 | `/Users/yulanbot/Developer/Ridge.io/swarm-worktrees/kestrel-email` | `kestrel/l1-email` | `146b616` | 113 / 0 | 0 | clean | Absorbed; cleanup candidate. |
| 10 | `/Users/yulanbot/Developer/Ridge.io/swarm-worktrees/kestrel-email-smtp` | `kestrel/l1-email-smtp-guard` | `228b95b` | 86 / 1 | 0 | clean | Patch-equivalent SMTP work absorbed; cleanup candidate. |
| 11 | `/Users/yulanbot/Developer/Ridge.io/swarm-worktrees/kestrel-legal` | `kestrel/l5-legal-copy` | `e8b8f41` | 109 / 1 | 0 | clean | Legal copy absorbed/modified; cleanup candidate after current legal rewrite is scoped. |
| 12 | `/Users/yulanbot/Developer/Ridge.io/swarm-worktrees/kestrel-legal-followup` | `kestrel/l5-legal-followup` | `7766991` | 101 / 1 | 0 | clean | Patch-equivalent follow-up absorbed; cleanup candidate. |
| 13 | `/Users/yulanbot/Developer/Ridge.io/swarm-worktrees/legal-terms` | `legal/terms-and-policies` | `3e48350` | 163 / 6 | 6 | clean | Six original legal commits are patch-unique because main later integrated/modified the files. **Do not merge wholesale.** Retain until legal truth/activation work compares current text and confirms no unique decision is lost. |
| 14 | `/Users/yulanbot/Developer/Ridge.io/swarm-worktrees/lumen-dashboard` | `lumen/l7a-dashboard` | `fd7b773` | 85 / 7 | 0 | clean | All seven commits patch-equivalent/absorbed; cleanup candidate. |
| 15 | `/Users/yulanbot/Developer/Ridge.io/swarm-worktrees/lumen-download` | `lumen/l3-download-app` | `6404b1d` | 118 / 1 | 0 | clean | Absorbed; cleanup candidate. |
| 16 | `/Users/yulanbot/Developer/Ridge.io/swarm-worktrees/mica-d031-spend-breaker` | `mica/d031-test-spend-breaker` | `6196d42` | 76 / 2 | 0 | clean | Patch-equivalent/absorbed; reconcile D-031 status, then cleanup. |
| 17 | `/Users/yulanbot/Developer/Ridge.io/swarm-worktrees/mica-d034-browser-deadlines` | `mica/d034-browser-deadlines` | `e753728` | 58 / 0 | 0 | clean | Absorbed; cleanup candidate. |
| 18 | `/Users/yulanbot/Developer/Ridge.io/swarm-worktrees/mica-internal-docs` | `mica/l6-internal-docs` | `eae52d5` | 86 / 3 | 0 | clean | Patch-equivalent docs absorbed; cleanup candidate. |
| 19 | `/Users/yulanbot/Developer/Ridge.io/swarm-worktrees/mica-metadata` | `mica/l4-metadata` | `bfbebed` | 111 / 6 | 0 | clean | Patch-equivalent metadata work absorbed; cleanup candidate. |

## 7. All registered worktrees — clone B

Git common directory: `/Users/yulanbot/Developer/Ridge.io/cloud-swarm-source/.git`.

| # | Worktree | Branch | HEAD | behind/ahead | patch unique | Dirty state | Recommended disposition |
|---:|---|---|---|---:|---:|---|---|
| 20 | `/Users/yulanbot/Developer/Ridge.io/cloud-swarm-source` | `main` | `a21db3f` | 0 / 0 | 0 | `.gitignore` adds `.gstack/` | Exact source reference. It lacks all ignored deploy configuration. Keep until clone consolidation and QA evidence preservation finish. |
| 21 | `/Users/yulanbot/.codex/worktrees/cloud-swarm-wake-mvp` | `codex/wake-mvp-integration` | `a21db3f` | 0 / 0 | 0 | clean | Exact main and fully absorbed. Cleanup candidate after checking ignored build/env material. |
| 22 | `/Users/yulanbot/.swarm/wt/cloud-swarm-source/Kepler--wake-relation-contract` | `swarm/Kepler/wake-relation-contract` | `a56eee8` | 8 / 1 | 0 | clean | Patch-equivalent to main's `24ec0f9`; cleanup candidate. |
| 23 | `/Users/yulanbot/.swarm/wt/cloud-swarm-source/Lead7--grok-acp-host-core` | `swarm/Lead7/grok-acp-host-core` | `9588ec2` | 8 / 1 | 0 | clean | Patch-equivalent to main's `a6a3cb1`; cleanup candidate. |
| 24 | `/Users/yulanbot/.swarm/wt/cloud-swarm-source/Lead7--hosted-agent-revocation-final` | `codex/hosted-agent-revocation-final` | `abbc561` | 37 / 6 | 1 | clean | Five commits are patch-equivalent; unique commit is integrated-candidate evidence. Compare against current committed revocation evidence before discarding. |
| 25 | `/Users/yulanbot/.swarm/wt/cloud-swarm-source/Lead7--wake-receiver-hardening` | `swarm/Lead7/wake-receiver-hardening` | `bab2a93` | 8 / 2 | 2 | clean | Commit messages match features landed as `7c0f7c5`/`55f445e`, but patch IDs differ. Tree-compare affected files/tests, then discard as superseded. |
| 26 | `/Users/yulanbot/.swarm/wt/cloud-swarm-source/Lead7--wake-relation-contract` | `swarm/Lead7/wake-relation-contract` | `a56eee8` | 8 / 1 | 0 | clean | Duplicate checkout of the same patch-equivalent branch as #22; cleanup candidate. |
| 27 | `/Users/yulanbot/.swarm/wt/cloud-swarm-source/Nori--hosted-remove-member-v2` | `swarm/Nori/hosted-remove-member-v2` | `2e1dac9` | 45 / 0 | 0 | `.gitignore` adds `.gstack/` | Absorbed. Preserve or intentionally discard shared ignore edit, then cleanup. |
| 28 | `/Users/yulanbot/.swarm/wt/cloud-swarm-source/Sable--wake-receiver-hardening` | `swarm/Sable/wake-receiver-hardening` | `7b49594` | 8 / 2 | 2 | modified `supabase/functions/read/index.ts` | **Quarantine.** Uncommitted diff removes 112 lines: cursor keys/capabilities, sender-owner relation join/case, and cursor ordering. Never merge. Preserve diff as rollback evidence if useful, then explicitly discard/delete only with authorization. |

`git worktree prune --dry-run` found no prunable registered entries. Cleanup therefore requires
intentional `git worktree remove` operations; nothing will disappear just by pruning metadata.

## 8. Dirty-file details

### Shared `.gitignore` edit

Three registered worktrees show the same one-line tracked change:

```diff
 dist-release/
+.gstack/
```

Paths:

- both root clones;
- Nori's remove-member worktree.

Because `.gstack` holds ignored QA/browser artifacts, the change is sensible, but it is
user-owned/uncommitted. Decide once whether to land it on current main; do not silently discard or
duplicate it while consolidating clones.

### Juniper untracked artifact

`juniper-landing` contains untracked `.gstack/`, including a Claude-availability metadata file.
It is not product source. Inspect it for historical value; otherwise it can be discarded as part
of the worktree removal.

### Sable rollback

Sable's dirty read-edge diff removes:

- `SIGNAL_CAPABILITIES` (`sender_owner_relation` and `cursor_after`);
- paired `after_created_at`/`after_id` request parsing;
- ascending keyset cursor logic;
- sender principal join and authenticated owner-relation classification;
- capability markers in responses.

That would make v0.1.4 startup fail its capability gate or, worse under a weakened client, lose
messages/ownership policy. It contains no forward value. The only reason to preserve it is as a
clear negative-control example.

## 9. Safe clone consolidation procedure

Recommended end state: one operator/deploy clone at
`/Users/yulanbot/Developer/Ridge.io/cloud-swarm`, current at `origin/main`, with its ignored
`site/.env`, Vercel project link, and Supabase link retained. Keep the source clone until every
ignored QA/dossier artifact has been inventoried, then retire it deliberately.

Procedure:

1. In both clones, fetch tags/branches and record `HEAD`, `origin/main`, and `git status`.
2. Save the `.gitignore` one-line diff as an explicit decision. Prefer landing `.gstack/` ignore
   on a new clean branch after the consolidation, not carrying three independent dirty copies.
3. Confirm the old clone has no dirty file other than `.gitignore` and the ignored dossier.
4. Fast-forward the old clone's `main` to `origin/main` with a non-destructive `--ff-only` merge.
   If Git refuses because of the ignore edit, preserve the one-line patch, temporarily move the
   edit through a normal patch/stash workflow, fast-forward, then reapply and inspect. Do not reset.
5. Verify that `site/.env`, `site/.vercel/project.json`, and `supabase/.temp/project-ref` still
   exist without printing their contents.
6. Verify `HEAD == origin/main == a21db3f` or the then-current remote head.
7. Run source/site gates before any deploy.
8. Copy or intentionally archive the current source clone's ignored `.gstack/qa-reports` and this
   dossier. Never copy `.env` through chat, logs, or a committed file.
9. Only when the operator clone is current and verified should the second root clone be considered
   for removal.

Alternative: make `cloud-swarm-source` authoritative and securely recreate all three ignored
deployment inputs there. That is technically valid but creates more secret/link recreation and is
therefore not the recommendation.

## 10. Safe worktree cleanup procedure

Perform cleanup in small batches after consolidation, not before:

1. Run `scripts/branch-audit.sh` from the current tree and preserve its output in ignored local
   evidence. Earlier audits exited nonzero because many remote branches are unique; do not delete
   remote branches in bulk.
2. For each cleanup candidate, re-run:
   - `git status --short`;
   - `git cherry -v origin/main HEAD`;
   - `git diff --stat origin/main...HEAD`;
   - targeted tree comparison for the files named in the branch commits.
3. If patch unique is zero and the worktree is clean, remove the explicit worktree path with
   `git worktree remove <exact-path>`.
4. If patch unique is nonzero but content is known superseded, record the main commits/tests that
   replace it before removal.
5. For dirty worktrees, preserve or intentionally discard each file separately. Never use a broad
   reset/checkout command.
6. Run `git worktree prune --dry-run`, then `git worktree prune` only after the explicit removals.
7. Re-enumerate all registered worktrees and count them. A cleanup claim without the resulting
   complete list is not evidence.
8. Delete local branches only after their worktrees are gone and their disposition is recorded.
   Remote branch deletion is a separate operator decision.

★ **SCOPE HOLE — READ BEFORE DELETING ANY BRANCH (F-4, added 2026-07-31).**

This entire procedure is **worktree-gated**: every step keys off the 28 registered worktrees, and
step 8 gates branch deletion on "their worktrees are gone." Measured reality:

| Measured | Count |
|---|---:|
| Registered worktrees (both clones) | **28** |
| Remote branches | **68** |

**At least seven remote branches have no registered worktree at all**, and every one of them
belongs to an agent this dossier's §3 lane table omitted:

```
origin/quill/cli-first-errors            origin/quill/p3-1-signals
origin/quill/current-target              origin/quill/preauth-audit
origin/quill/current-target-followup     origin/swarm/Forge/agent-connect-panel-hidden-fix
origin/quill/current-target-prerebase
```

Read step 8 literally against these and the gate is **vacuously satisfied** — there is no
worktree, so "their worktrees are gone" is trivially true, and nothing in this procedure ever
assigned them a disposition. A cleanup lane following the plan as written could delete branches
that were never assessed. `AGENTS.md` is explicit that *"branches that exist locally may hold the
only copy of something."*

**Corrected rule.** Worktree cleanup and branch cleanup are **two separate passes with different
inputs**, and this document only covers the first:

1. **Worktree pass** — steps 1–7 above. Scope: the 28 registered worktrees. This is complete.
2. **Branch pass** — *not specified in this dossier, and out of scope for it.* Scope: all 68
   remote branches. Requires its own `scripts/branch-audit.sh` run, a per-branch disposition
   recorded against `origin/main`, and an explicit operator decision per the existing rule that
   remote deletion is operator-only. **Branches with no worktree are the highest-risk members of
   this set, not the lowest** — nothing has been holding them open, so nothing has been
   protecting them either.

Until pass 2 exists, treat every worktree-less branch as **retain, unassessed**.

Suggested order:

- First: exact-main duplicate #21 and patch-equivalent clean #22/#23/#26.
- Second: clean patch-unique-zero historical UX/email/dashboard/docs trees.
- Third: branch-specific comparisons for #5/#6/#24/#25.
- Last: legal #13 and Sable #28, because they contain the highest decision/risk density.

## 11. Future quiet-swarm operating model

When work resumes, keep the trial workflow the user requested:

1. Lead pauses and writes the complete plan first.
2. Each subagent receives one well-scoped `/goal` with:
   - exact source/worktree;
   - files it may own;
   - dependency and non-goals;
   - acceptance tests and evidence format;
   - stop/escalation conditions;
   - explicit instruction to work quietly and checkpoint only material blockers/results.
3. File-disjoint lanes run in parallel. One lead owns integration, release, and deployment.
4. Use Grok for lower-level coding/review, Kimi K3 for consumer design, Gemini/AGY/Grok for
   model-inversion review, and Claude only for sparse high-level critical review.
5. Review the combined decision set before landing; individually correct changes can conflict.
6. Close/reap the agent and its worktree immediately after its result is landed or discarded.

Proposed next lanes are specified in `NEXT-EXECUTION-PLAN.md`. They are proposals, not current
assignments; the swarm remains paused at this snapshot.
