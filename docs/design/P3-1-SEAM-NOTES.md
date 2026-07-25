# P3-1 Phase A seam notes: signal plane

**Status:** Phase A analysis only at `2a01592`. No implementation, migration, or
CLI change is authorized by this document.

**Ruling:** `post_signal` belongs inside the existing Edge command transaction
envelope, but it touches **neither** the pure task `decide()` core **nor**
`decideWorkspace()`. It is a third, direct append branch. Routing an immutable
signal through either reducer would require inventing a transition/event/projection
for a value that deliberately has no lifecycle state. That would recreate the
structure removed by the communication-first steer
(`SUCCESSION-PLAN.md:688-708`, `SUCCESSION-PLAN.md:728-755`).

Three source-backed Phase B gates also fell out of the trace:

1. Human reads exist, but the agent Edge read proxy is specified only in design
   prose and is absent from the repository. Agent polling cannot pass the FLOOR
   through PostgREST with a custom `swm_agt_…` bearer.
2. The durable pending-`command_id` helper is human-profile/connect-command
   specific. It does not currently preserve an agent signal's command id across
   a transport-ambiguous CLI retry.
3. The current default/fixture agent scopes do not include `post_signal`, while
   the Edge command envelope rejects any agent command absent from its token
   scopes.

Phase B must resolve all three without loosening identity, tenancy, or read
authority.

## 1. Write seam: neither reducer

### What the code does today

- The Edge bundle imports task `applyCommand`/`reduceTask` and workspace
  `decideWorkspace`/`reduceWorkspace` as distinct paths
  (`supabase/functions/command/index.ts:1-14`).
- Its accepted wire union contains task commands and connect commands only
  (`supabase/functions/command/index.ts:22-71`).
- At transaction step 9 it branches connect commands into
  `prepareWorkspaceCommand`; every other accepted command is assumed to be a
  task command and loads a `swarm.tasks` projection
  (`supabase/functions/command/index.ts:2304-2350`).
- At step 10 the connect branch calls `decideWorkspace`; the other branch calls
  `applyCommand`, which calls task `decide`
  (`supabase/functions/command/index.ts:2353-2426`,
  `src/protocol/idempotency.ts:92-111`).
- The task core is explicitly a decision over a task projection and emits
  canonical task events (`src/protocol/commands.ts:107-126`). The workspace
  core is explicitly a decision over workspace authority state
  (`src/protocol/workspace-commands.ts:243-251`) and requires a current member
  before its authority-command switch
  (`src/protocol/workspace-commands.ts:327-332`).
- The remaining shared path assumes reducer output: append events, bump a stream
  head, fold either the workspace or task projection, and apply event side
  effects (`supabase/functions/command/index.ts:2443-2473`).

The non-binding “like connect commands” lean is therefore only half right.
Connect commands do ride the common envelope beside task `decide()`, but they
are **not reducer-free**: they call `decideWorkspace()` and fold workspace
events. Signals must not copy that part.

### Chosen branch

Add `post_signal` as a third validated command class inside
`handleTransaction()`:

1. Reuse body bounds, credential verification, server-derived `AuthContext`,
   workspace routing, revocation, client-version checking, agent-scope checking,
   idempotency lookup, final ledger write, and audit.
2. After an idempotency miss, atomically enforce the signal rate buckets and
   revalidate any `to` target as a live member of the already-resolved
   workspace.
3. Insert exactly one `swarm.signals` row. Generate `id`, `from`, defaults for
   `until`, and `created_at` on the server.
4. Store and return a signal response from the same transaction.

The signal branch does **not** load a task or workspace projection, lock or bump
`streams.head_seq`, append `swarm.events`, call either reducer, or run event
side effects. The resolved workspace stream can still supply the non-null
`stream_id` already required by `swarm.idempotency_keys`
(`supabase/migrations/20260723000001_p1_schema.sql:366-378`); using that routing
identity does not make the signal a stream event.

The new private table needs the existing authority posture applied to the new
object: owner `swarm_admin`, RLS enabled, a policy/grants only for
`swarm_command`, and no direct `anon`/`authenticated` access. Grant only the
`SELECT`/`INSERT` needed by this branch; grant no update/delete and apply the
existing append-only trigger pattern used for events/audit
(`supabase/migrations/20260723000001_p1_schema.sql:553-593`). Immutability is
therefore a database privilege/backstop as well as an absent CLI verb.

