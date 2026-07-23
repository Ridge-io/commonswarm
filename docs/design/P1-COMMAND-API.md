# SWARM P1 — Secure Authority Slice: server-side design spec

> **Status: DRAFT — authored by Kimi K3 (model-inversion), not yet implementation-reviewed.**
> Authored 2026-07-23 in four dispatches (§0–4, §4-completion–7, §8–9, §10 + SPEC GAPS);
> the raw generation logs are preserved in `docs/evidence/` as the review artifact.
> This spec designs the Supabase command API that wraps the **pure, unmodified**
> `decide()` core in `src/protocol/`. It is the P1 deliverable of `docs/design/SWARM-CLOUD.md` §9.
>
> **Unresolved:** the `SPEC GAPS` section at the end lists 18 open decisions. Several
> (#10, #13, #14, #16) are authorization-boundary questions where a wrong answer is a
> security defect, not a style choice. **Implementation must not start on those paths
> until the operator rules.**

---

# SWARM P1 — Secure Authority Slice: Server-Side Design Spec

Wraps the pure P0 `decide()` core (`src/protocol/`) behind the Supabase command API. P0 files are treated as frozen; every adaptation happens in new impure code or new sibling pure modules. Where this document makes a choice, the rejected alternative is named with the failure it avoids.

## 0. Non-negotiable invariants this design must preserve

1. `src/protocol/{events,reducer,commands,idempotency,upcasters,index}.ts` ship **byte-identical**. No imports added, no signatures widened.
2. Every authority decision for task/lease commands is produced by **the** `decide()` — one implementation, not a port.
3. A projection row is always `reduceTask`-equivalent to the event stream; the stream is authority, projections are derived.
4. Revocation, tenancy, and actor identity are evaluated **inside the command transaction, from server-derived state, on every command** (§2.1 Kimi #9, §2.3).
5. Authn/authz/validation failures never write stream events; domain rejections always do (§2.1; `commands.ts` rejection classes).

---

## 1. BOUNDARY MAP

### 1.1 The three zones

```
┌─ (c) Postgres/Supabase ────────────────────────────────────────────┐
│  swarm.* tables, RLS, constraints, grants, pg_cron purge, GoTrue   │
└──────────────▲─────────────────────────────────────────────────────┘
               │ parameterized SQL, ONE transaction per command,
               │ role = swarm_command (minimal DML, no DELETE on
               │ events/audit, no DDL)
┌─ (b) impure adapter — supabase/functions/command/index.ts (Deno) ──┐
│  credential classification+verification, principal derivation,     │
│  tenancy validation, revocation reads, size/format validation,     │
│  SQL-backed idempotency ledger + oracles, stream-head locking,     │
│  seq/event-id/clock injection, event append, projection write,     │
│  grant consumption, audit writes, rate buckets, HTTP mapping       │
│  imports and calls the pure core VERBATIM (npm workspace import)   │
└──────────────▲─────────────────────────────────────────────────────┘
               │ decide(state, cmd, ctx) / applyCommand(ledger, ...) /
               │ reduceTask / upcastEnvelope — pure calls only
┌─ (a) pure core — src/protocol/* (FROZEN) ──────────────────────────┐
│  decide(), applyCommand(), reduceTask/reduceStream, upcasters,     │
│  requestHash/canonicalJson, types                                  │
└────────────────────────────────────────────────────────────────────┘
```

### 1.2 What MUST NOT leak into the pure core (and where each lives instead)

| Contaminant | Core's existing defense | P1 location |
|---|---|---|
| Clock | `ctx.now` injected | `statement_timestamp()` of the command tx, read once, passed as ms epoch |
| Randomness | `ctx.nextEventId()` injected | Edge `crypto.randomUUID()` |
| Network | none exists | Edge only (Supabase Auth verification for human JWTs) |
| SQL | oracles are closures (`isMember`, `validCloseGrant`, …) | Each oracle = one prepared statement in the command tx |
| Auth | `ctx.actor` injected | Derived in step 2–3 of §3 below, never from request fields |
| Revocation | oracle-backed membership | In-tx tombstone reads, step 5 |
| Idempotency storage | `IdemLedger = Map` | `swarm.idempotency_keys`; the Map is **seeded from SQL and passed to the unmodified `applyCommand()`** (§3 step 7) |

### 1.3 Verdict on the `decide()` signature

**Adequate for the task/lease slice. Unchanged.** Every inadequacy candidate was checked and resolved without touching the core:

- **`expected_seq` / optimistic concurrency fields.** `decide()` has none and needs none: §2.1 gives task commands epoch/version fencing (already in the `Command` union), and the stream-head lock (§5) serializes appends, so there is no CAS-mismatch path to surface. The §2.1 phrase "stream-level `expected_seq` only for stream-level commands" has no defined command class to attach to — see SPEC GAPS #4. Adding a field would be a signature change with no consumer; rejected.
- **Grant single-use consumption.** `decide()` validates grants (`validTakeoverGrant`/`validCloseGrant`) but does not consume them; consumption is an adapter side effect keyed off the **emitted event** (`TaskClosed.grant_id`, `LeaseTakenOver.grant_id` → insert into `grant_consumptions`, unique on `grant_id`). Deterministic event→side-effect mapping; no signature change. §2.5/Kimi #15's "transactional unique constraint on (grant_id)" is satisfied exactly.
- **`authz` rejections carry `events: []`.** Correct as-is: the adapter writes the audit row and must **not** ledger them (P0 test `does not ledger an authz rejection…` pins this semantics; §3 step 14).
- **Seq allocation at decide-time.** `decide()` calls `ctx.nextSeq()` while constructing envelopes. Safe because allocation is in-memory arithmetic over the locked head row and the whole transaction commits or rolls back as one (§5.2). A discarded decision burns nothing.

**Scope extension that is NOT a signature change:** the P0 `Command`/`EventType` unions cover only the 8 task/lease verbs. P1 also needs workspace-authority commands (invitations, memberships, principals, tokens, repo mappings, landing authority, grants-issue). These go in **new sibling pure modules** — `src/protocol/workspace-events.ts`, `workspace-commands.ts` (`decideWorkspace()`), `workspace-reducer.ts` — mirroring the P0 pattern exactly (same envelope, same rejection classes, same oracle-closure style). The alternative — implementing workspace authority as plain SQL updates without events — is rejected: §2.1 makes the workspace stream the event-carried authority for membership/invitations/devices/principals/repo mappings, and a parallel non-event authority path is precisely the kind of special case that breeds authz drift bugs at P2/P3 when replay clients fold both streams. Failure avoided: "membership is special" authority fork.

**One input-validation gap closed in the wrapper, not the core:** `decide()` bounds `ttl_ms` only to finite-positive. An unbounded lease TTL lets a compromised ≤1h token pin a task for months (recovery only via takeover grant — friction on every task). P1 enforces `0 < ttl_ms ≤ 4h` at wrapper validation (§3 step 6), no core change needed. SPEC GAPS #8 flags that §2.2 itself does not bound lease TTL.

---

## 2. SCHEMA

Two schemas: **`swarm`** (private; not in PostgREST `db-schema`; deny-by-default) and **`swarm_read`** (exposed; read views/RPCs only). Roles: `swarm_admin` (NOLOGIN, owns everything), `swarm_command` (LOGIN, password in Edge secret; the only role the command Edge Function connects as).

### 2.1 DDL sketch (private schema)

```sql
CREATE SCHEMA swarm;

-- Global identity (§2.3 declared exceptions: no workspace_id)
CREATE TABLE swarm.users (
  user_id uuid PRIMARY KEY REFERENCES auth.users(id),
  display_name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE swarm.devices (
  device_id uuid PRIMARY KEY, user_id uuid NOT NULL REFERENCES swarm.users,
  label text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz, last_seen_at timestamptz);

-- Tenancy
CREATE TABLE swarm.workspaces (
  workspace_id uuid PRIMARY KEY, name text NOT NULL,
  created_by uuid NOT NULL REFERENCES swarm.users,
  created_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz);
CREATE TABLE swarm.memberships (
  workspace_id uuid NOT NULL REFERENCES swarm.workspaces,
  user_id uuid NOT NULL REFERENCES swarm.users,
  role text NOT NULL CHECK (role IN ('owner','admin','member')),
  invited_by uuid, joined_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz,
  PRIMARY KEY (workspace_id, user_id));
CREATE INDEX memberships_by_user ON swarm.memberships (user_id)
  WHERE revoked_at IS NULL;                          -- tenancy predicate hot path
CREATE TABLE swarm.invitations (
  invitation_id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES swarm.workspaces,
  email text, role text NOT NULL CHECK (role IN ('owner','admin','member')),
  token_hash bytea NOT NULL UNIQUE,                  -- sha256; raw token never stored (§7)
  expires_at timestamptz NOT NULL,                   -- TTL ≤ 7d, enforced at issue
  created_by uuid NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  consumed_at timestamptz, consumed_by uuid, revoked_at timestamptz);
CREATE INDEX invitations_live ON swarm.invitations (workspace_id)
  WHERE consumed_at IS NULL AND revoked_at IS NULL;

-- Agent side
CREATE TABLE swarm.agent_principals (
  principal_id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES swarm.workspaces,
  owner_user_id uuid NOT NULL REFERENCES swarm.users,  -- the human it belongs to
  name text NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
  revoked_at timestamptz, UNIQUE (workspace_id, name));
CREATE TABLE swarm.agent_runs (
  run_id uuid PRIMARY KEY, principal_id uuid NOT NULL REFERENCES swarm.agent_principals,
  device_id uuid NOT NULL REFERENCES swarm.devices,
  started_at timestamptz NOT NULL DEFAULT now(), ended_at timestamptz);
CREATE TABLE swarm.agent_tokens (
  token_id uuid PRIMARY KEY, principal_id uuid NOT NULL REFERENCES swarm.agent_principals,
  run_id uuid NOT NULL REFERENCES swarm.agent_runs,
  task_id uuid, epoch integer,                       -- narrowest default binding (§2.3)
  scopes jsonb NOT NULL, token_hash bytea NOT NULL UNIQUE,
  issued_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,                   -- ≤1h default, hard max 8h
  revoked_at timestamptz, surrender_only boolean NOT NULL DEFAULT false,
  predecessor_token_id uuid REFERENCES swarm.agent_tokens,
  renewal_grant_id uuid, lineage_id uuid NOT NULL);  -- lineage-wide revocation (§2.3)
CREATE INDEX agent_tokens_by_principal ON swarm.agent_tokens (principal_id);
CREATE INDEX agent_tokens_by_lineage ON swarm.agent_tokens (lineage_id);
CREATE TABLE swarm.revocation_tombstones (           -- token/principal/run/device/
  kind text NOT NULL, target_id uuid NOT NULL,       -- family/membership/lineage
  created_at timestamptz NOT NULL DEFAULT now(), created_by uuid,
  PRIMARY KEY (kind, target_id));
CREATE TABLE swarm.renewal_grants (                  -- bounded, minted at join/spawn (§2.3)
  renewal_grant_id uuid PRIMARY KEY, principal_id uuid NOT NULL,
  run_id uuid NOT NULL, max_successors integer NOT NULL, successors_used integer NOT NULL DEFAULT 0,
  horizon_expires_at timestamptz NOT NULL,           -- continuous-renewal horizon
  revoked_at timestamptz);

-- GitHub / repos
CREATE TABLE swarm.github_installations (
  installation_row_id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES swarm.workspaces,
  github_installation_id bigint NOT NULL UNIQUE, suspended_at timestamptz);
CREATE TABLE swarm.repositories (
  repo_mapping_id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES swarm.workspaces,
  github_repository_id bigint NOT NULL, installation_row_id uuid NOT NULL,
  full_name text NOT NULL, default_branch text NOT NULL,
  landing_authority_user_id uuid NOT NULL,           -- §2.10; never null while active
  created_at timestamptz NOT NULL DEFAULT now(), archived_at timestamptz,
  UNIQUE (workspace_id, github_repository_id));

-- Streams + event log
CREATE TABLE swarm.streams (
  stream_id uuid PRIMARY KEY, workspace_id uuid NOT NULL REFERENCES swarm.workspaces,
  kind text NOT NULL CHECK (kind IN ('workspace','repo')),
  repo_mapping_id uuid REFERENCES swarm.repositories,
  head_seq bigint NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE UNIQUE INDEX one_workspace_stream ON swarm.streams (workspace_id)
  WHERE kind = 'workspace';
CREATE UNIQUE INDEX one_repo_stream ON swarm.streams (repo_mapping_id)
  WHERE kind = 'repo';
CREATE TABLE swarm.events (
  workspace_id uuid NOT NULL,                        -- denormalized: every row carries tenant
  stream_id uuid NOT NULL REFERENCES swarm.streams,
  seq bigint NOT NULL,
  event_id uuid NOT NULL UNIQUE,
  command_id text NOT NULL,
  type text NOT NULL, schema_version integer NOT NULL,
  actor_user uuid, actor_agent_principal uuid, actor_run uuid,
  occurred_at_server timestamptz NOT NULL,
  payload jsonb NOT NULL CHECK (octet_length(payload::text) <= 65536),  -- Kimi #23
  PRIMARY KEY (stream_id, seq));                     -- replay hot path IS the PK
CREATE INDEX events_by_workspace ON swarm.events (workspace_id, stream_id, seq);

-- Projections (derived; rebuildable from swarm.events)
CREATE TABLE swarm.tasks (
  workspace_id uuid NOT NULL, stream_id uuid NOT NULL,
  task_id uuid NOT NULL, slug text NOT NULL,
  lifecycle text NOT NULL, version integer NOT NULL, epoch integer NOT NULL,
  owner text, lease_expiry timestamptz,
  submission jsonb, closed_disposition text,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (stream_id, task_id), UNIQUE (stream_id, slug));
CREATE INDEX tasks_board ON swarm.tasks (workspace_id, lifecycle);
CREATE TABLE swarm.leases (                          -- per-epoch lease ledger
  stream_id uuid NOT NULL, task_id uuid NOT NULL, epoch integer NOT NULL,
  owner text NOT NULL, acquired_at timestamptz NOT NULL, lease_expiry timestamptz NOT NULL,
  ended_at timestamptz, PRIMARY KEY (stream_id, task_id, epoch));
CREATE TABLE swarm.grants (
  grant_id uuid PRIMARY KEY, workspace_id uuid NOT NULL, stream_id uuid NOT NULL,
  type text NOT NULL CHECK (type IN ('takeover','merge','override-close','admin-op')),
  task_id uuid, binding jsonb NOT NULL,              -- {version,epoch,head_sha}|{epoch,recipient}|…
  issued_by uuid NOT NULL, issued_to text NOT NULL,
  expires_at timestamptz NOT NULL, revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE swarm.grant_consumptions (              -- §2.5 single-use, Kimi #15
  grant_id uuid PRIMARY KEY REFERENCES swarm.grants,
  consumed_at timestamptz NOT NULL DEFAULT now(),
  command_id text NOT NULL, event_id uuid NOT NULL);

-- Idempotency (≥30d retention, Kimi #17)
CREATE TABLE swarm.idempotency_keys (
  principal_kind text NOT NULL CHECK (principal_kind IN ('user','agent')),
  principal_id text NOT NULL, command_id text NOT NULL,
  request_hash text NOT NULL,                        -- P0 requestHash() verbatim
  response jsonb NOT NULL,                           -- StoredResponse, incl. rejections
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (principal_kind, principal_id, command_id));
CREATE INDEX idem_purge ON swarm.idempotency_keys (created_at);

-- Audit + rate limiting (§5)
CREATE TABLE swarm.audit_log (
  audit_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(),
  actor_user uuid, actor_agent_principal uuid, actor_run uuid,
  credential_kind text, credential_id uuid, device_id uuid,
  command_kind text NOT NULL, workspace_id uuid, stream_id uuid,
  outcome text NOT NULL,                             -- accepted|domain|authz|validation|replayed|conflict|rate_limited|authn
  reason text, detail text,                          -- control chars stripped before insert (Kimi #16)
  request_hash text, ip inet);
CREATE INDEX audit_by_ws ON swarm.audit_log (workspace_id, occurred_at DESC);
CREATE INDEX audit_by_cred ON swarm.audit_log (credential_id, occurred_at DESC);
CREATE TABLE swarm.security_alerts (
  alert_id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  occurred_at timestamptz NOT NULL DEFAULT now(), kind text NOT NULL,
  subject text NOT NULL, detail jsonb NOT NULL);
CREATE TABLE swarm.rate_buckets (
  bucket_key text NOT NULL,                          -- 'cred:<id>' | 'ip:<addr>:<endpoint>' | 'ws:<id>'
  window_start timestamptz NOT NULL, count integer NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket_key, window_start));

-- Inbox substrate (§2.13, P1 ships tables only; no user-visible commands until P3)
CREATE TABLE swarm.inbox_deliveries (
  message_event_id uuid NOT NULL, workspace_id uuid NOT NULL,
  recipient_principal text NOT NULL,
  enqueued_at timestamptz NOT NULL DEFAULT now(),
  delivered_at timestamptz, acked_at timestamptz,
  PRIMARY KEY (message_event_id, recipient_principal));

-- Config
CREATE TABLE swarm.config (key text PRIMARY KEY, value jsonb NOT NULL);
-- seed: ('min_client_version', '"0.1.0"')
```

Append-only enforcement on `events` and `audit_log`: no role except `swarm_admin` holds `UPDATE`/`DELETE`/`TRUNCATE`, plus a `BEFORE UPDATE OR DELETE` trigger that raises `SWARM_APPEND_ONLY` as a backstop against a future grant mistake.

### 2.2 Privilege matrix (exact)

```sql
REVOKE ALL ON SCHEMA swarm FROM anon, authenticated, public;
REVOKE ALL ON ALL TABLES IN SCHEMA swarm FROM anon, authenticated;
ALTER DEFAULT PRIVILEGES IN SCHEMA swarm REVOKE ALL ON TABLES FROM anon, authenticated;

-- swarm_command (the Edge command function's login): minimal DML, no DDL, no DELETE on ledgers
GRANT USAGE ON SCHEMA swarm TO swarm_command;
GRANT SELECT ON swarm.users, swarm.devices, swarm.workspaces, swarm.memberships,
  swarm.invitations, swarm.agent_principals, swarm.agent_runs, swarm.agent_tokens,
  swarm.revocation_tombstones, swarm.renewal_grants, swarm.github_installations,
  swarm.repositories, swarm.streams, swarm.tasks, swarm.leases, swarm.grants,
  swarm.grant_consumptions, swarm.idempotency_keys, swarm.config TO swarm_command;
GRANT INSERT ON swarm.events, swarm.audit_log, swarm.security_alerts,
  swarm.grant_consumptions, swarm.leases, swarm.inbox_deliveries TO swarm_command;
GRANT INSERT, UPDATE ON swarm.streams, swarm.tasks, swarm.memberships, swarm.invitations,
  swarm.agent_principals, swarm.agent_runs, swarm.agent_tokens, swarm.renewal_grants,
  swarm.repositories, swarm.grants, swarm.idempotency_keys, swarm.rate_buckets,
  swarm.workspaces, swarm.devices, swarm.users TO swarm_command;
-- never: DELETE/TRUNCATE on events, audit_log; never: swarm.events UPDATE.
ALTER ROLE swarm_command SET search_path = swarm, pg_catalog;   -- pinned at the role
```

Rejected: connecting the Edge Function as Supabase `service_role` (all-powerful, bypasses everything — one leaked env var is total compromise) and using SECURITY DEFINER SQL functions for the command path (impossible without forking `decide()` into PL/pgSQL; §3.1). The compensating control for granting row-level DML is that all invariants are *also* enforced by constraints (PK/UNIQUE/FK/CHECK) and the append-only triggers, so `swarm_command` cannot corrupt history even if the Edge code is wrong — it can only mis-authorize within a single transaction's logic, which is what the §9 integration tests and the projection-rebuild drift check (§10 R1) cover.

RLS is **enabled with zero permissive policies for `anon`/`authenticated`** on every `swarm.*` table — deny-by-default stands even if a future migration accidentally grants something.

### 2.3 Exposed read surface (`swarm_read`)

Human reads (board substrate, CLI with user JWT) via views; agent reads via the Edge read proxy (§8). Both share one predicate helper so they cannot diverge:

```sql
CREATE FUNCTION swarm.is_member(p_workspace uuid, p_user uuid) RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path = swarm, pg_catalog AS $$
  SELECT EXISTS (SELECT 1 FROM swarm.memberships
    WHERE workspace_id = p_workspace AND user_id = p_user AND revoked_at IS NULL) $$;
```

Exposed views (owned by `swarm_admin`; each carries its predicate in-view — see SPEC GAPS #2 for why not `security_invoker`):

```sql
CREATE VIEW swarm_read.tasks WITH (security_barrier = true) AS
  SELECT * FROM swarm.tasks t
  WHERE swarm.is_member(t.workspace_id, auth.uid());
CREATE VIEW swarm_read.events AS
  SELECT * FROM swarm.events e
  WHERE swarm.is_member(e.workspace_id, auth.uid());
CREATE VIEW swarm_read.memberships AS
  SELECT m.* FROM swarm.memberships m
  WHERE swarm.is_member(m.workspace_id, auth.uid());
CREATE VIEW swarm_read.repositories AS
  SELECT r.* FROM swarm.repositories r
  WHERE swarm.is_member(r.workspace_id, auth.uid());
CREATE VIEW swarm_read.leases AS
  SELECT l.* FROM swarm.leases l JOIN swarm.streams s USING (stream_id)
  WHERE swarm.is_member(s.workspace_id, auth.uid());
CREATE VIEW swarm_read.my_devices AS
  SELECT * FROM swarm.devices WHERE user_id = auth.uid();   -- global row, own-only
-- agent_principals, agent_runs: same is_member predicate via workspace_id.
-- invitations: NO general read view (capability disclosure only, §4). 
-- audit_log: swarm_read.audit_log WHERE is_member AND role IN ('owner','admin') — P1 minimal.
GRANT SELECT ON swarm_read.* TO authenticated;   -- nothing to anon
```

Every predicate is `is_member(workspace_id, auth.uid())` (or `user_id = auth.uid()` for global rows) — written identically in each view so the §10 per-view two-tenant tests can assert the predicate text and the zero-row result.

### 2.4 Workspace-stream vs repo-stream sequence allocation

Two independent `streams` rows: exactly one `kind='workspace'` per workspace (partial unique index), one `kind='repo'` per repo mapping (unique index). Each has its own `head_seq`; `events` PK is `(stream_id, seq)`; there is **no global order** (§2.13). Workspace-scoped (non-repo) tasks fold through `decide()` against the *workspace* stream — same code path, different stream row; slug uniqueness holds per stream via `tasks.UNIQUE(stream_id, slug)`.

**Gapless allocation under concurrency:** the command transaction does `SELECT head_seq FROM swarm.streams WHERE stream_id = $1 FOR UPDATE` (step 8, §3), computes event seqs in memory as `head+1 … head+k` via `ctx.nextSeq()`, appends, then `UPDATE streams SET head_seq = head + k`. Because the head `UPDATE` rolls back with the transaction, an aborted command leaves neither events nor a head bump — no gap is possible, and the `(stream_id, seq)` PK is the hard backstop. Rejected: a Postgres `SEQUENCE` per stream — sequence increments are non-transactional, so every rolled-back command burns values and produces exactly the gaps the §9 `seq-gap` test forbids. The lock serializes commits *per stream*; different repos and the workspace stream proceed in parallel.

---

## 3. COMMAND FUNCTION

### 3.1 Where `handle_command()` lives — the fork-avoidance decision

§2.1's "Edge Functions fronting a `handle_command()` transaction" is reconciled with invariant 2 (one `decide()`) as follows: **the transaction orchestrator is TypeScript in the `command` Edge Function (Deno), holding one Postgres transaction** on a pooled connection (transaction-mode pooler) opened as `swarm_command`, calling the unmodified `decide()` / `applyCommand()` / `reduceTask()` in-process, with every oracle and every write executed as parameterized SQL inside that transaction. There is no PL/pgSQL reimplementation. Rejected alternatives: (a) port `decide()` to PL/pgSQL — two authority implementations *will* drift, and the drift surface is the security boundary itself; (b) plv8 in-database — not available on hosted Supabase; (c) decide-at-edge / append-via-RPC without an open transaction — loses atomicity between oracles and append. SPEC GAPS #1 records this reading for the operator.

### 3.2 The transaction, in exact check order

Order is load-bearing: nothing tenant-private is read before tenancy is proven; revocation precedes idempotency (a revoked principal gets nothing back, not even its own stored responses — fail-closed, §2.3); idempotency precedes any state evaluation (§2.1: replay returns the stored original response **before** `expected_version`/epoch evaluation).

```
POST /commands  (Authorization: Bearer <supabase-JWT | swm_agt_…>)
body: { command_id, client_version,
        workspace_id, stream: {kind:'workspace'} | {kind:'repo', repo_mapping_id},
        command: {<P0 Command union> | <workspace command, §3.4>} }
```

1. **Edge pre-checks (stateless).** Body ≤ 128 KB. `command_id` matches `^[A-Za-z0-9_-]{8,72}$`. Classify credential by format: JWT → verify via Supabase Auth (`auth.getUser`); `swm_agt_` prefixed opaque → sha256 it (WebCrypto) and keep only the hash. Raw agent token never enters the DB, logs, or any response.
2. **BEGIN** (single tx; `READ COMMITTED` — §5.3). `SET LOCAL search_path = swarm, pg_catalog` (belt over the role-pinned path).
3. **Authenticate.** Human: user exists in `swarm.users`. Agent: `SELECT … FROM agent_tokens WHERE token_hash = $1` joined to principal/run/device. Unknown/expired → audit (`outcome='authn'`) + `401 {error:"unauthenticated"}`, uniform body. **No other table is read on this path.**
4. **Derive principal server-side.** `actor = {user: <owner user for agents, else the user>, agent_principal, run, device}` — stamped entirely from the credential row. Any `actor_*` field present in the request body is ignored (and its presence is recorded in the audit row's `detail`).
5. **Validate every client-supplied identifier against the derived tenancy (Kimi #9), reject-before-read.**
   - `workspace_id`: `is_member(workspace_id, actor.user)` — for agents, the principal's `workspace_id` must *equal* the request's (an agent principal is single-workspace by construction).
   - `stream`: `kind='repo'` → the `repo_mapping_id` must belong to `workspace_id` and be unarchived; resolve to `stream_id`. `kind='workspace'` → the workspace stream.
   - Command targets: `task_id` format-checked here (existence is decide-time, stream-scoped); `to_owner` (handoff), `issued_to`, recipient principals — deferred to the decide oracles, which read current in-tx rows; `device` claims — derived, never read from the body.
   - The one carve-out: `accept_invitation` from a *non-member*, authorized by the invite token capability instead of membership (§3.4).
   - Any mismatch → audit (`authz`) + `403 {error:"forbidden"}` — **uniform body, no existence oracle** (a non-member cannot distinguish "workspace doesn't exist" from "not a member").
6. **Revocation check (fail-closed, every command).** In-tx existence check against: token row `revoked_at`, `revocation_tombstones` for `(token,token_id) (principal,…) (run,…) (device,…) (membership,…) (family,…) (lineage,lineage_id)`, principal `revoked_at`, membership `revoked_at`, device `revoked_at`. Any hit → audit + `403`. **Validation & bounds.** Command-shape validation (kind known, field types, uuid/slug/SHA formats, `ttl_ms ∈ (0, 4h]`, disposition in `DISPOSITIONS`, message-body reservation ≤ 16 KB constant, evidence-set entries well-formed strings). Compute the would-be event payload size bound now (payload ≤ 64 KB enforced again by the `events` CHECK constraint). Failure → audit (`validation`) + `400/413`. Validation failures disclose format rules only, never existence.
7. **Idempotency lookup.** `SELECT request_hash, response FROM idempotency_keys WHERE (principal_kind, principal_id, command_id)`. Compute `requestHash(actor, cmd)` with the **unmodified P0 function**. Hash match → audit (`replayed`) + `200` with the stored `StoredResponse` verbatim (covers prior accept *and* prior domain rejection, Kimi #17). Hash mismatch → audit (`conflict`) + `409 {error:"command_id_conflict"}` (§7). Miss → proceed.
8. **Lock the stream head.** `SELECT head_seq FROM streams WHERE stream_id = $1 FOR UPDATE`. This is the single serialization point per stream (§5).
9. **Load decide-state + build `DecideCtx`.** Task projection row (or `null`). Oracles as in-tx prepared reads: `isMember`/`role` → `memberships` (for agents: principal's owner membership + principal unrevoked); `isEligibleRecipient` → user is current member OR principal is current unrevoked principal **of this workspace** (§2.2); `slugTaken` → `tasks` (backstopped by the unique index); `claimRequiresGrant` → `false` at P1 (claim kinds are P2 — SPEC GAPS #3); `evidenceComplete` → non-empty + structurally valid references (full §2.4 verification is P2 — RISK R7); `validTakeoverGrant` → live grant of type `takeover` bound to `{task, current epoch, recipient=caller}`, not revoked/expired/not already in `grant_consumptions`; `validCloseGrant` → dormant at P1 (schema-ready). `now` = `statement_timestamp()`; `nextSeq` = locked head arithmetic; `nextEventId` = `crypto.randomUUID`.
10. **Decide.** Seed a `Map` ledger from step 7 (empty on the miss path) and call the unmodified `applyCommand(ledger, state, cmd, ctx)` — which internally calls `decide()` and applies P0's exact ledger-write semantics (accepted and domain-rejected are ledgered; authz is not).
11. **Append events.** Insert the returned envelopes with their allocated seqs. On any PK violation → ROLLBACK, audit (`outcome='error'`, severity high) + `500` — under the head lock this indicates a defect in the authority path, not contention.
12. **Update projections by folding, not patching.** `projection' = decision.events.reduce(reduceTask, projection)` (pure core, in-edge) → upsert `swarm.tasks`; insert `swarm.leases` row per epoch-advancing event, update on `LeaseRenewed`. The projection is correct *by construction* (it is the fold); a nightly rebuild-from-events job + a `drift_detected` security alert is the tripwire.
13. **Side effects keyed off emitted events.** `grant_id`-bearing `TaskClosed`/`LeaseTakenOver` → `INSERT INTO grant_consumptions` (unique violation → ROLLBACK → this is the double-spend loser's path, §5.4). `TaskReopened` → mark open submissions/grants for that task `revoked_at` (§2.2 reopen semantics). Workspace-command events → their projection writes (§3.4).
14. **Ledger + audit.** Insert the idempotency row with `StoredResponse` **iff** the outcome was accepted or domain-rejected (never authz — the P0 test `does not ledger an authz rejection…` is load-bearing: a ledgered authz rejection would pin a later-membered principal's legitimate retry to a stale refusal). Insert the audit row (all outcomes, `detail` control-char-stripped — Kimi #16).
15. **COMMIT.** Map to HTTP: accepted → `200 {status:"accepted", events, min_client_version}`; domain-rejected → `200 {status:"rejected", class:"domain", reason, detail, event}` (the authority *did* act; the rejection is committed history — it is not a transport error). 

### 3.3 Which failure becomes a `CommandRejected` event vs audit-only — and why it matters

| Failure | Disposition |
|---|---|
| Domain rejection (member, well-formed, state forbids: `stale_epoch`, `not_owner`, lease-race loss, `close_needs_grant`, …) | **Committed `CommandRejected` event** + idempotency-ledgered |
| Authn (bad/expired credential) | audit only, 401 |
| Authz/tenancy (non-member, cross-tenant id, agent-token denylisted command) | audit only, 403 uniform |
| Revocation (token/principal/device/lineage/membership tombstone) | audit only, 403 |
| Validation (shape/format/TTL/oversize) | audit only, 400/413 |
| Idempotency 409 | audit only, 409 |
| Rate limit | audit + `security_alerts` row, 429 |

The distinction is not bookkeeping pedantry; four concrete failures ride on it. (1) **Cross-tenant oracle:** a committed event confirms the target stream exists and writes attacker-influenced rows into a tenant's ledger — authz failures must leave no tenant-visible trace. (2) **Replay pollution:** committed events are folded by every client forever and consume `seq`; non-members must never inject into that history. (3) **Later-member retry:** a ledgered authz rejection would make a newly-joined member's legitimate retry replay the old refusal (P0-tested semantics). (4) **Attribution:** the audit log is append-only, actor/credential/IP-stamped, and never replayed to clients — the right and only place for hostile-path evidence (G3).

### 3.4 Workspace-authority commands (new pure module, same pattern)

`decideWorkspace(wsState, cmd, ctx)` over a workspace projection `{members, invitations, principals, repos, landing_authorities, owners_count}`. All carry the human-credential-only gate where §2.3/§2.6 demand — enforced at step 6 by credential *kind* and re-checked by role oracle (defense in depth). Preconditions (each violation → committed `CommandRejected` on the workspace stream, except the credential-kind gate which is authz/audit-only):

| Command | Gate | Key preconditions | Events |
|---|---|---|---|
| `create_workspace` | human | (P1: operator-allowlisted) | `WorkspaceCreated`, workspace stream row created |
| `invite_member` | human Owner/Admin | invitee not already member; TTL ≤ 7d; token stored hashed | `MemberInvited` |
| `revoke_invitation` | human Owner/Admin | live invite | `InvitationRevoked` |
| `accept_invitation` | verified identity + token capability | token hash matches, unexpired, unrevoked; **atomic consumption**: `UPDATE invitations SET consumed_at, consumed_by WHERE token_hash=$1 AND consumed_at IS NULL AND revoked_at IS NULL AND expires_at>now() RETURNING` under the workspace head lock — concurrent accepts: loser re-evaluates after blocking, matches 0 rows → domain rejection | `InvitationAccepted`, `MemberJoined` |
| `remove_member` / `change_role` | human Owner/Admin (Admin: not on Owners) | target not last Owner (no-orphan invariant, §2.6); landing-authority successor named if target holds one (§2.10) | `MemberRemoved` / `MemberRoleChanged` |
| `create_agent_principal` | member (own) | name unique in workspace | `AgentPrincipalCreated` |
| `revoke_agent_principal` | Owner/Admin any, member own | — | `AgentPrincipalRevoked` + tombstone |
| `mint_agent_token` | human, own principal | scopes ⊆ human's rights; §2.3 denylist enforced (grants, minting, invitations, membership/role/ownership, repo mapping, workspace create/delete, capability-URL minting, `--force-discard`, revoking anything but self, trusted-content writes); default binding run+task+epoch; TTL ≤ 1h default, ≤ 8h hard | `AgentTokenMinted` (token_id only, never material) |
| `renew_worker_token` | **fenced successor endpoint, never generic mint** (§2.3) | predecessor token live and presented; successor fields derived **only** from predecessor (principal/run/task/epoch/scopes — no caller-selected targets); successor ⊆ predecessor (attenuation vs *predecessor*); renewal grant live with budget; horizon not exceeded; lineage tombstones clean; current lease epoch matches when task-bound | `AgentTokenMinted` (successor) |
| `revoke_agent_token` | human: per §2.6; agent: **only its own exact presenting token** (sibling/principal/run/device/family/membership revocation by an agent credential → authz refusal, §10) | — | `AgentTokenRevoked` + tombstone (+ lineage cascade rows) |
| `map_repository` | human Owner/Admin | installation valid for workspace; **names the landing authority** (current human member); creates repo stream row in same tx | `RepoMapped` |
| `archive_repo_mapping` | human Owner/Admin | landing-authority successor/remap resolved first (no-orphan) | `RepoMappingArchived` |
| `assign_landing_authority` / `transfer_landing_authority` | human Owner/Admin | successor is current human member; the role cannot be removed/demoted/remapped without a named successor | `LandingAuthorityAssigned` / `…Transferred` |
| `issue_grant` (P1: `takeover` type only) | human Owner/Admin | binds op+task+**current epoch**+recipient; TTL ≤ 1h | `GrantIssued` |
| `revoke_grant` | human Owner/Admin | — | `GrantRevoked` |
| `register_device` / `revoke_device` | human, own devices | global tables (SPEC GAPS #5) + tombstone on revoke | audit (stream events deferred, gap-noted) |

---

## 4. AUTH + TENANCY

**Human login (v1).** Authorization-code + PKCE via Supabase Auth (GoTrue), GitHub OAuth as the v1 provider (repo access is already GitHub-provisioned), external browser, loopback callback on `127.0.0.1:<random high port, retry on collision>`, copy/paste fallback; CLI-generated `state` verified on callback in both paths (Kimi #5). The redirect allowlist entry is an exact-match loopback URL — SPEC GAPS #6 (Supabase allowlist vs random ports). Tokens: access token cached in memory; **rotating refresh credential in the OS keychain** (macOS Keychain / libsecret; headless fallback = `0600` file in `0700` dir with loud warning, hard refusal below that — never unspecified plaintext). Per-device refresh serialization: keychain-held generation number + lockfile; concurrent refresh loses the CAS and retries. Server-side refresh-reuse detection revokes the token family (Kimi #7 — GoTrue capability, SPEC GAPS #7). `swarm devices` / `swarm logout [--device]` hit `revoke_device`, which tombstones the device and cascades to runs/tokens.

**The four identity shapes and their stamping.**

| Shape | Row(s) | Credential | `actor` stamped as |
|---|---|---|---|
| Human user | `auth.users` + `swarm.users` | Supabase JWT (PKCE session) | `{user: uid, agent_principal: null, run: null}` |
| Agent principal | `agent_principals` (durable, owned by a human, single workspace) | — (never authenticates directly) | — |
| Device | `devices` (global) | registered at login, keychain-held device id | derived from token's run, never from body |
| Run | `agent_runs` (one CLI session) | — | — |
| Worker credential | `agent_tokens` (opaque, hashed, run+task+epoch-bound, ≤1h TTL) | `swm_agt_…` bearer | `{user: principal.owner_user_id, agent_principal, run}` |


---

## 4. AUTH + TENANCY (completion)

…`canonicalPrincipal(actor)` (unmodified) keeps ownership comparisons agent-scoped: the `owner` string stamped into `LeaseAcquired` / `TaskSubmitted` and compared by `decide()` (`s.owner !== me`) is the bare agent-principal id for worker credentials and the bare user id for human JWTs. A human's ownership of a principal is a *data row* (`agent_principals.owner_user_id`), never an identity alias, and the two id spaces are disjoint uuid populations, so:

| Consequence | Mechanism — no wrapper code required |
|---|---|
| A human does **not** inherit their agent's lease | Human JWT → canonical principal = user id ≠ principal id → `not_owner` / `stale_epoch` domain rejections |
| Human authority over agent-owned tasks | Flows through `role()` (Owner/Admin close/reopen) or an explicit acquire/handoff at a **new epoch** — which simultaneously fences the agent's epoch-bound token (§6) |
| Two principals owned by the *same* human are mutually fenced | Owner string is the principal id; principal A's lease refuses principal B |
| Attribution (G3) and least-authority coexist | Authority compares one string; the envelope still triple-stamps `actor_user` / `actor_agent_principal` / `actor_run` from the token join |

**Tenancy: why a fully forged request body reaches nothing.** Threat model: the attacker holds a *valid* credential in workspace A and knows every identifier in workspace B (ids are not secrets). Every client-supplied identifier is resolved against server-derived tenancy **before any B-row is read** (§3.2 step 5, reject-before-read):

| Forged field | Server-side resolution (WHERE — against WHAT) | Result |
|---|---|---|
| `workspace_id = B` | `is_member(B, actor.user)` against `swarm.memberships` (live rows only); for agents, `agent_principals.workspace_id` must equal B — impossible, it is a single immutable column set at principal creation | 403 uniform body, audit-only, **zero B rows read** |
| `stream.repo_mapping_id` from B | `swarm.repositories WHERE repo_mapping_id=$1 AND workspace_id=$validated AND archived_at IS NULL` | 403 (pairing fails even if the mapping id is real) |
| `task_id` from B | Format-checked at step 5; existence is decide-time **against the resolved stream** — a B task id under A's stream is `unknown_task` | Committed `CommandRejected` **inside A's own stream** — attacker-visible only, zero cross-tenant effect |
| `to_owner` / recipient from B | `isEligibleRecipient` oracle: current member/principal **of the resolved workspace** | Domain `recipient_not_member` |
| `grant_id` from B | Grant oracle `WHERE grant_id=$1 AND workspace_id=$resolved AND binding matches` | Domain rejection; grant never consumed |
| `actor_*` / `device` in body | Ignored; presence recorded in audit `detail` (self-assertion attempt is itself signal) | No code path consumes them |
| Invitation token for B (the one capability path) | `accept_invitation` looks up by `token_hash`; workspace and invitee are bound **from the invitation row and `auth.uid()`** — the client chooses neither | Cross-tenant join impossible without a live capability issued by B |

Append-time backstops, in case steps 4–5 ever regress: (1) every event/task/grant row carries `workspace_id` stamped from the *resolved stream row*, pinned by composite FK `(stream_id, workspace_id) REFERENCES swarm.streams (stream_id, workspace_id)` (a trivially-unique index on the PK pair is added to support it) — a transaction that resolved a B stream while claiming A's tenant column violates the FK and rolls back; `leases` reaches tenancy transitively through its stream FK. (2) RLS is enabled on every `swarm.*` table with **no** policy for `anon`/`authenticated` (deny-all stands even after a future grant mistake); `swarm_command` carries `USING (true)` precisely because step 5 + scoped queries + the composite FK are the tenancy control for the command path — RLS's job here is to make the unauthenticated default "zero rows," which the §10 per-view two-tenant tests assert.

**Read path.** Human reads go only through `swarm_read` views whose predicate `is_member(workspace_id, auth.uid())` is ANDed into the plan (`security_barrier`); `auth.uid()` comes from the GoTrue-verified JWT, so a forged `?workspace_id=eq.B` filter can only narrow, never widen. Agent reads go through the Edge read proxy (§8), which resolves stream→workspace server-side and rechecks `principal.workspace_id` before issuing any query; signed artifact URLs are per-workspace-bucket, non-listable, minted only after the same check (Kimi #10). Invitations have **no general read view**: the raw token is a capability disclosed once at issue, stored hashed, and the acceptance page renders inviter identity + tenant age (the §8 invite-phishing control) rather than exposing the table.

**Actor identity: stamped from the credential, never the request.** (a) Single derivation site: step 3–4's credential-row join yields `user / principal / run / device`; the frozen `env()` copies `ctx.actor` into every envelope — no request-body field name appears anywhere in `src/protocol/*`, so there is physically no path from body to `actor_*`. (b) `device` comes from the token's run join (agents) or the login-time `register_device` row (humans), never from a command body. (c) Rejected alternatives: trusting client-stamped actor fields — the §2.1 failure it avoids is one-curl principal forgery; accepting actor *hints* for routing and validating later — late validation leaks an existence oracle (403-vs-404 distinguishes live ids; step 5's uniform 403 exists to kill exactly this); deriving the agent actor from a body `principal_id` + membership check — decouples credential from principal, letting any stolen member session impersonate any principal in the workspace instead of only the minted one.

---

## 5. CONCURRENCY + FENCING

Fencing is produced by the **pure** `decide()` against server-loaded state; the server never catches fencing failures as exceptions — they are *decisions*, committed as `CommandRejected` history per the §3.3 table.

### 5.1 The three fences

| Fence | Stored / advanced | Checked WHERE — against WHAT | Stale input → outcome |
|---|---|---|---|
| **Task version** | `tasks.version`; +1 only via `TaskReopened`; reducer asserts strict increase | Close-grant oracle binding `{version, epoch, head_sha}`; reopen also clears `submission` | Close after reopen → `not_submitted` (submission gone) or `close_needs_grant` (binding mismatch) — the grant dies with the version, per §2.5 |
| **Lease epoch** | `tasks.epoch`; +1 on acquire/handoff/takeover; reducer `assertEpochIncrease` refuses non-increasing | `decide()`: renew/handoff/submit compare `cmd.epoch` to `s.epoch`; **close compares `cmd.epoch` to `s.submission.epoch` (frozen)**; takeover-grant oracle compares `binding.epoch` to `s.epoch` at decision time | Committed `CommandRejected`: `stale_epoch` / `live_lease_needs_grant` |
| **Stream seq** | `streams.head_seq`; `events` PK `(stream_id, seq)` | Head row `FOR UPDATE` before any state read; seqs allocated `head+1 … head+k` | PK conflict → ROLLBACK + 500 (authority-path defect, not contention — §3.2 step 11); replay side: `reduceStream` halts on gap/dup |

**Stale-epoch close, precisely** (the §10 test). Task T: `submit` at epoch 3 freezes `submission {epoch 3, head_sha H}`. Variants:

- **Superseded:** a new `submit` at live epoch 5 overwrites the frozen submission. Retried `close{epoch:3}` (new command_id): `cmd.epoch(3) ≠ s.submission.epoch(5)` → domain `stale_epoch`, detail naming presented vs current — committed, ledgered, replayable.
- **Reopened:** `reopen` bumps version and nulls the submission: `close{3}` → `not_submitted`. If the claim was gated and the caller holds a close grant bound to `{v1, e3, H}`: version moved → `validCloseGrant` false → `close_needs_grant`.
- The comparison target is the **frozen submission epoch, never the live lease epoch** — §2.2's final row (a submission survives reacquisition) is exactly why a stale close stays refused while the live epoch has legitimately moved on.

Worker tokens add a third-party fence on the same numbers: tokens bind `{run, task, epoch}`; renewal checks the presented epoch against the current lease epoch in-tx, so an e3-bound token cannot renew into e5's lease — and its commands fence through the same `decide()` comparisons regardless (§6).

### 5.2 Serialization: one lock, one decision, one commit

Mechanism per command (each command touches exactly one stream): §3.2 step 8 `SELECT head_seq FROM swarm.streams WHERE stream_id=$1 FOR UPDATE`; **all** decide-state and oracle reads (steps 9–10) execute *after* lock acquisition; append + projection + head bump + ledger commit together. Single-row, single-stream lock scope means no lock-ordering discipline and no deadlock surface. Hold time is in-memory decide plus a few inserts; the only network call (Supabase Auth verification) happens in step 1, before `BEGIN`. `SET LOCAL lock_timeout='5s'` bounds the waiter: breach → `503` + `Retry-After` + audit (`outcome='error', reason='lock_timeout'`) instead of an unbounded queue.

**Two concurrent claims → exactly one winner, no negotiation round-trip** (the §10 lease-race test). T1 (A) and T2 (B) both `acquire` task T (epoch 5, open):

1. T2 blocks at `FOR UPDATE`.
2. T1 reads post-lock state (epoch 5, open) → `decide()` → `LeaseAcquired e6 owner=A` → append, upsert `tasks`, bump head, **COMMIT**.
3. T2 unblocks: under READ COMMITTED the blocked `FOR UPDATE` re-reads the row (EvalPlanQual) and returns the **new** head; T2's subsequent task read — a new statement with a fresh snapshot — sees epoch 6, owner A, live lease → `decide()`: `active ∧ live` → `not_acquirable` → committed `CommandRejected` in B's name, ledgered.

One winner; the loser's loss is itself durable history; **zero internal retries** — one command = one lock acquisition = one decision = one commit. The loser's remedy is a *new command_id* (a fresh decision), never a silent server retry. Concurrent takeover-vs-handoff at the same epoch (§10 #15) resolves identically: the loser re-decides against the winner's committed state — takeover-loser's grant (bound to the pre-handoff epoch) is now invalid → `live_lease_needs_grant`; handoff-loser sees `owner ≠ me` → `not_owner`.

Rejected alternatives:

- **Optimistic CAS on the head row** (`UPDATE … WHERE head_seq=$old`, rowcount-checked, retry on mismatch). Three failures: (1) decision/commit gap — oracle inputs (memberships, grants, tombstones) are not covered by the head CAS, so a correct CAS must re-run every oracle after winning, reinventing the lock badly; (2) retry storms — a create-race on a hot stream (fleet spawn) turns N commands into O(N²) decide attempts with backoff, where the row lock degrades to fair FIFO queueing; (3) audit/replay semantics blur — one user command becomes K internal attempts. This is why `decide()` needs no `expected_seq` field (§1.3): there is no CAS-mismatch path to surface.
- **REPEATABLE READ** — see §5.3; rejected outright, it is actively wrong here.
- **`pg_advisory_xact_lock(stream_id)`** — works, but the row lock also protects the `head_seq` update itself, is self-describing in `pg_locks`, and needs no lock-id derivation convention; zero payoff, one more convention.
- **Per-task row lock** — does not serialize seq allocation (still need the head lock) and does not cover slug-uniqueness inserts from concurrent creates; two locks reintroduce ordering questions. One lock per stream is the minimum covering both allocation and decision inputs; serializing unrelated tasks in the same stream is harmless at authority-command rates (§0: invisible rigor is free).

### 5.3 Isolation level: READ COMMITTED — load-bearing, not a default

The lock-then-read pattern *requires* per-statement snapshots: the loser's post-lock reads must see the winner's commit.

- **REPEATABLE READ is the specific failure this design rejects.** Under RR the snapshot pins at the transaction's first statement (step 3, pre-lock). A racer reads task state *stale*: both transactions see epoch 5, both emit `LeaseAcquired e6` at consecutive seqs — **two committed winners**, and replay then halts at the second (`assertEpochIncrease`: non-increasing epoch). RR converts a race into permanent stream damage against invariant 3.
- **SERIALIZABLE (SSI)** is safe but abort-driven: the loser fails with `40001` and must retry end-to-end — reintroducing the §5.2-rejected retry loop — and SSI's predicate-lock tracking false-positives across the wide oracle read set throttle hot workspace streams. The head lock already provides strict per-stream serialization; SSI buys nothing and costs abort semantics.
- Structural enforcement: step 9's state loader takes the locked head row as its input, so a pre-lock read has nothing to bind to; the §9 integration tests hammer concurrent acquires/closes and assert exactly one epoch-winner and gapless seqs per stream.

### 5.4 Grant double-spend (§10 #15)

Two concurrent closes presenting one grant: **primary** — serialization; the loser re-decides post-lock, sees `lifecycle='done'` → `already_done` committed rejection, never attempts consumption. **Backstop** — `grant_consumptions` PK on `grant_id`: any residual path reaching a duplicate insert gets a unique violation → ROLLBACK → 500 (§3.2 step 13) — a loud defect, never a silent second spend. The §10 test asserts exactly one `TaskClosed` and exactly one consumption row.

---

## 6. REVOCATION + RATE LIMITS

### 6.1 Revocation: effect within one command, not eventually

- **Enforcement point:** §3.2 step 6, inside the command transaction, per-statement snapshot. The check reads committed state as of its own execution, so a revocation committed before the *next* command's step-6 read is enforced for that command. There is no propagation mechanism to lag: no cache, no TTL, no invalidation messages — the Postgres row **is** the revocation state.
- **Linearization point:** the step-6 statement. A command that passed it before the revoke commits is allowed to finish; it is not preempted mid-transaction. Bounded window: ≤ 1 in-flight command per credential. Preemption is rejected: aborting in-flight commands makes outcomes ambiguous (the client cannot distinguish abort-before-append from abort-after) and forces recovery through idempotent replay anyway. The events an in-flight command commits remain valid history — they were authorized at decision time; revocation withdraws *future* authority, it does not rewrite the past.
- **Checked set (one indexed query):** token `revoked_at`; tombstones for `(token, principal, run, device, membership, family)` plus `(lineage, token.lineage_id)`; principal `revoked_at`; membership `revoked_at`; device `revoked_at` via the run join. Fail-closed: any hit → audit + 403. Order is load-bearing: revocation precedes idempotency (§3.2), so a revoked principal cannot even replay its own stored responses — a stored response is a remote read, and §2.3 permits only labeled local cache after membership revocation.
- **Cascades:** a revoke command writes the target tombstone plus — for family/device/principal targets — lineage tombstones enumerated from `agent_tokens_by_lineage` in the same tx; every descendant token carries `lineage_id`, so the per-command check catches descendants without materializing per-token rows. Renewal re-runs the identical set plus predecessor `revoked_at`, renewal-grant liveness, horizon, and `(task, epoch)` currency: an individually revoked worker is never resurrected by renewal (§10).
- **Agent self-surrender only:** an agent credential may tombstone its own exact presenting `token_id` — compared against the *authenticated row*, not a body field (§4); sibling/principal/run/device/family/membership targets are authz refusals (§10 test).
- **Rejected:** stateless JWT agent auth with expiry-bounded revocation — revocation window = token TTL (up to 8h), violating §2.3's every-command evaluation; cache + pub/sub invalidation — fail-open on a missed or dropped invalidation; polled CRL — the poll interval is the vulnerability window. Each fails *open* under exactly the conditions revocation exists for.

### 6.2 Rate limits (G7 posture: built as if anonymous public traffic were already arriving, though P1 is invite-only)

| Layer | Key | Breach disposition | Why this shape |
|---|---|---|---|
| Edge stateless (body ≤ 128 KB, `command_id` format) | connection | 400/413, no DB touch | Cheap drop before any work |
| Unauthenticated endpoints (login start/callback, invite accept, token exchange) | `ip:<addr>:<endpoint>` **and** identifier where present (login email, invite token hash) | 429 + jittered `Retry-After`; the identifier dimension writes `security_alerts` instead of hard-locking | Attacker throttled by IP; a victim is not lockable via their own email/URL (Kimi #13) |
| Authenticated commands | `cred:<token_id>` / `cred:<user_id+device_id>` | 429 + audit + alert | Per-**credential**, never per-principal: a thief burning a token's budget does not lock out the legitimate principal; re-mint restores capacity (§5, §2.9 alignment) |
| Workspace fairness ceiling | `ws:<workspace_id>` | 429 + operator alert | One tenant — compromised or merely buggy fleet — cannot starve the shared plane |
| Per-tenant resource creation (members, principals, invites/day, workspaces-per-identity ≤ 3) | count oracles inside `decideWorkspace()` | Domain rejection / 403 | **Hard** caps — these bound cost and must not be soft; §8's taxonomy forbids conflating them with the victim-protecting soft limits |
| Global spend circuit breaker | `swarm.config` flag (operator + auto-trip) | Degraded mode: signups/invites paused | G7 Sybil backstop (§8) |

Mechanics:

- **Counters:** fixed 60 s windows in `swarm.rate_buckets` via `INSERT … ON CONFLICT (bucket_key, window_start) DO UPDATE SET count = rate_buckets.count + 1 RETURNING count` — atomic and SQL-backed. In-memory edge buckets are rejected: edge instances are ephemeral and multi-instance, so in-memory limits diverge across instances and reset on cold start — unenforced exactly under the bursts they exist for.
- **Placement:** step 4½ — immediately after principal derivation, before tenancy/validation. Every authenticated attempt is charged, including cross-tenant probes and revoked-credential replays; charging only accepted commands would make enumeration free (rejected).
- **Breach commits:** on breach the transaction writes only the counter increment + audit row + `security_alerts` row and **commits**, then returns 429 — rolling back would refund the attempt. Disposition stays audit-only (§3.3): no events, no ledger row.
- **429 vs idempotent replay:** rate limiting precedes the idempotency lookup deliberately — a replay under breach gets 429, not the stored response; the row remains stored and a later retry within retention replays it. Unthrottled replay of ≥ 30 d of keys is itself a vector.
- **Uniformity:** 429 bodies carry no tenancy/credential detail; `Retry-After` is jittered to de-sync herds.
- **Seed defaults** (in `swarm.config`, tuned by the §10 abuse/load suite before P5 opens the surface): `auth.ip` 10/min; `command.cred` 120/min; `command.ws` 1200/min; `events.ws` 200 000/day; `invites.ws` 10/day (§8 phishing cap); workspaces per verified identity ≤ 3 (P5 gate).

---

## 7. IDEMPOTENCY RETENTION

**Contract.** Key `(principal_kind, principal_id, command_id)` (PK; kinds `user`/`agent` mirror P0's `idempotencyPrincipal` namespacing). Hash: the **unmodified P0 `requestHash()`** — sha256-hex of `canonicalJson({principal, cmd})`, keys sorted recursively. Stored: `StoredResponse {ok, reason?, detail?, class?, event_ids}` + `created_at`. Retention: **≥ 30 days** — daily `pg_cron` purge as `swarm_admin` (`swarm_command` holds no DELETE, §2.2): `DELETE FROM swarm.idempotency_keys WHERE created_at < now() - interval '30 days'`, horizon configurable in `swarm.config` with 30 d as floor (Kimi #17 sets the floor covering any realistic client retry; per-row cost argues against much more).

**What is hashed — exactly.** `{principal: "user:<uid>" | "agent:<pid>", cmd}` where `cmd` is the complete P0 `Command` member — every field that changes the command's effect:

| kind | hashed fields |
|---|---|
| create | `kind, task_id, slug` |
| acquire | `kind, task_id, ttl_ms` |
| renew | `kind, task_id, epoch, ttl_ms` |
| handoff | `kind, task_id, epoch, to_owner, ttl_ms` |
| takeover | `kind, task_id, grant_id, ttl_ms` |
| submit | `kind, task_id, epoch, branch, head_sha, evidence_set` |
| close | `kind, task_id, epoch, disposition, grant_id` |
| reopen | `kind, task_id, epoch` |

`ttl_ms` staying in the hash is deliberate: a retry with a different TTL must 409 — replaying a response whose committed `lease_expiry` contradicts the caller's assumption would be a silent lie.

**What is EXCLUDED — and why.**

| Excluded | Why | Failure if included |
|---|---|---|
| `command_id` | It *is* the lookup key; the hash exists to detect key **reuse** with a different request | Functionless redundancy |
| `workspace_id` / `stream` routing | P0 `requestHash` is frozen and hashes only `(principal, cmd)` | — (handled by wrapper augmentation below) |
| `client_version` | Compatibility metadata for the min-version gate, not command semantics | A legitimate retry after a CLI upgrade 409s instead of replaying |
| `event_id`, `seq`, `occurred_at_server` | Server-assigned **outputs** | Server time makes every request unique — idempotency ceases to exist |
| Credential material / `token_id` | The ledger is keyed by **principal**, not credential | A worker whose ≤ 1 h token rotated to a successor (same principal) would *re-execute* its pre-rotation `command_id` instead of replaying — duplicate effects across routine renewal |
| IP / user-agent / HTTP metadata | Transport artifacts | A retry from a different network (laptop → CI runner) must still replay |

**Routing-field augmentation (P0 stays frozen).** The SQL ledger row additionally stores `workspace_id` + `stream_id`, and the step-7 lookup matches them. The case the bare P0 hash cannot see: one principal, two memberships, same `command_id`, same `cmd`, different `workspace_id` — without the guard, the second request replays an accepted response for a command that never ran there; with it, the mismatch is treated as conflict → 409. The pure hash is untouched; the wrapper narrows the replay condition.

**409 semantics.** Row exists and (`request_hash` differs **or** workspace/stream differs) → audit (`outcome='conflict'`) + `409 {error:"command_id_conflict"}`; the existing row is untouched, nothing is appended, and the body carries no detail about the original request — uniformity forbids making the stored outcome readable to whoever controls the key.

**Concurrent-first-attempt race, closed by the PK, not the lookup.** Two racing fresh executions with the same key both miss step 7, serialize at the head lock, and both decide; the loser's step-14 ledger `INSERT` violates the PK → ROLLBACK (its now-divergent decision is discarded) → a fresh one-statement read sees the winner's row → returns the winner's stored response as a replay. First committer defines the response; exactly-once-per-key is enforced by the primary key. Bounded: one re-read, no loop.

**Replay path.** Hash match → `200` with the stored `StoredResponse` **verbatim** — accepted *and* domain-rejected outcomes both replay (Kimi #17: a late retry never re-executes a committed command). `event_ids` are provenance; events are never re-appended — the client observes effects via stream replay. The replay itself is audited (`outcome='replayed'`), so replay abuse is visible. Never ledgered: `authz` rejections (a later membership grant must make a retry eligible — the P0 test pins this) and all transport failures (401/403/400/413/409/429), which never reached `decide()`.

**Post-purge behavior, stated rather than hidden.** A `command_id` replayed after its row's purge re-executes as fresh — and degrades safely, because the state machine's own guards absorb duplicates: repeated create → `slug_not_unique`; repeated acquire → `not_acquirable`; repeated close → `already_done`. The 30 d floor exists so this path is unreachable by any realistic client retry (outbox drains, CI re-runs); clients must treat `command_id`s as single-use beyond the retention window (client contract, §8).

---

## 8. LOCAL-FIRST INTEGRATION

### 8.1 The local SQLite is a derived cache plus an intent queue — never an authority

An attached CLI's local database has exactly two write paths: **(a) fold** — apply server event envelopes through the unmodified `upcastEnvelope` → `reduceTask` from the shared `src/protocol` package (npm workspace import, same artifact the Edge Function bundles); **(b) outbox state transitions** (§8.6). There is no third path. `decide()` may be run locally **only as advisory pre-flight UX** (graying out a `close` button); its local result produces no events, authorizes nothing, and is never persisted as authority. Rejected: running `decide()` locally against the cached projection and treating a local accept as a queued lease acquisition — two laptops offline simultaneously would both "hold" epoch N+1, and reconciliation at reconnect has no correct merge because a committed close is irreversible. That is precisely the split-brain the lease fencing (§2.2) exists to prevent; G4 forbids the entire category (§8.7).

Local tables (CLI-owned, device-local):

| Table | Contents | Authority |
|---|---|---|
| `local.events` | raw envelopes, PK `(stream_id, seq)` | append-only mirror of `swarm.events` |
| `local.stream_cursors` | `stream_id, applied_seq, head_seq_hint, halted_json, last_sync_at, snapshot_seq_applied` | client state |
| `local.tasks`, `local.leases` | folded projections (shape mirrors §2.1 DDL) | derived; rebuildable from `local.events` |
| `local.outbox` | §8.6 | client intent |
| `local.attachments` | `workspace_id`, stream bindings (`workspace` + one per repo mapping), attached_at | set once by `cloud attach`; §6 irreversible |

### 8.2 Replay: the delivery-of-record read path

Realtime/Broadcast (P3) is a latency hint only; **cursor replay is the delivery-of-record** (§2.13). Two callers, one code path, one predicate (`swarm.is_member`, §2.3):

| Caller | Transport | Server side |
|---|---|---|
| Human (CLI/board, Supabase JWT) | PostgREST RPC | `swarm_read.replay(p_stream_id uuid, p_after_seq bigint, p_limit int) returns jsonb` — SECURITY DEFINER (`swarm_admin`, pinned `search_path`), guarded by `is_member(stream's workspace_id, auth.uid())`; non-member → uniform `403 {error:"forbidden"}`, indistinguishable from unknown stream |
| Agent (`swm_agt_…`) | Edge read proxy `POST /read/replay` | runs §3.2 steps 3–6 equivalents (token-hash authn → principal derivation → tenancy (`principal.workspace_id = stream.workspace_id`) → fail-closed revocation re-check **on every request**), then executes the same replay SQL as `swarm_command`. Revoked/expired → 403/401 uniform; after membership revocation the proxy serves nothing (§2.3: only labeled stale local cache remains) |

Response envelope: `{stream_id, events: EventEnvelope[], head_seq, min_client_version, protocol_schema_version}`. Rules:

1. **Cursor is keyset, not offset.** `WHERE stream_id=$1 AND seq > $2 ORDER BY seq ASC LIMIT least($3,500)`. `p_limit` is clamped server-side to [1, 500]. Rejected: `OFFSET n` pagination — unstable under concurrent append and O(n) scan; the `(stream_id, seq)` PK makes keyset the index-aligned path.
2. **Atomic page application.** Each page is folded inside one SQLite transaction: insert raw envelopes (PK dedups), fold in ascending seq, advance `applied_seq` to the page's last seq — commit together. A crash mid-page rolls back to the last page boundary; re-pull is idempotent. `applied_seq` never advances past an unfolded event.
3. **Gap = halt-and-rebootstrap, never skip.** If a page's first seq ≠ `applied_seq + 1`, the cursor is corrupt (or the snapshot baseline was lost): the client discards the stream's local projections and re-bootstraps per §8.3. Rejected: skip-forward resync — silently dropping history makes the local projection diverge from authority while the CLI keeps issuing commands against the phantom state.
4. **`head_seq` is a hint, not a fence.** It is read in the same statement as the page (single-statement consistency under READ COMMITTED), but convergence is guaranteed by re-pull, never by comparing to head. "Caught up" means: a pull returned 0 events.
5. **Upcast before reduce, always.** Every pulled envelope passes the unmodified `upcastEnvelope` first; `UpcastError` (newer schema or missing step) is a halt trigger (§8.5). Server and client share the registry, so an unknown type/version on the wire means exactly one thing: the server is newer than this client.
6. **Command-response fast path.** The `events` array in a `200 accepted` response (§3.2 step 15) may be folded immediately **iff** its first seq = `applied_seq + 1` (it was allocated under the head lock, so it is contiguous); otherwise it is discarded and replay heals. The response never replaces a replay pull for streams the command didn't touch.
7. **No cross-stream order.** Workspace stream and repo streams are pulled and folded independently (§2.13); merged UI views sort by `occurred_at_server` for display only, never for authority.

### 8.3 Snapshot bootstrap

`swarm_read.snapshot(p_stream_id uuid) returns jsonb` — same SECURITY DEFINER + `is_member` guard and same uniform 403 as §8.2; agent path via the same read proxy. It executes as **one SQL statement** (`jsonb_build_object` over subqueries), which under READ COMMITTED yields a statement-consistent cut:

`{stream_id, snapshot_seq (= streams.head_seq read in the same statement), protocol_schema_version, min_client_version, projections: {tasks: [...], leases: [...]} }` — plus `{memberships, agent_principals, repositories, landing_authorities}` for the workspace stream.

Attach flow (`swarm cloud attach` / invite accept):

1. snapshot → write projections locally, record `snapshot_seq_applied`;
2. replay from `snapshot_seq + 1` to head (heals any commit that raced the snapshot statement);
3. **verification fold**: the client independently runs the unmodified `reduceStream` over the raw pulled events for at least one task touched during catch-up and asserts equality with the snapshot-derived projection row; mismatch → attach aborts loudly (this is the client-side twin of the server nightly rebuild/`drift_detected` tripwire, §3.2 step 12).

Full replay from seq 1 is always a valid fallback (events are reducer-complete, §2.1); the snapshot is an optimization, never a second authority. Rejected: storage-level/export-file snapshots — an inconsistent cut across tables plus a second import format to keep honest; the single-statement jsonb read is consistent by construction and reuses the replay code path for the remainder.

### 8.4 Minimum-supported-client version

- Source of truth: `swarm.config('min_client_version')` (seeded `"0.1.0"`, §2.1). Carried on **every** command response (§3.2 step 15), replay response, and snapshot response.
- **Server-side**: the client sends its package `client_version` on `POST /commands` (§3.2 preamble). Step 6 validation compares it against the config value read in-tx; below-minimum → `400 {error:"client_unsupported"}` + audit `outcome='validation'`. Uniform body; the minimum is not secret.
- **Client-side**: on any response whose `min_client_version` is semver-greater than the running version, the CLI halts **before** the next fold: stops advancing cursors (an event stream written by a newer protocol is exactly where unknown types appear), refuses new commands with an upgrade-required message, and keeps serving the already-folded cache labeled stale. Rejected: silent continue ("fold what you know, skip what you don't") — that is skip-on-unknown with extra steps, and forfeits the §2.1 halt guarantee. Rejected: per-client/per-device kill switch — an availability and hostage lever; the version floor is tenant-global and operator-set.
- Bumping the floor is a human Owner/Admin workspace command, audited (it is a deliberate coordination event: "everyone past protocol change X must upgrade").

### 8.5 The unknown-type halt, concretely

Triggers during fold: `UnknownEventTypeError`, `UpcastError`, `StreamIntegrityError` (all unmodified P0 classes). Behavior, in order:

1. the page transaction **rolls back** — `applied_seq` stays at the last good seq;
2. `local.stream_cursors.halted_json = {stream_id, seq, type, error}` is recorded;
3. commands targeting that stream refuse locally with `halted: upgrade required (unknown event "T" at seq N)` — they are not sent, not enqueued;
4. reads from that stream serve the pre-halt prefix only, labeled `halted at seq N`;
5. recovery is exactly: upgrade client → re-fold from `snapshot_seq_applied` (or seq 1) → clear halt. Never `--force`, never skip.

Rejected: skip-and-continue on unknown types — the client would fold a partial history, diverge from authority, and keep closing/renewing against a phantom projection; the failure this avoids is not a cosmetic one (a wrong board) but **authoritative closes issued from a state the server never had**. The halt is the client-side enforcement of invariant 3 (§0): the stream is authority, so an unreadable stream means stop, not improvise.

### 8.6 Outbox (§2.7 allowlist, exact)

Allowlist is exactly **{draft task create, message send}** — and at P1 only draft task create is user-reachable (messaging ships P3; the outbox schema ships now). Everything else is online-only with the honest §2 refusal; it is never enqueued.

| Field | Rule |
|---|---|
| `command_id` | generated **at enqueue time**, matching the server regex `^[A-Za-z0-9_-]{8,72}$` (§3.2 step 1); immutable thereafter |
| states | `pending → sending → accepted \| rejected`; no other transitions |
| dependency ordering | `depends_on` (outbox row id); flush is topological — a message about a task flushes after that task's create is `accepted` |
| flush | `POST /commands` with the stored body verbatim; crash-safe because the server ledger keys `(principal, command_id)` (§3.2 step 7): a retry after an uncertain outcome replays the stored original (§9 T-11) |
| `accepted` | stores the server `StoredResponse` (event ids); the events themselves arrive via replay/§8.2 fast path |
| `rejected` | stores the canonical `reason`/`detail` from the committed `CommandRejected` (or the HTTP error for validation/authz); **the rejected draft is preserved, never auto-requeued, never edited in place** — re-issue = new row, new `command_id` |
| blocked dependents | a `rejected` dependency leaves dependents `pending` with a surfaced blocked reason; they are never silently dropped or flushed out of order |

### 8.7 G4 at this layer: what "never falls back to local authority" means

| # | Concrete rule | Enforcement point |
|---|---|---|
| 1 | No local decide-authority: every authority command for an attached stream goes to `POST /commands`; the CLI never appends to `local.events` from anything but a server response or replay page | single fold/outbox write paths (§8.1) |
| 2 | Attached marker is one-way: `local.attachments` row exists ⇒ the legacy `semantics=v1-local` lease path refuses every command for those tasks (§2.2 "never conflated"; §6 step 1 freeze). Reversal only via `cloud export` into a **new** local swarm (§6 step 7) | CLI command router checks attachment before dispatch |
| 3 | Offline: reads = cache labeled with `applied_seq` + `last_sync_at`; writes = §8.6 allowlist only; hard-invariant commands (acquire/renew/handoff/takeover/submit/close/reopen/grants/mint/…) refuse honestly, unqueued | outbox allowlist check before enqueue |
| 4 | Revocation is sticky downward: after a 403-revocation from the read proxy, only explicitly-labeled **stale local-cache** reads are served; no remote reads, no commands, no `--force` resurrection (§2.3) | CLI credential-health state (`swarm whoami`) |
| 5 | Halt ≠ fallback: an unknown-type/version halt (§8.5) waits for upgrade + re-fold; it never reverts the stream to local judgment | §8.5 step 3–5 |
| 6 | Disagreement resolves toward the server, always: seq conflict, verification-fold mismatch, or projection drift ⇒ local projections are rebuilt from the server stream; the reverse direction does not exist | §8.2 rule 3, §8.3 step 3 |
| 7 | The lease is held by the server, not by possession of the CLI: no local file, lock, or flag extends, renews, or reclaims a lease offline; expiry is server time (§4 honest-liveness) | `occurred_at_server`/`statement_timestamp()` only (§1.2) |

Rejected alternative for the whole section: "optimistic offline acquire with reconcile-on-reconnect" — the reconcile has no correct answer when both sides closed work (closes are irreversible records, §2.2), so the design would need either a merge protocol for authority (a second authority implementation — invariant 2 forbids it) or silent loss of one side's committed record. G4 exists to make that failure impossible by construction.

---

## 9. TEST PLAN

### 9.0 Harness, fixtures, hooks, global invariants

Suite: `tests/p1-server/` — integration tests against `supabase start` (local) with the `command`/`read` Edge Functions served in test mode. The **service_role key is used only for fixture setup and fault injection, never in the command path**. Every test gets fresh workspaces **A** and **B**, users (UA owner of A, UA2 member of A, UB member of B), an agent principal+run+token in A. Commands go over HTTP exactly as a client would send them; concurrency via `Promise.all` over fetches. Two **test-only hooks** in the Edge Function, enabled iff `SWARM_ENV=test` (refused otherwise): `SWARM_CMD_TEST_SLEEP_AFTER_STEP=<n>:<ms>` (sleep between §3.2 steps) and `SWARM_CMD_TEST_ROLLBACK_BEFORE_STEP=<n>` (throw → rollback at a named step).

**Global invariants asserted after every test** (the §10 R1 drift tripwire, run as SQL + the unmodified core):

- **I1 — projection ≡ fold**: for every stream, `reduceStream` over raw `swarm.events` (upcast first) equals `swarm.tasks` rows, canonical-JSON compared.
- **I2 — contiguous seqs**: per stream, `array_agg(seq order by seq) = array(select generate_series(1, max(seq)))` and `streams.head_seq = max(seq)`.
- **I3 — tenant discipline**: every `events.workspace_id` equals its stream's `workspace_id`; every row of every tenant-owned table carries the attaching workspace.
- **I4 — ledger hygiene**: `swarm.idempotency_keys` contains only accepted/domain outcomes (no authz/validation rows); every ledger row's `request_hash` recomputes via the unmodified `requestHash()`.
- **I5 — attribution (G3)**: every committed event has non-null `actor_user`; agent-originated events additionally carry `actor_agent_principal` + `actor_run` that join back to the presenting token's row.

### 9.1 The launch-blocking dozen

**T-01 — Cross-tenant write rejection** *(§10 core/Kimi #9; §3.2 steps 5, 15; §3.3)*
Setup: UA holds B's `workspace_id` and repo `stream_id` (deliberately leaked — knowledge of ids is not authority). Control: a random nonexistent workspace id.
Action: UA's JWT → `POST /commands` `{workspace_id: B, stream: B's repo stream, command: create}`; then the same body against the nonexistent id.
Expected: both return `403` with **byte-identical** `{error:"forbidden"}` bodies (no existence oracle); zero rows in B's `swarm.events`; zero `idempotency_keys` rows for that `command_id`; B's `streams.head_seq` unchanged; exactly one `audit_log` row per attempt with `outcome='authz'`, `actor_user=UA`, `workspace_id` as supplied; I1–I5 pass for both tenants.

**T-02 — Forged actor field** *(§2.1 actor stamping; §3.2 step 4)*
Setup: UA (authenticated), UV (another member of A).
Action: valid `create` whose body additionally carries `actor_user: <UV uuid>`, `actor_agent_principal: <foreign principal>`, `device: "victim-laptop"`. Variant: same fields smuggled *inside* the `command` object.
Expected: base request → `200 accepted`; the appended envelope's `actor_user = UA`, `actor_agent_principal IS NULL`, `actor_run IS NULL`; UV's id appears nowhere in `swarm.events`; the audit row's `detail` records forged-field presence. A clean retry (identical command, no forged fields) → `replayed` with the original `StoredResponse` — proving the forged fields never entered the idempotency identity (`requestHash` is over the derived principal + command only). The in-`command` variant → `400` validation refusal, zero events.

**T-03 — Stale-epoch close** *(§10 core; §2.2 close fencing; `decide()` close branch)*
Setup: UA (Owner) creates task, acquires (epoch 1), submits with ttl 200 ms (submission frozen at epoch 1); sleep 300 ms (lease dies; submission survives, §2.2 final row); UA2 acquires (epoch 2) and submits (submission superseded → frozen epoch 2).
Action: UA closes presenting `epoch: 1`.
Expected: `200 {status:"rejected", class:"domain", reason:"stale_epoch"}`; exactly one committed `CommandRejected` event (reason `stale_epoch`); `swarm.tasks` row unchanged (`lifecycle='awaiting_review'`, submission epoch 2); the rejection is ledgered; an identical retry → `replayed` and **no second** `CommandRejected`; I1–I5.

**T-04 — Double-spent grant** *(§10 #15; §2.5; §3.2 steps 9, 13; §5.4)*
Setup: UA2 holds a live lease (epoch 1); UA (Owner) issues takeover grant `g` bound `{task, epoch 1, recipient: UA2's principal}`.
Action: two concurrent `takeover` commands from UA2, distinct `command_id`s, both presenting `g`.
Expected: exactly one `200 accepted` with `LeaseTakenOver{epoch: 2, grant_id: g}`; `grant_consumptions` contains exactly one row for `g`; the stream contains exactly one `LeaseTakenOver` carrying `g`; the loser (re-deciding after the head lock, §2.4) receives a domain rejection (`live_lease_needs_grant` — grant no longer epoch-bound/current, and already consumed) with a committed `CommandRejected`; the loser's retry replays its stored rejection without a second event; the `grant_consumptions` PK is the backstop — a forced duplicate insert as service_role errors. I1–I5.

**T-05 — Replayed command_id** *(§2.1 idempotency; §3.2 step 7)*
Setup: member UA.
Action: `create` with `command_id: k` → `200 accepted` (response R1). Resend the byte-identical request twice.
Expected: both retries return R1's `StoredResponse` verbatim (same `event_ids`); `swarm.events` holds exactly one row with `command_id=k`; `streams.head_seq` unmoved by retries; exactly one `idempotency_keys` row for `(user, UA, k)`; audit shows one `accepted` + two `replayed` rows.

**T-06 — Key reuse with a different hash → 409** *(§10 core; §3.2 step 7; §7)*
Setup: ledger row from T-05.
Action: UA resends `command_id: k` with a different command body (different slug).
Expected: `409 {error:"command_id_conflict"}`; zero new events; the ledger row for `k` is unchanged (original hash, original response); `streams.head_seq` unmoved; audit gains one `outcome='conflict'` row; a subsequent retry of the *original* body still replays the original response (the conflict did not poison the key).

**T-07 — Revoked principal mid-flight** *(§2.3 revocation-every-command; §3.2 step 6; §5.3 READ COMMITTED)*
Setup: principal P (owner UA), run R, token T; test hook `SWARM_CMD_TEST_SLEEP_AFTER_STEP=4:1500`.
Action: start command C with T; at +500 ms, from a second connection, UA commits `revoke_agent_principal(P)` (+tombstone); let C resume. Then issue further commands on T and on a sibling token of P.
Expected: C's step-6 revocation read sees the committed tombstone → `403`; C appends zero events; audit row with `credential_id = T.token_id`; all subsequent commands on T and the sibling fail `403` (principal-level cascade, fail-closed); a renewal attempt on P's lineage is refused. I2 proves C burned no seq.

**T-08 — Oversize payload** *(§2.1 Kimi #23; §3.2 steps 1, 6; §2.1 events CHECK)*
Setup: member UA.
Action: (a) body of 200 KB; (b) well-formed body ≤ 128 KB whose computed event payload exceeds 64 KB (evidence_set of long strings).
Expected: (a) `413` from the stateless pre-check with **zero DB writes of any kind** (assert audit/event counts unchanged — step 1 precedes any transaction); (b) in-tx validation refusal (`413`/`400`), one audit row `outcome='validation'`, zero events, head_seq unmoved; separately (schema assertion, once): a direct service-role `INSERT` with an oversized payload fails the `octet_length <= 65536` CHECK — the constraint exists as backstop even if wrapper validation regresses.

**T-09 — Seq gap under concurrent append** *(§2.4 gapless allocation; §3.2 steps 8, 11)*
Setup: one repo stream; 20 concurrent commands: 10 valid `create`s (distinct tasks), 7 commands engineered for domain rejection (5 principals racing `acquire` on one task, 2 stale-epoch `renew`s), 3 commands with `SWARM_CMD_TEST_ROLLBACK_BEFORE_STEP=15` (post-append rollback).
Expected: after settlement, I2 holds exactly — `events.seq` is precisely `1..M` with no gaps, `head_seq = M = count(events)`; the 3 rolled-back commands contributed zero events and zero head movement (in-memory seq arithmetic rolls back with the tx, §1.3); each committed transaction's events occupy one contiguous block; every domain rejection present as its committed `CommandRejected` inside the same contiguous numbering.

**T-10 — Lease race, exactly one winner** *(§10 core; §2.2; §5 head-lock serialization)*
Setup: open task; members UA and UA2, distinct `command_id`s.
Action: simultaneous `acquire` from both.
Expected: exactly one `LeaseAcquired` event (epoch 1); winner `200 accepted`; loser `200 {status:"rejected", class:"domain", reason:"not_acquirable"}` with committed `CommandRejected`; projection `epoch=1, owner=<winner>`; each side's retry replays **its own** stored original (winner's accept, loser's rejection — §2.1 replay-before-state); I1–I5. Repeat 50× and assert the winner count is always exactly 1 (never 0, never 2).

**T-11 — Retry-after-commit returns the original result** *(§10 core; Kimi #17; §3.2 steps 7, 14)*
Setup: extends T-05 to the rejection-ledger semantics.
Action: (a) accepted path: `create` with k1 → R1; resend ×3. (b) domain path: `acquire` a task whose lease is live-held by someone else, k2 → rejection R2; resend ×3.
Expected: every retry body equals the original `StoredResponse` exactly (`event_ids` identical, `ok`/`reason`/`detail`/`class` identical); stream holds exactly one event set for k1 and exactly one `CommandRejected` for k2; `head_seq` changes only on the first commit of each; audit shows one `accepted`/`domain` + three `replayed` per key; ≥30-day retention asserted as a schema/config constant (purge job boundary).

**T-12 — Last-Owner removal refused** *(§10 core; §2.6 no-orphan; §3.4)*
Setup: workspace A with sole Owner UA and member UA2.
Action: (1) `remove_member{target: UA}` issued by UA; (2) `change_role{target: UA, role: member}` issued by UA.
Expected: both refused as **committed domain rejections on the workspace stream** (`CommandRejected`, reason `last_owner` — the workspace module's no-orphan code, §3.4); UA's `memberships` row is byte-identical afterward (`role='owner'`, `revoked_at IS NULL`); zero `MemberRemoved`/`MemberRoleChanged` events for UA; UA can still issue commands (not bricked — §7 sole-Owner is first-class); retries replay both rejections; I1–I5.

### 9.2 Remaining P1-gating §10 tests (compact)

| Name | Setup → action | Observable assertion |
|---|---|---|
| T-13 unknown event type halts client | service-role injects `events` row `type='FutureEvent', schema_version=1` past head; CLI pulls | fold rolls back; `applied_seq` = seq−1; `halted_json` recorded; commands to that stream refuse locally; after whitelist-"upgrade", re-fold converges to I1 |
| T-14 dropped/reordered pages converge | client harness drops page 2 and reorders page 3 of a replay | re-pull from cursor heals; final local projection canonical-equals `swarm.tasks`; `applied_seq = head_seq` |
| T-15 revoked-membership agent token fails auditable | revoke UA2's membership; use UA2-derived agent token | command → 403, zero events, audit row with `credential_id`; read proxy → 403; CLI serves only labeled stale cache |
| T-16 concurrent invite accepts → one membership | one invite token; two verified users accept concurrently (§7, Kimi #6) | exactly one `InvitationAccepted`+`MemberJoined`; loser matches 0 rows on the atomic consumption `UPDATE` → domain rejection; `invitations.consumed_at` set once |
| T-17 handoff to non-member | `handoff to_owner = non-member` (and separately, revoked member) (Kimi #9) | domain `recipient_not_member`, committed `CommandRejected`; owner/epoch unchanged |
| T-18 denylisted scope refused at mint | human mints agent token requesting `issue_grant` scope (§2.3 denylist; §3.4) | refusal per §3.4 precondition rules (committed `CommandRejected` on workspace stream); zero `agent_tokens` rows; audit present |
| T-19 renewal is a fenced successor | `renew_worker_token` with caller-selected `task_id`/`scopes` divergent from predecessor; and a successor broader than predecessor | validation refusal for caller-selected targets; broader-than-predecessor refused; a legal renewal's successor row derives principal/run/task/epoch/scopes solely from the predecessor, budget decremented, lineage intact |
| T-20 agent revocation authority confined | agent token presents `revoke_agent_token` against (a) a sibling token, (b) its principal, (c) its own exact presenting token (§2.3/§10) | (a),(b) → 403 authz, audit-only, zero tombstones; (c) → accepted, exactly one tombstone for the presenting token; enforcement on next command fails closed |
| T-21 per-view two-tenant zero rows | UB's JWT selects every `swarm_read.*` view filtering on A's ids (Kimi #11) | zero rows from every view (incl. `events`, `tasks`, `leases`); predicate text asserted identical across views; replay/snapshot RPCs return uniform 403 |
| T-22 append-only enforcement | as `swarm_command`: `UPDATE`/`DELETE` on `events`, `audit_log`; as a test role granted UPDATE: retry | permission denied for `swarm_command` (grant absent); trigger raises `SWARM_APPEND_ONLY` for the granted role — backstop proven |
| T-23 expired-lease mutation rejected | acquire with ttl 200 ms; sleep; `renew` (and `submit`) at same epoch | domain `lease_expired` for each, committed `CommandRejected`; state unchanged |
| T-24 submission survives expiry; supersession | as T-03 setup through the second submit | after expiry + reacquire, frozen submission row still closeable at its epoch; after the new submit, only the new `{epoch, head_sha}` closes (T-03 covers the stale side; here the *current* close succeeds → `TaskClosed`, disposition recorded) |
| T-25 read proxy re-verifies every request | revoke token T between two replay calls | first call 200, second 403; no caching window; audit rows for both |

Every row above is executable against the harness in §9.0 with no manual steps; T-01…T-12 plus I1–I5 are the P1 merge gate, and T-13…T-25 bind §8's client rules to the server they consume.

---

## 10. RISK REGISTER

Ranked by (probability × blast radius) at the P1 invited-beta trust level. Boundary = Swarm's containment boundary per §0: INSIDE = Swarm can in principle prevent/detect it; OUTSIDE = documented residual risk the design can only mitigate. R1–R3 are the only risks that can *silently* corrupt or falsely mint authority; everything below them is bounded, detected, or accepted.

| # | Risk | Boundary | Mitigation / honest residual |
|---|---|---|---|
| R1 | **Projection drift**: a `swarm.tasks`/`leases` row stops being `reduceTask`-equivalent to the event stream (bug in step 12 folding, a migration, an operator edit). `decide()` then evaluates false state — a stale epoch looks current, a live lease looks expired → double-acquire or stale close committed as *valid* history. | INSIDE | Projection is the fold by construction (§3.2 step 12); nightly rebuild job re-folds every stream with the same pure `reduceStream` and diffs every projection row; mismatch → `drift_detected` row in `security_alerts` + operator notification. **Rejected:** SQL-trigger-maintained projections (a second reducer implementation — the drift surface becomes the authority itself); hand-patched dual writes (this is exactly the bug class). Residual: drift window ≤ 24h between rebuilds — accepted at P1 volume; tighten cadence if a drift ever fires. |
| R2 | **Check-order regression** in the Edge orchestrator. The §3.2 order (authn → tenancy → revocation → validation → idempotency → lock → decide) is load-bearing but not type-enforceable; a refactor that reads task state before the tenancy proof reopens the cross-tenant existence oracle, and one that returns the idempotent replay before the revocation check hands a revoked principal its stored responses. | INSIDE | §9 order-pinning integration tests: non-member command leaves zero stream rows and an `authz` audit row; revoked principal with a *ledgered* prior command gets 403, never the stored 200; these tests fail on any reorder. The §3.2 numbered order is the review checklist. Residual: TypeScript cannot make order unrepresentable — accepted, covered by the pinned tests. |
| R3 | **`swarm_command` DB password leak** (Edge secret). | INSIDE | Blast radius is pre-bounded by the §2.2 grant matrix: SELECT + minimal DML in `swarm` only; no DELETE on `events`/`audit_log`, no UPDATE on `events` (grant absence *plus* append-only trigger), no DDL, no `auth.*`, no storage, no GoTrue. Constraints (seq PK, slug UNIQUE, grant single-use, FKs) still hold for the leaker — it can mis-authorize within one transaction's logic but cannot rewrite history. Detection: audit-log anomaly + R1 drift check. Response: password rotation + windowed audit review. **Rejected alternative that would make this total:** connecting as `service_role` (§2.2) — one leaked env var = full compromise. |
| R4 | **Compromised human refresh credential / host.** Equivalent to full account compromise until revoked: mint tokens, issue grants, invite, remove members (§2.3 states this plainly). | Theft vector OUTSIDE (laptop/browser/keychain); use INSIDE | Refresh-rotation reuse detection → family revocation (SPEC GAPS #7); per-device revocation with cascade; keychain-only storage + redaction; ≥2 Owners + break-glass so one compromised Owner cannot permanently capture a workspace (§2.6); audit alerts. **Accepted residual:** a live human credential *is* the human — detection speed is the control, not prevention. |
| R5 | **Authority bypass via a second write path** — any future code that INSERTs into `swarm.events` or mutates projections without going through `decide()` (P2 webhook handlers, backfills, operator emergency SQL, the R1 rebuild job itself). Produces invariant violations with no `CommandRejected` history and no audit row. | INSIDE | Doctrine rule: the command function is the only append path; CI grep-gate blocks `INSERT INTO swarm.events` outside the command function's directory; R1 rebuild detects projection-only violations; R1 job is read-compare-alert, never auto-repair (auto-repair would itself be a second writer — divergence between repair and authority is the failure avoided). |
| R6 | **Frozen-core packaging drift**: the Edge bundle resolves the npm-workspace import of `src/protocol/*` to a stale or locally patched copy — a second `decide()` in disguise, violating invariant 2 invisibly. | INSIDE | CI hashes `src/protocol/*` at bundle time; the Edge function logs that hash at cold start; release gate compares bundle hash to repo hash; a mismatch fails the deploy. **Rejected:** vendoring a copy into `supabase/functions/` (guaranteed drift on the first core touch). |
| R7 | **`evidenceComplete` is shallow at P1** (§3.2 step 9): oracle = non-empty + structurally-valid references; the §2.4 provenance-bound verification ships with the artifact plane at P2. A P1 submission/close can cite fabricated evidence strings. | INSIDE, time-boxed | Safe to accept *only because* claim kinds don't exist at P1 (SPEC GAPS #3): `claimRequiresGrant ≡ false`, so no P1 close is represented as evidence-verified, and the `merged` disposition's reachability gate is part of the same P2 machinery. Hard rules: claim-typed tasks cannot be created until P2 flips the oracle; every P1 surface renders dispositions as *recorded, not verified* — any UI implying verification is a bug. |
| R8 | **Event/seq spam via committed domain rejections.** A member — or a compromised worker inside its binding — can mint unbounded `CommandRejected` events: they burn seq, are folded by every client forever, and are idempotency-ledgered. | INSIDE | Per-credential rate buckets → 429 + `security_alerts` (§5); workspace fairness ceiling; revoke + re-mint restores the victim (no lockout, Kimi #13). **Accepted residual:** §8's per-tenant hard caps (events/day et al.) ship at P5; at the invited-beta trust level per-credential buckets + revocation suffice. Forward-registered for P5. |
| R9 | **Compromised ≤1h worker token: in-binding damage window.** It can churn its own task's lease, spam domain rejections (R8), and surrender itself — but cannot escalate (denylist + attenuation-only minting), cannot touch other tasks (run+task+epoch binding), cannot brick the fleet (revocation authority is human-confined). | INSIDE | Bounded by ≤1h TTL (8h hard max), revocation-evaluated-every-command, lineage tombstones, rate buckets. **Accepted residual:** up-to-TTL in-binding noise; this is the deliberate price of the multi-day-fleet renewal design (§2.3), narrowed by lineage-wide revocation. |
| R10 | **GoTrue platform assumptions fail**: hosted Supabase doesn't expose refresh-reuse family revocation or wildcard loopback redirect URLs at the project's plan (SPEC GAPS #6/#7). P1 login security silently degrades — a stolen refresh credential lives indefinitely. | OUTSIDE (platform) | Both are P0 provisioning-inventory checks with recorded fallbacks (pinned port + collision queue; swarm-side device↔session tracking + forced re-auth interval). Gate: P1 login does not ship until both are verified on the actual project, not assumed from docs. |
| R11 | **Human Git credentials and out-of-band infrastructure applies.** Agents inherit human Git credentials; arbitrary writes to unprotected refs and direct `terraform apply`/`psql` are outside every Swarm gate. | OUTSIDE | Mitigated, not eliminated (§0/§2.10): per-epoch branch registration, protected-branch rulesets, deploy secrets held in Swarm/CI custody rather than on agent-reachable laptops, least-privilege cloud credentials. Documented residual risk, carried since §0 — no P1 control claims otherwise. |
| R12 | **Timing side channel on uniform responses.** Reject-before-read keeps the authz path to one indexed EXISTS before any tenant read, and bodies/status are uniform — but the Edge path makes no constant-time guarantee. | INSIDE | **Accepted residual:** the discriminating signal (one indexed lookup) is sub-ms and inside network jitter; §10 tests assert uniform status/body, not timing. The invite-capability path (§4), where enumeration matters most, is a single hash lookup on both the hit and miss branches by construction. |
| R13 | **Pooler protocol mismatch.** Supavisor transaction-mode multiplexing breaks named prepared statements and any session state assumed across statements; a misconfigured session-mode connection would also void the `SET LOCAL` discipline. | INSIDE | Unnamed/simple-protocol statements only, everything scoped to the single open tx; role-pinned `search_path` as backstop over `SET LOCAL`; `statement_timeout` so a stalled tx can't hold the stream-head lock past the client's idempotent retry window; P0 smoke test runs the full §3.2 path through the actual pooler, not a direct connection. |

Not registered here (owned by later phases, noted so nobody reads their absence as oversight): artifact provenance forgery (P2), pre-landing check bypass (P2), reservation abuse (P3), public-signup Sybil exhaustion (P5).

---

## SPEC GAPS

Consolidated list. Each is a decision for the operator, stated as a question with a recommended answer. #1–#8 were referenced inline in sections 0–4; #9–#18 are new.

**#1 — Where does `handle_command()` live?** §2.1 says "Edge Functions fronting a `handle_command()` transaction" without saying whether the transaction orchestrator is a PL/pgSQL function or TypeScript in the Edge Function. This blocks everything downstream: it decides whether `decide()` is *ported* (an authority fork — the two implementations will drift, and the drift surface is the security boundary) or *imported*. **Recommended:** TypeScript orchestrator in the `command` Edge Function holding one pooled Postgres transaction (§3.1); no PL/pgSQL reimplementation; plv8 rejected (not on hosted Supabase); decide-at-edge/append-via-RPC rejected (loses oracle↔append atomicity). Operator confirms or overrides.

**#2 — What mechanism governs the exposed read views?** §2.1 says "RLS governs explicitly exposed human READ views only" without naming the mechanism. On Postgres 15, `security_invoker = true` views apply the *underlying tables'* RLS — and every `swarm.*` table carries zero permissive policies, so security-invoker views return zero rows to everyone (self-DoS). Owner-pinned views bypass RLS and therefore need the predicate written in-view. **Recommended:** `swarm_admin`-owned views, each carrying `is_member(workspace_id, auth.uid())` in-view (§2.3), `security_barrier` where user input is filtered; RLS stays enabled with zero policies as the deny-by-default backstop. Amend §2.1's sentence to name this.

**#3 — Do P1 tasks carry claim kinds?** §2.4's evidence matrix and §2.5's close grants presume a task has a claim kind; no section says how a task acquires one or whether P1 tasks can. `decide()`'s `claimRequiresGrant`/`validCloseGrant` oracles need a defined P1 answer. **Recommended:** P1 tasks carry no claim kind; `claimRequiresGrant ≡ false`; the close-grant path is dormant but schema-ready (`grants.type` already includes `override-close`); the claim-kind column and P2 oracle flip arrive with §2.4's phase.

**#4 — What is a "stream-level command"?** §2.1's concurrency sentence reads "task version + lease epoch (stream-level `expected_seq` only for stream-level commands)" — but no section defines a stream-level command class, and nothing in §2.2/§2.5/§2.6 takes `expected_seq`. Risk: an implementer invents the field and forks the `Command` union to attach it. **Recommended:** record that no stream-level command class exists at P1 — concurrency is the stream-head lock (§5) plus epoch/version fencing — and strike or define the phrase in §2.1.

**#5 — Devices: global table or workspace-stream content?** §2.3 declares `devices` a global identity table (no `workspace_id`); §2.1 lists "devices" among workspace-stream contents. A workspace-stream event requires a `workspace_id` the device row does not have — direct contradiction. **Recommended:** P1 device register/revoke emits audit rows only (§3.4), with `my_devices` as the read surface. If device lifecycle must later be replayable to other members (the P3 board wants cross-member roster), decide then between per-workspace registration rows and per-membership fan-out events — do not retrofit a `workspace_id` onto the global table.

**#6 — Loopback redirect: exact-match registration vs random ports.** §2.3 (Kimi #5) requires both "a random high ephemeral loopback port with retry on collision" and "an exact-match registered loopback redirect." These conflict unless hosted GoTrue supports wildcard ports in redirect URLs. Blocks the login build. **Recommended:** verify on the actual Supabase project that the redirect-URL allowlist accepts a loopback wildcard; if it does not, pin one registered high port with a collision queue and keep copy/paste as the always-works path. Either way this is a P0 provisioning-inventory check, not a code assumption.

**#7 — Is refresh-reuse family revocation available and enabled?** §2.3 (Kimi #7) requires "replay of a rotated refresh token revokes the entire token family" — a GoTrue server capability, not something Swarm code can implement client-side. If the hosted plan doesn't expose it, a stolen refresh credential lives indefinitely (R4/R10). **Recommended:** confirm and enable refresh-token rotation with reuse detection in the project's auth settings; record in the P0 provisioning inventory; fallback if unavailable: swarm-side device↔session tracking plus a forced re-authentication interval.

**#8 — §2.2 does not bound lease TTL.** The table computes `lease expiry = now + ttl` with no maximum; Kimi #23 bounded payload bytes but nothing bounded lease duration. A compromised ≤1h token pinning a task for months defeats the lease's recovery story (takeover-grant friction on every task). **Recommended:** the P1 wrapper enforces `0 < ttl_ms ≤ 4h` (§3 step 6) — renewal is unlimited, so the bound only caps a dead agent's worst-case pin; amend §2.2 to state the bound. Operator confirms 4h as the ceiling.

**#9 — `occurred_at_server` representation.** The P0 envelope carries ms-epoch numbers; the §2.1 schema column is `timestamptz` (µs resolution). Golden replay fixtures and `StoredResponse` byte-equality need a deterministic conversion or replay comparisons drift on sub-ms noise. **Recommended:** write `timestamptz` from `statement_timestamp()`; emit envelope times as `date_trunc('milliseconds')` — ms-floor, never round; amend §2.1 with one line.

**#10 — Concurrent first-execution race on `(principal, command_id)`.** §2.1 defines retry and 409 semantics but not two *simultaneous first* submissions of one key: both miss the step-7 lookup (which runs before the head lock), one commits, and the loser's step-14 ledger INSERT hits the PK — currently an unmapped 500. **Recommended:** `INSERT … ON CONFLICT DO NOTHING RETURNING`; zero rows returned → re-read the stored row, hash-compare, and answer `replayed` or `409` exactly as the sequential path would; add the race to the §9 suite.

**#11 — `min_client_version` semantics.** §2.1 requires "minimum-supported-client version" but never says where the floor lives, that the client sends its version, or what a below-floor client receives; §3.2's `client_version` body field and step-15 response field are otherwise spec-orphans. **Recommended:** floor lives in `swarm.config('min_client_version')`; server semver-compares on every command; below floor → `426 {error:"upgrade_required", min_client_version}` + audit row; bumping the floor is an operator action in the release runbook.

**#12 — Credential wire formats.** §2.3/§7 say agent and invite tokens are "opaque, hashed at rest" without entropy, encoding, prefix, or *what exact string is hashed* — four interoperating implementations (CLI, Edge, board, docs) would otherwise diverge. **Recommended:** 32 bytes from a CSPRNG, base64url; prefixes `swm_agt_` / `swm_inv_`; sha256 over the full presented string including prefix; one line per credential added to §2.3/§7.

**#13 — Is `invitations.email` an authorization input?** §7 binds membership to the verified identity, "never inferred from an email match" — so the schema's `email` column must not gate acceptance, which also means a forwarded link works for any holder. Intended per the capability model, but unstated. **Recommended:** `email` is inviter-side bookkeeping and invite-page rendering only; acceptance ignores it; state this explicitly in §7 so a future hardening pass doesn't add an email-match check that quietly breaks link forwarding. (The alternative — email-bound invites — kills forwarding and is not recommended.)

**#14 — Membership revocation vs live leases.** §2.3 makes a revoked member's commands fail closed, but their live leases persist until TTL expiry, and no section says whether revocation force-ends leases — nor is there a system actor to emit such events. **Recommended:** lapse-by-TTL (bounded ≤4h by #8) plus the takeover grant for urgency; no system-actor events at P1. Board lanes render "revoked" from revocation state, not lease state.

**#15 — The `credentials` table and the GoTrue cascade.** §2.3 lists `credentials` among the global tables; the P1 schema has none (human sessions live entirely in GoTrue). Meanwhile `revoke_device` must cascade to the GoTrue refresh family, which requires the service key — which §2.2 forbade anywhere near the DB path. **Recommended:** no `swarm.credentials` table at P1 (amend §2.3's list or mark it GoTrue-internal); a separate auth-admin module in the Edge deployment holds the service key, scoped to GoTrue admin API calls only, never Postgres. State the split in §2.3.

**#16 — Does an agent act with its owner's role?** §2.2's close/reopen checks consult `ctx.role(caller)`; §2.6 binds roles to humans; §2.3 says token scopes ⊆ human rights. Unstated: the role an *agent* carries into role-gated transitions. "No" means no agent can ever reopen or admin-close even for an Owner — breaking owner-driven fleets; "yes" means an Owner's worker wields admin at task scope. **Recommended:** agents inherit their owner's role for §2.2 transitions, attenuated by the token denylist (which already bars `--force-discard` and the human-only operations); one line in §2.3.

**#17 — Audit-log retention.** §5 mandates the append-only audit log; Kimi #17 fixed idempotency retention at ≥30d; audit retention is unstated, and both R1 forensics and incident review consume it. **Recommended:** `swarm.events` retained forever (it is the authority); `audit_log` retained ≥1 year, then exported to storage archive rather than deleted; the pg_cron purge covers `idempotency_keys` (30d) and `rate_buckets` (hours) and never touches audit or events. Operator confirms the 1-year period.

**#18 — Is snapshot bootstrap in P1 scope?** §2.1 lists "paginated replay + snapshot bootstrap" as one machinery line; the P1 read surface (§2.3) defines only paginated replay. If snapshots are implicitly P1, the read proxy and §9 suite are under-built; if not, §2.1 over-promises. **Recommended:** replay-only at P1 (stream lengths are trivial at invited-beta scale); snapshot tables and format deferred to P3 alongside the board; amend §2.1's phrase to "paginated replay at P1; snapshot bootstrap at P3."
