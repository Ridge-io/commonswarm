I'll start by reading the full arm prompt and the spec contract, then check the round-2 diff against section 8.I'll pull the spec contract, the round-1 FAIL, and the Lane A evidence, then check the round-2 code against them.I'll read the claim/ACK handlers, recovery, enable path, and the new tests next — those are the round-1 FAIL points.Measured at `d141c1e` (ancestor of `5380a01`). Exact arm, Lane A round 2 only. I did not run `test:p1-server`. Evidence READMEs are claims.

## Round-1 FAIL is closed

Section 8 pending-surface is on the wire. Names come from `src/cloud/session-wire.ts`. The next client author does not invent them.

## Contract (file:line)

**Claim binds proof, not body.** `claimAgentInbox` writes `session_id` / `session_generation` from the verified proof (`durable-delivery.ts:357-358`; caller `command/index.ts:8524-8525`). Command body has no session fields.

**ACK observed needs current proof and `surfaced: true`.** Managed `observed` with `surfaced !== true` returns `not_surfaced` (`durable-delivery.ts:699-701`) → HTTP 409 `delivery_not_surfaced` (`command/index.ts:9696-9701`, `session-wire.ts:128-129`). Surfaced ACK sets `surfaced_at` (`durable-delivery.ts:736-738`). Queued ACK does not (`831-835`).

**Tests that drive it:** bind `managed-delivery.test.ts:338-353`; bare + `surfaced:false` `:368-425`; surfaced `:427-472`.

**Recovery reopens queued, does not bump attempts.** `reclaimUnsurfacedLeases` (`command/index.ts:9728-9767`) clears session/lease and reopens `ack_outcome='queued'`. Called from recover (`9978`), fresh acquire (`10156`), release (`10263`), disable (`9933`). Reclaim CASE keeps `attempt_count` (`durable-delivery.ts:349-356`). Test `:509-573`.

**Acquire retry with a new host binding is refused.** `sessionBindingsConflict` (`session-wire.ts:91-96`) on live UUID+key (`command/index.ts:10096-10110`). Test `agent-execution-sessions.test.ts:736-779`.

**`swarm_read` cannot select `key_hash`.** Column GRANT omits it; view omits it (`20260906000030:53-88`). `read/index.ts:642` joins the view. Test `agent-execution-sessions.test.ts:781-822`. Migration does **not** rebuild `swarm_read.agent_principals` with `p.*`. Round-1 view still lists columns, no `wake_id` (`20260906000020:300-314`). Test `agent-execution-sessions.test.ts:599-608`.

## Round-1 nits

| nit | fix | test |
|---|---|---|
| REVOKE anon | `20260906000030:99` + DO `:160-163` | migration DO, not a live server test |
| `is_live` NULL | `read/index.ts:640` matches fence `agent-auth.ts:236` | source match `protocol-workspace.test.ts:1763-1781` |
| three codes | handlers `9842/9853/10049` | `agent-execution-sessions.test.ts:692-734` |
| re-enable `session_id` | `ON CONFLICT` `:9886-9887` then retire placeholder `:9892` | `:824-846` |

## Unmanaged positive control

`managed-delivery.test.ts:474-507`: no headers, no `surfaced`, queued→observed 200, `session_id`/`surfaced_at` NULL. Also `post_signal` with no headers `agent-execution-sessions.test.ts:621-632`. Managed flag is `=== true`; unmanaged SQL ORs do not fire.

## Fence (unchanged, still holds)

Exemption is only `acquire_agent_session` (`session-wire.ts:104-106`). Inventory `protocol-workspace.test.ts:1602-1673` (61/61 in this run). Activity uses the same fence (`activity/index.ts:130-138`). Read does not claim/ACK. Capability is `swm_cap_` only.

## NIT

- `AckResult.session_expired` is never returned; the fence answers first.
- Unmanaged claim will copy parse-ok headers onto the row (`command/index.ts:8525`). Old clients do not send them.
- No test that **acquire-after-expiry** (not `recover`) reclaims queued, or that TTL expires queued-unsurfaced. The SQL is there (`durable-delivery.ts:234-263`, `command/index.ts:10156`).
- Live-holder cache loss: queued rows stay out of `deliveries[]` until release/recover/expiry. Client can compose `release` + acquire. Not a new wire.

## Not established

`test:p1-server` on this SHA. Production apply. Client ACP/idle (not this diff).

QUOTE-BACK: # Agent UUIDs and one active execution session
VERDICT: PASS
REASON: Round 2 ships the section 8 pending-surface wire (claim binds proof, managed observed needs surfaced=true, recovery reopens queued without burning attempts, binding retry and key_hash hides hold) with tests that drive those claims.
