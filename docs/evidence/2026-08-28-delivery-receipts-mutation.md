# Delivery receipt cross-sender mutation — 2026-08-28

Target: `supabase/migrations/20260828000001_signal_delivery_receipts.sql`

The control is `cross-sender mutation control pins caller kind, author id, and workspace` in
`tests/delivery-receipts.test.ts`. The root `npm test` script names that file literally.

## RED

Temporary mutation: remove both author predicates from the signal lookup while leaving the
workspace predicate intact:

```sql
AND signal.from_kind = v_author_kind
AND signal.from_principal = v_author_id
```

Command:

```sh
node --import tsx --test --test-name-pattern='cross-sender mutation control' tests/delivery-receipts.test.ts
```

Measured result: exit `1`; `0` passed, `1` failed. The failure was:

```text
AssertionError [ERR_ASSERTION]: receipt lookup must bind the signal to the authenticated sender and workspace
```

## GREEN and restore

The author predicates were restored. The migration SHA-256 before mutation and after restore was
byte-identical:

```text
3ee38a559ab02e54e15ce6c6719c2cfb18e9f70c95d90f9bf12f373fdde4fa48
```

The same command then exited `0`; `1` passed, `0` failed.

This establishes that the checked-in control detects removal of the cross-sender author gate. It
does not establish that the unapplied migration has run against PostgreSQL or production.
