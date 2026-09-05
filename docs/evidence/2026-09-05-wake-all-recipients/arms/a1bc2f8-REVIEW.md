# Review brief — lane/wake-all-recipients @ a1bc2f8 (CommonSwarm)

Repo root: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-all-recipients

Read the whole diff at
/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-all-recipients/arms-a1bc2f8/DIFF.patch
and read the files it touches in that checkout. **Quote back the first `diff --git` line of
DIFF.patch before any finding**, so the reader knows you opened it.

## What the lane claims

CommonSwarm signals can name up to 8 recipients. Until now the database woke only the recipient
at position 0. This lane wakes every AGENT recipient at any position.

1. Migration `supabase/migrations/20260905000020_wake_all_recipients.sql` adds
   `swarm.agent_delivery_is_wakeable(signal_id, workspace_id, agent)` and calls it from BOTH
   enqueue triggers, plus a new AFTER INSERT trigger on `swarm.signal_recipients` that inserts one
   `swarm.signal_deliveries` row per agent recipient with `ON CONFLICT DO NOTHING`.
2. `supabase/functions/command/durable-delivery.ts`: `hydrateDeliveryRefs` authorizes against the
   recipient SET (was: the scalar `s.to_agent_principal_id`), returns `to_agent` = the CLAIMING
   principal, and adds `recipient_position` / `recipient_count`. The `expired` ack path takes the
   same widening. A `recipient_fanout: 1` capability marker is added.
3. `src/cloud/delivery.ts` parses the new pair (absent stays null) and keeps its "addressed to
   another agent" refusal unchanged. `src/listener/{types,engine,runtime}.ts` render one sentence
   in the worker prompt when the set has more than one recipient.
4. `supabase/functions/read/index.ts` gains a `channels` resource for agent credentials.

## Attack these, in order. For each, say PASS or FAIL and why.

1. **Tenancy and authorization.** Can the new `EXISTS (swarm.signal_recipients ...)` arm in
   `hydrateDeliveryRefs` or in the `expired` ack let an agent read a signal it is not addressed to,
   or one in another workspace? Check the join keys, the workspace columns, and what
   `swarm.signal_recipients` guarantees (see `20260905000010_signal_recipients.sql`). Construct a
   concrete row set that would leak if you can.
2. **`to_agent` now means something different on this wire than on a feed read.** Find every
   consumer of a hydrated delivery's `signal.to_agent` in `src/` and say whether any of them is now
   wrong, misleading, or silently changed. Include the listener journal fingerprint, main-route
   projection, receipts, and anything that persists a signal record.
3. **Double wake and lost wake.** Trigger firing order: `signals_enqueue_delivery` (AFTER INSERT ON
   swarm.signals) versus `signal_recipients_enqueue_delivery` (AFTER INSERT ON
   swarm.signal_recipients). Is `ON CONFLICT DO NOTHING` against PRIMARY KEY
   `(signal_id, recipient_agent_principal_id)` sufficient? Can any ordering, any deferred
   constraint, or any statement-level behaviour produce two rows, or zero rows for a recipient that
   should be woken? What about `ON CONFLICT DO NOTHING` silently swallowing a DIFFERENT conflict?
4. **The three new refusal clauses.** `until > statement_timestamp()`, `revoked_at IS NULL`, and the
   self-address clause. For each: is it reachable, does it refuse something that used to work that
   somebody depends on, and is the comment about its reach accurate? The `self` clause is claimed
   to be a real behaviour change with nothing else preventing that shape — verify by searching the
   command edge for a self-address refusal.
5. **Concurrency and the claim/ack paths.** `claimAgentInbox` steps 1..7 were not changed. Does
   waking N recipients break any of: the outstanding-lease cap, `pending_delivery_count`,
   `oldest_pending_at`, the poison ceiling, or `SKIP LOCKED` ordering? Two listeners for two
   different recipients of the SAME signal now run concurrently — find anything that assumed one.
6. **Wire compatibility.** Does an installed 0.1.55 client (which does NOT know
   `recipient_position`) still accept a claim response, a replay of an OLD stored claim ledger, and
   an ack? Does the new client refuse anything a capable server can legitimately send? Check
   `parseClaimLedger`, the replay path in `supabase/functions/command/index.ts`, and
   `checkedRecipientSlot`.
7. **The `channels` read resource.** Does it match the tenancy every other resource in that file
   takes? Is the empty-envelope branch in the right place? Can a human JWT reach it? Can a caller
   read another workspace's channels? Is the column list a second typed copy of something?
8. **Claims in prose.** Every comment added by this diff is a claim. Find one that is FALSE.
   Specifically check: the migration header's apply-order paragraph; the `until` clause's stated
   reach against `signals_check`; the retirement notes in
   `supabase/functions/_shared/channels.ts` and `supabase/functions/command/index.ts`; the note in
   `src/cloud/channels.ts` about the CLI not being wired; and whether any list inside a sentence is
   typed rather than generated.
9. **Tests.** For each new or rewritten test, does it reach the code path it claims? Name any test
   that would pass with the feature removed. `tests/p1-local/chat-recipients-postgres.test.ts`,
   `tests/p1-server/chat-signals.test.ts`, `tests/delivery-client.test.ts`,
   `tests/listener-engine.test.ts`, `tests/listener-runtime.test.ts`.

Try to REFUTE the lane, not to agree with it. If you find nothing in a section, say what you
checked and why it holds. Do not summarise the diff back.

The last line of your reply must be exactly one of:
VERDICT: PASS
VERDICT: FAIL

## Round two: what changed since 3547d82, which both arms failed

Two findings were verified and fixed. Attack the FIXES as hard as the rest.

- The clause refusing a self-addressed signal is GONE. `runListenerAttendanceCanary`
  (`src/listener/attendance-canary.ts`) posts a self-note with the agent's own credential and
  `cswarm listen canary` needs that wake. Check: does the predicate now wake a self-note at every
  position, does the p1-local test assert it POSITIVELY, and is the removed clause's reason
  recorded where the next reader will meet it? Is anything else in the repo relying on an agent
  NOT waking itself?
- The channel column list moved to `CHANNEL_READ_COLUMNS` in
  `supabase/functions/_shared/channels.ts`. The read edge interpolates it into a `tx.unsafe`
  SELECT. Check: is that interpolation safe (where do the identifiers come from, where does the
  one value go), does `tests/chat-channel-constants.test.ts` really pin both arrays by import,
  and is the stated BOUND of that control accurate?
- One arm claimed the `signals_check` constraint name is false. It is not: Postgres auto-names an
  unnamed table CHECK `<table>_check`. Do not repeat that finding without measuring it.

A residual the first round surfaced and this lane did NOT fix, deliberately, because the files are
another lane's: `src/cloud/arrival-watch.ts` and `src/listener/hook.ts` re-check the SCALAR
`to_agent` on FEED rows, so a signal naming this agent at position 1 is dropped by the hook and
makes arrival-watch THROW. Say whether you agree that is pre-existing from L2 (merged 060ff67) and
reachable today without this lane, or whether this lane makes it a new defect.
