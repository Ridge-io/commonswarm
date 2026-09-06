# lane/main-only REPORT

HEAD: `67863bd22e34c28e28baf919b4c8774331d31149`
Branch: `lane/main-only`
Worktree: `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-main-only`
Do not merge. Never production.

## What landed on the branch

A listener may start only `--route main`. It claims into `pending-for-main.json` and does not start a model.

`--route worker`, `--route split`, and `--defer-over` are refused. The sentence is built from `LISTENER_ROUTE_MODES` plus the ruling: a listener never answers for a session; the seat's own session reads the queue.

Start needs a hook or a live `cswarm inbox --notify` lock for the same principal (`arrivalWatchLockHeld`, not pgrep). Neither: `listen_unattended_refused` names both remedies from `LISTENER_ATTENDANCE_SURFACES`. `--allow-unattended` stays; it says a queue may not wake a session.

`listen status` names the attending surface. When none: "Signals queue and nothing wakes the session." Old `routeMode: "worker"|"split"` status files still parse and print the LEGACY cannot-start-again sentence.

Host ACP files stay in the tree (follow-up). Provider flags only name the attendance surface kind.

## Commits

- `4a0678a` feat(listener): only route main; never start a model
- `0ffbf9f` test(listener): main-only route, attendance, no-model runtime
- `1e161cd` docs: listener never starts a model
- `67863bd` fix(listener): generated canary copy and main host_limits

Identity: `scripts/check-commit-identity.sh origin/main..HEAD` — 8 address-fields OK (`yulanbot@gmail.com`).

## Gates (on 67863bd)

| command | result |
|---|---|
| `npm run build` | exit 0 |
| `npx tsc --noEmit -p tsconfig.json` | exit 0 |
| `npm test` | 910 pass, 0 fail |
| `env -u FORCE_COLOR npm run test:p1-cli` | 491 pass, 0 fail |
| `npm run check:tests` | exit 0 |
| `npm run check:edge` | exit 0 |
| `scripts/check-commit-identity.sh origin/main..HEAD` | OK |

## D-036

One Gemini arm (`agy` 1.1.27, `gemini-3.1-pro-high`). Grok excluded.

Round 1 SHA `1e161cd8e511465e89a0d10a46ebae5cbaa849af`: `VERDICT: FAIL` (typed canary copy, old test names, worker `host_limits` on main). Files: `scratchpad/lane-main-only/arms-1e161cd8e511465e89a0d10a46ebae5cbaa849af/`.

Round 2 SHA `67863bd22e34c28e28baf919b4c8774331d31149`: `VERDICT: PASS`. Files: `scratchpad/lane-main-only/arms-67863bd22e34c28e28baf919b4c8774331d31149/{REVIEW.md,DIFF.patch,gemini/ARM.txt}`.

## Live control

Listener `--state-dir /tmp/cswarm-main-only-live-IczmeF/state` against `http://127.0.0.1:54321`, `--allow-unattended`, `--provider grok`, fake executable path that does not exist.

Ready JSON: `routeMode: "main"`, `attendingSurface: "none"`, `attendingSentence: "ATTENDING: none. Signals queue and nothing wakes the session."`, `providerExecutable: null`. Process COMM was `node`, not grok.

Posted note: **not established**. Local `command` function is `BOOT_ERROR` because docker edge runtime is mounted on another lane's worktree (`cswarm-astra-identity-…/supabase/functions`, missing `session-wire.ts`). This lane did not restart that runtime and did not `db:reset`. Queueing without `model.start()` is in `tests/listener-main-only.test.ts` (throwing `start()` → ready + `pending-for-main.json`).

## Not established

- Merge. Production. Deploy.
- A posted note in `pending-for-main.json` on this host.
- Deleting host ACP files.
- `listen stop` leaving no process when status says stopped (status said stopped while pid 40321 was still alive; killed with SIGTERM).
