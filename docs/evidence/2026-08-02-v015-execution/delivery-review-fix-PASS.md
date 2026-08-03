# Delivery production-review corrections — result

Worker: **Corbel** (Codex)  
Branch: `lead7/mvp-release-0.1.5`  
Reviewed code base: `8852ce8dd5e3fcc7d82c211b98e22f1d630d5c4e`  
Starting branch SHA: `1f7c9ac2fe769d3399034c4c00c8c8e1b5aae58d`  
New pushed SHA: `df2f4c9c4119b560ac2b7749b733dd6148212cf2`

The starting SHA differed from the frozen reviewed base by one documentation-only commit.
The five reviewed blobs (`durable-delivery.ts`, command `index.ts`, read `index.ts`,
`command.test.ts`, and the delivery migration) were byte-identical between `8852ce8` and
the starting SHA before work began.

## Exact corrections

1. Claim hydration still authorizes and loads the immutable signal for the exact workspace,
   recipient principal, and signal IDs, but returns the ledger ref's persisted
   `sender_owner_relation`. A replay no longer substitutes the hydration-time relation.
2. Terminal ACK handling now returns `delivery_unavailable` unless the stored last lease and
   listener both match. Matching identity plus matching outcome remains idempotent; matching
   identity plus a different outcome remains `delivery_ack_conflict`. The same classification
   is applied on the post-update reread race path.
3. `claim_agent_inbox` and `ack_agent_delivery` are workspace-stream commands. A caller-selected
   repo stream is refused before delivery mutation, idempotency insertion, or accepted audit.
4. Read responses advertise `delivery_claim` and `delivery_ack` only on a home-workspace inbox
   query. Home non-inbox and foreign-workspace signal responses retain only
   `sender_owner_relation` and `cursor_after` markers.

No migration, `src/`, site, manifest/version, lockfile, or generated protocol change was made.

## RED then GREEN proof

All four discriminators are in `tests/p1-server/command.test.ts`, which is reached by the
`tests/p1-server/**/*.test.ts` glob in `test:p1-server`.

Before production edits, one targeted invocation selected exactly four tests:

- tests 4; pass 0; fail 4; runner 12.324s; wall 12.35s.
- Correction 1 RED: replay after author revocation returned `unknown`; expected persisted
  `same_owner`.
- Correction 2 RED: terminal ACK with a different lease returned HTTP 409; expected the
  non-enumerating HTTP 403.
- Correction 3 RED: repo-routed claim and ACK both returned HTTP 200; expected `[403, 403]`.
- Correction 4 RED: a home non-inbox read still advertised both delivery markers.

After the production edits, the identical targeted invocation was GREEN:

- tests 4; pass 4; fail 0; runner 8.072s; wall 8.10s.

The full server gate also exercised the poison-terminal ACK case, the matching-identity
different-outcome conflict control, and both home-inbox and foreign-workspace capability paths.

## Gates and elapsed time

- `npm test`: 343 tests, 343 pass, 0 fail; runner 4.187s; wall 4.34s.
- `npm run check:tests`: exit 0; wall 1.67s.
- `npm run build`: exit 0; wall 1.09s.
- `npm run check:edge`: command, read, and capability entrypoints checked; exit 0; wall 0.80s.
- `git diff --check`: exit 0.
- Final `npm run db:reset`: exit 0; wall 26.42s.
- `npm run test:p1-cli`: 137 tests, 137 pass, 0 fail; runner 7.200s; wall 7.34s.
- `npm run test:p1-local`: 4 tests, 4 pass, 0 fail; runner 6.201s; wall 6.30s.
- `npm run test:p1-server`: 69 tests, 69 pass, 0 fail; runner 94.140s; wall 94.37s.

The earlier reset used for the RED proof also passed in 26.57s.

## Exclusive-slot proofs

`pgrep -f 'test:p1-server|test:p1-local|supabase functions serve' | wc -l` returned `0`:

- before the RED-proof reset;
- before the RED targeted invocation;
- before the GREEN targeted invocation;
- before the final reset;
- before `test:p1-cli`;
- before `test:p1-local`;
- before `test:p1-server`;
- after `test:p1-server`.

No residual matching process remained.

## Migration identity

`supabase/migrations/20260731000001_signal_deliveries.sql` remained blob
`d569747fe9ef93186c7422f7082fcf37fec116f2`, identical to `8852ce8`. Its working-tree SHA-256
was `58d9409065e150870dba91e6b82eff9d519063c0c25cd55ef88f141695f69d44`.

## Not established

This work did not establish deployment, deployed edge behavior, production behavior,
production migration application, real-load capacity, or actual production `pg_cron` execution.
It did not run the new-SHA two-arm exact/inversion review; the goal assigns that review to the
Lead. It did not deploy, tag, release, or bump a version.
