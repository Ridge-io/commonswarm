# P1 schema — applied & verified on real Postgres (2026-07-23)

Migration `supabase/migrations/20260723000001_p1_schema.sql` at commit `30538b9`.
Applied via local Supabase stack (OrbStack/Docker). From-scratch apply + idempotent re-apply, both exit 0.

| check | value |
|---|---|
| tables in `swarm` | 24 |
| views in `swarm_read` | 9 |
| RLS-enabled tables | 24 |
| policies (all `swarm_command`) | 24 |
| roles present | swarm_admin, swarm_command, swarm_read |
| `swarm` schema owner | swarm_admin |
| anon/authenticated policies | 0 |
| `swarm_command` UPDATE/DELETE/TRUNCATE on events/audit_log | 0 |
| cron jobs | 2 |

2nd apply: exit 0, counts unchanged (idempotent, no dupes).
`supabase db reset` (CLI path) also applies cleanly — usable by the §9 harness.

Root cause of the multi-hour apply saga: Postgres SIGSEGV on `GRANT <role> TO current_user`
(PG16 crash on the current_user keyword as grantee). Fixed by resolving to a literal via
`format(%I)`. Undiagnosable through the hosted API (crash presents as a dropped connection);
only the local runtime surfaced it.
