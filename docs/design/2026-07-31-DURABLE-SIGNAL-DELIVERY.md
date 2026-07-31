# Durable direct-signal delivery and acknowledgement

Status: revised after adversarial security review; implemented in codebase; not yet production-applied until rollout

Date: 2026-07-31

Applies after: CommonSwarm v0.1.4 cursor listener and server-proven sender relation

## Goal

Make direct agent delivery survive listener restarts and competing consumers without mutating
immutable signals or claiming exactly-once model execution. The server contract is at-least-once
delivery with one live lease winner; the listener keeps its existing deterministic reply effect so
retries cannot create a second durable reply signal.

This design preserves the v0.1.4 ascending-cursor path as a compatibility fallback. Realtime may
later wake a listener, but it never becomes the source of delivery truth.

## Measured starting point

The following was established against the linked production project on 2026-07-31 without reading
or printing signal/customer bodies:

- `supabase inspect db table-stats --linked` enumerated 27 `swarm` tables and estimated
  `swarm.inbox_deliveries` at zero rows.
- A data-only dump excluded the other 26 enumerated tables. Its output contained exactly one COPY
  section, for `swarm.inbox_deliveries`, no INSERT statement, a valid PostgreSQL backslash-dot
  terminator, and exactly zero data rows. The temporary dump was deleted immediately.
- The first row counter did not recognize the backslash-dot terminator and counted 11 footer lines.
  That result was invalidated and not treated as data. The corrected probe checked the two
  terminator character codes and returned zero rows with `terminator_found=true`.
- Source enumeration finds the dormant table only in schema/grant/comment material. No command,
  read edge, CLI, or listener reads or writes it.
- The dormant columns (`message_event_id`, free-text `recipient_principal`) do not accurately name
  the current typed signal/agent contract.

Decision: create a new accurately named `swarm.signal_deliveries` table. Leave
`swarm.inbox_deliveries` untouched and mark it dormant. A rename/re-purpose would save one empty
table but would make the first delivery migration destructive and harder to roll back.

## Adversarial review disposition

The combined adapter/delivery review is preserved at
`docs/evidence/2026-07-31-aegis-security-review.md`. This revision closes every delivery-contract
finding before implementation:

- H5: stale leases reset and requeue; only immutable signal TTL produces `expired`.
- H6: the idempotency ledger stores body-free references and response hydration re-reads immutable
  signals after exact-recipient authentication.
- H7: the read edge never assumes `swarm_command`; narrow authentication/count authority lives in
  one pinned `SECURITY DEFINER` function.
- H8: rollback disables claim first, drains/acks live leases, rewinds cursor fallback, then disables
  ack.
- M1-M4: forced RLS/admin policy, signal-inserter role assertion, explicit lease-capability
  handling, ten-claim poison ceiling, and 30-day terminal-row purge are now part of the contract.

The adapter findings B1-B4, H1-H4, and M5-M8 are independent code work and are not claimed fixed by
this document.

## Non-negotiable invariants

1. `swarm.signals` stays append-only. Delivery state lives in a separate mutable table.
2. Only direct typed-recipient `ask` and `note` signals (`NEW.kind IN ('ask', 'note')` with `to_agent_principal_id IS NOT NULL`) enqueue delivery rows. Directed `working-on` signals are rejected at command validation today. Broadcasts, direct-human signals, and non-ask/note kinds do not fan out into agent deliveries. Any future signal kind requires an explicit migration, spec update, client decision, and tests.
3. Enqueue is in the same database transaction as signal insertion.
4. Claim and acknowledgement run at the authenticated command boundary, never through the public
   read edge.
5. Only the exact recipient agent principal may claim or acknowledge its delivery.
6. Sender ownership is computed by the server at claim time. Missing/inconsistent authors are
   `unknown`; clients may not infer or upgrade it.
