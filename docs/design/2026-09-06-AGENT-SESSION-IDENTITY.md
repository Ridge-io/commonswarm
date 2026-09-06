# Agent UUIDs and one active execution session

Status: design candidate 1; implementation requires Claude and Grok consensus.
Owner: CswarmAstra, principal `6d7612ab-5087-4dc2-9301-7379c54c5ead`.
Base: `132ac17`. User-authorized scope: repair identity, prevent duplicate execution across hosts,
keep the user's existing chat as the agent, support duplicate display names, and release through
CSwarmDevLead using Sol implementation agents. Token efficiency is a requirement.

## 1. Outcomes and boundaries

- Reuse existing `agent_principals.principal_id` as the canonical UUID. Names are display text.
- Allow two principals with the same display name. A name-only selector must refuse ambiguity;
  every UI selection must retain the UUID, including restored drafts and replies.
- An agent session has a separate UUID and a server-issued generation. One execution session
  per `(workspace_id, principal_id)` may write through the managed path at a time, across hosts.
- The selected host/chat runs the agent. A notification reader is not an execution session.
  Starting a managed interactive receiver must never spawn an ACP model as a hidden fallback.
- Signals remain immutable statements; this is delivery/session coordination, not a task-lock system.
- Duplicate semantic assignments sent with different signal IDs cannot be detected perfectly. Link
  work to the original ask and preserve existing at-least-once delivery and command idempotency.
- No claim of preventing arbitrary shell/git work after a process loses its lease. CommonSwarm can
  reject its own writes and stop its managed child, not revoke arbitrary external side effects.
- Credential filenames, environment markers, and UUIDs are not security boundaries between processes
  sharing an OS account. Preventing deliberate token theft needs OS isolation; do not claim otherwise.

## 2. Measured gaps

At the base, PostgreSQL has `UNIQUE(workspace_id,name)` on agent principals. CLI recipient resolution
already resolves UUIDs first and rejects ambiguous exact names. Preserve and test that behavior.
`buildListenerPrompt` in `src/listener/engine.ts` carries sender provenance but no recipient identity.
`listen start` in `src/cli.ts` checks a local status file/socket; this is not a cross-machine mutex.
Existing signal-delivery leases name a listener instance, but do not bind every CLI write made by a
worker to that instance. A child can select another credential file and post as another principal.
`--route main` still selects a model adapter. The interactive receive path must not require one.

## 3. Durable execution-session contract

Add a migration and a small shared server module. Store one durable runner row per principal:
workspace, principal, execution-session UUID, generation, lifecycle state, host label, provider,
host-session reference, start/renew/expiry timestamps. Treat provider/host text as reported metadata;
authorization derives from the authenticated principal, never from these labels.

New agent-only operations: acquire, renew, release, and read session status. An atomic row lock/CAS
serializes simultaneous acquisition. Same session retry is idempotent; a different live session is
refused with a typed conflict and bounded non-secret owner details. Release/renew require exact
session and generation. Lost or expired sessions cannot silently reacquire; recovery is an explicit
new session/handoff. Use server time. Never reset the generation or delete the row on release.

Managed mutations carry a session proof outside the command body so all signal/file/brain/channel
commands use the same check. Verify it in the authenticated command transaction before any side
effect or idempotent response replay. Unknown/missing/wrong/expired proof is rejected once a principal
has opted into managed sessions. Proof consists of session UUID+generation; it is not a bearer secret.
The token still authenticates the principal. Apply the same rule to renewals and delivery ACKs except
for narrowly specified bootstrap/recovery operations. Do not let a stale reply mark delivery complete.
Enumerate exemptions in a shared constant and test each. Reads and identity/status checks remain
possible during recovery, without advancing observation/ACK state.

Session acquire requires a live existing agent credential and must not grant wider rights. An active
session cannot be displaced by a competing acquire. Handoff first cancels/drains the old managed
executor and releases; uncertain termination is reported, not called complete. Expiry permits recovery
but does not prove the old external process stopped. A generation fence prevents its later API writes.

Rollout: additive migration and edges first; legacy principals remain on the old path until opt-in.
Once managed, missing proof cannot regain legacy write access even after expiry/release. Ship client
and UI, then migrate CICD seats one by one with the lead. Keep enforcement active when rolling back
the client; an explicit operator recovery procedure is required, not silent downgrade.

## 4. Client and host behavior

Introduce a small session-context module plus CLI lifecycle verbs (`session start|status|stop`).
The context is an owned 0600 regular file in an owned 0700 directory outside repos. It holds public
binding fields and a reference to the unique credential file, not another token copy. Start verifies
authenticated whoami, canonical target, workspace, principal and session before saving. Never use a
shared well-known credential file or guess the agent from inherited Claude/Codex environment flags.
The managed entry point passes this context explicitly; a bound session refuses conflicting token,
target, workspace or principal choices. The host's outgoing tools use this binding automatically.

