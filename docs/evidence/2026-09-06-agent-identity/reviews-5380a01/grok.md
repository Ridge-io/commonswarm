I'll review the integrated server and names lanes against the spec. First I need the full prompt, the accepted contract, and the actual checkout.HEAD is `5380a01` on the identity branch. Next I’ll read the spec contract and the server/names evidence, then measure the actual code.I’ll inventory the mutation fence, migration, and UUID selection in the checkout rather than trust the evidence READMEs.The fence exists. Next I’ll check every command-dispatch path, the rest of the migration, and whether tests actually pin the typed codes.Measured at `5380a01`. I did not run `test:p1-server`. Evidence READMEs are claims, not proof.

## GAP (this is the fail)

Section 8 says managed `queued` stays non-terminal, with a pending-surface phase, and claim/ACK bound to the live execution UUID/generation. A bare queued-to-observed promotion must be refused when managed.

None of that is in the wire or the delivery rows:

- `src/cloud/session-wire.ts` has proof headers, TTL, and error codes. It has no pending-surface type.
- `ackAgentDelivery` still promotes `queued` → `observed` with no lease and no `managed_at` check (`supabase/functions/command/durable-delivery.ts:637-676`).
- Claim/ACK still bind only `lease_id` + `listener_instance_id` (`durable-delivery.ts:729-750`). No session UUID/generation on the row.
- `reclaimUnsurfacedLeases` only clears unacked leases (`command/index.ts:9683-9697`). A `queued` row already has `acked_at` set, so recovery cannot reclaim it.

The client lane is told to “use the server’s pending-surface protocol” (`docs/design/2026-09-06-IDENTITY-CLIENT-LANE.md` item 9). That protocol is not here. The next author would have to invent it.

The fence does stop a **stale proof** from claiming or ACKing (`command/index.ts:7338-7364`; test at `tests/p1-server/agent-execution-sessions.test.ts:480-536`). That is not the missing pending-surface contract.

## What holds (file:line)

**Opt-in + exemption.** `AGENT_SESSION_PROOF_EXEMPT_KINDS` is only `acquire_agent_session` (`session-wire.ts:48-50`). Acquire does not set `managed_at`; unmanaged returns `session_not_managed` (`command/index.ts:9963-9969`). Enable is human owner/admin, row-locked, and refuses live leases (`9761-9785`). Agents cannot disable (`lockHumanManagedPrincipal` at `9724-9752`).

**Fence.** Agent mutations hit `enforceAgentSessionProof` unless exempt (`command/index.ts:7338-7340`). Inventory test pins the dispatcher (`tests/protocol-workspace.test.ts:1596-1667`). Activity uses the same fence (`activity/index.ts:130-138`). Read does not claim/ACK (`read/index.ts:420`; no `claimAgentInbox`). Capability is `swm_cap_` / `swarm_capability` only.

**Migration.** View lists columns; no `p.*`; no `wake_id`; has `managed_at` (`20260906000020_agent_execution_sessions.sql:300-318`). Function returns `managed_at` (`97-110`, `291`) and keeps the three grants (`296-298`). Duplicate names: unique constraint dropped (`4-5`); default still refuses under `pg_advisory_xact_lock` (`command/index.ts:6330-6356`); `allow_duplicate_name: true` creates a second row.

**Names.** Picker/chips/drafts/rail keep UUIDs. Name-only drafts resolve only when unique (`identity-label.ts:109-141`). Mention suffix selects the right twin (`mention-address.ts:69-96`, `mention-address.test.mjs:69-96`). CLI `--to` already refuses ambiguous names (`signals.ts:1440-1462`). Create-another sends the flag only after the click (`AgentConnect.astro:602-605`, `identity-label.ts:172-183`).

**Typed codes in tests that exist.** Wrong key → `session_proof_invalid`; wrong principal/generation → `session_conflict`; expiry/stale claim → `session_expired`; retired UUID → `session_retired`; missing headers → `session_proof_missing`; duplicate default → `principal_name_taken` (`agent-execution-sessions.test.ts:322-689`). Those matches are real.

## NIT

- Recreated view grants SELECT to `authenticated, swarm_read` (`migration:318`) but does not `REVOKE … FROM anon` (sibling views do).
- Read `is_live` treats NULL `expired_at` as live (`read/index.ts:640`); the fence treats NULL as dead (`agent-auth.ts:236`).
- No server test asserts `session_not_managed`, `session_already_managed`, or `session_leases_live` (codes exist in handlers; tests never name them).
- Re-enable `ON CONFLICT` does not replace `session_id` with the placeholder it then retires (`command/index.ts:9786-9810`).

## Not established

Interactive ACP/model factory (client lane, not in this diff). Live `test:p1-server` on this SHA. Production apply.

QUOTE-BACK: # Agent UUIDs and one active execution session
VERDICT: FAIL
REASON: Lane A never shipped pending-surface or a managed refusal of bare queued-to-observed, so the next client author would have to invent the delivery contract section 8 already required.
