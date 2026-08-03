# /goal — repair the non-idempotent config restore that corrupts `delivery_retention_days`

Worker: **Sable2** (Codex). Lane: narrow test-state repair.
Clone: `/Users/yulanbot/Developer/Ridge.io/cloud-swarm` · Branch: `lead7/mvp-release-0.1.5`
**Frozen base: supplied by the launcher as `$FROZEN_BASE`, asserted in preflight.**

You own exactly one file: `tests/p1-server/command.test.ts`. You hold the exclusive DB slot.

## The defect, already diagnosed — do not re-derive it, verify it

The second review arm flagged that `swarm.purge_terminal_signal_deliveries()` fails. It guessed the
cause was `make_interval` type casting. **That guess was wrong.** Executing the function found the
real cause:

```
ERROR: invalid input syntax for type integer: ""30""
```

`swarm.config` currently holds `delivery_retention_days` as jsonb **string** `"\"30\""` — a JSON
string containing the literal characters `"30"` — while the established convention (see
`idempotency_retention_days`) stores it as a jsonb **number** `30`. `(value #>> '{}')::integer` then
receives `"30"` with quotes and throws.

The migration is **correct** (`VALUES ('delivery_retention_days', '30'::jsonb)`) and must not be
touched. The corruption comes from this test's own restore block, around
`tests/p1-server/command.test.ts:7168` and `:7262`:

```ts
const initialConfigVal = initialConfigRow ? JSON.stringify(initialConfigRow.value) : null;
...
VALUES ('delivery_retention_days', ${initialConfigVal}::jsonb)
```

The driver returns the jsonb already parsed; `JSON.stringify` then re-encodes it, and `::jsonb`
parses that back — **adding one encoding layer per run**. The restore is not idempotent, so it
progressively corrupts the row instead of restoring it. Because the migration seeds with
`ON CONFLICT (key) DO NOTHING`, a later `db:reset` does not repair it either.

**Production is not affected** — the migration seeds correctly and no production code writes this key
(verified: the only writers in the repo are this migration and this test). This is local shared-state
pollution, and it is exactly the cross-suite interference the release checklist warns about: after any
`test:p1-server` run, the purge function fails locally, which would read as a spurious backend defect
to whoever looks next.

## The repair

Make the save/restore **round-trip exactly**, so running the test any number of times leaves
`swarm.config` byte-identical to how it started. Options, in order of preference:

1. Read the value already serialized — e.g. `SELECT value::text ...` — and restore that text with a
   single `::jsonb` cast, with no `JSON.stringify` in between.
2. Or restore via a parameter the driver types as jsonb directly, without a manual re-encode.

Do not "fix" it by hardcoding `30`; the point is a faithful round-trip of whatever was there.

Also confirm the `null` branch still behaves: if the key was absent before the test, it must be absent
after.

## Acceptance — all measured, not reasoned

1. **Repair the corrupted row first** so you start from a correct baseline:
   `UPDATE swarm.config SET value = '30'::jsonb WHERE key = 'delivery_retention_days';`
   then prove `jsonb_typeof(value) = 'number'`.
2. **Prove the purge function executes on the cron path** (the failing case):
   `SELECT swarm.purge_terminal_signal_deliveries();` must succeed with no argument.
3. **Run `npm run test:p1-server`, then re-check the config row.** `jsonb_typeof` must still be
   `number` and the value still `30`. Under the current code it becomes a string — that is your
   red-before proof, so capture it **before** applying the fix.
4. **Run the suite a second time** and re-check again. Twice through must be identical to once
   through; that is what "idempotent" means here and a single run would not have caught the original
   bug.
5. Re-prove `SELECT swarm.purge_terminal_signal_deliveries();` succeeds after both runs.
6. Full suite counts unchanged: `test:p1-server` 69/69, and `npm test` still green.

## Gates

`npm test`, `npm run check:tests`, `npm run build`, `git diff --check`. Then, holding the slot with a
zero-process proof between steps: `npm run db:reset`, `npm run test:p1-server` (×2 as above).
Do not run `test:p1-cli` or `test:p1-local` in this lane.

## Deliverable

Commit **once**, push, record the new SHA. Write
`/Users/yulanbot/Developer/Ridge.io/cloud-swarm/scratchpad/2026-07-31-common-swarm-handoff/CONFIG-RESTORE-FIX-RESULT.md`
with: the red-before evidence (config row corrupted by a run), the diff, the green-after evidence
(two runs leave it identical), the purge-function execution proof, all gate counts, and the new SHA.

## Non-goals

Do not touch the migration, any edge function, `src/`, `package.json`, the site, or the version. Do
not change the purge function — it is correct. Do not deploy, tag, or release. Do not join the swarm
or set swarm status. Do not broadcast or contact `AdvisorClaude2`.

## Stop conditions

Preflight fails · you cannot reproduce the corruption before fixing it (that would mean the diagnosis
is wrong — report rather than proceeding) · the suite count changes · residual processes survive.

State what you did **not** establish: production behaviour, hosted `pg_cron` execution, and real-load
capacity are out of scope.
