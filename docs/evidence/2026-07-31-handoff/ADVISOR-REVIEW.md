# Advisory review of the 2026-07-31 handoff dossier

Reviewer: AdvisorClaude (cloud-swarm swarm seat, analysis-only mandate)
Reviewed: 2026-07-31, ~09:20–09:45 CDT
Method: read all four dossier files and AGENTS.md complete; read the canonical spec sections
they name; then **re-measured** repository, release, production, swarm, and ledger state
read-only. Nothing was edited, deployed, deleted, or woken.

Everything below that is stated as fact was measured in this pass unless explicitly labeled
"not established."

---

## 1. Mission restatement

CommonSwarm sells **awareness, not authority**: a person and their AI collaborators share one
Slack-like channel of short immutable signals so nobody duplicates work. A signal never claims,
blocks, or closes anything.

The product is live, public, self-serve, and free at <https://commonswarm.com>. CLI is `cswarm`,
released version 0.1.4.

The one thing that separates this from a chat log is that **agents must receive direct asks after
their setup turn ends, without cmux or terminal-keystroke injection.** v0.1.4 achieved that for
exactly one host. That is the product's spine and the honest measure of how far it has come.

The immediate continuation goal — stabilize v0.1.4, close legal/trust and repo-ops gaps, re-prove
the signed-in production journey, then extend receive beyond Grok with strict cross-owner isolation
— is correct and correctly ordered. I would not reorder it.

---

## 2. Status classification (re-measured)

### 2.1 Shipped and verified — confirmed by my own measurement

| Claim | My measurement |
|---|---|
| Remote `main` = `a21db3f5986…` | `git ls-remote` confirms exactly |
| Tag `v0.1.4` = `4cc29e69…` | confirmed |
| Release final, not draft/prerelease, published 2026-07-31T04:51:35Z | confirmed via `gh release view` |
| Binary digest `ebd4df65…c270`, 1,261,735 bytes; `.sha256` 73 bytes | confirmed; **the checksum asset's own content matches the binary's API digest** — the dossier asserted the digest but did not show the two agreeing. They do. |
| All 10 public routes + `/nope.sh` 404 control | confirmed, all 200 / 404 as tabled |
| 12 migrations present | confirmed (12 `.sql` files) |
| 28 registered worktrees (19 clone A + 9 clone B) | confirmed exactly |
| Sable worktree holds an uncommitted rollback | **confirmed and worse than a count**: `-112/+20` lines, and `sender_owner_relation` appears **0 times** in Sable's working file vs **2 times** on `origin/main`. It is a true capability rollback. |
| Clone A on `main` at `af87f8a`, 8 behind, `.gitignore` dirty | confirmed |
| Clone B exact at `a21db3f`, `.gitignore` dirty | confirmed |
| Deploy inputs split exactly as described | confirmed: clone A has all three, clone B has none |

**Additionally verified, and to the project's credit:**

- `site/.env` in clone A is structurally sound: `PUBLIC_SUPABASE_URL` and
  `PUBLIC_SUPABASE_ANON_KEY` both populated, **zero service-role markers**.
- Vercel link resolves to `projectName: coswarm-site`; Supabase ref resolves to
  `ukezjcnxjvkpkeezxaew`. Both correct.
- `install.sh` served from production defaults `REPO="${CSWARM_REPO:-Ridge-io/cloud-swarm}"` —
  the D-022-class installer bug is genuinely fixed on the live artifact.

### 2.2 Shipped but insufficiently validated

- Cross-owner isolation — gates pass; **no two-human production canary.**
- 30-day credential horizon — rotation exercised; **no wall-clock canary.**
- Signed-in dashboard on the current deployment — **not re-walked**; browser transport failed.
- Cold-browser magic-link return leg — **unproven** end to end.
- Delivery is at-least-once with only in-process dedup — **no durable ack.**

### 2.3 Unbuilt

- Native background receive for any host except measured Grok CLI 0.2.117.
- Durable delivery/ack/lease/unread substrate (`swarm.inbox_deliveries` exists but is dormant —
  **I confirmed the table is real**, defined in `20260723000001_p1_schema.sql:424`, so Phase 5's
  premise is sound and not a phantom).
- Host protocol matrix (Lorentz lane was interrupted, never delivered).
- Self-serve export/delete, telemetry, billing.

### 2.4 Externally blocked

Attorney review; effective-date decision; DMCA designated-agent filing; trademark clearance;
provider background APIs for desktop/ChatGPT/Cowork wake; two-human canary consent.

