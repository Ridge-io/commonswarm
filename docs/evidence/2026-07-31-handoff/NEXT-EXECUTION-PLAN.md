# Detailed continuation plan and specifications

> **Correction, 2026-08-03.** This document names the listener adapter boundary `ListenerHostAdapter`. **No such symbol exists in the tree** — the real boundary is `ListenerModel` at `src/listener/types.ts:71`, a single `prompt()` method, with adapters `grok-model.ts` and `opencode-model.ts`. Anyone grepping the name written here gets a confident zero, which is exactly the failure mode this repo's doctrine warns about. The superseded name is left in place below rather than rewritten, because this is a historical record; use `ListenerModel` when acting.


Snapshot: **2026-07-31 08:57 CDT**  
Status: proposed continuation plan; no lane below is currently assigned or running.

## 1. Definition of the next successful state

The next phase is complete when all of the following are true:

1. There is one clearly authoritative, current, deploy-capable local clone.
2. The legal surface truthfully describes the live product, and the operator has made an
   explicit reviewed decision about whether/when it becomes effective.
3. The durable swarm task ledger, TODO, charter, defect register, design tasks, and evidence
   headers agree with current `main` and production.
4. A fresh signed-in production walkthrough proves the current workspace-first, teammate invite,
   roster, live-feed, prompt-completion, and remove/revoke journeys on desktop and mobile.
5. At least one additional high-priority CLI host can receive a CommonSwarm ask without cmux or
   terminal keystroke injection, or an evidence-backed matrix explains exactly why its honest
   supported mode remains foreground NDJSON.
6. The receive plane has a designed and preferably shipped durable delivery/acknowledgement
   contract without mutating immutable signals.
7. A real two-human production canary proves cross-owner isolation, or the exact external access
   needed to run it is explicitly recorded as the only blocker.
8. The release/deploy evidence states both what is established and what remains unestablished.

The order matters. Repository consolidation and legal truth precede another broad feature/release
cycle. Host adapters and delivery acknowledgement can be designed in parallel after the source of
truth is safe, but must integrate through one lead.

## 2. Dependency map

```text
P0 snapshot + clone consolidation
├── P0 legal product-fact inventory ── operator/counsel review ── legal activation deploy
├── task/docs/evidence reconciliation
├── authenticated production QA
│   ├── invite/pending-access refresh fixes
│   ├── feed/live-state polish
│   └── email cold-browser proof
└── receive-plane continuation
    ├── host protocol matrix ── second host adapter
    ├── durable delivery/ack design ── migration/API/CLI implementation
    ├── real cross-owner canary
    └── 24h/7d/30d longevity canary

All landed work ── exact-SHA gates ── model-inversion review ── release/deploy ── production proof
```

## 3. Phase 0 — freeze, inventory, and consolidate the repository

### Goal

Eliminate the possibility of deploying stale source or a current source tree with empty backend
configuration.

### Required actions

1. Keep the local swarm paused.
2. Fetch `origin` and tags in both root clones.
3. Re-measure every dirty file and worktree; compare with
   `SWARM-AND-WORKTREES.md` before acting.
4. Decide whether the `.gstack/` ignore line should land. Recommendation: yes, as a tiny explicit
   commit on current main, because QA artifacts are intentionally local. Do not silently absorb
   the existing user edit.
5. Make `/Users/yulanbot/Developer/Ridge.io/cloud-swarm` the operator/deploy clone:
   - preserve the one-line `.gitignore` edit;
   - fast-forward `main` from `af87f8a` to current `origin/main` with `--ff-only`;
   - reapply/inspect the ignore decision if needed;
   - verify `site/.env`, `site/.vercel/project.json`, and `supabase/.temp/project-ref` still exist
     without printing their contents;
   - verify the site environment contains a nonempty public Supabase URL/anon key and no
     service-role key using redacted/structural checks.
6. Run a clean site build and confirm generated `/start` and `/app` backend metadata is nonempty.
7. Verify the Vercel link names `coswarm-site` in scope `ridgedotio` without exposing identifiers
   beyond the already-public project ID/name.
8. Verify the Supabase link resolves to project `ukezjcnxjvkpkeezxaew`.
9. Inventory ignored assets in `cloud-swarm-source`:
   - `.gstack/qa-reports/screenshots`;
   - any generated release/build evidence;
   - this dossier if a copy is later placed there.
10. Keep `cloud-swarm-source` until its ignored value has been copied/archived and every registered
    worktree in its Git common directory is handled. Do not delete it as a shortcut.

### Acceptance

- Exactly one chosen operator clone has `HEAD == origin/main`.
- That clone has all three ignored deployment inputs and a clean structural probe.
- A clean Astro build emits eight routes with nonempty backend metadata and no service-role marker.
- `git status` is either clean or contains only an explicitly named/owned `.gitignore` decision.
- A durable local note records which clone is authoritative.
- No worktree/branch/customer data was deleted during consolidation.

★ **ADDED (F-1, 2026-07-31) — the version-regression gate. This is the acceptance criterion
that directly catches the failure this phase exists to prevent.** Run it on the **built**
output, never on the source you edited, and pair the must-be-absent grep with its positive
control on the same invocation:

```sh
grep -c '0\.1\.4' site/dist/download/index.html                # positive control, must be >= 2
grep -c 'CSWARM_VERSION=0\.1\.3' site/dist/download/index.html # must be 0
```