7. One unacked delivery has at most one unexpired lease. Two claimers cannot both win it.
8. Acknowledgement happens only after the local effect is terminally persisted and any required
   reply post is accepted or idempotently replayed.
9. Bodies never enter delivery metadata, idempotency rows, logs, audit detail, status, or error
   fields. A claim response is hydrated from immutable signals only after idempotency resolution.
10. Old cursor clients continue working throughout migration and rollback.
11. Poison deliveries terminate visibly after a bounded number of lease claims, and terminal rows
    have a server-owned retention job. Neither bound is caller-selectable.

## Additive schema

Create `swarm.signal_deliveries`:

```sql
CREATE TABLE swarm.signal_deliveries (
  signal_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  recipient_agent_principal_id uuid NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  lease_id uuid,
  leased_by uuid,
  leased_until timestamptz,
  last_lease_id uuid,
  last_leased_by uuid,
  attempt_count integer NOT NULL DEFAULT 0,
  lease_expiry_count integer NOT NULL DEFAULT 0,
  last_lease_expired_at timestamptz,
  delivered_at timestamptz,
  acked_at timestamptz,
  ack_outcome text,
  last_error_code text,
  updated_at timestamptz NOT NULL DEFAULT statement_timestamp(),
  PRIMARY KEY (signal_id, recipient_agent_principal_id),
  FOREIGN KEY (signal_id, workspace_id)
    REFERENCES swarm.signals (id, workspace_id),
  FOREIGN KEY (recipient_agent_principal_id, workspace_id)
    REFERENCES swarm.agent_principals (principal_id, workspace_id),
  CHECK (attempt_count BETWEEN 0 AND 10),
  CHECK (lease_expiry_count BETWEEN 0 AND attempt_count),
  CHECK (num_nonnulls(lease_id, leased_by, leased_until) IN (0, 3)),
  CHECK (
    acked_at IS NULL
    OR ack_outcome = 'expired'
    OR delivered_at IS NOT NULL
  ),
  CHECK (ack_outcome IS NULL OR ack_outcome IN
    ('replied', 'observed', 'expired', 'failed_terminal')),
  CHECK (last_error_code IS NULL OR last_error_code ~ '^[a-z][a-z0-9_]{0,63}$'),
  CHECK (num_nonnulls(last_lease_id, last_leased_by) IN (0, 2)),
  CHECK (
    acked_at IS NOT NULL
    OR (last_lease_id IS NULL AND last_leased_by IS NULL)
  ),
  CHECK (
    acked_at IS NULL
    OR (last_lease_id IS NOT NULL AND last_leased_by IS NOT NULL)
    OR ack_outcome = 'expired'
    OR (ack_outcome = 'failed_terminal' AND last_error_code = 'delivery_attempts_exhausted')
  )
);
```

Additional constraints in the migration:

- `last_lease_id` and `last_leased_by` record terminal client ACK lease identity and are paired (both NULL or both non-NULL).
- An unacked row (`acked_at IS NULL`) never holds a `last_lease_id` / `last_leased_by` pair.
- Terminal rows (`acked_at IS NOT NULL`) store the exact client ACK `lease_id` and `leased_by` pair, with NULL permitted ONLY for server-owned automatic terminalization paths (`ack_outcome = 'expired'` from TTL cleanup or `failed_terminal` with `last_error_code = 'delivery_attempts_exhausted'`).
- `ack_outcome` is null exactly when `acked_at` is null.
- Acked rows have active lease fields (`lease_id`, `leased_by`, `leased_until`) cleared.
- `leased_until` must be later than `updated_at` when a lease is present.
- `last_lease_expired_at` is null exactly while `lease_expiry_count` is zero.
- The primary unacked index orders by recipient, workspace, enqueue time, then signal UUID and is
  partial on `acked_at IS NULL`.
- The table is owned by `swarm_admin`; RLS is enabled and forced. Explicit all-row policies exist
  for `swarm_admin` and `swarm_command`. Only `swarm_command` receives SELECT/INSERT/UPDATE.
  `anon`, `authenticated`, `PUBLIC`, and `swarm_read` receive no direct table authority.
