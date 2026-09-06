# L3 wake in responses and rotation — freeze at 7c9a4589b7c62151d2bf087f0417d969fea516a4

Author family: Grok. Branch: `lane/wake-command`. Merge-base: `88d9f45214b1e4224605818d188312cf1c5f17b5`.

## Claims (three sentences)

An agent inbox read on the own-workspace page returns optional `wake: { topic: "cswarm-wake:" + wake_id, event: "wake" }` whose 43-character id equals `agent_principals.wake_id`, taken from the eleventh column of `agent_delivery_read_context`; a human read, a foreign-workspace agent inbox, and an own-workspace feed with `inbox: false` do not. Mint, renew, and claim HTTP responses carry the same optional object, built from the shared `_shared/wake.ts` constants, and the topic is not written to audit detail or the idempotency ledger. `rotate_wake_id` runs at the two revocation-by-intent sites (principal revoke and token revoke); `discardStrandedSuccessor` does not rotate; after token revoke with a remaining live token the old topic is refused by `wake_topic_authorized` and the new one is admitted.

## Files

- `supabase/functions/_shared/wake.ts`
- `supabase/functions/read/index.ts`
- `supabase/functions/command/index.ts`
- `tests/p1-server/wake-topic-in-responses.test.ts`
- `tests/p1-server/wake-rotation.test.ts`
- `tests/p1-cli/citation-drift.test.ts` (pointers retargeted after the command inserts)

## Re-derived agent-credential `revoked_at` writers in `supabase/functions/command/index.ts`

Grep: every `SET revoked_at` in that file, classified by the table the statement updates.

| file:line | table | intent? | rotate? |
|---|---|---|---|
| `command/index.ts:3606` | `swarm.agent_tokens` (`discardStrandedSuccessor`) | no — stranded unused successor on ordinary renewal | no |
| `command/index.ts:4142` | `swarm.agent_principals` (`AgentPrincipalRevoked`) | yes | yes, `:4153` |
| `command/index.ts:4171` | `swarm.agent_tokens` (principal-revoke cascade) | same transaction, same principal | no second call |
| `command/index.ts:4240` | `swarm.agent_tokens` (`AgentTokenRevoked`) | yes | yes, `:4255` |

Other `SET revoked_at` in the same file write `invitations` (`:4003`), `memberships` (`:4042`), `renewal_grants` (`:4203`, `:4212`, `:4270`), `grants` (`:4461`), `capability_urls` (`:5829`). None is an agent-credential revocation. Database cascade `swarm.renewal_grants_revoke_cascade` is not an intent site and does not rotate (spec W6).

## Gate exit codes

| command | exit |
|---|---|
| `npm run db:reset` | 0 (applied `20260906000010_wake_delivery.sql`) |
| `npm run build` | 0 |
| `npm run check:edge` | 0 |
| `npm test` | 0 |
| `env -u FORCE_COLOR npm run test:p1-cli` | 0 (483 pass) |
| `npm run check:tests` | 0 |
| `npm run test:p1-server` | 0 (155 pass, including the eight wake tests) |
| `npm run test:p1-local` | 0 (48 pass) |
| `scripts/check-commit-identity.sh origin/main..HEAD` | 0 (6 address-fields) |

## Mutation rows

1. Removed `...(body.inbox ? optionalWake(agent.wake_id) : {})` from the own-workspace inbox return in `read/index.ts`. `tests/p1-server/wake-topic-in-responses.test.ts` exit 1: inbox test failed (`Object.hasOwn(body, "wake")` false); mint/renew/claim and the human/foreign negatives still passed.
2. Removed `await rotateWakeId(tx, revoked[0]!.principal_id)` from `AgentTokenRevoked`. `tests/p1-server/wake-rotation.test.ts` exit 1: token-revoke test failed (`wake_id` unchanged); principal revoke still rotated; stranded-successor discard still did not.
3. Restored both with `git checkout --`. Both files rerun: 8 pass, exit 0. `git diff --quiet` exit 0.

## NOT established

- Production apply of the `read` or `command` edge (`functions deploy`, `--linked`, `db push`, ref `ukezjcnxjvkpkeezxaew`). Not this lane.
- A live listener `--state-dir` status JSON. L4 owns the client.
- That mint/renew *replay* bodies carry `wake` (the field is added where `agent_token` is returned, on the fresh path only).
- Rotation on grant-revoke cascade, device revoke, run end, membership revoke, or workspace archive. Spec W6 says they do not.
- Merge to `main`. This SHA is not on `main`.
- Hosted `wake_topic_authorized` behaviour. Local stack only.
