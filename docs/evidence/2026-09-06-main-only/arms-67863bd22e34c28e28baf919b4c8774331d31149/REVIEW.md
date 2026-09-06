# lane/main-only D-036 review — 67863bd22e34c28e28baf919b4c8774331d31149

Branch: `lane/main-only`. Merge-base: `4df2a5f822f68e4b0c69ac0194fa5512af2c4ec4`.
Author family: Grok. One Gemini arm (`agy`, `gemini-3.1-pro-high`). Grok excluded.

## Commits

- `4a0678a` feat(listener): only route main; never start a model
- `0ffbf9f` test(listener): main-only route, attendance, no-model runtime
- `1e161cd` docs: listener never starts a model
- `67863bd` fix(listener): generated canary copy and main host_limits

## Round 1 (SHA 1e161cd) — FAIL

Arm: `../arms-1e161cd8e511465e89a0d10a46ebae5cbaa849af/gemini/ARM.txt`
`VERDICT: FAIL` on C7 (typed canary copy), C9 (old test names), C10 (worker `host_limits` on live main).

## Round 2 (SHA 67863bd) — PASS

Arm: `gemini/ARM.txt`
Diff: `DIFF.patch`
Prompt: `PROMPT.txt`
`VERDICT: PASS`

## Live control (local stack, no db:reset)

State dir: `/tmp/cswarm-main-only-live-IczmeF/state`
Listener pid 40321 was `node dist/cli.js __listen-supervisor … --provider grok --grok-executable /tmp/cswarm-main-only-never-spawn-grok --route main`.
COMM was `node`. The fake grok path did not exist. `pgrep -f` of that path matched the listener argv only.

`listen status --json` while ready:

```json
{
  "state": "ready",
  "routeMode": "main",
  "attendingSurface": "none",
  "attendingSurfaces": [],
  "attendingSentence": "ATTENDING: none. Signals queue and nothing wakes the session.",
  "connected": true,
  "attendanceState": "unattended",
  "pid": 40321,
  "provider": "grok",
  "providerExecutable": null,
  "pendingForMainCount": 0,
  "lastErrorCode": null,
  "deliveryMode": "durable_claim",
  "deferOverChars": null
}
```

Posted note: **not established**. `cswarm note` returned `Worker failed to boot`. Docker edge runtime for this host is mounted on another lane (`/private/tmp/cswarm-astra-identity-20260906-01a07471/server/supabase/functions`); `command` and `activity` are `BOOT_ERROR` (missing `session-wire.ts`). This lane did not restart that runtime and did not `db:reset`. `pending-for-main.json` was therefore empty. Queueing without a model is covered by the throwing-`start()` unit test.

`listen stop` printed `state: "stopping"` while pid 40321 was still alive; status then said `stopped` with the same pid still alive. Killed with SIGTERM.

## Not established

- Production. Not merged. Not deployed.
- A posted note landing in `pending-for-main.json` on this host's local stack.
- Removal of host ACP files (`src/listener/*-model.ts`). Declared follow-up.
- `listen stop` process gone when status says stopped.
