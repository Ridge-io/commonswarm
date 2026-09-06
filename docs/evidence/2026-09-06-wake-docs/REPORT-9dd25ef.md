# L8 wake-docs report

Branch: `lane/wake-docs`
SHA: `9dd25ef7b493ec827843585834c26ac90a7be198`
Merge-base: `78b046991ae527830187d5c0934f1c41ced9a431`
Author: Yulan Bot `<yulanbot@gmail.com>` (Agent-Family: xai, grok-4.6)
Not merged.

Commit:

- `9dd25ef` docs: push delivery addendum, empty-claim persistence, check:edge four entrypoints

Files: `docs/design/SWARM-CLOUD.md`, `AGENTS.md`. Nothing else.

Freeze dir: `lane-wake-docs/arms-9dd25ef7b493ec827843585834c26ac90a7be198/` (`REVIEW.md`, `DIFF.patch`).
First `diff --git` line: `diff --git a/AGENTS.md b/AGENTS.md`

## What landed

`SWARM-CLOUD.md` §2.13 addendum **Push delivery (wake topics)**. LIVE server (L2/L3): per-principal `wake_id` (32 random bytes as 43 base64url characters), topic `cswarm-wake:{wake_id}`, content-free `wake` event from `swarm.wake_agent_delivery` on `signal_deliveries`, `wake_topic_authorized` under the anon SELECT policy, `rotate_wake_id` on intent revocation, optional `wake: { topic, event }` on the own-workspace agent inbox page and on mint/renew/claim. L4 (next client release): subscribe, claim on wake, reconcile every 5 minutes while subscribed / idle poll cadence in `src/cloud/idle-poll.ts` while not, status `mode: push|poll` with `mode: push` only while subscribed. Design argument cited: `docs/design/2026-09-06-PUSH-DELIVERY.md`.

§2.2: an idle `claim_agent_inbox` writes no `audit_log`, no `idempotency_keys`, no `rate_buckets`. A claim that leases a delivery, or that terminalizes a poisoned row, writes those rows as before. LIVE.

`AGENTS.md` trap: push is a hint; the row is the truth; a status that says push must be subscribed now.

`check:edge` names four entrypoints (`command`, `read`, `capability`, `activity`). Commands table and the tsc trap. No "was three" note.

Quoted in the commit message:

```
"check:edge": "deno check --config supabase/functions/command/deno.json supabase/functions/command/index.ts supabase/functions/read/index.ts supabase/functions/capability/index.ts supabase/functions/activity/index.ts"
```

Checked against `20260906000010_wake_delivery.sql`, `supabase/functions/_shared/wake.ts`, `src/cloud/idle-poll.ts`, `command/index.ts` (`hasUnackedDeliveries`, `claimAgentInboxPersistsLedger`, `optionalWakeForPrincipal`, `rotateWakeId`), `read/index.ts` (`optionalWake` on `inbox: true`).

## Gates

| command | exit |
|---|---|
| `npm test` | 0 (861 pass) |
| `env -u FORCE_COLOR npm run test:p1-cli` | 0 (483 pass) |
| `scripts/check-commit-identity.sh origin/main..HEAD` | 0 (2 address-fields) |

## Gemini arm

pid: **99273**
model: `gemini-3.1-pro-high`
output: `lane-wake-docs/arms-9dd25ef7b493ec827843585834c26ac90a7be198/gemini/ARM.txt`
Alive at report time (PPID 1, disowned). ARM.txt 0 bytes (agy prints on exit). Verdict not yet read. Lane still owes a `VERDICT:` line on this SHA.

## NOT established

- Gemini `VERDICT` (pid 99273 still running).
- A second D-036 arm. Brief asked for one Gemini arm. Lead runs the other family.
- Merge to `main`.
- Production (`functions deploy`, `--linked`, `db push`, ref `ukezjcnxjvkpkeezxaew`).
- L4 client (`src/listener/wake.ts` is absent). 5-minute reconcile is spec `LISTENER_RECONCILE_POLL_MS = 300_000`, not a constant in `idle-poll.ts`.
- An empty claim against a live queue (unacked rows exist, `delivery_refs` empty) still takes `rate_buckets`; the §2.2 sentence is the idle case (`hasUnackedDeliveries` false).
- Layout line in `AGENTS.md` (`supabase/ … command, read, capability`) still omits `activity`. Brief named the two `check:edge` places only.

## Next

Lead: wait for pid 99273, then the other-family arm on this SHA. Do not merge yet.
