# Lane A — server execution sessions (round 2)

Builder: Grok on `lane/identity-server-r2`, cut from `lane/agent-identity`
`5380a01`. Round 1 established the fence, opt-in, and typed session codes.
The Grok exact arm on `5380a01` FAILed because pending-surface and
session-bound deliveries were not on the wire. This round ships that
contract. Import every name from `src/cloud/session-wire.ts`; do not invent
a parallel client protocol.

The named arm path `docs/evidence/2026-09-06-agent-identity/arms-5380a01/grok.txt`
was missing in this worktree. The same report is at
`docs/evidence/2026-09-06-agent-identity/reviews-5380a01/grok.md` and was
pasted in the round-2 brief.

## Established

- Session tables `swarm.agent_execution_sessions` and
  `swarm.retired_agent_sessions` exist. `swarm_command` has SELECT/INSERT/UPDATE;
  `swarm_read` has SELECT. RLS policies match sibling tables.
- `swarm.agent_principals.managed_at timestamptz NULL` is set by
  `enable_agent_management` and cleared by `disable_agent_management` (human
  owner/admin, row-locked). The command and activity fences consult session
  tables only when `managed_at` is not null. Both reads take `FOR SHARE` in
  the command transaction (`agent_principals.managed_at`, then the session
  row). recover/enable/disable/acquire take `FOR UPDATE` on those rows, so a
  stale request cannot pass the fence and still write after a lifecycle
  change commits. The unmanaged skip is the locked `managed_at` value, not
  the caller's pre-lock `managedAt`.
- `swarm.agent_delivery_read_context` was dropped and recreated from the live
  20260906000010 body plus `managed_at`, with the same three privilege
  statements (OWNER swarm_admin, REVOKE ALL FROM PUBLIC, GRANT EXECUTE TO
  swarm_read).
- `swarm_read.agent_principals` was recreated with enumerated columns
  (principal_id, workspace_id, owner_user_id, name, created_at, revoked_at,
  model, managed_at). It does not project `wake_id`. A migration DO block and a
  server test refuse a `wake_id` column on that view.
- Sole agent-mutation exemption: `AGENT_SESSION_PROOF_EXEMPT_KINDS` in
  `src/cloud/session-wire.ts` is exactly `acquire_agent_session`. The command
  fence is `!isAgentSessionProofExempt(kind)`. A pure test derives every
  dispatched kind from the command edge (`COMMAND_KINDS`, exported `KIND`
  constants, and `handleTransaction` `kind ===` labels — not a fixed name
  list) and from the protocol `Command` / `WorkspaceCommand` unions. Every
  agent-issuable kind is fenced by `enforceAgentSessionProof` or listed in
  `AGENT_SESSION_PROOF_EXEMPT_KINDS`. A mutation that inserts a new direct
  handler fails the inventory.