- `swarm_command` receives no DELETE. A `SECURITY DEFINER` function owned by `swarm_admin`, with a
  pinned `search_path`, deletes only terminal rows whose `acked_at` is at least 30 days old. A
  daily named `pg_cron` schedule invokes it. The floor comes from
  `delivery_retention_days >= 30`; unacked rows are never pruned.

`leased_by` is the listener instance UUID already generated for supervisor status. It is metadata,
not a bearer. `lease_id` is a random, row-scoped, intra-principal capability: agent authentication,
exact recipient, workspace, `leased_by`, and the lease UUID must all match. It never appears in
status, logs, audit detail, or the read edge.

## Transactional enqueue and backfill

An `AFTER INSERT` security-invoker trigger on `swarm.signals` inserts one delivery row when
`NEW.to_agent_principal_id IS NOT NULL AND NEW.kind IN ('ask', 'note')`. Its function fully qualifies
every relation and pins its `search_path` to `pg_catalog`; it cannot be redirected through
caller-controlled names. The trigger is the invariant boundary: old command edges, new command
edges, and any future controlled insert path all enqueue identically for direct `ask` and `note`
signals. It uses `ON CONFLICT DO NOTHING` only for migration/replay idempotence. Directed
`working-on` signals are rejected at command validation today, while any future signal kind
requires an explicit migration, spec update, client decision, and test suite additions. The
inserting `swarm_command` role receives the narrow INSERT privilege needed by the trigger; there is
no security-definer bypass.

The migration enumerates every non-superuser role with effective INSERT on `swarm.signals` and
aborts unless that role can also INSERT `swarm.signal_deliveries`. This converts a future grant
mistake into a migration failure rather than a later outage of the append-only signal path. The
assertion initially resolves exactly `swarm_admin` and `swarm_command`.

Migration order is deliberately:

1. create table, constraints, grants, and indexes;
2. create the enqueue function and trigger;
3. backfill direct agent `ask` and `note` signals whose `until` is still in the future;
4. assert no live direct agent `ask` or `note` signal lacks a delivery row;
5. assert the signal-inserter/delivery-inserter role set is identical;
6. create the terminal-row purge function and named daily retention schedule.

Creating the trigger before backfill closes the deploy race: inserts committed after the migration
DDL cannot fall between backfill and trigger activation. Broadcast rows are the negative control.

Direct `ask` and `note` signals enqueue. The automatic reply engine still prompts only for asks;
notes become terminal `observed` effects and are acknowledged without a model turn. Directed
`working-on` is currently ineligible at the command surface, but the trigger remains typed-recipient
based so a future intentional addition cannot silently skip delivery.

## Command contract

### `claim_agent_inbox`

Agent-only request:

```json
{
  "kind": "claim_agent_inbox",
  "listener_instance_id": "uuid",
  "limit": 10
}
```

- `limit` defaults to 10 and is constrained to `1..100`.
- Lease duration is a server constant of 15 minutes in the first release. The caller cannot widen
  it. This covers the bounded worst case of three 120-second prompt attempts plus five bounded post
  attempts and backoff. A later heartbeat/renew command requires a separate measured need.
- Ten lease claims is the server-side poison-message ceiling in the first release. The caller
  cannot raise it. A live row whose prior lease has expired is first reset by clearing all lease
  fields, incrementing `lease_expiry_count`, and setting `last_lease_expired_at`; it remains
  unacked and eligible for redelivery. **Lease expiry never means signal expiry.**
- After stale leases are reset, a row with `attempt_count >= 10` and no live lease is terminally
  acknowledged as `failed_terminal` with `delivery_attempts_exhausted`. This bounded failure is
  surfaced in status/evidence rather than silently redelivering and spending model calls forever.
