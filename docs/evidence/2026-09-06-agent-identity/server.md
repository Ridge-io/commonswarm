# Lane A — server execution sessions (fix-up)

Builder: Grok, taking over from a Gemini run that landed grants (2525d1a),
null handling (f994c22), and the protocol bundle (1f8a31e), then stopped.
Branch: `lane/identity-server`. This file replaces the earlier "Gaps: None"
claim, which was false: grants were missing until 2525d1a, `check:edge` was
red until f994c22, the bundle was stale until 1f8a31e, the exemption set was
not exported, activity was unfenced, unmanaged principals paid a session-table
query on every command, and the two mega-tests did not isolate the Lane A
items.

## Established

- Session tables `swarm.agent_execution_sessions` and
  `swarm.retired_agent_sessions` exist. `swarm_command` has SELECT/INSERT/UPDATE;
  `swarm_read` has SELECT. RLS policies match sibling tables.
- `swarm.agent_principals.managed_at timestamptz NULL` is set by
  `enable_agent_management` and cleared by `disable_agent_management` (human
  owner/admin, row-locked). The command and activity fences consult session
  tables only when `managed_at` is not null.
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
  fence is `!isAgentSessionProofExempt(kind)`. A pure test enumerates every
  agent-mutation kind the command edge dispatches and fails closed on a new
  kind.
- Activity (`supabase/functions/activity/index.ts`) is an agent mutation
  (broadcast in the principal's name) and uses the same fence when
  `managed_at` is not null.
- Private session key is a header (`x-cswarm-session-key`), never a command
  body field. Server stores SHA-256 as `bytea`.
- Duplicate display names: SQL unique name constraint dropped; default
  `create_agent_principal` still refuses; `allow_duplicate_name: true` creates
  a second principal; concurrent defaults take `pg_advisory_xact_lock` and
  produce exactly one row.

## Not established

- Live listener / CLI session context (Lane C, not this worktree).
- Site UUID pickers (Lane B).
- Production deploy, `db:push`, or any call to `cloud-swarm-dev`.
- Whether `npm run test:p1-server` is green on this SHA: recorded below only
  after that gate finishes. A previous builder's "Gaps: None" is retired.
- Exact host-conversation binding and capability handshake (client lane).
- Automatic sweeping of unrelated principals: not implemented, by design.

## Route inventory

### Command kinds — fenced when the principal is managed

Every agent-authenticated mutation except acquire. Inventory frozen in
`tests/protocol-workspace.test.ts` ("every agent-mutation kind the command
edge dispatches is fenced or exempt"):

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
membership test.

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

Tests assert `body.error` (the code), never `error.message` (D-053).

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

Same UUID+key retry while live: 200, same generation.

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
| `npm test` | 903 pass / 0 fail / 26 suites |
| `npm run test:p1-server` | full serial glob: 156 pass / 10 fail / 166 tests (192.5s). All 10 fails are in `tests/p1-server/command.test.ts` and all 10 passed when that file ran alone: 72 pass / 0 fail (140.5s). The 10 were file-seam flakes (`functions serve` zombie / 502 "invalid response from the upstream server" / `SWARM_SELF_SERVE` not on the leftover worker). Lane A session tests: 11 pass / 0 fail. |

A previous builder's "Gaps: None" is retired. This file is the inventory.
