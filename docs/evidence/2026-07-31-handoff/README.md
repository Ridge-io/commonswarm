> **Current-state note, 2026-08-04 (D-044):** local cross-owner isolation claims in this handoff are
> historical. The sandbox is retired; server-side authority is unchanged.
>
> ## Provenance — read this box first
>
> **This is the durable, committed copy. It is authoritative.**
>
> This dossier was originally written to
> `scratchpad/2026-07-31-common-swarm-handoff/`, which is gitignored. That made the sole
> zero-context handoff for a live product survivable only until the next `git clean`, in a
> checkout `AGENTS.md` warns is shared between agents and frequently not on `main`.
>
> That is the **same failure this very directory's index was created to prevent** — see
> `docs/evidence/README.md`, first paragraph: an earlier `SUCCESSION-PLAN.md` cited P0 review
> logs under `scratchpad/`, and by the time the next Lead read it, the cited evidence no longer
> existed. The pattern recurred. It is fixed here by committing.
>
> - **Authoritative copy:** `docs/evidence/2026-07-31-handoff/` (this one).
> - **Working copy:** `scratchpad/2026-07-31-common-swarm-handoff/` — convenience only.
> - **If the two disagree, this one wins.**
>
> **Contents.** Five documents: four written 2026-07-31 08:57 CDT by the outgoing Lead, plus
> `ADVISOR-REVIEW.md`, an independent read-only re-measurement completed 09:45 CDT. The four
> original documents carry **in-place corrections** for the nine review findings. Per this
> repo's correction doctrine, **every superseded line is kept and marked dead rather than
> deleted** — the reasoning that produced a wrong conclusion is usually worth more than the
> conclusion. Start with the corrections log below, then `ADVISOR-REVIEW.md`.
>
> **Nothing in this dossier is a live-state transcript you should trust.** Swarm membership,
> the task ledger, and clone heads all moved during authoring. Where this document reports
> such state it now points at the instrument instead. Run it.

# CommonSwarm zero-context handoff dossier

Snapshot: **2026-07-31 08:57 CDT**  
Reviewed and corrected: **2026-07-31 09:45 CDT** (AdvisorClaude, independent re-measurement)  
Prepared from: repository state, deployed artifacts, release metadata, production probes,
durable evidence, local swarm state, collaboration-agent results, and all registered Git
worktrees.

★ **Storage — CORRECTED 2026-07-31.**
~~Storage: this directory is under `scratchpad/`, which is ignored by git. These files are
deliberately **not committed**.~~ ★ **SUPERSEDED — DEAD.** Leaving the sole zero-context
handoff for a live product in gitignored `scratchpad/`, inside a checkout `AGENTS.md` warns
is shared and frequently not on `main`, put it one `git clean` away from nonexistence — and
it contradicted this repo's own rule that *"a completion claim whose evidence cannot be
re-read later is not evidence."* **You are reading the committed copy.** See the provenance
box at the top of this file.

## Corrections log

An independent adversarial re-measurement on 2026-07-31 confirmed this dossier's anchors and
found no overstatement — but produced nine findings, six of which changed the document. Every
correction is applied **in place, with the superseded line kept and marked dead**, per the
repo's correction doctrine. Full reasoning and method:
[`ADVISOR-REVIEW.md`](ADVISOR-REVIEW.md).

| ID | Severity | What changed | Where |
|---|---|---|---|
| F-1 | P0 | The stale-clone deploy has a **named** regression (0.1.4→0.1.3 on `/download`), not a theoretical one | `STATE-AND-PRODUCTION.md` §2, warning 1 below |
| F-2 | P0 | The proposed legal effective date **has already elapsed** | `STATE-AND-PRODUCTION.md` §8, `PRODUCTION-QA.md` QA-001 |
| F-4 | P1 | 68 remote branches vs 28 worktrees; 7 branches have no worktree and no disposition | `SWARM-AND-WORKTREES.md` §10 |
| F-5 | P1 | The task ledger **is** queryable; the lane table omitted 7 agents and misattributed one lane | `SWARM-AND-WORKTREES.md` §3, §4 |
| F-6 | P1 | The swarm is **not** paused | `SWARM-AND-WORKTREES.md` §1, warning 4 below |
| F-7 | P2 | Test reachability is already instrumented by a meta-gate | `STATE-AND-PRODUCTION.md` §6 |
| F-8 | P2 | `AGENTS.md` does **not** carry a stale migration count | `STATE-AND-PRODUCTION.md` §3 |
| F-9 | P0 | This dossier was not durable | fixed above; committed copy |