---

## 3. Wrong, contradictory, or unsafe — findings

### F-1 (P0, new severity). The stale-clone deploy would cause a *named, customer-facing* regression, not just a theoretical one

The dossier warns "do not deploy from either clone." Correct — but it understates the case by
leaving it abstract. I diffed the 8 commits clone A is missing. They **do** touch `site/`:

```
site/src/lib/install.ts                          CSWARM_VERSION=0.1.3 → 0.1.4
site/src/components/download/OtherWays.astro     pin cmd 0.1.3 → 0.1.4
site/src/components/download/AfterInstall.astro  "cswarm 0.1.3" → "cswarm 0.1.4"
site/src/components/connect/agent-prompt.ts      (+ its observer test)
```

Production today serves `cswarm 0.1.4` twice on `/download` (measured). Clone A's working tree
still says `0.1.3` (measured, `install.ts:36`).

**So a deploy from clone A would silently roll the public install instructions back to 0.1.4→0.1.3
while the GitHub release remains 0.1.4** — a stranger following the site would pin an older CLI
than the agent prompt requires. This is the exact shape of the D-023 availability incident: green
deploy log, wrong artifact, copy asserting a deployment state that is no longer true.

Elevate the warning from "don't deploy" to "**a deploy from clone A is a known-regression event
with a named diff**." That is a much harder thing for a future agent to talk itself past.

### F-2 (P0, missed). The proposed effective date has already elapsed

Live `/terms`, `/privacy`, `/acceptable-use` all render `Proposed effective 27 July 2026` and
`Last updated 29 July 2026`, alongside `Draft — not yet in force`, and `/app` says the documents
are "drafts published for review (not yet in force)."

**Today is 31 July 2026.** The page proposes an effective date four days in the past while
simultaneously declaring itself not in force. To a reader that is not merely "drafts are live" —
it is self-contradictory on its face, and it degrades further every day it sits.

The dossier's QA-001 reports the draft banner but not the elapsed date. This makes the P0 more
urgent and gives the operator a concrete forcing function: the date must move or the banner must
resolve; standing still is now actively wrong, not merely incomplete.

### F-3 (P0, confirmed). Every legal factual mismatch is real on the live artifact

I probed production directly rather than trusting the source anchors:

| Check | Result |
|---|---|
| `/privacy` contains `~/.CommonSwarm` (wrong path) | **1 occurrence — present** |
| `/privacy` contains `~/.cswarm` (correct path) | **0 occurrences — absent** |
| `/privacy` mentions Resend | **0 — omitted from provider list** |
| `/terms` mentions GitHub | 4 |
| `/terms` mentions magic link | **0** |
| `/app` offers "sign-in link" (positive control) | 3 |

Every one of QA-002/003/004 is confirmed against the deployed page, with the control proving the
instrument discriminates. The dossier is accurate here and I found no overstatement.

### F-4 (P1, missed — cleanup safety hole). The cleanup plan is scoped to worktrees; the deletion risk lives in branches

The dossier inventories **28 registered worktrees** and builds its cleanup procedure around them.
But I measured **68 remote branches**. Seven of them belong to agents the dossier's lane table
(§3) does not mention at all:

```
origin/quill/cli-first-errors        origin/quill/p3-1-signals
origin/quill/current-target          origin/quill/preauth-audit
origin/quill/current-target-followup origin/swarm/Forge/agent-connect-panel-hidden-fix
origin/quill/current-target-prerebase
```

None have a registered worktree. So the dossier's step 8 — "delete local branches only after their
worktrees are gone" — has a gap: **these branches have no worktree to gate on, and no disposition
recorded.** A future agent following the plan literally could conclude they are unaccounted-for
debris. `AGENTS.md` warns that branches may hold the only copy of something. Add an explicit rule:
*worktree-less branches are out of scope for this cleanup and require a separate `branch-audit.sh`
pass before any remote deletion.*

### F-5 (P1, wrong). The dossier's agent-lane reconstruction is missing seven agents, and misattributes at least one lane

The dossier says the task ledger "could not be queried after the lead left the swarm."
**It is queryable right now.** I read it. It shows lanes owned by seven agents the dossier's §3
table omits entirely: **Forge, Lattice, Delta, Iris, Quill, Mason, Fjord.**

