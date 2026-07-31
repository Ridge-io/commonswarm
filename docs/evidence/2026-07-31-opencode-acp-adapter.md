# OpenCode ACP second host adapter — design & measurement

Date: 2026-07-31
Lane: A2 (Slate) + Aegis remediation
Base: `origin/main` `d8bd531fc9b3e8c6aca7de5976d51e2dbc834c48`
Measured host: **OpenCode CLI 1.18.10** (`opencode acp --pure`)

## Decision (operator / Lead7)

OpenCode 1.18.10 completed ACP `protocolVersion` 1 `initialize` + `session/new`, then a
live empty-cwd / 0700-home Kimi K3 probe passed the existing forced-deny canary
(`permission=true`, `deniedTool=true`). Codex app-server remains unselected because
zero-tool behavior is unproven on this machine.

## Superseded claim (DEAD)

~~A private 0700 home alone prevents project `opencode.json` allow lists from applying.~~
**SUPERSEDED — DEAD.** Measured on 1.18.10: with a hostile project
`permission.bash=allow` and only a private XDG home + forced-ask global config,
`opencode debug config --pure` still resolves **allow**. Project merge is defeated
only when `OPENCODE_DISABLE_PROJECT_CONFIG=1` is set; the adapter sets that env var
and positively verifies via `debug config --pure` before spawn.

## Architecture

Reuse the provider-neutral ACP stack:

- `AcpTransport` / `AcpHostSession` (initialize, session/new, sequential prompt, cancel,
  host-correlated permission canary)
- `ListenerModel` / `ListenerEngine` / runtime / supervisor

Provider-specific code:

| File | Role |
|---|---|
| `src/host/opencode.ts` | realpath pin, env, home, config probe, spawn, terminate |
| `src/listener/opencode-model.ts` | canary empty cwd → openWorkCwd; in-flight set |
| CLI / detach | `--provider opencode`, absolute `--opencode-executable` |

**Provider code never reads or reinterprets `sender_owner_relation`.**

## Spawn & pin

```
<absolute-realpath> acp --pure
```

- Version gate: exact `1.18.10` via the same absolute executable and child env.
- `OPENCODE_DISABLE_PROJECT_CONFIG=1` always forced in child env.
- Effective-config probe: `debug config --pure` with a hostile project allow-all cwd
  must not show `bash`/`*` = allow.
- No `--effort` mapping; CLI rejects `--effort` with `--provider opencode`.
- Detached start requires an absolute `--opencode-executable` (bare `opencode` refused).

## Homes & auth

- Worker: private 0700 home, auth-only copy, generated forced-ask config.
- Canary: empty temp 0700 cwd (never the user repo); then `openWorkCwd(workCwd)`.
- Cross-owner: fresh home + empty cwd per turn; tracked in an in-flight Set.
- Auth: regular file, not symlink, uid match, mode `0600`, size bound, valid JSON.
- `allowMissingAuth` is explicit test-only — not implied by injecting a fake opener.
- Close: try/finally, SIGTERM → wait → SIGKILL, await exit, remove credential home.
- Stale-home sweep removes old `cswarm-opencode-home-*` under tmpdir.

## Canary (host-correlated only)

1. Host receives `session/request_permission`.
2. Host selects reject_* (or cancelled) and records `toolCallId`.
3. Agent emits `tool_call` / `tool_call_update` with that **same** `toolCallId` and a
   bounded structured status in
   `{rejected,denied,cancelled,canceled,failed,error}`.
4. Provider free-text / content-body regex never unlocks prompts.

Steady-state `--permissions allow` only selects `allow_once` *after* this deny canary.
The canary does not prove allow mode.

## Forced tools (1.18.10)

`bash`, `glob`, `read`, `grep`, `webfetch`, `websearch`, `write`, `edit`, `task`,
`apply_patch`, `todowrite`, `question`, `skill`, `execute`, `external_directory`, `*`.

## Live verification (1.18.10)

See `docs/evidence/2026-07-31-opencode-project-config-disable.md` for the measured
hostile-project probe (project allow disabled; no sentinel file side effect).

## Not established

- End-to-end production `cswarm listen --provider opencode` on a customer workspace.
- Tool surface after 1.18.10 (version pin refuses other builds).
- Codex app-server zero-tool proof (still unselected).