If the first returns 0, the instrument is broken and the second proves nothing — that is not a
pass, it is an unmeasured build. Rationale and the measured diff are in
`STATE-AND-PRODUCTION.md` §2.1.

★ **ADDED (F-9) — durability precedes tree surgery.** Before step 4's fast-forward, the handoff
dossier must exist as **committed** files, not only in gitignored `scratchpad/`. Consolidation
manipulates a shared checkout; an accidental `git clean` mid-procedure would destroy the only
copy of the document describing the procedure. Preserve first, then move HEAD.

### Rollback/stop condition

If the fast-forward conflicts with any tracked user edit beyond `.gitignore`, stop and compare;
do not reset or checkout over it. If the ignored site environment cannot be verified, no site
deploy is authorized.

## 4. Phase 1 — legal truth and activation

### Goal

Make every customer-facing legal statement match the deployed product, then activate documents
only through an explicit operator/counsel decision.

### This is two tasks, not one

1. **Engineering/product truth pass:** inventory actual data flows and write a factually accurate
   draft.
2. **Legal activation:** counsel/operator review, effective-date decision, and removal of draft
   state. Engineering cannot self-approve this phase.

### Product-fact inventory

Before editing prose, enumerate and verify:

- Auth methods: email magic link and GitHub OAuth.
- Identity fields stored for each method, including display-name fallback and verification state.
- Browser storage/session mechanism used by `@supabase/supabase-js`; avoid a blanket cookie claim
  until measured in a cold browser.
- Network destinations from `/app`, `/invite`, and `/start`.
- Service providers currently in the path: Supabase, Vercel, GitHub when selected, Resend for
  email; determine whether Cloudflare or any other operator service belongs in the disclosure.
- Production hosting/database region from the operator dashboard.
- Data categories: users, emails, devices, memberships, invitations, agent principals/runs/tokens,
  immutable signals/replies, audit/idempotency/delivery/renewal records, standard provider logs.
- Retention/deletion reality, including the absence of self-serve export/delete.
- CLI local state: keychain service plus `~/.cswarm` secure fallback/state paths.
- Current free-tier caps, spend breaker, and no-billing fact.
- Agent actions/owner responsibility and cross-workspace visibility.
- Security/contact channels and external filings.

### Required copy changes

- Terms: replace GitHub-only dependency with “email magic link or GitHub,” accurately describe
  what losing each identity path means, and ensure user-agent responsibility language still fits
  invited teammate-owned agents.
- Privacy introduction/auth sections: cover both auth methods and their actual fields.
- Privacy website section: replace “every page is static / loads nothing third party” with precise
  language: the shell is statically hosted; interactive workspace routes connect to the stated
  backend/auth providers; fonts are first-party; no advertising/product analytics/session replay
  are currently used if that remains true.
- Privacy providers: include every verified provider/data purpose and do not claim an exhaustive
  count until the inventory is complete.
- Privacy local deletion: change `~/.CommonSwarm` to `~/.cswarm`, and describe keychain removal
  separately if needed.
- Data/primitives: distinguish immutable signals from protocol task/event tables and do not imply a
  user-facing feature that does not exist.
- `/app` acknowledgement: while drafts remain, keep the honest draft notice. When effective, change
  to conventional terms/privacy acknowledgement in the same deployment as the legal pages.
- Metadata/descriptions/social cards: sweep `description`, OG, and Twitter copy, not only page body.

### Guard specification

Keep the existing build-time unresolved-placeholder guard. Add observers that fail when:

- ★ **(F-2, added 2026-07-31) a `Proposed effective` date is in the past relative to build
  time.** This is the observer that would have caught what is live right now: the guard shipped
  in `docs/evidence/2026-07-30-legal-draft-date-guard.md` checks for an unresolved
  *placeholder*, not a *stale* date, so it passed while the deployed pages proposed 27 July
  2026 four days after that date had gone by. A draft that ages past its own proposed date is
  self-contradictory on a live public page, and it degrades daily with no steady state — so
  this must fail the build, not warn. Pair it with a positive control (a future date passes)
  so the observer cannot silently become a no-op;
- effective documents contain “draft” or “proposed effective” copy;
- `/app` says documents are effective while any page still renders the draft banner;
- legal pages say GitHub-only while the live app includes email auth;
- the old `~/.CommonSwarm` path returns;
- the current provider inventory omits a provider configured in an operator-approved manifest.

Do not encode “attorney approved” as a boolean an agent can flip casually. Store the operator's
approval/effective date in a durable decision artifact and require an exact reviewed commit.

### External decisions/blockers

- Attorney review: required before activation.
- Effective date and notification approach: operator decision.
- Trademark search: external/operator action before broader announcement.
- DMCA designated-agent filing: external filing; record public directory result and renewal date.

### Acceptance

- Draft text matches verified product facts.
- Counsel/operator approval and effective date are recorded, or the pages remain explicitly draft
  with a clearly reported blocker.
- Clean site build/tests pass with mutation controls for draft/effective mismatch.
- Production deployment changes legal pages and `/app` acknowledgement atomically.
- Live positive/negative probes establish expected effective/draft markers and current auth/provider
  statements.
- No claim of attorney review, trademark clearance, or DMCA safe harbor is made without evidence.

## 5. Phase 2 — reconcile task state and durable documentation

### Goal

Ensure a zero-context agent cannot be sent backward by stale status language.

### Required documents