- Only a signal whose immutable `until <= statement_timestamp()` is terminally acknowledged as
  `expired`. This can happen before its first delivery; it never aliases a stale lease.
- Candidates are exact-recipient, unacked, signal-live, below the attempt ceiling, and unleased.
  Selection is oldest-first by `(enqueued_at, signal_id)` with `FOR UPDATE SKIP LOCKED`.
- Each winner receives a fresh row-specific `lease_id`, the caller's `leased_by`, fixed
  `leased_until`, incremented `attempt_count`, first `delivered_at`, and `updated_at`.
- The response returns the immutable signal, the row-scoped lease capability, server-proven
  `sender_owner_relation`, and exact remaining live-unacked count. It never returns an owner UUID.
- Authentication comes from `loadAgentCredential`; request/artifact fields cannot select another
  principal.
- The idempotency row stores only bounded delivery references (`signal_id`, `lease_id`,
  `leased_until`, `sender_owner_relation`) and the count observed in the original transaction. It
  never stores a signal body. Fresh and replay responses hydrate those references from immutable
  `swarm.signals` after exact-recipient authentication; a missing/mismatched row is a server
  integrity error, never a partial batch.
- A retry with the same command ID therefore reproduces the same batch without copying bodies into
  the ledger. Clients reject replayed leases already past `leased_until` and issue a new claim
  command ID.

The fresh claim transaction follows this order; implementations may not reorder the steps:

1. authenticate the exact agent/workspace and resolve an idempotency replay before fresh mutation;
2. lock/reset this recipient's stale leases, clearing lease fields and incrementing expiry metadata
   without acknowledging them;
3. terminalize **unleased** rows whose immutable signal TTL elapsed as `expired`;
4. terminalize remaining unleased, signal-live rows at the ten-attempt ceiling as
   `failed_terminal/delivery_attempts_exhausted`;
5. select signal-live, unleased, below-ceiling candidates oldest-first with
   `FOR UPDATE SKIP LOCKED`, write their leases, and store body-free replay references;
6. compute the exact live-unacked count, commit, then hydrate immutable bodies for the authenticated
   response.

An unexpired lease is never stolen or TTL-terminalized by a competing claim. This explicit order is
the mutation control for the H5 failure class.

Claim response shape:

```json
{
  "ok": true,
  "status": "accepted",
  "capabilities": {
    "delivery_claim": 1,
    "delivery_ack": 1,
    "sender_owner_relation": 1
  },
  "deliveries": [
    {
      "signal": { "id": "uuid", "kind": "ask", "body": "..." },
      "lease_id": "uuid",
      "leased_until": "timestamp",
      "sender_owner_relation": "same_owner|cross_owner|unknown"
    }
  ],
  "pending_delivery_count": 1,
  "terminal_delivery_failure_count": 0
}
```

### Abuse Bounds and Outer Transaction Order

1. **Per-Principal Rate Limits**:
   - Claim rate limit: `DELIVERY_CLAIM_RATE_LIMIT_PER_MINUTE = 120` per workspace and recipient agent principal (`delivery:claim:principal:<workspace_uuid>:<principal_uuid>`).
   - ACK rate limit: `DELIVERY_ACK_RATE_LIMIT_PER_MINUTE = 240` per workspace and recipient agent principal (`delivery:ack:principal:<workspace_uuid>:<principal_uuid>`).
   - Rate bucket enforcement precedes idempotency lookup (abuse-accounting mutation precedes delivery-state mutation). On breach, returns HTTP 429 `{ error: "rate_limited", limit, resets_at, message }` with `Retry-After` header. First refusal in a window writes audit log and security alert; subsequent refusals write no audit/alert.

2. **Concurrency-Safe Live-Lease Ceiling**:
   - `DELIVERY_MAX_OUTSTANDING_LEASES = 100` live unacknowledged leases per recipient principal across all listeners/tokens.
   - Exact recipient `agent_principals` row is locked `FOR UPDATE` in fresh claim transactions before cleanup/count/claim.
   - At ceiling capacity, returns `200 accepted` with `deliveries: []` and truthful `pending_delivery_count`.

