# OpenCode ACP second host adapter — design & measurement

Date: 2026-07-31  
Lane: A2 (Slate)  
Base: `origin/main` `d8bd531fc9b3e8c6aca7de5976d51e2dbc834c48`  
Measured host: **OpenCode CLI 1.18.10** (`opencode acp --pure`)

## Decision (operator / Lead7)

OpenCode 1.18.10 completed ACP `protocolVersion` 1 `initialize` + `session/new`, then a
live empty-cwd / 0700-home Kimi K3 probe passed the existing forced-deny canary
(`permission=true`, `deniedTool=true`). Codex app-server remains unselected because
zero-tool behavior is unproven on this machine.

## Architecture

Reuse the provider-neutral ACP stack:

- `AcpTransport` / `AcpHostSession` (initialize, session/new, sequential prompt, cancel,
  permission canary)
- `ListenerModel` / `ListenerEngine` / runtime / supervisor (one-principal exclusion,
  durable replay, relation-based mode selection)

Provider-specific code lives only in:

| File | Role |
|---|---|
| `src/host/opencode.ts` | spawn, version pin, home prep, auth validation, forced-ask config |
| `src/listener/opencode-model.ts` | same-owner worker vs per-turn cross-owner isolation |
| CLI / detach wiring | `--provider opencode`, `--opencode-executable` |

**Provider code never reads or reinterprets `sender_owner_relation`.** The engine alone
chooses `worker` vs `isolated` mode from the server-stamped relation.

## Spawn & pin

```
opencode acp --pure
```

- Version gate: exact `1.18.10` via `opencode --version`.
- No `--effort` mapping is measured for OpenCode; the CLI rejects `--effort` with
  `--provider opencode` rather than silently ignoring it.
- Optional model is written only into the generated private `opencode.json`, never argv.

## Homes & auth

- **Worker (same-owner):** private 0700 home with:
  - auth-only copy of `XDG_DATA_HOME/opencode/auth.json` (or default
    `~/.local/share/opencode/auth.json`)
  - generated `xdg-config/opencode/opencode.json` with every known 1.18.10 tool forced to
    `"ask"` plus `"*": "ask"` so ambient/project allow lists cannot bypass ACP
- **Cross-owner / unknown:** brand-new auth-only 0700 home **and** empty 0700 cwd per turn;
  both removed after the turn. Never reuses the worker home or cwd.
- Auth checks: regular file, not symlink, uid match, mode `0600`, size bound, valid JSON.

## Forced tools (1.18.10)

`bash`, `glob`, `read`, `grep`, `webfetch`, `websearch`, `write`, `edit`, `task`,
`apply_patch`, `todowrite`, `question`, `skill`, `execute`, `external_directory`, `*`.

## Permissions

- Default deny (host `reject_once` / cancel).
- Same-owner `allow_once` only after explicit local `--permissions allow`, and only after
  the canary has already passed under deny.
- Ready only after permission-request **and** denied-tool-result canary.
- CommonSwarm credentials never appear in argv, env, status, logs, or host frames
  (`sanitizeChildEnv` allowlist).

## Tests (pure, named in `npm test`)

- `tests/host-acp-opencode.test.ts` — argv/env/config, version parse, auth safety, home
  prep, canary pass/fail (including half-canary negative control), secret absence with
  causal denylist control.
- `tests/listener-opencode-model.test.ts` — canary-before-allow, same-owner persistence,
  fresh cross-owner homes/cwds, zero allowed hostile tools, cancel, closed/one-winner.

## Not established

- End-to-end live OpenCode model turn through `cswarm listen` on production (this slice is
  pure + wiring; Lead7 already measured canary probe separately).
- OpenCode tool surface after 1.18.10 (version pin refuses drift; wildcard asks for unknown
  names but new tool kinds still need re-measure).
- Concurrent multi-listener exclusion beyond existing principal-key file store (unchanged).
- Codex app-server zero-tool proof (still open if revisited).