The existing `StoredResponse` parser requires `event_ids` and preserves only a
fixed set of response fields (`supabase/functions/command/index.ts:936-962`).
Phase B must extend the stored/replayed response to retain the server-generated
signal id/record (with `event_ids: []` if the common response contract keeps
that field). Otherwise a retry can prove that a post happened but cannot
narrate what was recorded.

`requestHash()` is mechanically suitable because it hashes the namespaced,
server-derived principal plus canonical command JSON
(`src/protocol/idempotency.ts:28-44`), but its TypeScript input is currently the
task `Command` union. Generalize the type boundary for a validated non-task
command without routing the command through `applyCommand()`. This can be a
type-only core change; it does not justify runtime bundle drift.

## 2. What the command envelope gives for free

“Inherited” below means “obtained by keeping `post_signal` in
`handleTransaction()` at the same check boundary.” It does not mean the new
branch needs zero glue.

| Concern | Inherited | Must be built for signals |
|---|---|---|
| Credential authentication and principal derivation | **Yes.** Bearers are classified and human JWTs are verified before the transaction (`supabase/functions/command/index.ts:2627-2678`). Agent tokens are hash-looked-up through token → principal → run → device and stamp user/principal/run from those rows (`supabase/functions/command/index.ts:985-1020`); human auth stamps the verified user id (`supabase/functions/command/index.ts:1023-1047`). | Add `post_signal` to the allowed agent-scope story. The envelope refuses commands absent from an agent token's scopes (`supabase/functions/command/index.ts:2217-2237`), while both normal defaults (`supabase/functions/command/index.ts:305-314`) and fixture scopes (`src/cloud/seed.ts:6-15`, `src/cloud/seed.ts:233-250`) omit it. |
| Tenancy and revocation (pin 1) | **Yes.** `resolveRoute` requires the requested workspace, enforces an agent principal's single workspace, and resolves a membership/stream inside it (`supabase/functions/command/index.ts:1050-1116`). The transaction refuses a missing route uniformly, then checks revoked membership/token/principal/run/device/tombstones before command effects (`supabase/functions/command/index.ts:2105-2149`). | The signal command must always request the workspace stream and must server-recheck `to` against live co-members of `route.workspaceId`. No invitation-capability carve-out applies. |
| Server idempotency ledger (pin 9) | **Mostly.** The existing transaction looks up `(principal_kind, principal_id, command_id)` before state/effects (`supabase/functions/command/index.ts:2255-2290`), inserts the response atomically (`supabase/functions/command/index.ts:2475-2501`), and resolves concurrent insert races by replay/conflict (`supabase/functions/command/index.ts:2567-2603`). The table/retention substrate already exists (`supabase/migrations/20260723000001_p1_schema.sql:366-381`). | Extend the validated hash/response shape for `post_signal`; insert signal + ledger row in one transaction. On the client, extract/generalize the existing pending-intent helper: today it accepts only `ConnectCommand` and a human `CredentialStore` session (`src/cloud/pending-command.ts:17-31`, `src/cloud/pending-command.ts:75-108`). Agent mode currently reads a token from stdin and has no human profile session (`src/cli.ts:958-982`), so durable ambiguous-retry recovery for agent posts is not inherited. Do not invent a second server idempotency scheme. |
| Audit (pin 8) | **Yes, if the branch stays in the envelope.** `insertAudit` stamps actor, credential, device, command, route, outcome, hash, and sanitized detail (`supabase/functions/command/index.ts:621-645`). Existing validation/authz/replay/fresh outcomes call it throughout the transaction, including the final atomic ledger/audit step (`supabase/functions/command/index.ts:2502-2515`). | Call the same helper for signal validation, targeting refusal, rate refusal, replay/conflict, accepted post, and errors. A separate endpoint would have to duplicate this and is rejected. |
| Rate/fairness (pin 13) | **Storage and privileges only.** `swarm.rate_buckets(bucket_key, window_start, count)` exists (`supabase/migrations/20260723000001_p1_schema.sql:416-421`); `swarm_command` has insert/update/select (`supabase/migrations/20260723000001_p1_schema.sql:748-775`) and old windows are purged (`supabase/migrations/20260723000001_p1_schema.sql:821-849`). | **All enforcement logic.** There is no `rate_buckets` reference anywhere under `supabase/functions/` or `src/` at this commit. Phase B must implement atomic per-credential and per-workspace increments, limits, reset narration, 429 audit/alert behavior, and tests. For a human the available stable credential identity is the verified user; for an agent it is `AuthContext.credentialId = token_id`, not the broader agent principal (`supabase/functions/command/index.ts:1009-1017`, `supabase/functions/command/index.ts:1040-1047`). |
| Forged identity fields / pin 16 | **Credential derivation is inherited; `from` rejection is not.** Existing top-level `actor_user`, `actor_agent_principal`, `actor_run`, `device`, and `device_id` are ignored and audit-noted (`supabase/functions/command/index.ts:523-534`), and T-02 proves they cannot alter stored event authors (`tests/p1-server/command.test.ts:755-791`). | The current list does not include `from`, the outer request type permits arbitrary keys (`supabase/functions/command/index.ts:351-358`), and no signal validator exists. Phase B must make `command.from` an extra/invalid key and must reject or explicitly ignore+audit a top-level `from`; no header may override it. The stored value must be assigned only from `canonicalPrincipal(auth.actor)`. |

