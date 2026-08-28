# Delivery receipt PostgreSQL repair — 2026-08-28

Scope: local Supabase/PostgreSQL only. Nothing here was committed, pushed,
applied to production, or deployed.

## RED: reproduced before the fix

The local stack was running. `npm run db:migrate` applied
`20260828000001_signal_delivery_receipts.sql`. The function resolved to owner
`swarm_admin` with `search_path=pg_catalog`.

The agent-path call ran as `swarm_read`, supplied a non-null 32-byte agent hash,
and installed no human JWT claims:

```sql
SET ROLE swarm_read;
SELECT swarm_read.signal_delivery_receipts(
  '11111111-1111-4111-8111-111111111111'::uuid,
  '22222222-2222-4222-8222-222222222222'::uuid,
  decode(repeat('00', 32), 'hex')
);
```

PostgreSQL returned:

```text
ERROR:  42501: permission denied for schema auth
LINE 1: auth.uid()
        ^
QUERY:  auth.uid()
CONTEXT:  PL/pgSQL function swarm_read.signal_delivery_receipts(uuid,uuid,bytea)
          line 3 during statement block local variable initialization
LOCATION:  aclcheck_error, aclchk.c:2843
```

The local privilege check also returned
`has_schema_privilege('swarm_admin','auth','USAGE') = false`. This establishes
the reported cause. The failure happened before the agent credential branch.

## Fix

Forward migration:

```text
supabase/migrations/20260828000002_fix_signal_delivery_receipts_auth.sql
```

The already-applied `20260828000001` migration was not edited.

The replacement function:

- reads the human `sub` from `request.jwt.claims` with
  `current_setting(..., true)`;
- gets `NULL` when the GUC is absent, so the agent branch runs;
- does not call `auth.uid()` or need `USAGE` on `auth`;
- uses `SET search_path = swarm, pg_catalog`, matching
  `swarm.agent_delivery_read_context`;
- keeps both author predicates and the workspace predicate.

After `npm run db:migrate`, PostgreSQL showed version `20260828000002` applied
locally. The function still belongs to `swarm_admin`, retains only the intended
execute grants, and has `search_path=swarm, pg_catalog`.

## GREEN: real PostgreSQL paths

`tests/p1-local/delivery-receipts-postgres.test.ts` creates a transaction-local
workspace, human, three agent principals, two valid agent tokens, and three
signals. It invokes the function under `swarm_read` and `authenticated`, then
rolls the fixture back.

Measured result:

```text
✔ delivery receipts work for agent, human, broadcast, and cross-sender paths
tests 1
pass 1
fail 0
```

The four asserted results were:

| path | result |
|---|---|
| agent-authored addressed signal, author token | `addressed=true`, one receipt for the recipient |
| human-authored addressed signal, matching JWT `sub` | `addressed=true`, one receipt for the recipient |
| agent-authored broadcast | `addressed=false`, `receipts=[]` |
| same-workspace different sender token | SQL `NULL` |

The existing non-author mutation control was moved to the forward migration and
rerun:

```text
✔ cross-sender mutation control pins caller kind, author id, and workspace
tests 1
pass 1
fail 0
```

## Required gate tails

```text
npm run build
exit 0

npm test
tests 638
pass 638
fail 0

npm run test:p1-cli
tests 337
pass 337
fail 0

npm run check:tests
exit 0

npm run check:edge
Check supabase/functions/command/index.ts
Check supabase/functions/read/index.ts
Check supabase/functions/capability/index.ts
exit 0
```

The first `test:p1-cli` run hit the already-documented two-poll/two-second fake
server race in `signals.test.ts`. Both two-poll ceilings are now six seconds.
The isolated control and the full gate pass.

## Not established

- The forward migration is not applied to production.
- No edge function was deployed.
- No production receipt lookup was rerun after the local fix.
- The local proof calls PostgreSQL directly under the production roles; it does
  not start and call the local `read` edge function over HTTP.