## Read this first

CommonSwarm is an open-free-tier coordination product for teams where people and AI agents
work side by side. A person creates a workspace, connects their own agent or sends a private
one-use link to a teammate, and sees short immutable coordination signals in a shared,
Slack-like feed. Agents announce what they are about to work on so collaborators do not
duplicate work. A signal does **not** claim, block, or close a task.

The product is live at <https://commonswarm.com>. The CLI is `cswarm`; the released version
is **0.1.4**. Self-serve signup is open. There is no paid tier or billing.

The current product goal is:

> Make the full stranger-to-first-swarm journey feel like a consumer product, and make agent
> communication real: a stranger can understand CommonSwarm, sign in, create a workspace,
> add their own agent or invite a teammate, see a live shared feed, and have agents actually
> receive and answer direct messages after their original setup turn ends—without cmux or
> terminal-keystroke injection.

The immediate continuation goal is narrower:

> Stabilize the released v0.1.4 receive MVP, close the legal/trust and repository-operations
> gaps, prove the complete signed-in production journey again, then extend the safe receive
> adapter beyond Grok while preserving strict cross-owner isolation.

## Executive status

### What is shipped

- Workspace-first `/app`: zero-workspace creation, empty workspace, prominent **Add an
  agent**, and a shared channel feed.
- Consumer-oriented marketing and onboarding copy.
- **Add an agent** branches into “my agent” and “a teammate's agent.” The teammate path
  creates a private one-use `/invite` link instead of making the sender text a long live
  credential.
- Agent identity includes a name, model label, owner, role, and stable circular initial/avatar
  treatment.
- Agent roster moved out of the left rail into a Slack-style workspace-header stack and
  searchable management dialog/sheet, keeping **Add an agent** above the roster.
- The agent prompt closes automatically after first use, also has an explicit **Done** exit,
  and uses **Back to the channel** rather than “Clear this prompt.”
- The web feed polls every two seconds while visible/focused, pauses when hidden, retains the
  last readable feed on transient errors, supports loading older updates, and refreshes agent
  identity when an unknown agent appears.
- v0.1.2 added direct asks, replies, and blocking inbox reads.
- v0.1.3 added the host-neutral, resilient
  `cswarm inbox --kind ask --follow --ndjson` receive stream.
- v0.1.4 added detached `cswarm listen start/status/stop`, measured against Grok CLI
  `0.2.117` over ACP v1. It persists idempotent effects, rotates short credentials within a
  30-day human-authorized horizon, and stops promptly on lineage revocation.
- The read edge now supplies a server-proven `sender_owner_relation` and lossless ascending
  cursor. Same-owner asks may enter one persistent worker. Cross-owner and unknown asks enter
  a fresh, isolated, tool-denied, context-free session.

### What is not done

- The live legal documents explicitly say they are drafts “not yet in force,” even though
  signup is open. Several legal/privacy statements are stale or false relative to email
  magic-link auth, Supabase client traffic, Resend SMTP, and `~/.cswarm`.
- Native background receipt exists only for the measured Grok CLI adapter. Codex, Claude,
  Gemini/AGY, ChatGPT, Cowork, and desktop hosts still need adapters or explicit foreground
  `--follow --ndjson` integration.
- Receipt is at-least-once. There is no durable acknowledgement, unread state, lease, or
  exactly-once receipt contract.
- The production canary proved a real same-owner Grok turn. Cross-owner isolation is proved
  by server/process gates, not by a second human in production.
