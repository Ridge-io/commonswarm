# L3 wake-command report

Branch: `lane/wake-command`
SHA: `7c9a4589b7c62151d2bf087f0417d969fea516a4`
Merge-base: `88d9f45214b1e4224605818d188312cf1c5f17b5`
Author: Yulan Bot `<yulanbot@gmail.com>`
Not merged.

Commits:

- `ca37cee` feat(read): carry wake on the agent inbox page
- `93a248c` feat(command): wake on mint/renew/claim; rotate on intent revoke
- `f7e4e7a` test(p1-server): wake topic in responses and rotation
- `7c9a458` test: retarget citation-drift pointers after command inserts

Freeze dir: `arms-7c9a4589b7c62151d2bf087f0417d969fea516a4/` (`REVIEW.md`, `DIFF.patch`).
First `diff --git` line: `diff --git a/supabase/functions/_shared/wake.ts b/supabase/functions/_shared/wake.ts`

## What landed

Own-workspace agent inbox (`inbox: true`) returns optional `wake: { topic, event }`. `wake_id` is column eleven of `agent_delivery_read_context`. Human, foreign, and `inbox: false` reads do not carry it.

Mint, renew, and claim responses carry the same object. Mint/renew add it where `agent_token` is returned.

`rotate_wake_id` runs at principal revoke and token revoke. A stranded-successor discard does not rotate.

## Re-derived agent-credential `revoked_at` sites

`supabase/functions/command/index.ts`:

| line | table | rotate |
|---|---|---|
| 3606 | `agent_tokens` (`discardStrandedSuccessor`) | no |
| 4142 | `agent_principals` (`AgentPrincipalRevoked`) | yes, 4153 |
| 4171 | `agent_tokens` (principal cascade) | no second call |
| 4240 | `agent_tokens` (`AgentTokenRevoked`) | yes, 4255 |

## Gates

| command | exit |
|---|---|
| `npm run db:reset` | 0 |
| `npm run build` | 0 |
| `npm run check:edge` | 0 |
| `npm test` | 0 |
| `env -u FORCE_COLOR npm run test:p1-cli` | 0 (483 pass) |
| `npm run check:tests` | 0 |
| `npm run test:p1-server` | 0 (155 pass) |
| `npm run test:p1-local` | 0 (48 pass) |
| `scripts/check-commit-identity.sh origin/main..HEAD` | 0 (8 address-fields) |

## Mutations

1. Removed inbox `wake` field. Responses test exit 1 (inbox assertion). Mint/renew/claim still passed.
2. Removed one `rotateWakeId` call (token revoke). Rotation test exit 1 (id unchanged). Principal revoke still rotated.
3. Restored. Both files 8 pass, exit 0. `git diff --quiet` exit 0.

## Gemini arm

pid: **63965**
model: `gemini-3.1-pro-high`
output: `arms-7c9a4589b7c62151d2bf087f0417d969fea516a4/gemini/ARM.txt`
Alive at report time. Verdict not yet read. Lane still owes a `VERDICT:` line on this SHA.

## NOT established

- Production deploy (`functions deploy`, `--linked`, `db push`, ref `ukezjcnxjvkpkeezxaew`).
- Merge to `main`.
- Live listener status JSON (L4).
- Mint/renew *replay* carrying `wake` (fresh path only, with `agent_token`).
- Rotation on grant cascade, device revoke, run end, membership revoke, or archive.
- Hosted `wake_topic_authorized` behaviour.
- The Gemini arm verdict (process is still running).