The server ledger is stronger than the client pending helper and both are
required: the ledger prevents duplicates once a stable id reaches the server;
the pending helper is what makes the same stable id survive an ambiguous
transport retry.

## 3. Read view: exact predicate and one missing transport

The table needs an internal tenant key even though the public shape abbreviates
it. The human read projection should be:

```sql
CREATE VIEW swarm_read.signals
WITH (security_barrier = true)
AS
  SELECT
    s.id,
    s.workspace_id,
    s.from_principal AS "from",
    s.to_user_id AS "to",
    s.about,
    s.kind,
    s.body,
    s.until,
    s.created_at
  FROM swarm.signals AS s
  WHERE swarm.is_member(s.workspace_id, auth.uid())
    AND (s.to_user_id IS NULL OR s.to_user_id = auth.uid());
```

This uses the existing authorization predicate **unchanged**. `swarm.is_member`
is a live-membership existence check
(`supabase/migrations/20260723000001_p1_schema.sql:595-615`), and every current
tenant read view uses that same owner-pinned, security-barrier pattern
(`supabase/migrations/20260723000001_p1_schema.sql:617-675`). The second clause
is an addressing visibility restriction that only narrows already-authorized
tenant rows; it is not a new tenant-authorization function and cannot widen
access.

Do not put `until > now()` in the view. `feed` adds that read-time filter by
default and removes it for `--include-stale`; `inbox` adds `to = auth.uid()`.
Both remain bounded client queries over the same view. A sender is not included
merely because they sent a directed signal: the brief defines feed as broadcasts
plus signals addressed to the reader. The post response is the sender's receipt.

As with the P2-2 views, the migration must owner-pin the new view to
`swarm_admin`, explicitly grant `SELECT` to `authenticated, swarm_read`, and
revoke anon. The old `GRANT SELECT ON ALL TABLES IN SCHEMA swarm_read` only
covered objects that existed then
(`docs/design/P2-2-SEAM-NOTES.md:119-128`).

### Agent polling is not implemented yet

Human reads can use the existing PostgREST helper, which sends a verified human
JWT plus `Accept-Profile: swarm_read`
(`src/cloud/workspaces.ts:196-235`). A custom `swm_agt_…` token is not a GoTrue
JWT, so it cannot make `auth.uid()` non-null through that path.

The already-approved P1 architecture says humans read the views and agents use
an Edge read proxy while sharing `swarm.is_member`
(`docs/design/P1-COMMAND-API.md:300-316`); for every agent request the proxy must
rehash/authenticate the token, derive the principal, resolve tenancy, and
recheck revocation (`docs/design/P1-COMMAND-API.md:616-624`). Repository
inventory at `2a01592` contains only
`supabase/functions/command/index.ts`; no `read` function or read endpoint
exists.