3. **Poison Visibility**:
   - `terminal_delivery_failure_count` reports the number of delivery rows newly terminalized as `failed_terminal/delivery_attempts_exhausted` in that claim transaction.
   - Emits `delivery_attempts_exhausted` security alert when positive. Replays reproduce the count from the body-free idempotency ledger without emitting secondary alerts.

### `ack_agent_delivery`

Agent-only request:

```json
{
  "kind": "ack_agent_delivery",
  "signal_id": "uuid",
  "lease_id": "uuid",
  "listener_instance_id": "uuid",
  "outcome": "replied|observed|expired|failed_terminal",
  "last_error_code": null
}
```

- The authenticated agent must be the exact recipient.
- A live acknowledgement must match `lease_id`, `leased_by`, workspace, and recipient.
- Success sets `acked_at`, `ack_outcome`, optional bounded error code, clears all lease fields, and
  updates `updated_at`.
- `expired` is accepted only when the referenced signal TTL has actually elapsed at the server.
  Stale lease expiry is never an acknowledgement outcome.
- TTL cleanup never rewrites an active lease. If a reply post was accepted before signal TTL but its
  matching ack arrives after TTL, the matching live lease may still ack `replied`; the immutable
  correlated reply remains authoritative. If the post lost the TTL race and was refused, the
  listener persists/acks `expired`. A later stale-lease cleanup requeues first and TTL-terminalizes
  only when no terminal local effect won.
- `failed_terminal` is intentionally available before the server poison ceiling for a bounded,
  non-retryable local/provider refusal. It requires an allowed `last_error_code`; the server-side
  `delivery_attempts_exhausted` path is a distinct automatic terminalization.
- Retrying the same command ID is a normal idempotency-ledger replay.
- A row already acknowledged with the same outcome is idempotent even if the lease has been
  cleared. A different outcome/identity is a conflict, not a rewrite.
- Wrong/stale lease, wrong principal, removed membership, revoked token, cross-workspace ID, and
  unknown signal all return the same non-enumerating refusal class.
- A missing or mismatched immutable signal during fresh/replay hydration returns that same generic
  external `delivery_unavailable` class. Internal diagnostics may record only request/delivery IDs
  and an integrity code, never whether a foreign signal exists or what it contains.

`release_agent_delivery` is not in the first release. A crashed or cancelled consumer relies on
lease expiry. Adding early release is reversible and can follow measured recovery latency.

## Sender-owner relation

Claim returns the same closed enum as the v0.1.4 read edge:

- owner human or live sibling agent with the same immutable owner: `same_owner`;
- resolvable live human/agent owned by another member: `cross_owner`;
- missing, revoked, malformed, or internally inconsistent author: `unknown`.

The receiver owner comes from the authenticated agent database join. It never comes from the
credential artifact or request body. `unknown` takes the cross-owner isolated/tool-denied path.
Server tests must exercise the read and claim matrices side by side so drift is visible.

## Listener integration

1. Perform the existing authenticated read/capability probe before starting a model.
2. Start the provider and pass its forced-deny permission canary.
3. Use claim mode only when both `delivery_claim: 1` and `delivery_ack: 1` are present. An absent
   claim capability retains the v0.1.4 ascending-cursor path and labels status
   `delivery_mode: cursor_fallback`; an impossible claim-without-ack combination fails closed.
4. For each claimed row, persist/verify the existing `ListenerEffectRecord` before prompting.
5. Keep processing a `retry_pending` effect locally with bounded backoff while its lease has enough
   time remaining. Stop before lease expiry rather than prompting under an invalid lease.
6. Ack only terminal outcomes:
   - reply accepted/replayed -> `replied`;
   - direct note/no model -> `observed`;
   - signal expired -> `expired`;
   - bounded terminal refusal/error -> `failed_terminal` plus enum error code.