It also shows at least one misattribution: `grok-acp-host-core` is owned by **Lattice(2)** in the
ledger, but the dossier attributes that work to Lead7 (worktree `Lead7--grok-acp-host-core`,
branch `swarm/Lead7/grok-acp-host-core`). Branch naming and ledger ownership disagree. Whoever
reconciles the ledger must close on *evidence*, not on branch-name inference — otherwise this
mismatch becomes a wrong closure record.

Measured ledger state: **5 `awaiting_review`, 18 `active`, 7 `done`** — matching the dossier's
stale snapshot in shape, so its reconciliation ruling is still the right ruling. But it should be
executed against the live ledger, which exists, not against a transcribed snapshot.

### F-6 (P1, contradictory). The swarm is not paused

The dossier's stop-the-line warning #4 says the swarm is paused, the primary process is "Not
joined," and the two A2A members have no continuation work. As of this review:

```
Anvil [a2a]           — provisioning agent, operator authority
Wren  [a2a]           — GUI-origin uxtest endpoint
Lead7 [cmux/codex]    — CommonSwarm lead — orchestration and integration   ← ACTIVE
AdvisorClaude [claude] — this seat
```

Lead7 is joined and issuing goals. The dossier went stale on its own central operating assumption
within roughly twenty minutes of being written. That is not a criticism of the author — it is the
predictable failure mode of writing live process state into a document, and it is exactly the
class of error `AGENTS.md` flags about deployment-state claims living in git. **Recommendation:
strike the swarm-state section from the dossier and replace it with "run `swarm members` and
`swarm task list`" — a pointer to the instrument, not a transcription of its output.**

### F-7 (P2, under-credited). The test-reachability trap is already guarded, and the dossier does not say so

`AGENTS.md` and the dossier both warn at length that `npm test` is a literal file list and a new
test can silently not run — citing the D-025 incident where six observers in `tests/support/`
were never reached.

I enumerated it. **There are 37 test files and 0 orphans.** More importantly, there is a meta-gate:
`tests/p1-cli/test-gate-coverage.test.ts` walks the tests tree, parses `package.json` scripts, and
asserts reachability — and it is itself named in the `test` script. All nine test files added by
v0.1.4 are reachable (`tests/support/agent-receive-cli.test.ts` is explicitly in the literal list).

The trap is real history but it is now **instrumented**. The dossier repeats the warning without
noting the guard, which risks a future agent spending a lane re-solving a solved problem. Credit
it, and keep the warning only as "confirm `test-gate-coverage` still passes."

### F-8 (P2, small factual error). `AGENTS.md` does not claim ten migrations

`STATE-AND-PRODUCTION.md` §3 says "`AGENTS.md` and parts of `TODO.md` still say ten migrations in
historical passages." I grepped both. `AGENTS.md` contains **no migration count at all** — only
"migrations + Deno edge functions" and "a migration written is not a migration applied."
The stale "10 migrations" text is in `TODO.md` only (lines 231, 322), and in both places it is a
*historical* statement about the 2026-07-28 deploy, which was accurate at the time.

Minor, but it matters for the same reason the rest does: the reconciliation lane will go looking
for a defect in `AGENTS.md` that is not there, and may "fix" a correct file.

### F-9 (unsafe, structural). The dossier's own storage contradicts the project's evidence doctrine

`scratchpad/` is gitignored. The dossier says so in its first paragraph and calls it deliberate.
But `AGENTS.md` is explicit: *"Evidence cited from a document must live somewhere durable — that is
what `docs/evidence/` is for. A completion claim whose evidence cannot be re-read later is not
evidence."*

This document is the sole zero-context handoff for a live product, it names itself the resume
point, and it lives one `git clean` away from nonexistence — in a checkout that `AGENTS.md`
separately warns is shared with other agents and frequently not on `main`. The QA screenshots it
indexes are likewise under an ignored `.gstack/` inside the clone the plan proposes to eventually
retire.

**This is the highest-leverage unflagged risk in the dossier.** Recommend: promote the durable
parts — anchors, status classification, dispositions, decision list — into `docs/evidence/` or
`docs/org/` before executing any consolidation or cleanup that touches either clone.

---

## 4. Severity-ranked remaining work

**P0 — before any deploy**
1. Consolidate clones; make one authoritative and current (F-1 makes this concrete).
2. Legal product-fact correction + effective-date resolution (F-2, F-3) — engineering truth pass
   is unblocked; activation is not.
3. Preserve the dossier durably before touching either clone (F-9).
4. Quarantine Sable's rollback (confirmed real).

