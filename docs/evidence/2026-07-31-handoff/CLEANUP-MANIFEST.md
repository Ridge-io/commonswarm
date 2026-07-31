# MVP gap-closure cleanup manifest

Date: 2026-07-31 America/Chicago

This manifest records destructive cleanup authorized by the operator in
`EXECUTION-ORDERS.md`. It does not authorize remote branch deletion.

## Sable receiver-hardening rollback

- Removed worktree:
  `/Users/yulanbot/.swarm/wt/cloud-swarm-source/Sable--wake-receiver-hardening`
- Local branch retained:
  `swarm/Sable/wake-receiver-hardening`
- Worktree HEAD before removal:
  `7b495941ff46f46d96f4da8894005cd79636c5ae`
- Dirty file discarded:
  `supabase/functions/read/index.ts`
- Disposition reason: the uncommitted change removed the released
  `sender_owner_relation` and lossless cursor contract. It was an unsafe rollback,
  not forward work.
- Exact preserved diff:
  `docs/evidence/2026-07-31-handoff/sable-rollback.diff`
- Preserved diff SHA-256:
  `9a015338fd8551bccd610174535376bceccd5e7d739dbf7160e1b32dfe26a8d4`
- Positive control: the preserved scratchpad copy, durable copy, and live
  pre-discard `git diff` all produced that same digest.
- The raw `.diff` intentionally preserves four whitespace-only lines from the
  rejected working-tree patch. Consequently `git diff --check` reports those
  lines inside this evidence artifact; changing them would break the measured
  byte-for-byte preservation. No source or Markdown file has that exception.
- Result: clone B's registered worktree count changed from 9 to 8; the worktree
  path is absent; the local branch remains for the later read-only branch audit.

## Not done in this slice

- No other worktree was removed.
- No local branch was deleted.
- No remote branch was deleted.
- No product source from the Sable worktree was merged.
- No production deployment or database mutation occurred.