- Activity (`supabase/functions/activity/index.ts`) is an agent mutation
  (broadcast in the principal's name) and uses the same fence when
  `managed_at` is not null.
- Private session key is a header (`x-cswarm-session-key`), never a command
  body field. Server stores SHA-256 as `bytea`.
- Duplicate display names: SQL unique name constraint dropped; default
  `create_agent_principal` still refuses; `allow_duplicate_name: true` creates
  a second principal; concurrent defaults take `pg_advisory_xact_lock` and
  produce exactly one row.
- Round 2 (`20260906000030`): `swarm.signal_deliveries` has `session_id`,
  `session_generation`, and `surfaced_at`. Claim on a managed principal copies
  the verified proof onto the row. Managed `queued` stays nonterminal until
  `surfaced_at`. ACK `observed` without `surfaced: true` is
  `delivery_not_surfaced`. Recovery reopens unsurfaced queued rows without
  incrementing `attempt_count`. Acquire retry with a changed host binding is
  `session_conflict`. `swarm_read` cannot select `key_hash`.
  `swarm_read.agent_principals` is revoked from `anon`. Read `is_live` treats
  NULL `expired_at` as dead. Re-enable `ON CONFLICT` writes the placeholder
  `session_id` it then retires. Server tests name `session_not_managed`,
  `session_already_managed`, and `session_leases_live`.

## Not established

- Live listener / CLI session context (Lane C, not this worktree).
- Site UUID pickers (Lane B).
- Interactive ACP/model factory (client lane, not this worktree).
- Production deploy, `db:push`, apply of `20260906000030`, or any call to
  `cloud-swarm-dev`.
- Exact host-conversation binding and capability handshake (client lane).
- Automatic sweeping of unrelated principals: not implemented, by design.

## Route inventory

### Command kinds — fenced when the principal is managed

Every agent-authenticated mutation except acquire. Inventory derived in
`tests/protocol-workspace.test.ts` from the dispatcher and from
`src/protocol` command unions, not a handwritten kind list ("every
agent-mutation kind the command edge dispatches is fenced or exempt"):

- task: `create`, `acquire`, `renew`, `handoff`, `takeover`, `submit`,
  `close`, `reopen`
- agent workspace: `declare_agent_model`, `submit_feedback`,
  `revoke_agent_token`, `renew_agent_token`
- signals / channels / receipts: `post_signal`, `channel_create`,
  `channel_rename`, `channel_archive`, `signals_seen`
- delivery: `claim_agent_inbox`, `ack_agent_delivery`
- files: `file_version_create`, `file_version_commit`, `file_download_url`,
  `file_tombstone`, `file_restore`
- session: `renew_agent_session`, `release_agent_session`

A newly added kind in that dispatcher is fenced unless it is added to
`AGENT_SESSION_PROOF_EXEMPT_KINDS`, and adding it there fails the exact-
membership test. A mutation control inserts `synth_unfenced_kind` as a
direct `handleTransaction` handler and shows the inventory extra-set
fails; the retired fixed-name regex does not see that kind.

### Command kinds — exempt

- `acquire_agent_session` only. It does its own row-locked check (retired UUID,
  live conflict, same UUID+key retry).

### Command kinds — human-only (no agent proof accepted as impersonation)

`HUMAN_ONLY_COMMANDS` plus pre-route human handlers. Agent credentials cannot
issue them. Session headers on a human request are ignored.

- `create_workspace`, `archive_workspace`, `invite_member`,
  `revoke_invitation`, `accept_invitation`, `remove_member`, `change_role`,
  `create_agent_principal`, `revoke_agent_principal`, `set_agent_model`,
  `mint_agent_token`
- session operator: `enable_agent_management`, `disable_agent_management`,
  `recover_agent_session`
- pre-route: `register_device`, `mint_capability_url`,
  `revoke_capability_url`, `resume_renewal_grant`

### Read (`supabase/functions/read/index.ts`)

Read-only. Role `swarm_read`. Authenticates `swm_agt_` via
`agent_delivery_read_context` (first-use stamp only). Does not call
`claimAgentInbox` or `ackAgentDelivery`. Members/identity may show
`managed_at` and public session fields. `whoami`-shaped identity is a read.

### Activity (`supabase/functions/activity/index.ts`)

Agent-authenticated mutation: `realtime.send` in the principal's name. Fenced
when `managed_at` is not null. Not exempt.

### Capability (`supabase/functions/capability/index.ts`)

Anonymous `swm_cap_` URL read. Role `swarm_capability`. Not agent-authenticated.
Mutates only `rate_buckets` (read counters), `audit_log`, and `security_alerts`
(surge/refusal accounting). Does not claim, ACK, or touch session tables.

## Typed error codes

From `src/cloud/session-wire.ts` `AgentSessionErrorCode`:

| code | HTTP |
|---|---|
| `session_proof_missing` | 401 |
| `session_proof_invalid` | 401 |
| `session_expired` | 401 |
| `session_retired` | 403 |
| `session_conflict` | 409 |
| `session_not_managed` | 403 |
| `session_already_managed` | 409 |
| `session_leases_live` | 409 |
| `delivery_not_surfaced` | 409 |

Tests assert `body.error` (the code), never `error.message` (D-053).

`ACK_AGENT_DELIVERY_SURFACED_FIELD` is `"surfaced"`.
`AGENT_SESSION_BINDING_FIELDS` is `provider`, `host_label`, `host_session_ref`.

## Pending-surface wire (round 2)

Delivery rows bind to the live execution session at **claim** time, from the
verified proof, never from the body.

`swarm.signal_deliveries` columns (migration `20260906000030`):

| column | meaning |
|---|---|
| `session_id uuid NULL` | Copied from the proof at claim when the principal is managed. |
| `session_generation integer NULL` | Copied with `session_id`. NULL iff `session_id` is NULL. |
| `surfaced_at timestamptz NULL` | Set when a managed principal ACKs `observed` with `surfaced: true`, or a terminal non-queued outcome. |

For a **managed** principal, `queued` is nonterminal until `surfaced_at` is
set. Recovery (`recover_agent_session`, a fresh acquire after expiry, and
`disable_agent_management`) clears `session_id` / `session_generation` /
lease on every row of that principal with `surfaced_at IS NULL`, including
rows already ACKed `queued`, and reopens those queued rows so a new holder
can claim them. `attempt_count` is not incremented for that queue-only
reclaim. Signal TTL still applies.

### claim_agent_inbox (managed)

Proof headers required (existing fence). The claim UPDATE writes
`session_id` and `session_generation` from the verified proof.

Stale generation: 409 `{ "error": "session_conflict" }`.

Expired proof: 401 `{ "error": "session_expired" }`.

### ack_agent_delivery (managed)

ACK body field `surfaced` is a closed boolean. Required for managed
`observed`. Ignored and optional for unmanaged.

Bare queued-to-observed (lease_id null, `surfaced` missing or false):

```
POST /functions/v1/command
Authorization: Bearer swm_agt_<43-char-synth>
x-cswarm-session-id: 00000000-0000-4000-8000-000000000021
x-cswarm-session-generation: 2
x-cswarm-session-key: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
{
  "command_id": "00000000-0000-4000-8000-000000000201",
  "client_version": "0.1.0",
  "workspace_id": "00000000-0000-4000-8000-000000000001",
  "stream": { "kind": "workspace" },
  "command": {
    "kind": "ack_agent_delivery",
    "signal_id": "00000000-0000-4000-8000-000000000301",
    "lease_id": null,
    "listener_instance_id": null,
    "outcome": "observed",
    "last_error_code": null
  }
}
```

Response 409: `{ "error": "delivery_not_surfaced" }`

Surfaced ACK after host injection (same proof as the row's
`session_id` + `session_generation`):

```
"command": {
  "kind": "ack_agent_delivery",
  "signal_id": "00000000-0000-4000-8000-000000000301",
  "lease_id": null,
  "listener_instance_id": null,
  "outcome": "observed",
  "last_error_code": null,
  "surfaced": true
}
```

Response 200: `{ "ok": true, "status": "accepted", "outcome": "observed" }`
and `surfaced_at` is set.

Queued pending-surface (not yet injected): `"outcome": "queued"` with the
live `lease_id` and `"surfaced": false`. Does not set `surfaced_at`.

### Unmanaged ACK (positive control)

No session headers. No `surfaced` field. Today's queued-to-observed
promotion still returns 200 and leaves `session_id` / `surfaced_at` NULL.

### acquire retry binding

Same live UUID+key with a different `provider` / `host_label` /
`host_session_ref` is 409 `{ "error": "session_conflict" }`. Same binding
retries 200 with the same generation.

### key_hash

`swarm_read` has no column privilege on `swarm.agent_execution_sessions.key_hash`.
`swarm_read.agent_execution_sessions` does not project it. `read/index.ts`
joins the view. NULL `expired_at` is dead (`is_live` matches the fence).

## Synthetic request/response examples

All UUIDs, keys, and tokens below are synthetic. The private key is 32 random
bytes, base64url, 43 characters. Headers are never logged.

### enable_agent_management (human owner/admin)

Request:

```
POST /functions/v1/command
Authorization: Bearer <human jwt>
{
  "command_id": "00000000-0000-4000-8000-000000000101",
  "client_version": "0.1.0",
  "workspace_id": "00000000-0000-4000-8000-000000000001",
  "stream": { "kind": "workspace" },
  "command": {
    "kind": "enable_agent_management",
    "principal_id": "00000000-0000-4000-8000-000000000010"
  }
}
```

Response 200: `{ "ok": true, "status": "accepted" }`

Already managed: 409 `{ "error": "session_already_managed" }`

Live legacy delivery leases: 409 `{ "error": "session_leases_live" }`

### acquire_agent_session (agent; sole exemption)

Request (key in header, not body):

```
POST /functions/v1/command
Authorization: Bearer swm_agt_<43-char-synth>
x-cswarm-session-id: 00000000-0000-4000-8000-000000000021
x-cswarm-session-key: AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA
{
  "command_id": "00000000-0000-4000-8000-000000000102",
  "client_version": "0.1.0",
  "workspace_id": "00000000-0000-4000-8000-000000000001",
  "stream": { "kind": "workspace" },
  "command": {
    "kind": "acquire_agent_session",
    "session_id": "00000000-0000-4000-8000-000000000021"
  }
}
```

Response 200: `{ "ok": true, "status": "accepted", "generation": 2 }`

Unmanaged: 403 `{ "error": "session_not_managed" }` (does not opt in)

Live other session: 409 `{ "error": "session_conflict" }`

Retired UUID: 403 `{ "error": "session_retired" }`

Same UUID+key retry while live, same host binding: 200, same generation.

Same UUID+key retry with a different `provider` / `host_label` /
`host_session_ref`: 409 `{ "error": "session_conflict" }`.

### renew_agent_session

Headers: all three proof fields. Body `session_id` + `generation` must match
headers. 200 `{ "ok": true, "status": "accepted" }`. Expired: 401
`session_expired`.

### release_agent_session

Same proof. 200 `{ "ok": true, "status": "accepted" }`. Retires the UUID.
Writes stop immediately. History is kept.

### disable_agent_management (human owner/admin)

Revokes the current session, clears `managed_at`, reclaims unsurfaced leases.
200 `{ "ok": true, "status": "accepted", "warning": "legacy writes resume" }`.

### recover_agent_session (human owner/admin)

Retires the UUID, increments generation, leaves `managed_at` set, reclaims
unsurfaced leases without incrementing `attempt_count`. 200
`{ "ok": true, "status": "accepted" }`. Unmanaged: 403 `session_not_managed`.

### Managed mutation missing/wrong proof

`post_signal` / `claim_agent_inbox` / `ack_agent_delivery` / activity with no
headers: 401 `{ "error": "session_proof_missing" }`.

Wrong key: 401 `{ "error": "session_proof_invalid" }`.

Wrong generation or another principal's session: 409
`{ "error": "session_conflict" }`.

Expired session: 401 `{ "error": "session_expired" }`.

### Unmanaged positive control

`post_signal` with a live agent token and no session headers: 200
`{ "ok": true, "status": "accepted", "signal": { ... } }`. No session-table
query.

## Client changes this lane needs

- Send `x-cswarm-session-id`, `x-cswarm-session-generation`,
  `x-cswarm-session-key` on every managed mutation, including activity,
  `renew_agent_token`, claim, and ACK. Import names from
  `src/cloud/session-wire.ts`.
- ACK `observed` for a managed principal must send `surfaced: true` after
  host injection. A bare queued-to-observed promotion is
  `delivery_not_surfaced`. Import `ACK_AGENT_DELIVERY_SURFACED_FIELD` and
  `DELIVERY_NOT_SURFACED_CODE`.
- Acquire retries must resend the same `provider` / `host_label` /
  `host_session_ref`. Import `AGENT_SESSION_BINDING_FIELDS`.
- Generate the 32-byte key before acquire; never ask the server to return it.
- Treat `session_not_managed` on acquire as "operator must enable", not as
  silent opt-in.
- `create_agent_principal` may send `allow_duplicate_name: true` only after an
  explicit operator choice.
- Replay a lost mutation with the same `command_id` and body plus the
  **current** proof. Old proof cannot read the stored result.

## Gates

| command | result |
|---|---|
| `npm run build` | pass (tsc) |
| `npm run check:tests` | pass |
| `npm run check:edge` | 0 Deno errors (command, read, capability, activity) |
| `npm test` | 922 pass / 0 fail / 26 suites |
| `npm run test:p1-server` | full serial glob after `db:reset`: 177 pass / 0 fail (264.9s). Includes `managed-delivery.test.ts` and the new typed-code tests in `agent-execution-sessions.test.ts`. |
| `npm run test:p1-local` | 48 pass / 0 fail (107.8s). |

A previous builder's "Gaps: None" is retired. Round-1 `test:p1-server` flake note (10 fails in `command.test.ts` when globbed) was not reproduced on this SHA.