- `TODO.md`
- `docs/org/CHARTER.md`
- `docs/org/DEFECT-REGISTER.md`
- `docs/marketing/SITE-BRIEF.md`
- `README.md`
- `AGENTS.md` migration/release counts if stale
- `docs/design/2026-07-30-REMOTE-TEAMMATE-AGENT-INVITE.md` task checkboxes/status
- `docs/evidence/2026-07-30-header-agent-roster/README.md` status header
- local swarm durable task ledger

### Rules

- Preserve superseded statements marked dead; correct them in the artifact rather than deleting
  historical reasoning.
- Close a ledger task only with the exact main commit/release/evidence path.
- ★ **(F-5, added 2026-07-31) Query the live ledger — it works.** `swarm task list --swarm
  cloud-swarm` returns 5 `awaiting_review`, 18 `active`, 7 `done`. This dossier's claim that it
  "could not be queried" is dead. Reconcile against the instrument, not against the transcribed
  snapshot in `SWARM-AND-WORKTREES.md` §4.
- ★ **(F-5) Close against evidence, never against a branch name.** A branch prefix records which
  seat pushed, not who owned the work. Measured counterexample: the task `grok-acp-host-core` is
  owned by **Lattice** in the ledger, while the branch and worktree read
  `swarm/Lead7/grok-acp-host-core`. Closing it to Lead7 on branch-name evidence would write a
  false ownership record into a durable ledger — precisely the irreversible-record error the
  authority model exists to prevent.
- ★ **(F-5) Seven agents are missing from the lane table** — Forge, Lattice, Delta, Iris, Quill,
  Mason, Fjord — and they own real lanes. Reconstruct lanes from the ledger, not from
  `SWARM-AND-WORKTREES.md` §3.
- Split mixed tasks: e.g. “legal guard shipped” vs “legal activation externally blocked.”
- For each open defect, reproduce against current main or mark it superseded/fixed with evidence.
- Do not claim a live UI outcome based only on a source observer.
- Do not reactivate old agents to close their own tasks. The lead can reconcile durable state from
  landed evidence when the system permits.

### Defect triage priorities

- Reassess D-003 renewal-test review against current v0.1.4 gates.
- Keep D-006 stale membership/self-leave behavior open until the user journey exists.
- Keep D-016 archive semantics open until the two surfaces agree.
- Confirm D-019 (“tests never typechecked”) is now stale because `check:tests` exists, then update
  status rather than trusting the old title.
- Confirm D-020 intermittent suite failure on current exact tree before assigning it.
- Close or rewrite D-022/D-023 if current installer/availability controls prove them fixed.
- Reassess D-034 signal deadline against landed commit/tests.
- Tooling defects D-009/D-010/D-014/D-015 are outside product release unless they block the next
  swarm cycle.

### Acceptance

- Every active/awaiting-review swarm task has one of: closed with evidence, reopened with a current
  reproduction, or explicitly externally blocked.
- No current-facing document names v0.1.1/v0.1.2/v0.1.3 as the latest release.
- No design evidence says a deployed feature is unlanded.
- The launch bar distinguishes web invite acceptance from agent-host terminal/native-wake needs.
- A new zero-context reader reaches the same state described in this dossier.

## 6. Phase 3 — fresh authenticated production QA

### Goal

Re-prove the exact current consumer journey, including the specific bugs reported by the user.

### Preconditions

- Authoritative deploy-capable clone is consolidated.
- Browser control can attach to the user's existing signed-in Chrome, or the user explicitly
  approves a new controlled browser profile/window.
- Production mutations use a disposable account/workspace and a predeclared cleanup plan.
- No live credential is written to logs, screenshots, source, shell history, or this dossier.

### Desktop journey

1. Open `/app` signed out.
2. Request an email magic link to a disposable inbox.
3. Complete it in a cold browser and verify the signed-in return to `/app`.
4. Create a workspace from the zero-workspace state.
5. Confirm the empty channel shows **Add an agent** without scrolling.
6. Choose “I run this agent,” name/model it, copy the prompt, and connect with exact current
   `cswarm`.