7. A crash before ack causes redelivery after lease expiry. The durable effect record suppresses a
   second prompt on the same state directory and replays the exact body/command ID after response
   loss.
8. A different machine may have to repeat a model turn after an unknowable crash boundary. This is
   why the product promises at-least-once delivery, not exactly-once model execution. The server
   reply effect remains single because the deterministic command ID rejects a different body.

Local effect storage becomes version 2 by adding `signalKind`. Version-1 records upcast to
`signalKind: "ask"` without rewriting their durable body/command identity. A direct note writes a
terminal `observed` v2 record before ack and never enters the model. This keeps existing v0.1.4 ask
effects readable while making note acknowledgements causally durable.

If claim capability disappears during controlled rollback, the listener finishes and acknowledges
any leases it already holds but requests no new ones. Before entering cursor fallback it resets the
ascending cursor to the beginning of the live horizon and rescans all live direct rows; terminal
effect records suppress repeat model/post effects. This explicit rewind prevents a previously
advanced cursor from skipping an unacked leased signal.

Listener status adds metadata-only fields: `deliveryMode`, `pendingDeliveryCount`, last claim time,
and last ack time. No lease UUID, signal body, prompt, reply, or bearer is written to status/logs.

## Read compatibility and counts

After migration and command deployment, the read edge advertises `delivery_claim: 1` and
`delivery_ack: 1` for authenticated agent inbox pages and includes `pending_delivery_count` for that
exact principal. The read transaction never assumes `swarm_command`. It starts as `swarm_read` and
calls a narrowly scoped `SECURITY DEFINER` authentication/count function owned by `swarm_admin`,
with a pinned `search_path` and `PUBLIC` execute revoked. The function accepts the token hash and
requested workspace, applies the same token/run/principal/membership/revocation checks as
`loadAgentCredential`, and returns only the authenticated principal context plus its live-unacked
count. It cannot claim, acknowledge, insert, or update a delivery. `swarm_read` receives EXECUTE on
that function and no delivery-table privilege. Capability absence means cursor-only behavior;
clients never infer capability from HTTP success.

The first release exposes the honest count through CLI/listener status. Human-dashboard per-agent
unread badges remain a follow-up because they need an explicit owner/admin aggregation contract;
the browser must not borrow an agent bearer.

## Deployment sequence

1. Apply the additive migration and run its live-direct-row reconciliation assertion.
2. Deploy the command edge with claim/ack while the read edge still advertises no capability.
3. Run anonymous/authenticated negative controls and disposable claim/ack tests.
4. Deploy the read edge capability/count.
5. Publish the client release and install through `commonswarm.com/install.sh`.
6. Run restart, concurrency, response-loss, revocation, and cross-owner production canaries.

This ordering ensures no client sees `delivery_claim: 1` before both command operations exist.

Rollback is the mirror of deployment:

1. disable **new claims** and remove only `delivery_claim` from the read capability; keep
   `ack_agent_delivery` and `delivery_ack` live;
2. listeners finish/ack held effects, stop claiming, reset their fallback cursor, and rescan the
   live horizon through the immutable signal path;
3. wait at least the 15-minute maximum lease plus measured clock/queue margin, and query until zero
   live leases remain;
4. only then remove `delivery_ack` or the ack handler if rollback requires it.

The additive table, trigger, purge schedule, and rows remain in place until a separately reviewed
migration. Signals and old clients are unaffected. This drain prevents a live lease from being
stranded between claim and ack.

## Required tests and causal controls

Migration/server:

- exact production zero-use evidence is recorded without bodies;
- direct ask/note trigger enqueue; broadcast/direct-human do not;
- migration backfill covers every live direct-agent signal and no other row;
- two concurrent claimers produce one lease winner;
- wrong principal/workspace, revoked token/principal, and removed member cannot claim/ack;
- stale/wrong lease and listener instance fail without row enumeration;
- ack replay is idempotent; different outcome conflicts;
- stale lease expiry clears/requeues without ack; a reversed mutation that writes `acked_at` must
  fail the causal control;
