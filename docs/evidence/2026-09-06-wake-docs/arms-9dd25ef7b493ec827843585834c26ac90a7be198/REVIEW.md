# L8 wake-docs — freeze at 9dd25ef7b493ec827843585834c26ac90a7be198

Author family: Grok. Branch: `lane/wake-docs`. Merge-base: `78b046991ae527830187d5c0934f1c41ced9a431`.
Docs only. Files owned: `docs/design/SWARM-CLOUD.md`, `AGENTS.md`.

Quote back this heading and the first heading of the DIFF (`docs:` subject or `#### Push delivery (wake topics)`). End with a `VERDICT:` line (`PASS` or `FAIL`). A reply without `VERDICT:` is not a review.

Read-only. Do not edit the tree. Do not merge. Do not touch production.

## Absolute paths

- `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-docs/docs/design/SWARM-CLOUD.md`
- `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-docs/AGENTS.md`
- `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-docs/docs/design/2026-09-06-PUSH-DELIVERY.md`
- `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-docs/supabase/migrations/20260906000010_wake_delivery.sql`
- `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-docs/supabase/functions/_shared/wake.ts`
- `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-docs/src/cloud/idle-poll.ts`
- `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-docs/package.json`
- `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-docs/supabase/functions/command/index.ts`
- `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-docs/supabase/functions/read/index.ts`
- `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-wake-docs/arms-9dd25ef7b493ec827843585834c26ac90a7be198/DIFF.patch`

## What the lane claimed

Check every sentence the DIFF added. File:line plus the source that confirms or refutes it. Cannot determine is allowed.

### SWARM-CLOUD.md §2.2

An idle `claim_agent_inbox` — no unacked delivery for the principal — writes no `audit_log` row, no `idempotency_keys` row, and no `rate_buckets` row. A claim that leases a delivery, or that terminalizes a poisoned row, writes those rows as before. Marked LIVE.

### SWARM-CLOUD.md §2.13 addendum "Push delivery (wake topics)"

Server facts marked LIVE; listener client (L4) marked as shipping in the next release. Design argument cited as `docs/design/2026-09-06-PUSH-DELIVERY.md`.

LIVE (L2/L3):

1. Each `swarm.agent_principals` row carries a `wake_id` of 32 random bytes as 43 base64url characters.
2. The private Realtime topic is `cswarm-wake:{wake_id}`.
3. An AFTER INSERT trigger on `swarm.signal_deliveries` (`swarm.wake_agent_delivery`) sends a content-free `wake` event on that topic.
4. `swarm.wake_topic_authorized` is the predicate of the `realtime.messages` SELECT policy `TO anon`.
5. `swarm.rotate_wake_id` runs in the same transaction as a revocation by intent (principal revoke; token revoke).
6. The own-workspace agent inbox page (`read`, `inbox: true`) and the mint, renew, and claim responses carry optional `wake: { topic, event }`.

L4, next release (no `src/listener/wake.ts` in this tree):

7. The next client release subscribes to that topic.
8. On `wake` it claims.
9. While the socket is subscribed it reconciles (read, then claim) every 5 minutes; while it is not, it uses the idle poll cadence in `src/cloud/idle-poll.ts`.
10. `cswarm listen status` reports `mode: push` or `mode: poll`. `mode: push` is reported only while the socket is subscribed.

### AGENTS.md

- Trap: "Push is a hint; the row is the truth; a status that says push must be subscribed now." Three clauses, one short paragraph.
- `check:edge` names four entrypoints (`command`, `read`, `capability`, `activity`). Commands table and the "Edge functions are outside tsc" trap. No "was three" note.

## Attack these (numbered; FAIL if any lands)

1. Does any new sentence use a banned modifier (*actual, real, true, clear, honest, genuine, main, key, important*) that adds no fact? The trap title contains "the truth" because the brief required that clause; other uses are in scope.
2. Does any new sentence invent an "X, not Y" contrast the sources did not introduce?
3. `wake_id` "32 random bytes as 43 base64url characters": quote the generator in `20260906000010_wake_delivery.sql` and `WAKE_ID_LENGTH` in `wake.ts`. Do they agree?
4. Topic `cswarm-wake:{wake_id}` and event `wake`: quote `WAKE_TOPIC_PREFIX` and `WAKE_EVENT`. Does the trigger send that topic and event?
5. "content-free": the trigger payload includes `v`, `signal_id`, `enqueued_at`. Does the spec's "content-free" mean no body/sender/kind, so the sentence holds, or does it overclaim?
6. `wake_topic_authorized` under an anon RLS policy: quote the `CREATE POLICY` (role `anon`, function call). Is there a second policy that makes "the" policy ambiguous?
7. Rotation on intent revocation: quote `rotateWakeId` call sites in `command/index.ts`. Does ordinary renewal rotate? The addendum does not say it does not; is omitting that a defect?
8. Inbox / mint / renew / claim carry `wake`: quote `optionalWake` / `optionalWakeForPrincipal` sites. Does a human read or `inbox: false` also carry it, contradicting "own-workspace agent inbox page"?
9. Empty-claim persistence: quote `hasUnackedDeliveries`, `claimAgentInboxPersistsLedger`, and the claim branch. Does an empty claim against a live queue (unacked rows exist, `delivery_refs` empty) still write `rate_buckets`, so "idle claim" is required and "empty claim persists nothing (rate bucket)" would be false?
10. "every 5 minutes": `LISTENER_RECONCILE_POLL_MS = 300_000` is in the spec, not in `idle-poll.ts`. L4 is not in this tree. Is citing 5 minutes while marking L4 as next-release honest, or a number with no source in the named files?
11. Idle cadence: quote `IDLE_POLL_DEFAULT_MS` and `nextIdlePollMs` in `idle-poll.ts`. Does "idle poll cadence in `src/cloud/idle-poll.ts`" match, or did the addendum hide that empty polls double to `IDLE_POLL_MAX_MS`?
12. `mode: push` only while subscribed: this is L4 spec text. Confirm `src/listener/wake.ts` is absent so it is not claimed LIVE.
13. `package.json` `check:edge` (line 22) names four `index.ts` files: command, read, capability, activity. Does AGENTS.md list those four and only those four? Does any remaining "three entrypoints" line about `check:edge` survive?
14. DIFF touches only `AGENTS.md` and `docs/design/SWARM-CLOUD.md`. FAIL if another path appears.

## Verdict rule

- `VERDICT: FAIL` if any numbered attack lands as a defect in the committed prose (wrong name, wrong number, LIVE vs next-release inverted, list inside a sentence that does not match the enforcement).
- `VERDICT: PASS` if every new sentence is checkable against the named sources (L4 numbers against the spec, idle cadence against `idle-poll.ts`, server names against the migration / `wake.ts` / edge files).
- Nits that do not make a sentence false are nits, not FAIL.

Write file:line for every check. Quote the source. Then `VERDICT:`.
