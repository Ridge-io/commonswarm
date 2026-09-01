# Grok exact review of 3295f57 (v0.1.44 candidate) — VERDICT: PASS (2026-09-01)

I'll start by confirming HEAD is `3295f57`, reading the required review docs, and joining the swarm. Then I'll run C1–C6 myself.HEAD matches `3295f57`. Next I’ll join the swarm, read the remaining review docs, and pull the scoped diff.I'll join this repo's swarm, then pull the scoped diff and locate the C1–C6 control sites.I'll join as Rivet, then pull the key diffs and the tests that implement C1–C5.Swarm join is done. Next I’ll read the remaining diffs and tests, then start the gates and the C1–C5 controls in parallel.C6 gates can start now. I’ll write the C1–C5 probes in parallel and keep mutations until after the gates finish.I have the control sites. Next I’ll start the C6 gates and write independent C1–C5 probes.C1 file/get timed out as typed errors; brain list was 278ms against a 180ms deadline (overhead, not a retry). C3 failed because `tsx` resolved from the temp project. I’ll fix those probes and keep the C6 gates running.C6 mixed: build, check:tests, check:edge, and db:reset passed; `npm test`, `test:p1-cli`, and site test exited 1. I’ll read those failures next.The first C6 run was contaminated: `FORCE_COLOR` plus load. I’ll run C5 on the reset DB, then re-run the failed gates cleanly and serially.Clean gates passed. Next I’ll mutation-test C1–C3, restore after each, and confirm the tree is clean.Exact review of `3295f578f070fd3a384bb9919616b0cffb3de3a6` (`git rev-parse HEAD` matched). Codex authored the lanes. Tree restored to that SHA after mutations (`git diff --quiet` on tracked files).

The four Codex FAIL items on `fc88624` hold on this SHA.

## Controls (observed)

**C1 body-stall** — fake `fetch` returns 200 headers, body never ends. Deadline 180 ms.

| path | elapsed | typed error | fetch count |
|---|---|---|---|
| `listFilesAsAgent` | 189 ms | `FileTransportError.noResponse === true` | 1 |
| `listFilesAsHuman` | 181 ms | same | 1 |
| `getObject` | 182 ms | same | 1 |
| `listBrainRowsAsAgent` (retry wrapper) | 187 ms | same | 1 |

**C1 MUTATE** (`src/cloud/files.ts` `fetchWithDeadline`: `cancel(timer)` after headers, before body). File list hung 412 ms against a 120 ms deadline (`outcome=hung`). Restore: `git checkout -- src/cloud/files.ts`.

**C2 overall budget** — fake clock, product 30 s / 2 s floor.

- First remaining `30000`, retry remaining `3000`, result `ok`.
- Below floor: 28.5 s burned, `attempts=1`, same error thrown.

**C2 MUTATE** (retry starts `now() + timeoutMs`). Remaining became `[30000, 30000]`. Remainder assert went RED. Restore: `git checkout -- src/cloud/files.ts`.

**C3 two-principal install** — temp `HOME`, two git projects, 0600 `listener-credential.json` files, `cswarm hook install claude --principal-id <A|B> --write`.

- A wrote `…/c3-proj-a-…/.claude/settings.local.json` with only A.
- B wrote `…/c3-proj-b-…/.claude/settings.local.json` with only B.
- `HOME/.claude/settings.json` absent.
- Files mode `0600`. No shared-host warning on the default path.

**C3 MUTATE** (default target = user settings). Both installs wrote `HOME/.claude/settings.json`. Last writer was B only. Restore: `git checkout -- src/cli.ts`.

**C4 `CLAUDE_CONFIG_DIR`** — `--user` wrote `/var/folders/…/c4-config-bE4bZz/settings.json` (`0600`, principal A). `HOME/.claude/settings.json` stayed `{ "theme": "home-untouched" }`. Warning printed (see P3).

**C5 migration** — local Supabase was up. Exclusive `npm run db:reset` applied `20260902000001_broadcast_recipient_roster.sql`. `000002` absent on disk and in `schema_migrations` (`['20260902000001']`).

RPC broadcast JSON:

- `receipts`: one member row (`recipient_user_id`, `display_name`, `seen_at: null`). No `tracking_state`.
- `broadcast_roster.agents.principals`: `c5-recipient`, `c5-sender`, both `not_tracked`.
- Directed keys: `addressed`, `receipts` only.

`619ff1f^` parser (`bcaa529644e960fb51f99294f3a42de1114890ca`): parsed broadcast and directed; threw on agent rows stuffed into `receipts`.

Function owner `swarm_admin`. `EXECUTE`: `authenticated` true, `swarm_read` true, `anon` false.

**C6 gates** — first parallel run was a bad instrument (`FORCE_COLOR=1` plus load: stderr asserts and Chrome `SIGKILL`). Clean serial rerun with those vars unset:

```
# npm run build
> chmod 755 dist/cli.js
EXIT:0

# npm test
ℹ tests 680
ℹ pass 680
ℹ fail 0
NPM_TEST_EXIT:0

# npm run test:p1-cli
ℹ tests 381
ℹ pass 381
ℹ fail 0
P1CLI_EXIT:0

# npm run check:tests
> tsc -p tsconfig.tests.json
EXIT:0

# npm run check:edge
> deno check --config supabase/functions/command/deno.json …
EXIT:0

# npm --prefix site run build
[build] 8 page(s) built in 7.76s
BUILD_EXIT:0

# npm --prefix site test
ℹ tests 235
ℹ pass 234
ℹ fail 0
ℹ skipped 1
SITE_TEST_EXIT:0
```

## Findings

**P3 — timeout copy says “no response” after headers arrived.** `src/cloud/files.ts:409` (`the download failed before a response`), `src/cloud/files.ts:536` and `:595` (`file list could not reach the cloud service`). C1 reached body consumption, then those strings, with `noResponse: true`. CLI prints `error.message` (`src/cli.ts:6537`). Retry is still correct for an idempotent read. JSDoc at `src/cloud/files.ts:96-98` still says `noResponse` means no HTTP response arrived.

**P3 — `--user` warning overclaims when `CLAUDE_CONFIG_DIR` is set.** `src/cli.ts:5258` / `:5531`: “affects EVERY Claude Code session for this OS user”. C4 wrote only `$CLAUDE_CONFIG_DIR/settings.json` and left `HOME/.claude/settings.json` unchanged. The warning is true for the default user file; it is false on the custom-dir path.

No P1 or P2. The four Codex FAIL items are fixed.

## NOT-established

- Production apply of `20260902000001` (local reset only).
- Full `npm run test:p1-local` matrix (authorization, directed-human). This arm ran one broadcast RPC, one directed-agent RPC, and the old parser.
- Claude Code runtime load of `settings.local.json` (installer writes only).
- Two agents in one project: default install still keeps one CommonSwarm hook; last `--write` wins. C3 used two projects, as specified.
- Tilde expansion of `CLAUDE_CONFIG_DIR`.

VERDICT: PASS