- The 30-day renewal horizon is gated and exercised through rotation, but no wall-clock
  30-day canary has elapsed.
- The authenticated dashboard was not independently re-walked in this snapshot. The Chrome
  control transport was unavailable; public routes, deployed assets, release evidence, and
  prior production screenshots were inspected instead.
- Current planning/legal/evidence documents and the local swarm task ledger have substantial
  status drift.
- The repository is split between a current clone with no deployment configuration and a
  stale clone that holds the ignored deployment configuration. Do not deploy before this is
  reconciled.

## Stop-the-line warnings

1. **Do not deploy from either clone as-is.**
   - `/Users/yulanbot/Developer/Ridge.io/cloud-swarm-source` is exactly at production
     `main` (`a21db3f`) but has no `site/.env`, no `site/.vercel/project.json`, and no
     Supabase project link.
   - `/Users/yulanbot/Developer/Ridge.io/cloud-swarm` has those three deployment inputs but
     its `main` is eight commits behind (`af87f8a`).
   - A site build without `site/.env` succeeds and silently produces broken auth/backend
     metadata. A Vercel deploy without the project link can silently target a new project.

   ★ **SHARPENED 2026-07-31 (F-1) — this is a known regression, not a theoretical risk.**
   The eight commits clone A is missing **do touch `site/`**. Measured diff:

   ```
   site/src/lib/install.ts                          CSWARM_VERSION=0.1.3 → 0.1.4
   site/src/components/download/OtherWays.astro     pin cmd 0.1.3 → 0.1.4
   site/src/components/download/AfterInstall.astro  "cswarm 0.1.3" → "cswarm 0.1.4"
   site/src/components/connect/agent-prompt.ts      (+ its observer test)
   ```

   Production serves `cswarm 0.1.4` twice on `/download` today (measured). Clone A's working
   tree still says `0.1.3` (measured, `site/src/lib/install.ts:36`). **A deploy from clone A
   would silently roll the public install instructions back from 0.1.4 to 0.1.3 while the
   GitHub release stays 0.1.4** — a stranger following the site would pin an older CLI than
   the agent prompt requires. That is the exact shape of the D-023 availability incident:
   green deploy log, wrong artifact, copy asserting a deployment state that is no longer true.
   Treat a clone-A deploy as a **known-regression event with a named diff**, not as a risk to
   be weighed.

2. **Do not merge the dirty Sable worktree.** Its uncommitted edit removes the released
   sender-relation capability and cursor contract from the read edge. It is a rollback of
   v0.1.4 behavior, not unfinished value.

3. **Do not flip the legal pages from draft to effective without operator/counsel approval.**
   This dossier identifies product facts that must be corrected, but it is not legal advice.

4. ~~**Do not wake or repopulate the local swarm merely to reconcile it.** The user explicitly
   asked that this swarm remain paused to conserve model credits. The two current A2A members
   have no assigned continuation work.~~

   ★ **SUPERSEDED — DEAD (F-6, 2026-07-31 09:45).** The swarm is **not** paused. Measured
   membership at review time: `Anvil` (a2a), `Wren` (a2a), `Lead7` (cmux/codex, joined and
   issuing goals), `AdvisorClaude` (cmux/claude-code). This document went stale on its own
   central operating assumption within roughly twenty minutes of being written.

   **The durable lesson, which is why this line is kept rather than edited:** transcribing
   live process state into a document guarantees it rots. **Do not read swarm state from this
   file. Run the instrument:**

   ```sh
   swarm members --swarm cloud-swarm
   swarm task list --swarm cloud-swarm
   ```

   The standing credit-conservation intent still holds — keep the fleet small and quiet, and
   do not wake agents merely to collect acknowledgements. But "the swarm is paused" is a
   measurement, not a policy, and it is currently false.

5. **Do not delete a worktree or remote branch based only on ahead/behind counts.** Several
   old branches are patch-equivalent to main under different commit hashes; several have
   genuinely unique historical commits. Use the dispositions and verification sequence in
   `SWARM-AND-WORKTREES.md`.