Therefore the P3-1 FLOOR requirement that an agent can poll is a real Phase B
scope item, even though §4's deliverable list did not name it. The narrow seam
is the already-designed Edge read proxy, not `service_role`: authenticate and
revoke-check with the same credential-row logic, derive the owner user id
server-side, then execute `swarm_read.signals` under read-role/request-claim
context so the same `auth.uid()`/`is_member` predicate runs. It must not query
the private table under a looser hand-written filter. Agent-principal targeting
remains out of v1, so an agent's inbox identity is its credential-derived owner
member user id.

## 4. Hosted exposure

Hosted already accepts `swarm_read` as an exposed PostgREST schema. P2-2
recorded the surgical Management API patch and its exact value
(`docs/evidence/p2-status-workspaces.md:40-70`), while local config names
`swarm_read` in the exposed schema list
(`supabase/config.toml:7-15`).

I reran a read-only hosted canary on 2026-07-24 using the repository's hosted
URL/anon key:

```text
workspaces      status=401 code=42501
member_profiles status=401 code=42501
memberships     status=401 code=42501
```

That is a positive schema-exposure control: the requests reached all three
`swarm_read` resources and were denied to anon. The prior unexposed failure was
`406 PGRST106`, not `401 42501`
(`docs/evidence/p2-status-workspaces.md:42-69`).

