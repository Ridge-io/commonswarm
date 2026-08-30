# Delivery receipt cross-sender mutation — rerun 2026-08-29

Target: `supabase/migrations/20260829000001_member_signal_delivery_receipts.sql`

The source control is `agent cross-sender mutation control pins author id and workspace` in
`tests/delivery-receipts.test.ts`. The root `npm test` script names that file literally.
The real-Postgres control is `delivery receipt authorization matrix holds on real Postgres` in
`tests/p1-local/delivery-receipts-postgres.test.ts`. `npm run test:p1-local` names that file
literally.

## RED

Temporary mutation: replace the agent side of the human-or-agent lookup with a principal-presence
check. This removes both author predicates while leaving the workspace predicate and agent
credential checks intact:

```sql
AND (
  v_human_user_id IS NOT NULL
  OR v_agent_principal_id IS NOT NULL
)
```

The mutated migration was applied to the real local Postgres container. No remote database was
used:

```sh
docker exec -i supabase_db_cloud-swarm psql -U postgres -d postgres -v ON_ERROR_STOP=1 \
  < supabase/migrations/20260829000001_member_signal_delivery_receipts.sql
node --import tsx --test --test-name-pattern='agent cross-sender mutation control' \
  tests/delivery-receipts.test.ts
node --import tsx --test --test-name-pattern='delivery receipt authorization matrix' \
  tests/p1-local/delivery-receipts-postgres.test.ts
```

Measured result: both controls exited `1`.

- Source control: `0` passed, `1` failed with the expected missing-boundary assertion.
- PostgreSQL control: `0` passed, `1` failed because the second agent received the first
  agent's receipt object where the test required `null`.

The source failure was:

```text
AssertionError [ERR_ASSERTION]: agent receipt lookup must bind the signal to the authenticated sender and workspace
```

## GREEN and restore

The author predicates were restored. The migration SHA-256 before mutation and after restore was
byte-identical:

```text
51015a4a7f525ee93a02bd5afafa5e9e2c7de0c763a0e95ad83d32ed016f5039
```

The restored migration was applied through the same local container. The source control exited
`0` with `1` passed and `0` failed. The complete receipt PostgreSQL file exited `0` with `2`
passed and `0` failed.

This establishes that both controls detect removal of the agent cross-sender author gate and that
the restored forward migration runs on real local PostgreSQL. It does not establish that the
unapplied migration has run in production.