## Repository and production anchors

| Anchor | Value |
|---|---|
| Canonical remote `main` | `a21db3f59864c1142d6d270d2aa309f98b75ed07` |
| Release tag | `v0.1.4` |
| Release commit | `4cc29e690a8452ef9fa502cf9ea2159ae6d7caa3` |
| Release checksum | `ebd4df650f066470dd128225b05e716befccf73f5e35599daa3cf9c48790c270` |
| Production site | <https://commonswarm.com> |
| Vercel project | `ridgedotio/coswarm-site` (legacy project name is intentional) |
| Vercel deployment | `dpl_FLsNC8Cu549rfCh8fSShPo3zX3AM`, Ready |
| Supabase project | `ukezjcnxjvkpkeezxaew` |
| Node requirement | `>=24` |
| Current product phase | P3-1, open free tier |

## Dossier map

1. [`STATE-AND-PRODUCTION.md`](STATE-AND-PRODUCTION.md)
   - codebase architecture and exact repository/release state;
   - what was built and why;
   - production deployment and verification;
   - current customer-facing issues and evidence gaps;
   - last measured gates and what was not re-established today.

2. [`SWARM-AND-WORKTREES.md`](SWARM-AND-WORKTREES.md)
   - paused swarm state;
   - every known agent lane, result, remaining work, and blocker;
   - stale durable task-ledger snapshot;
   - all 28 registered worktrees across both clones, with ahead/behind, unique patches,
     dirty state, and recommended disposition;
   - safe cleanup and consolidation procedure.

3. [`NEXT-EXECUTION-PLAN.md`](NEXT-EXECUTION-PLAN.md)
   - detailed phased plan and specifications;
   - legal-truth, repository, QA, host-adapter, delivery-ack, and production-canary work;
   - proposed future quiet-swarm lanes;
   - exact acceptance gates, deployment sequence, rollback, and stop conditions.

4. [`PRODUCTION-QA.md`](PRODUCTION-QA.md)
   - route-by-route public QA;
   - reproducible issue table with severity, expected/actual behavior, and evidence;
   - screenshots and current browser-control limitation.

5. [`ADVISOR-REVIEW.md`](ADVISOR-REVIEW.md) — **read this second, right after this file.**
   - independent read-only re-measurement of every anchor above;
   - the nine findings, with the method used to establish each;
   - severity-ranked work, dependency-aware sequence, and the single best first slice with
     acceptance and rollback;
   - a "what I did not establish" section that bounds the review itself.

## Canonical source documents

Read these in this order; where they disagree, the first applicable canonical document and
measured production artifact win:

1. `AGENTS.md` — current operator/deploy doctrine and traps.
2. `docs/design/SWARM-CLOUD.md` — canonical service specification.
3. `docs/design/2026-07-29-WORKSPACE-FIRST-DASHBOARD.md` — workspace-first product ruling.
4. `docs/design/2026-07-30-REMOTE-TEAMMATE-AGENT-INVITE.md` — teammate invite product spec.
5. `docs/design/2026-07-30-AGENT-RECEIVE-MVP.md` — current receive contract through v0.1.4.
6. `docs/evidence/2026-07-30-v0.1.4-agent-listener-release.md` — exact release and production
   evidence.
7. `docs/org/2026-07-26-simplification-state.md` — verification doctrine and incidents.

Several secondary documents are stale. In particular, do not trust unchecked task boxes in
the teammate-invite plan, “candidate/not landed” text in header-roster evidence, the release
version in `TODO.md`, or open task-ledger statuses without checking `origin/main` and
production first.

## Mission and product principles

- The consumer journey starts with a workspace, not a setup checklist.
- The workspace is the product: a channel/feed plus agents, people, and coordination signals.
- Adding one's own agent and inviting a teammate are distinct intents and must remain distinct
  in the UI.
- The invite sender should share a small private link, never a long live credential in a text.
- The product should know when a one-use agent prompt has been consumed and finish the UI
  automatically; pending invites/credentials must be visible and revocable.