**Conclusion:** a new view inside the already-exposed `swarm_read` schema needs
no further `PATCH /v1/projects/{ref}/postgrest` and no hosted config change.
Phase B must apply the linked migration (including the explicit view grant),
then post one signal and read that same row back before trusting any empty-list
assertion. If DDL ever leaves PostgREST's schema cache stale, the surgical
recovery is `NOTIFY pgrst, 'reload schema'`
([PostgREST schema-cache documentation](https://postgrest.org/en/stable/references/schema_cache.html));
it is not a schema-list change.

Never run `supabase config push`. The repository config contains scaffold auth
defaults while hosted contains the wildcard loopback allowlist and enabled
GitHub provider; the documented overwrite would break PKCE
(`docs/evidence/p2-status-workspaces.md:72-94`).

## 5. Every client-influence point for `from`

Pin 16 needs defense at each boundary, not merely a safe database assignment:

1. **CLI grammar.** `Arguments` parses arbitrary flag names, but each verb's
   `assertShape` rejects flags outside its allowlist
   (`src/cli.ts:96-159`). The five signal verbs must never list `from`; a
   `--from` attempt must fail before network I/O.
2. **Typed client request.** Existing command clients serialize the caller's
   `command` object verbatim into the body
   (`src/cloud/command-client.ts:183-203`,
   `src/cloud/command-client.ts:262-297`). The signal request type must omit
   `from`; its serializer should construct the exact allowed object rather than
   spreading arbitrary input.
3. **Direct HTTP body.** Types do not protect curl. Existing command validation
   first recognizes a kind and then uses `exactKeys` for each accepted shape
   (`supabase/functions/command/index.ts:666-715`; for example,
   `supabase/functions/command/index.ts:717-755`). `post_signal` must use the
   same exact-key rule, with no `from`, `actor_*`, principal, credential, or
   created-time input.
4. **Outer envelope.** The request body has an index signature and the current
   forged-field detector does not name `from`
   (`supabase/functions/command/index.ts:351-358`,
   `supabase/functions/command/index.ts:523-534`). Cover a top-level `from`
   explicitly. Whether the established actor-field behavior remains
   ignore+audit or signal `from` fails validation, neither path may consume the
   value.
5. **Headers.** The client controls which bearer it presents; that is the one
   intended way it selects an identity. The server verifies that bearer and
   derives the principal (`supabase/functions/command/index.ts:2627-2678`).
   No `X-From`, forwarded identity, API-key field, or display-name header may
   participate.
6. **Database insert/defaults.** Assign `from` in the insert from
   `canonicalPrincipal(auth.actor)` only. That function deliberately chooses
   the agent principal when present and otherwise the verified user id
   (`src/protocol/events.ts:14-30`). The command role is the write boundary;
   PostgREST roles have no direct authority-table access
   (`supabase/migrations/20260723000001_p1_schema.sql:702-715`).
7. **Names and rendering.** Human display names originate in identity-provider
   metadata before being sanitized/upserted
   (`supabase/functions/command/index.ts:2659-2678`,
   `supabase/functions/command/index.ts:1027-1047`). Agent names are
   human-supplied command data (`supabase/functions/command/index.ts:748-754`).
   Both are labels, not authorship. Reads/rendering must retain the authoritative
   full principal id (and enough server-derived kind information to distinguish
   human from agent); never store or compare a display name as `from`.
8. **Replay and narration.** A replay must return the stored server-authored
   signal response, not reconstruct a response from the retry body. The
   idempotency lookup already returns the stored response
   (`supabase/functions/command/index.ts:2271-2288`); extend that response
   parser as noted in §1.

The launch-gate test must exercise both credentials and both smuggling
locations: direct HTTP posts with `from` inside `command` and at the top level,
once under a human JWT and once under an agent token. A successful case must
read the stored row back and prove the author is the credential's canonical
principal. A rejected case must prove zero signal rows. Existing T-02 is the
positive control that this style of forged-field test can detect a regression
(`tests/p1-server/command.test.ts:755-791`).

## 6. Workspace selection and recipient resolution

Signal verbs should call `commandWorkspaceAndCredential()` unchanged. For
humans it delegates to the five-step resolver: flag/env short-circuit, then
live saved default, sole live membership, or deterministic fail-closed list
(`src/cli.ts:359-380`, `src/cloud/workspaces.ts:531-593`). For agents it accepts
only `--workspace-id` or `SWARM_CLOUD_WORKSPACE_ID` and refuses to infer a human
profile default (`src/cli.ts:958-982`). This exactly preserves the P2-2/G9
contract.

The server then independently enforces that workspace through `resolveRoute`;
client resolution is UX, not authority. Signals use `{kind:"workspace"}` only.

`--to` may use the existing membership-gated `member_profiles` read shape,
which returns user ids, sanitized display names, and roles for the selected
workspace (`src/cloud/workspaces.ts:308-361`). Exact UUID or exact display-name
resolution must fail closed on ambiguity. Regardless of client resolution, the
command transaction must recheck that the final user id is a live member of
the resolved workspace immediately before insert; a stale client directory
cannot authorize a target.

For an agent post, the server can perform that same co-member resolution after
agent-token auth, or the new agent read proxy can supply the gated directory.
It may not fall back to a global user lookup or `service_role`.

## 7. `inbox_deliveries` is deliberately unused

`swarm.inbox_deliveries` is a P1 substrate with delivery and ack timestamps
(`supabase/migrations/20260723000001_p1_schema.sql:423-432`). P3-1 v1 does not
write it. `coswarm inbox` is a query over `swarm_read.signals`; there is no
push, delivery queue, or ack state. This is a deliberate poll-first product
choice, not an overlooked empty table. Push may later dual-write or add a
transport layer without changing immutable signal rows.

## 8. Verification performed

- `npm run test:p1-server`: **12/12 passed**, including cross-tenant uniformity,
  P2-2 view predicates, forged actor fields, replay/conflict, and the connect
  reducer path. Durable log:
  `~/.swarm/evidence/9a518dee-016e-48bb-ac28-4d29ea2f826c/p3-1-phase-a-seam/run-001.log`.
- Rebuilt the checked-in command core as the suite's pretest step: zero protocol
  bundle diff.
- A final mechanical pass resolved all 71 local `file:line` references, required
  all requested conclusions, and found no trailing whitespace. Durable log:
  `~/.swarm/evidence/9a518dee-016e-48bb-ac28-4d29ea2f826c/p3-1-phase-a-seam/run-004.log`.
- Source-inventory negative probes had positive controls:
  `rate_buckets` was found in the migration/grants but nowhere in
  `supabase/functions/` or `src/`; the command function was found under
  `supabase/functions/`, while no read function was present.
- Hosted read-only positive canary returned `401 42501` for three existing
  `swarm_read` views, distinguishing exposed-but-anon-denied from the historical
  `406 PGRST106`.

Phase B should not start until Lead + Sable explicitly clear the three gates at
the top of this document and the chosen neither-reducer branch.