- only signal-TTL expiry produces `ack_outcome='expired'`, once, and never reappears;
- active-lease TTL race: reply accepted before TTL then acked after remains `replied`; reply refused
  after TTL becomes `expired`; a competing claim cannot rewrite the live lease;
- the tenth failed lease claim is the final claim and the row becomes visibly
  `failed_terminal/delivery_attempts_exhausted` instead of spending forever;
- backlog greater than 100 drains oldest-first with equal-timestamp UUID control;
- relation matrix matches the read edge and never exposes owner UUIDs;
- forced RLS/grants deny browser roles and direct table access while the admin purge still works;
- migration role enumeration fails if a synthetic signal-inserter lacks delivery INSERT;
- retention deletes only terminal rows older than the 30-day floor and never an unacked row;
- claim idempotency rows contain delivery references but no body/bearer; hydrated fresh and replay
  HTTP responses are byte-equivalent for immutable signal fields;
- hydration mismatch, foreign principal/workspace, and unknown signal share the same external
  `delivery_unavailable` class while internal diagnostics remain body-free;
- the read transaction never sets `swarm_command`; its narrow definer function cannot mutate;
- audit detail contains no body or lease capability.

Client/runtime:

- both capabilities select claim mode; absent claim selects cursor fallback; claim without ack fails;
- crash before prompt, during prompt, after effect persistence, after reply post, and after ack;
- lost claim/ack/post response retries the same deterministic command ID/body;
- terminal effect is persisted before ack (mutation control reverses order and must fail);
- `retry_pending` stays within lease bound and never acks early;
- note is observed/acked with zero model prompts;
- two listeners prompt at most one model while one lease is live;
- hostile cross-owner claim reaches a fresh zero-tool host session;
- credential absent from argv, env, status, logs, and raw host frames;
- pending count changes only with live unacked rows;
- rollback with a held lease keeps ack live, drains it, resets the cursor, and rescans without a
  duplicate model/post effect.

Test reachability is part of acceptance. Pure tests must be explicitly named by the root `npm test`
literal list; database cases belong to the exclusive `tests/p1-server/**` gate. `check:edge` is
independent and mandatory.

Causal negative controls must show failures when each of these is removed or weakened:

- recipient predicate;
- `FOR UPDATE SKIP LOCKED`/lease exclusion;
- stale-lease reset rather than terminal ack;
- trigger enqueue;
- relation fail-closed normalization;
- effect-persist-before-ack ordering;
- idempotency-body exclusion/hydration;
- narrow read definer role boundary;
- capability absence plus cursor-rewind fallback.

## Acceptance

- Stop/restart on another process redelivers every live unacked direct signal unless it reaches the
  explicit ten-claim poison ceiling, which is surfaced as terminal failure rather than hidden loss.
- Two consumers do not both own one live lease or prompt concurrently for it.
- Ack/post response loss produces one durable reply signal.
- Revocation cancels/stops claims/posts within the measured bound.
- CLI reports an exact pending count without content.
- v0.1.4 cursor clients continue working before, during, and after rollout.
- Durable evidence states the lease duration, measured recovery bounds, and anything not
  established.

## Explicitly not established yet

- Migration/command/read implementation is implemented in codebase; not yet production-applied until rollout.
- The 15-minute lease has not been load-tested against real provider tail latency.
- The ten-claim poison ceiling and 30-day terminal retention floor have not been production-load
  tested; both are fixed server constants/config floors for the first measured rollout.
- Cross-machine duplicate model execution after an unknowable crash is not eliminated and is not
  promised.
- Human-dashboard unread aggregation is not part of this first contract.
- Realtime wake, early release, and lease heartbeat are deferred.