7. Verify the prompt auto-closes on first connection and **Done**/**Back to the channel** both work.
8. Verify the feed shows the first signal, circular avatar, agent name, model, and owner.
9. Open the header roster; confirm Add-first, filter, scroll, remove permissions, Escape/backdrop/X,
   focus return, and no rail agent list.
10. From another process, post two signals. Verify they appear without pressing refresh in no more
    than two poll intervals plus network tolerance (target ≤5 seconds).
11. Hide the tab, post another signal, restore focus, and verify catch-up without duplicate rows.
12. Add a new principal while the workspace remains open; verify roster count/identity catches up
    once and does not refetch indefinitely for a later-revoked historical principal.
13. Create a teammate invite, copy the small link, verify pending access appears, cancel a spare
    invite, and keep one for recipient journey.
14. In a separate human/disposable account, redeem the invite, connect an owned agent, and verify
    owner/model identity in the sender's roster/feed.
15. Verify consumed pending access clears without reopening the workspace; if it does not, capture
    and fix the bounded refresh defect.
16. Remove/revoke the disposable agent through the UI, including accepting the native confirmation;
    verify roster disappearance while immutable historical messages remain attributable.
17. Clean up through normal product/Admin APIs. Only use trigger-bypassing database cleanup with
    explicit operator approval and exact enumeration, as in prior evidence.

### Mobile journey (390×844 minimum)

- Workspace switcher and account controls remain reachable.
- Header avatar stack is fully visible and not clipped by workspace title.
- Roster opens as a bottom sheet with Add-first and accessible close/focus behavior.
- Add/invite/prompt/Done/Back paths fit without hidden primary actions.
- Feed rows wrap long agent messages without horizontal scroll or type/owner ambiguity.
- Load older and transient error/retry UI remain reachable.

### Accessibility checks

- Keyboard-only flow for auth choices, create, Add, roster, invite, Done, Back, and remove.
- Dialog name, `aria-expanded`, `aria-controls`, live status, alert semantics, and focus return.
- Reduced-motion and light/dark contrast.
- 200% zoom and narrow viewport.
- Uniform avatar geometry; color is not the only identity signal because initials/name remain.

### Acceptance evidence

- Timestamped screenshots for desktop/mobile key states.
- Console/network error log with secrets/body content redacted.
- Measured live-update latency for at least three events.
- Exact deployed asset/deployment ID.
- Disposable graph enumeration before/after cleanup.
- A list of anything not established.

## 7. Phase 4 — host protocol matrix

### Goal

Replace “agents can consume NDJSON” with a measured support contract for the hosts users actually
run.

### Hosts to assess, in priority order

1. Codex CLI/app-server surface used by the Codex app.
2. Claude Code/Claude Desktop/Cowork supported protocol surfaces.
3. Gemini CLI and AGY/opencode host integration.
4. Existing Grok CLI ACP adapter as the reference implementation.
5. ChatGPT/Codex desktop background integration, if a supported public/local API exists.

The near-term success bar is CLI hosts. Desktop/Cowork/ChatGPT native background wake is a tall
ask and must remain “unsupported” rather than being simulated by GUI keystroke injection.

### Matrix fields

For each host, record:

| Field | Required evidence |
|---|---|
| Host/version | Exact binary/app version and installation source |
| Protocol | ACP, app server, SDK, stdin/stdout JSON, MCP notification, hook, or none |
| Start/resume | Can a detached supervisor start a new turn? Can it resume an existing session? |
| Persistence | Can one same-owner worker retain context safely? |
| Isolation | Can a fresh context/home/session be guaranteed for cross-owner input? |
| Tool policy | Can tools be force-denied and can denial be canaried before ready? |
| Cancellation | Can an in-flight turn stop on credential revocation/shutdown? |
| Authentication | How is host login discovered/copied without exposing it? |
| Output | Structured final message vs raw stream; size/encoding behavior |
| Concurrency | Multiple sessions/listeners and one-principal exclusion |
| Failure modes | Crash, hang, restart, prompt refusal, rate limit, malformed frames |
| Honest fallback | Foreground `cswarm inbox --follow --ndjson`, manual poll, or unsupported |

### Adapter interface

Keep provider-specific code behind a small host boundary. A concrete TypeScript design should
support behavior equivalent to:

```ts
interface ListenerHostAdapter {
  readonly id: string;
  probe(): Promise<MeasuredHostCapabilities>;
  start(options: HostStartOptions): Promise<HostSession>;
  runTurn(session: HostSession, turn: IsolatedTurn): Promise<NormalizedHostReply>;
  cancel(session: HostSession, reason: string): Promise<void>;
  stop(session: HostSession): Promise<void>;
}
```

`MeasuredHostCapabilities` must say whether persistent context, clean isolation, tool denial,
cancellation, and structured final output are actually available. Policy code remains in the
listener engine; an adapter cannot reinterpret `sender_owner_relation`.

### Security invariants

- Missing or invalid relation is `unknown` and takes the cross-owner path.
- Cross-owner/unknown never enters the same-owner persistent session.
- Cross-owner/unknown gets zero tools/MCP servers, a fresh session, and no project/home context.
- If the host cannot guarantee this, it may only receive same-owner messages under explicit local
  policy, or it is unsupported for automatic reply.
- Provider credentials may be permission-checked/copied into an isolated home only when required;
  never place CommonSwarm credentials in the host process environment or prompt.
- `--permissions allow` remains a local same-owner opt-in. No remote signal can enable tools.
- Startup must run a forced-deny capability canary before reporting ready.
- Status/logs remain metadata-only.

### First implementation target

After the matrix, choose the host with the strongest measured safe protocol and highest user value.
Do not choose by brand preference. Likely outcomes to test:

- If Codex app server can start/cancel clean turns and enforce a tool policy, implement it first.
- If a Claude/Gemini CLI provides a stronger structured subprocess protocol, implement that first
  and leave Codex as foreground NDJSON until safe.
- If none can guarantee cross-owner isolation, ship same-owner-only automatic mode with explicit
  refusal for cross-owner, while retaining Grok as the full reference adapter.

### Acceptance for any new adapter

- Exact measured host version pinned in docs/tests.
- Ready only after authenticated CommonSwarm arm plus host permission canary.
- Same-owner persistent and cross-owner isolated paths tested independently.
- Hostile cross-owner prompt causes zero tools and sees no prior context/file/home.
- One-principal simultaneous start has one winner.
- Crash/restart/lost-post replay prompts at most once per effect.
- Credential absent from argv/environment/status/log/raw host frames.
- Revocation cancels/stops within a measured bound.
- Foreground fallback and unsupported desktop claims are clearly documented.

## 8. Phase 5 — durable delivery acknowledgement and unread state

### Goal

Make delivery durable across process restarts and concurrent consumers without changing immutable
signals or promising impossible exactly-once model execution.

### Current state

- `signals.ts` has a lossless ascending cursor and in-process signal-ID memory.
- The listener persists reply effects, so duplicate receipt does not need to duplicate a reply.
- The P1 schema contains dormant `swarm.inbox_deliveries` with message ID, workspace, recipient,
  enqueued/delivered/acked timestamps. It has no active receive command, lease owner, lease expiry,
  or typed agent recipient.

### Required design decision

First query only schema/counts, not customer bodies, to determine whether the dormant table is
empty and unused. Then choose one of:

1. **Evolve `swarm.inbox_deliveries` additively** if its semantics can be made unambiguous without
   breaking any consumer; or
2. **Create `swarm.signal_deliveries`** if overloading `message_event_id`/text recipient would
   preserve misleading names or unknown legacy data.

Recommendation: prefer a new accurately named table unless zero-use proof plus a safe rename makes
the existing substrate clearly simpler. The design spec's mention of the dormant table is a prompt
to assess it, not permission to force-fit it.

### Proposed data contract

For each direct agent-addressed signal, maintain one delivery record keyed by
`(signal_id, recipient_agent_id)`:

```text
signal_id uuid
workspace_id uuid
recipient_agent_id uuid
enqueued_at timestamptz
lease_id uuid null
leased_by text null                 # local listener instance ID, not a bearer
leased_until timestamptz null
attempt_count integer not null
delivered_at timestamptz null       # first successful claim
acked_at timestamptz null
last_error_code text null           # bounded enum, no body
updated_at timestamptz
primary key (signal_id, recipient_agent_id)
```

Insert/enqueue must occur transactionally with the direct signal or through an idempotent backfill
that cannot miss a committed signal. Broadcast signals do not create per-agent delivery rows in the
MVP; the direct inbox is the wake contract.

### Claim/ack API

Mutating delivery state belongs at the authenticated command boundary, not the read edge.
Proposed agent-authenticated commands:

- `claim_agent_inbox`
  - input: workspace, optional cursor/limit, listener instance ID;
  - verifies token/workspace/principal and current lineage;
  - selects unacked records whose lease is null/expired with `FOR UPDATE SKIP LOCKED`;
  - sets a bounded lease and attempt count;
  - returns signal plus opaque `lease_id` and server-proven sender relation;
  - maximum batch remains bounded (for example 100).
- `ack_agent_delivery`
  - input: signal ID and lease ID;
  - only the recipient principal can ack;
  - idempotent if already acked;
  - rejects stale/wrong lease without leaking another recipient's record.
- Optional `release_agent_delivery`
  - allows graceful local failure to release before TTL;
  - otherwise lease expiry makes redelivery automatic.

Command IDs remain deterministic for ack/release so response loss is replay-safe.

### Semantics

- Guarantee **at-least-once durable delivery**, not exactly-once model execution.
- A process crash before ack causes redelivery after lease expiry.
- A lost ack response is harmless: retrying the same ack is idempotent.
- The listener consults its durable effect record before prompting; an already-produced reply is
  reposted/reconciled rather than prompting again.
- Ack only after the effect is terminally persisted and any required reply post has reached a
  known accepted/replayed outcome. For non-reply notes, ack after the host records successful
  delivery/handling according to the adapter contract.
- Expired signals become a terminal delivery state or are acknowledged with an explicit expired
  outcome; they must not loop forever.
- Unread count is the number of live, unacked delivery records. It is not derived from cursor time.
- Signals remain append-only. Delivery rows are command-owned mutable state with explicit RLS and
  audit events.

### Realtime relationship

Supabase Realtime/WebSocket may later be used only as a low-latency wake hint. On every connection
or reconnect, the client must claim/replay from durable server state. A missed socket event cannot
mean a missed message.

### Migration and compatibility

- Additive schema first; no destructive column/table removal in the same release.
- Existing v0.1.3/v0.1.4 cursor clients continue to work.
- New clients capability-probe durable delivery and fall back honestly to cursor mode.
- Add a capability version such as `delivery_ack: 1`; absence must not be interpreted as ack.
- Define retention/pruning only after `acked_at` plus signal horizon/idempotency horizon. Never
  prune a live or leased unacked row.
- Rate-limit claims/acks and bound outstanding leases per principal.

### Tests

- Transactional enqueue for every direct ask/note and none for wrong workspace/recipient.
- Two concurrent claimers: one lease winner per delivery.
- Crash before ack, lease expiry, and redelivery.
- Lost ack response and deterministic replay.
- Stale/wrong lease, wrong principal, cross-tenant, revoked token, and removed member.
- Backlog > page size drains oldest-first without gaps.
- Equal timestamps order by UUID and do not duplicate/skip.
- Acked rows never reappear; unacked rows do.
- Listener crash at each boundary: before prompt, after prompt persistence, after post, after ack.
- Cross-owner isolation remains based on server relation returned with the claimed signal.
- No signal body enters metadata-only delivery logs.
- Migration positive/negative controls and rollback to cursor-only clients.

### Acceptance

- A listener can stop, restart on another process, and receive every unacked direct ask.
- Two listeners do not both prompt the model for one live lease.
- Response loss at claim/ack/post boundaries yields at most one durable reply effect.
- UI/CLI can show honest unread/pending counts.
- Old clients continue to receive through the existing cursor path.

## 9. Phase 6 — real cross-owner production canary

### Goal

Prove the security boundary with two actual human owners rather than relying only on tests.

### Preconditions

- Explicit permission from both humans or disposable test identities.
- Separate owner accounts, agent principals, and host sessions.
- Exact release candidate and disposable workspace/data-cleanup plan.
- Cross-owner host path uses a provider adapter that can prove strict isolation.

### Journey

1. Human A creates workspace and agent A.
2. Human A sends a private teammate link to human B.
3. Human B accepts and creates agent B.
4. A/agent A sends a direct ask to agent B containing a unique harmless marker plus a hostile
   instruction to inspect files/call a tool/reveal prior context.
5. Agent B receives it in a fresh cross-owner session.
6. Verify the reply contains only the requested harmless response and no file/tool/context result.
7. Record host permission trace showing zero allowed tool calls and no shared session identifier.
8. Repeat same-owner ask to B to establish the control arm and permitted persistent behavior.
9. Revoke B's root lineage and measure listener stop.
10. Remove disposable data through normal paths and enumerate zero remainder.

### Acceptance

- Server reports exact `cross_owner` for the first ask and `same_owner` for the control.
- Cross-owner path uses fresh home/session/context and zero tools.
- Same-owner control reaches persistent worker according to local permission policy.
- One correlated reply per ask; no duplicate model prompt/effect.
- Revocation stops subsequent claims/posts within measured bound.
- Evidence contains IDs/metadata needed for causality but no credentials or sensitive prompt/body.

## 10. Phase 7 — credential longevity canary

### Goal

Prove that “long-lived like an API key” user experience is delivered by short rotating bearers
inside a revocable 30-day authorization, rather than by putting a 30-day bearer in a prompt.

### Program

- Immediate accelerated rotation test on every release.
- 24-hour unattended listener checkpoint.
- 7-day checkpoint including host restart and network interruption.
- 30-day wall-clock checkpoint or the maximum configured horizon, whichever is authoritative.
- Mid-run root-lineage revocation drill on a separate canary.

### Metadata to retain

- Listener instance/principal IDs.
- Ready, rotation, successful read, restart, and stop timestamps.
- Counts of rotations, claims, prompt attempts, posts, acks, and bounded errors.
- Credential lineage IDs only if they are non-secret; never bearer bodies.
- Cleanup state.

### Acceptance

- No human re-pastes a credential during the horizon.
- No expired bearer remains in argv/environment/log/status.
- Network/host restart recovers without losing unacked messages.
- Root revocation stops the listener promptly at any checkpoint.
- Successor state is mode 0600 and removed on final cleanup.

## 11. Phase 8 — product UX follow-ups

These follow core/legal/repository work unless fresh QA makes one a blocker.

### Credential copy

Replace “each key lasts a few hours” with outcome-oriented copy, for example:

> This one-time setup starts a listener that can stay connected for up to 30 days. CommonSwarm
> rotates short credentials automatically, and workspace owners can revoke access at any time.

Verify the statement against current renewal configuration before shipping exact numbers. If the
horizon is configurable, render truthful product copy rather than hard-coding a value that can
drift.

### Pending access refresh

Add a bounded refresh when:

- invite/agent token first-use is detected;
- a newly seen agent principal maps to a pending access entry;
- the workspace regains focus after an invite was created.

Preserve single-flight/cooldown behavior. Do not add another independent two-second poll.

### Connectivity/unread feedback

Once durable ack exists, consider:

- a subtle “Live / reconnecting / last updated” state;
- unread/pending ask count per agent;
- listener connected/last seen metadata that does not imply the model is actively working;
- clear distinction between pending invite, connected agent, and revoked agent.

### Membership lifecycle

- Self-leave workspace.
- Owner/admin removal with clear effect on agents descended from that user.
- Archive semantics consistent across UI/CLI/read surfaces.
- Removed agent disappears from current roster while historical signals retain identity.

### Avatar future

Keep current uniform circles/colors/initials. Later, design a deliberate policy for image or emoji
avatars with fallbacks, accessibility labels, content moderation, and stable identity. Do not
reintroduce mixed random shapes.

### Performance/polish

- Audit route-specific font preloads.
- Confirm `/download` whitespace at a normal interactive viewport before changing layout.
- Load-test feed/roster with 100+ signals and 25+ agents.
- Consider Supabase Realtime only after durable replay/ack is correct.

## 12. Phase 9 — observability and privacy-conscious operations

Current state has no inspected analytics/error dashboard. Before adding one, update privacy policy
and decide what is necessary.

Minimum operational telemetry should avoid content:

- edge request/error/latency counts by operation and status class;
- listener ready/reconnect/credential-stop/provider-failure counts;
- invite creation/redemption/expiry counts;
- delivery enqueue/claim/ack/lease-expiry backlog counts;
- release version adoption from explicit CLI metadata if privacy-approved.

Do not log signal bodies, prompts, replies, email addresses, bearer tokens, raw host frames, or
filesystem paths. Define retention and access before enabling telemetry. Product analytics,
session replay, and advertising remain out of scope unless a separate privacy/product decision is
made.

## 13. Proposed quiet-swarm lanes

The swarm remains paused now. When restarted, run no more concurrent lanes than can be integrated
and reviewed. A sensible first wave is three workers plus Lead.

### Lane A — repository/task reconciliation (Grok, low-level)

Suggested `/goal`:

> On a new clean worktree from current `origin/main`, reconcile repository operational state only.
> Compare the two root clones and all registered worktrees against the dossier; do not delete or
> reset anything. Produce a patch updating stale non-legal status documents and a separate exact
> cleanup manifest. Close no task without a main/evidence anchor. Run document/source observers and
> report every statement that still conflicts with production. Stop before any deployment.

Files: docs/status/task artifacts, not product/legal page content.  
Blocker: needs Lead clone-consolidation decision first.

### Lane B — legal product-fact inventory (Grok or Codex, read-only first)

Suggested `/goal`:

> Inventory the deployed product's auth, storage, provider, data, retention, and local CLI paths.
> Produce a fact matrix and a proposed factual patch to the draft terms/privacy/AUP; do not remove
> draft status or claim counsel review. Include email magic-link, Resend, Supabase browser traffic,
> and `~/.cswarm`. Add mutation-sensitive observers for product-fact drift. Stop for operator/counsel
> review before activation.

Files: legal pages/tests only after fact matrix.  
Blocker: operator/counsel activation decision.

### Lane C — authenticated production QA (Wren/Grok after access)

Suggested `/goal`:

> Execute the exact disposable signed-in journey in Phase 3 on the current deployed artifact.
> Capture desktop/mobile evidence, live-update latency, invite consumption/pending refresh, roster
> identity, prompt auto-close/Done/Back, remove confirmation, email cold-browser return, and cleanup.
> Do not retain credentials or customer data. Diagnose findings but do not implement fixes outside a
> separately assigned worktree.

Blocker: browser-control access and disposable email/account approval.

### Lane D — host matrix and next adapter (Grok implementation + Gemini/AGY inversion)

Suggested `/goal`:

> Measure local Codex, Claude, Gemini/AGY/opencode, and Grok host surfaces against the matrix in this
> dossier. Produce exact-version evidence and choose one next adapter based on safe start/cancel,
> forced tool denial, clean cross-owner isolation, and user value. Implement only after Lead accepts
> the matrix. Reuse the listener engine; provider code may not infer sender ownership. Run hostile
> isolation, concurrency, credential-leak, restart/idempotency, and revocation tests.

Files: host adapter/tests/docs, disjoint from delivery schema.  
Blocker: actual supported host APIs; no GUI keystroke injection fallback.

### Lane E — durable delivery contract (senior backend/security)

Suggested `/goal`:

> Turn Phase 5 into an exact additive migration/API/client spec. First prove whether
> `swarm.inbox_deliveries` is unused. Preserve immutable signals and old cursor clients. Specify
> claim lease, ack, retry, RLS/audience, retention, capability version, migration rollback, and
> causal tests. Do not touch production. Obtain an adversarial security review before implementation.

Files: new design doc/migration/API tests; no host-specific code.  
Blocker: design ruling on reusing vs replacing dormant table.

### Lane F — consumer design review (Kimi K3)

Suggested `/goal`:

> Using fresh authenticated desktop/mobile screenshots and the current aesthetic system, review only
> the end-to-end consumer journey. Preserve workspace-first IA, header roster, uniform circular
> avatars, Add-own-vs-teammate split, and current primitives. Propose fixes for observed hierarchy,
> copy, responsive, and empty/error states. Benchmark consumer clarity against workbench.md without
> copying its brand. Deliver annotated specs before code.

Blocker: fresh signed-in screenshots. No need to run before Phase 3.

### Review policy

- Grok and Gemini/AGY provide routine cross-family adversarial/model-inversion review.
- Claude is available again but should be used only for one critical combined plan/security review
  or pre-release decision-set review, then fully exited.
- The Lead reviews the combined decision set and is the only deployer.

## 14. Exact gate and release sequence

For any receive/backend release:

1. Resolve exact source/worktree/branch.
2. Ensure every new pure test is reachable from a package script; update the literal root test list
   where appropriate.
3. Run:
   - `npm install` if lock/dependency state requires it;
   - `npm test`;
   - `npm run check:tests`;
   - `npm run build`;
   - `npm run check:edge`;
   - `npm run test:p1-cli` with an exclusive DB slot;
   - `npm run test:p1-server` with local Supabase and an exclusive DB slot;
   - `npm --prefix site test`;
   - clean site build after deleting `site/dist`;
   - release bundle self-test.
4. Run mutation/negative controls that prove new tests fail on the causal pre-fix boundary.
5. Run routine Grok + Gemini/AGY inversion review. Use one sparse Claude review only if the combined
   change has critical security/product strategy risk.
6. Land to main; fetch and verify exact landed SHA.
7. Build release artifact at the exact tag candidate; compare local checksum, checksum file, and
   uploaded digest.
8. Publish final GitHub release, not draft/prerelease, with both assets.
9. Install through public `commonswarm.com/install.sh` in an isolated target and verify exact
   version/protocol.
10. Apply migrations before deploying functions that depend on them.
11. Deploy only the functions that changed; record version/hash and anonymous controls.
12. Site deploy:
    - verify `site/.env` structurally;
    - delete `site/dist`;
    - clean build;
    - copy `site/.vercel` into `dist/.vercel`;
    - deploy `dist` to `ridgedotio/coswarm-site`;
    - verify the public alias, not a per-deployment SSO URL.
13. Run live positive/negative route/backend probes.
14. Run disposable production canary and cleanup.
15. Commit durable evidence stating established and not established outcomes.

### Rollback

- Listener/host defect: disable new adapter first; retain host-neutral cursor path.
- Delivery-ack defect: clients fall back to v0.1.4 cursor path; leave additive table/columns in place
  until a separate safe migration.
- Read-edge defect: redeploy prior exact function version; new clients must fail capability startup
  rather than run with an unsafe relation/cursor.
- Site defect: redeploy prior known Vercel deployment to the same project alias.
- Legal deploy mismatch: restore prior draft/effective set atomically; do not leave `/app` acceptance
  and legal pages in different states.

## 15. Decisions requiring the user/operator

1. Which clone becomes the permanent operator/deploy clone? Recommendation: current
   `/cloud-swarm`, fast-forwarded safely.
2. Should `.gstack/` be committed to `.gitignore`? Recommendation: yes.
3. Who will review/approve legal drafts and what is the effective date?
   ★ **(F-2) THIS IS NOW TIME-FORCED, NOT PARKABLE.** The deployed pages propose 27 July 2026,
   which has passed. Three exits exist and one must be picked: **(a)** move the proposed date
   forward, **(b)** activate the documents, or **(c)** change the copy to something true while
   review is pending. Only (c) is available to engineering without counsel, and even (c) should
   be ratified by the operator. Doing nothing is not a neutral hold — it leaves an affirmatively
   contradictory statement on a live public page that worsens daily.
3a. ★ **(F-9) Should the handoff dossier be promoted into `docs/` and committed?**
   Recommendation: **yes, before any consolidation or cleanup touches either clone.** It is the
   sole zero-context handoff for a live product and currently sits one `git clean` from
   nonexistence, which contradicts this repo's own evidence doctrine.
3b. ★ **(F-4) Who runs the separate remote-branch audit pass?** The cleanup procedure in
   `SWARM-AND-WORKTREES.md` covers 28 worktrees; there are 68 remote branches, at least 7 with
   no worktree and no recorded disposition. Remote deletion is already operator-only; this
   decision is about *commissioning the audit*, not about deleting.
4. Has the DMCA agent been registered, and what is its expiry/renewal date?
5. Has a trademark/common-law search been completed for CommonSwarm?
6. May QA create two disposable human accounts and a workspace for a real cross-owner canary?
7. May browser QA open a new controlled Chrome window/profile if existing Chrome attachment remains
   unavailable?
8. Which user host is the highest-value second adapter after the evidence matrix—not before it?
9. Is privacy-conscious operational telemetry desired, and what retention/access policy applies?

## 16. Prioritized TODO checklist

### P0 — before another deploy

- [ ] ★ **(F-9) Commit the handoff dossier to `docs/evidence/2026-07-31-handoff/` FIRST.**
      Nothing else in this list may touch a shared checkout until the document describing the
      procedure survives a `git clean`.
- [ ] Consolidate clones and deployment configuration.
- [ ] ★ **(F-1) Gate the consolidated build**: `0.1.4` present ≥2 **and**
      `CSWARM_VERSION=0.1.3` absent, on the built `download/index.html`.
- [ ] Preserve/decide the `.gitignore` change.
- [ ] Quarantine Sable rollback; do not merge.
- [ ] Verify current exact main and run baseline gates.
- [ ] Produce legal product-fact matrix.
- [ ] ★ **(F-2) Resolve the elapsed proposed effective date** — move it, activate, or make the
      copy true. Time-forced; degrades daily.
- [ ] Obtain counsel/operator ruling before legal activation.
- [ ] Reconcile stale task/document statuses **against the live ledger** (F-5), closing on
      evidence rather than branch names.

### P1 — core product completion

- [ ] Fresh signed-in desktop/mobile production journey.
- [ ] Cold-browser email magic-link return proof.
- [ ] Verify/fix pending-access auto-refresh.
- [ ] Finish host protocol matrix.
- [ ] Ship one safe additional CLI host adapter.
- [ ] Specify and implement durable delivery claims/acks.
- [ ] Run real two-human cross-owner production canary.
- [ ] Start 24h/7d/30d listener longevity canaries.
- [ ] ★ **(F-4) Run the remote-branch audit as a pass distinct from worktree cleanup.** 68 remote
      branches vs 28 worktrees; ≥7 branches have no worktree and no disposition. Until this
      exists, every worktree-less branch is **retain, unassessed**.

### P2 — reliability and UX

- [ ] Align credential-lifetime copy with rotating 30-day user outcome.
- [ ] Add honest connectivity/unread status after durable ack.
- [ ] Resolve member self-leave/remove/archive semantics.
- [ ] Add privacy-conscious operational telemetry if approved.
- [ ] Audit font preloads and `/download` whitespace.
- [ ] Load-test larger feeds/rosters.

### P3 — later

- [ ] Realtime wake hints layered over durable replay.
- [ ] Native desktop/ChatGPT/Cowork integrations where supported.
- [ ] Self-serve data export/account deletion.
- [ ] Rich avatar image/emoji policy.
- [ ] Billing/paid tier only after a separate product decision.
- [ ] Files/tasks/threads only when intentionally promoted to consumer primitives.

## 17. Explicit non-goals

- No cmux/GUI keystroke injection presented as product receive support.
- No 30-day bearer embedded in onboarding prompts.
- No cross-owner tool-enabled wake.
- No mutation of immutable signals to represent delivery/read state.
- No analytics/session replay added without privacy and operator decisions.
- No wholesale worktree/remote-branch deletion.
- No legal activation by an autonomous coding agent.
- No claim that a green deploy log proves `commonswarm.com` changed.