**P1 — core product**
5. Fresh signed-in production walkthrough (desktop + mobile).
6. Reconcile the live ledger, with F-5's ownership caveat.
7. Host protocol matrix → second adapter.
8. Durable delivery/ack contract.
9. Two-human cross-owner canary.
10. Cold-browser magic-link proof.
11. Branch-level audit as a distinct pass from worktree cleanup (F-4).

**P2**
12. Credential-lifetime copy (live copy still reads "lasts a few hours" — I confirmed it).
13. Pending-access refresh.
14. Doc/defect drift, including F-8's correction.
15. Longevity canaries.

---

## 5. Dependency-aware next sequence

```
[durably preserve dossier]  ──►  [consolidate clones]  ──►  everything else
                                        │
        ┌───────────────────────────────┼────────────────────────────┐
        ▼                               ▼                            ▼
 legal fact pass              ledger/doc reconciliation      host matrix (read-only,
 (blocked at activation                                       parallel-safe, no repo
  by operator/counsel)                                        write contention)
        │                               │                            │
        ▼                               ▼                            ▼
                    authenticated production QA  ──►  delivery-ack design
                                        │
                                        ▼
                              two-human canary + longevity
```

Three things can genuinely run in parallel after consolidation because they are file-disjoint:
legal (site/legal pages), reconciliation (docs/ledger), host matrix (read-only measurement,
writes nothing). Everything downstream funnels through one integrator.

---

## 6. Single best first execution slice

**Slice: durably preserve the handoff, then consolidate clone A to `origin/main`.**

Not the legal work — that is P0 by severity but blocked on a human, and its engineering half is
safe to start only once the repo it edits is the right one. Not QA — blocked on browser access.
Consolidation is the only P0 that is fully unblocked, is a prerequisite for every other lane, and
currently sits one careless command away from shipping the F-1 regression.

**Steps**
1. Copy the four dossier files + this review into `docs/evidence/2026-07-31-handoff/`; commit on a
   branch. (Removes the `git clean` failure mode before any tree surgery.)
2. In clone A: stash the one-line `.gitignore` edit through a normal patch workflow — **never
   `reset`, never `checkout --`.**
3. `git merge --ff-only origin/main` → `af87f8a` becomes `a21db3f`.
4. Reapply the ignore edit; decide it explicitly (recommend: land `.gstack/` as a tiny commit).
5. Re-verify the three deploy inputs still exist, structurally, without printing values.
6. Clean site build; assert `/download` output contains `0.1.4` and **zero** `0.1.3` — this is the
   direct regression check for F-1, with the `0.1.4` grep as its positive control.

**Acceptance**
- `git rev-parse HEAD == git ls-remote origin main` in clone A.
- All three deploy inputs present; `site/.env` has both `PUBLIC_*` keys and zero service-role
  markers.
- Built `dist/download/index.html`: `grep -c '0\.1\.4'` ≥ 2 **and** `grep -c 'CSWARM_VERSION=0\.1\.3'` = 0.
- `git status` clean or only the named `.gitignore` decision.
- Nothing deleted: worktree count still 19 in clone A, 9 in clone B.

**Rollback**
`af87f8a` is recorded here and is a real commit; `git merge --ff-only` creates no new objects, so
`git reset --hard af87f8a` restores the prior head exactly if needed. The `.gitignore` edit is
preserved as a patch file outside the tree first, so the worst case loses nothing. **No deploy in
this slice** — consolidation and deployment are separate acts and must not be bundled.

**Stop condition**
If the fast-forward conflicts on anything other than `.gitignore`, stop and report. Do not resolve.

---

## 7. Minimal quiet swarm lanes

Three workers plus Lead7 is right. My adjustments to the dossier's proposal:

| Lane | Owner | Scope | Blocked by |
|---|---|---|---|
| **A. Consolidation + durable preservation** | Lead7 only | The slice above. Nobody else touches either clone until it lands. | nothing — start here |
| **B. Legal fact matrix** | Grok, read-only first | Produce the fact matrix and a *proposed* patch. Must include the elapsed-effective-date finding (F-2). **May not** remove draft status. | operator/counsel for activation only |
| **C. Host protocol matrix** | Grok impl + Gemini/AGY inversion | Measurement only, writes nothing to the repo. Safe to run during A. | supported host APIs |
| **D. Ledger/doc reconciliation** | Grok | Against the **live** ledger, not the transcript. Close only with a main/release anchor. Carry F-5's ownership caveat and F-8's correction. | lane A |

Deliberately **not** running yet: QA (blocked on browser access), delivery-ack design (wants the
matrix first), cleanup (highest risk, lowest urgency, and F-4 says its scope is wrong as written).

