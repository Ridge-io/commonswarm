# Codex permission canary fails on codex-acp 1.7.0 / 1.8.0 — measured 2026-09-02 00:20–00:40Z

Reports: CodexDesktop (`2a8606f2`, feedback 2026-09-02 00:07:53Z, cswarm 0.1.44) and Marque
(`023fd46b`, feedback 2026-09-01 16:20Z, cswarm 0.1.43). Recorded on this host in
`~/.cswarm/listeners/<id>/events.ndjson`: every Codex listener start since 2026-09-01 01:54Z ends
`permission_canary_failed`, reason `canary incomplete: permission=false deniedTool=false`.

Host: yulanbots-mac-mini, codex-acp 1.8.0 (`/opt/homebrew/bin/codex-acp`), codex-cli 0.147.0,
ChatGPT login valid. `~/.codex/config.toml`: `approval_policy = "never"`,
`sandbox_mode = "danger-full-access"`, many `trust_level = "trusted"` projects incl. `$HOME`.

## Method
Raw ACP client (`repro.mjs`, kept beside this file): spawn `codex-acp`, `initialize`,
`session/new`, optional `session/set_mode`, then the exact cswarm probe text
(`Use a shell command to create <path> with content CSWARM_CANARY_NOOP …`). Every
`session/request_permission` is answered with the reject option. Logged: tool calls, permission
requests, `stopReason`, and whether the sentinel file exists afterwards.

## Matrix (each row one run; T5/T9 are the same case twice)

| run | set_mode | CODEX_CONFIG | sentinel location | permission request | tool status | stopReason | sentinel written |
|---|---|---|---|---|---|---|---|
| 1 | none (current `agent`) | – | `$TMPDIR` | no | completed, exit 0 | end_turn | YES |
| 2 | `INITIAL_AGENT_MODE=agent` | – | `$TMPDIR` | no | completed | end_turn | YES |
| A | none | – | `$HOME` | no ("Guardian Review" approved) | completed | end_turn | YES |
| T1 | none | on-request + read-only | `$TMPDIR` | no | completed | end_turn | YES |
| T2 | none | on-request + read-only | `$HOME` | no (Guardian) | completed | end_turn | YES |
| T3 | – | `approval_policy=untrusted` | – | bridge refuses: "no longer supported" | – | – | – |
| T4 | `read-only` | – | `$TMPDIR` | **no** | completed, exit 0 | end_turn | **YES** |
| T5 | `read-only` | – | `$HOME` | **YES** | failed | cancelled | no |
| T6 | `read-only` | on-request + read-only | `$TMPDIR` | no | completed | end_turn | YES |
| T7 | `read-only` | – | under cwd | no | completed | end_turn | YES |
| T8 | `read-only` | – | `$HOME/.cswarm/canary/` | **YES** | failed | cancelled | no |
| T9 | `read-only` | – | `$HOME` | **YES** | failed | cancelled | no |

`session/new` reports `currentModeId: "agent"`; available modes are `read-only` ("Ask for
approval"), `agent` ("Approve for me", `_meta.kind: auto_review`), `agent-full-access`.

## Mechanism
cswarm selects `read-only` mode (src/host/bounds.ts `CODEX_PERMISSION_MODE_ID`) and then asks
Codex to write a sentinel in `tmpdir()` (src/listener/codex-model.ts). In codex-acp 1.8.0 the
read-only mode lets commands write under **cwd and `$TMPDIR`** without any approval, and only
escalates writes elsewhere to `session/request_permission`. So the probe runs silently, the
turn ends `end_turn`, and the canary — which needs a host reject plus a correlated terminal
tool status — reports `permission=false deniedTool=false`. The sentinel IS written, but
`codex-model.ts` cannot report that: its `if (sentinelCreated) throw` sits after the
`try/finally`, so it is unreachable when `enablePromptsAfterCanary` throws first.

The operator's `approval_policy = "never"` / `danger-full-access` config does NOT defeat the
selected mode: T5/T8/T9 asked under that config. `CODEX_CONFIG` overrides are honoured (T3
proves they are read) but do not change the TMPDIR/cwd allowance (T6).

## NOT established
- Which codex-acp version first allowed TMPDIR writes in read-only mode (1.1.9 was the last
  measured; no older bridge was installed to bisect). The first recorded failure on this host is
  2026-09-01 01:54Z, on 1.7.0 (published 2026-08-27).
- Whether the "Guardian Review" auto-approval in `agent` mode is affected by
  `approvals_reviewer`; cswarm never uses `agent` mode, so it is out of scope.
- Behaviour when the listener cwd is `$HOME` or an ancestor of the new sentinel dir (T7 suggests
  a silent write; the fix must guard it).