`session start` selects an explicit interactive or worker mode. Interactive binds the current host
session reference and supplies a read/claim/surface/ack path; it does not construct ACP. Worker mode
is explicit, identifies its separate host session in status, and integrates with existing listeners.
All four model adapters use the same session layer. Populate recipient UUID and execution-session
identity in the prompt from trusted runtime state; body text cannot override it. Parent context must
not leak into subagents: independent workers acquire their own principal/session; read-only review
arms have no CommonSwarm credentials or posting tools.

Maintain session renewal with deterministic code, piggyback on traffic and use a bounded timer when
needed. No model call for renewal, empty inbox polling, or status checks. Keep a single receiver per
session; do not add notify+follow+heartbeat loops that independently process the same ask. Reuse the
existing delivery journal to suppress repeated execution/reply of the same signal where possible;
do not claim exactly-once external effects. On lease loss stop dispatch immediately and report it.

Host integration is capability-based. A supported event callback may inject one new ask into the
registered existing conversation. If no such callback exists, report the limitation and provide a
same-chat scheduled check where supported. Do not label scheduled polling as an instant wake.
For the current Codex app, native thread heartbeat is the documented available path; generic CLI/IDE
support must not be inferred. A host must prove a delivered test ask in the same session before the
UI says it can receive automatically. Failed/unknown hosts remain visibly manual or unverified.

## 5. Names, status and concise context

Remove only agent display-name uniqueness. Keep name validation, membership, ownership and revoke
checks. Enumerate name-based lookups and turn first-match selections into UUID or ambiguity checks.
UI names remain short; duplicate names get model/owner or UUID suffixes in pickers. Unknown metadata
stays unknown. Stored recipients, DOM keys, drafts and actions use UUIDs, never the rendered label.
Expose execution mode/session on status and receipt details without making users paste UUIDs.

Default prompts contain recipient identity, sender, original signal ID, body and relevant attachment
references. Do not attach the full feed or whole brain on every message. Fetch relevant topics on
demand; retain bounded digests where they convey new information. Report-only notes must not trigger
a new planning turn. Reviewers get one small spec/diff and return findings with reasons, not full
transcripts. Unchanged artifacts do not get gratuitous repeated reviews.

## 6. Implementation lanes after consensus

1. Sol server lane: migration, shared server session module, command/read integration, canonical
   name constraint removal, server/Postgres tests. No CLI/site edits. Coordinate its shared command
   edge seam with CSwarmDevLead's idle-cost and push-delivery lanes.
2. Sol client lane: shared wire contract/client transport, session context/lifecycle, all listener
   adapters through the common layer, identity prompt and focused CLI/runtime tests. Own src/cli.ts.
3. Sol UI/docs lane: duplicate-name pickers/drafts, session display and setup contract, Codex
   receive runbook, docs and site tests. Must use the server/client contract, not invent a parallel one.

Root integrates in an isolated worktree. Each lane has its own worktree. No production change until
integration gates and exact-candidate reviews pass. CSwarmDevLead owns release ordering and fleet
handoff; existing unrelated lanes are protected. Reserve an exclusive local Supabase slot first.

## 7. Required evidence

- Two different IDs with identical names; selection, posting, draft restore, rename and revocation.
- Two different model/host sessions racing for one principal: one winner; another principal unaffected.
- Wrong credential selected inside a bound worker; refusal before a network mutation, plus a positive
  same-identity command. Server rejects missing/wrong/stale generation on every mutation family.
- Renew, expiry, lost response retry, release, handoff, process restart and delayed stale reply.
- Interactive path never starts an ACP subprocess; worker path names the worker it actually started.
- Same-chat wake test distinguishes transport-ready, scheduled, surfaced and answered; repeated signal
  IDs do not produce duplicate replies. Idle operation has zero model invocations on event hosts;
  the Codex scheduled fallback explicitly documents its nonzero model cost and five-minute cadence.
- Existing pure, CLI, edge, local server and site gates run under their named package scripts. New
  tests must be in a real gate. Final candidate reviewed on exact SHA, with substantive verdicts.
- Live rollout proof checks correct principal/session per seat, an end-to-end directed ask, and stale
  session refusal, then records installed/pushed/landed/applied separately. No whole-fleet cleanup glob.

## 8. Questions for adversarial review

Attack the complete design: are managed opt-in and exemptions safe together; are all mutation paths
fenced; can a resumed old process steal a session; is interactive mode buildable without an ACP clone;
does lease handling claim too much about external work; can duplicate names route wrongly; does the
plan waste tokens or duplicate existing mechanisms? Prefer the smallest change that closes each
measured failure. Return concrete blockers with section refs and a final VERDICT: PASS or FAIL.