Per `AGENTS.md`'s current gate: any lane that changes a SHA needs **both** Grok and Gemini via
`agy` on the exact SHA. Not Claude, and not either one alone.

---

## 8. True operator decisions

Genuinely human; no agent should resolve these.

1. **Which clone is authoritative?** — recommend clone A, fast-forwarded. Low risk, and it holds
   the secrets that are expensive to recreate.
2. **Effective date.** Forced by F-2: 27 July has passed. Move the date, or activate, or state a
   new proposed date. Standing still is now a wrong statement, not a neutral one.
3. **Who reviews the legal drafts, and when?** Nothing downstream of "legal truth" can finish
   without this.
4. **DMCA registration status + renewal date.**
5. **Trademark search for "CommonSwarm."**
6. **May QA create two disposable human accounts** for the cross-owner canary?
7. **May browser QA open a controlled Chrome window/profile** if attachment keeps failing? This
   currently blocks the entire P1 QA lane.
8. **Land `.gstack/` in `.gitignore`?** — recommend yes, once, explicitly.
9. **Should the dossier be promoted into `docs/`?** (F-9) — recommend yes, before any tree surgery.

---

## 9. What the dossier missed or got wrong

**Missed**

- **The stale-clone deploy has a named regression** — 0.1.4→0.1.3 across three site files. The
  warning was abstract; it should be concrete. (F-1)
- **The proposed effective date has elapsed.** Live pages propose 27 July 2026 while today is
  31 July. Not mentioned anywhere. Makes P0 legal urgent rather than merely open. (F-2)
- **68 remote branches vs 28 worktrees.** Seven branches from unlisted agents have no worktree, so
  the worktree-gated cleanup plan does not cover them. (F-4)
- **Seven agents absent from the lane table** — Forge, Lattice, Delta, Iris, Quill, Mason, Fjord —
  all with owned ledger tasks. (F-5)
- **The dossier itself is not durable.** It lives in gitignored `scratchpad/`, in a shared checkout
  that is often not on `main`, and it is the sole zero-context handoff. This contradicts the
  project's own evidence doctrine and is the single most consequential unflagged risk. (F-9)
- **Test reachability is already instrumented** by `tests/p1-cli/test-gate-coverage.test.ts`;
  0 orphans across 37 files. The dossier repeats the D-025 warning without crediting the fix. (F-7)

**Got wrong**

- **"The ledger could not be queried."** It queries fine. I read it: 5 awaiting_review, 18 active,
  7 done. Reconcile against the live instrument. (F-5)
- **"The swarm is paused / the lead is not joined."** Lead7 is joined and issuing goals. The
  document went stale on its own operating assumption almost immediately. Replace transcribed
  process state with a pointer to `swarm members`. (F-6)
- **"`AGENTS.md` still says ten migrations."** It contains no migration count. Only `TODO.md` does,
  and there it is correct-in-context historical text. (F-8)
- **`grok-acp-host-core` attributed to Lead7**; the ledger says Lattice. Branch naming and ledger
  ownership disagree — close on evidence, not branch names. (F-5)

**What the dossier got right, and should be preserved**

The four stop-the-line warnings are all real. I independently re-derived three of them and found
no overstatement anywhere in the legal section — every mismatch reproduces on the live page with a
positive control. The Sable rollback is genuinely dangerous and the dossier's characterization is
if anything conservative. The phase ordering (repo → legal → QA → receive) is correct and I would
not change it. The refusal to claim attorney review, trademark clearance, DMCA safe harbor, or any
traffic metric is exactly right, and the "what this dossier does not contain" section is a model of
the doctrine it is written under.

---

## 10. What I did not establish

- I did not run any test suite, build, or gate. Every gate result in §6 of the dossier is quoted
  from its release evidence, **not re-measured by me.**
- I did not walk the signed-in dashboard. That gap remains exactly as the dossier describes it.
- I did not query the database, inspect customer data, or check traffic.
- I did not verify Supabase edge function versions/hashes independently — I accepted the dossier's
  v15/v6/v2 figures without re-probing the CLI.
- I did not diff the legal worktree (#13) to check whether its six patch-unique commits contain a
  decision that would be lost.
- I did not attempt browser control, so I cannot say whether the transport failure is transient.
- I read `SWARM-CLOUD.md` §0–§3 only, not all ~1000 lines; my "phase ordering is correct" judgment
  rests on the dossier plus those sections, not the full spec.
