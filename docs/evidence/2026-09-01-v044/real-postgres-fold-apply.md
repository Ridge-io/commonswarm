# Folded roster migration on real Postgres — observed 2026-09-01

Local Supabase (Docker, 127.0.0.1:54321), exclusive slot held by the Lead. `npm run db:reset`
applied the chain and finished:

```
Applying migration 20260901000020_signal_human_receipts.sql...
Applying migration 20260902000001_broadcast_recipient_roster.sql...
Seeding data from supabase/seed.sql...
Finished supabase db reset on branch main.
```

Applied versions matching `2026090%` in local `supabase_migrations.schema_migrations`:
`20260901000001 20260901000010 20260901000020 20260902000001` — there is no 000002 to apply.

Positive control on the APPLIED OBJECT, not the file: `pg_proc.prosrc` of
`swarm_read.signal_delivery_receipts` contains the literal `'principals'` → count **1**.

`tests/p1-local/delivery-receipts-postgres.test.ts`: 3/3 pass, now including the old-parser leg —
the parser blob npm 0.1.42/0.1.43 shipped (tree `619ff1f^`) reads the directed AND the broadcast
wire returned by real Postgres, and throws on the pre-fold shape rebuilt from the same response
(control). Mutation arm: asserting `receipts.length + 1` on the broadcast leg → RED
(`✖ delivery receipt authorization matrix holds on real Postgres`); reverted → 3/3 green again.

Production (`supabase migration list --linked`, read-only): remote has `20260901000020`;
`20260902000001` is local-only. **Not applied to production.**