- Agent messages need clear identity: uniform avatar shape, stable color/initials, model, owner,
  and role. Rich images/emoji are future enhancement, not current scope.
- The feed should feel live. Polling is acceptable for now if it is fast, lossless, and resilient;
  realtime transport is an optimization, not a substitute for replay.
- Most importantly, agents must receive direct asks after the setup turn. A shared feed that
  requires every agent to be manually polled is not the minimum viable product.
- Same-owner automation may retain context under explicit local permission. Cross-owner input
  is untrusted and must be isolated, context-free, and tool-denied.
- Plain and calm copy wins. The benefit is coordination and unblocking collaborators, not
  authority, enforcement, or surveillance.

## Working methodology to preserve

- Dogfood the deployed product and start from observed user friction.
- Measure the artifact, not the branch or filename.
- Pair every “must be absent” check with a positive control that proves the instrument works.
- Say whether work is written, committed, pushed, landed, deployed, or production-verified.
- Put regression tests on a script that actually runs them; `npm test` uses a literal file list.
- Run `npm run check:edge`; edge functions are outside root `tsc`.
- Use exact-SHA gates and an exact release artifact before tagging.
- Keep credentials on stdin and out of argv, environment, logs, prompts, and swarm messages.
- Preserve immutable signals; put delivery state in a separate substrate.
- Prefer quiet, bounded `/goal` lanes with clear acceptance criteria. Minimize swarm chatter.
- Use Grok for lower-level implementation/review, Kimi K3 for high-level product design, and
  Claude only sparingly for critical strategy or adversarial review. This was a user-directed
  credit-conservation policy and a trial of the quieter swarm workflow.

## Resume checklist

Before changing code:

1. Read all **five** files in this directory — the four below plus `ADVISOR-REVIEW.md`.
2. Run `swarm members` and `swarm task list` for **current** swarm state. Do not read it from
   this document (F-6).
3. Run `git fetch origin --tags --prune` in both clones and re-measure their heads.
4. Decide which clone becomes the one operator/deploy clone; follow the consolidation plan.
   **The first slice is specified end to end in `ADVISOR-REVIEW.md` §6, with acceptance,
   rollback, and a stop condition.**
5. Preserve every dirty file before any worktree cleanup. Quarantine Sable's rollback.
6. Reconcile the durable task ledger against `origin/main` — **query the live ledger, it works**
   (F-5) — and close on evidence, not on branch names.
7. Re-run the public production probes and verify the release/tag/checksum anchors.
8. Obtain the operator/counsel decision before any legal activation. **The proposed effective
   date has already elapsed (F-2); standing still is now a wrong statement, not a neutral one.**
9. Only then restart a minimal swarm with file-disjoint, dependency-aware lanes.

### The one-command orientation

If you read nothing else, run this. It re-establishes every anchor in under a minute:

```sh
# identity and current state
git rev-parse HEAD && git ls-remote origin main          # must match after consolidation
swarm members --swarm cloud-swarm                        # who is actually live

# the F-1 regression check — positive control paired with the must-be-absent grep
grep -c '0\.1\.4' site/src/lib/install.ts                # must be >= 1
grep -c 'CSWARM_VERSION=0\.1\.3' site/src/lib/install.ts # must be 0

# production is still what we think it is
curl -s -o /dev/null -w '%{http_code}\n' https://commonswarm.com/          # 200
curl -s -o /dev/null -w '%{http_code}\n' https://commonswarm.com/nope.sh   # 404 control
```

## What this dossier does not contain

- No credential, Supabase anon key, agent token, service-role key, SMTP secret, invite link, or
  copied onboarding prompt.
- No claim about active users, traffic, revenue, or error rate. There is no analytics/error
  dashboard evidence in this snapshot, and the database was not queried for customer counts.
- No legal conclusion. The legal section reports observable product/document mismatch only.
- No assertion that a worktree is safe to delete merely because this dossier recommends it as a
  candidate. The cleanup section gives the verification required immediately before deletion.
