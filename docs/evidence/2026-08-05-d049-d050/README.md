# D-049 / D-050: explicit ACP modes and fatal teardown

Measured 2026-08-05 on the installed provider versions and the source tree that began at
`72971c2d320ef7b0fca036682e23ba1fd354464c`.

## Provider modes

`provider-mode-spike.ts` drives raw ACP `initialize` and `session/new` using the same executable
arguments and child-environment builders as the production hosts.

| Provider | Version | Reported default | Available modes |
|---|---:|---|---|
| Claude | 0.64.2 | `default` (Manual) | `auto`, `default`, `acceptEdits`, `plan`, `dontAsk`, `bypassPermissions` |
| Codex | 1.1.9 | `agent` | `read-only`, `agent`, `agent-full-access` |
| Grok | 0.2.117 | no mode object or mode config | none reported |
| OpenCode | 1.18.10 | config option `build` | config options `build`, `plan`; no legacy mode object |

The OpenCode production child still uses its isolated config whose wildcard and known tools are
forced to `ask`. Grok still sends `_meta.yoloMode:false` and relies on the deny canary; neither
adapter advertised a mode that CommonSwarm could select through `session/set_mode`.

### Permissive negative controls

The raw driver explicitly selected the permissive mode, asked for a sentinel file in a fresh
temporary cwd, denied any permission request it received, and removed the cwd after measurement.

```
Claude session/set_mode bypassPermissions -> {}
permission requests                         0
sentinel created                            true

Codex session/set_mode agent               -> {}
permission requests                         0
sentinel created                            true
```

Those are the red arms: a deny canary cannot pass in either permissive mode because the adapter
never asks the host. The sentinel proves the zero is not a model refusal or an observer that missed
a denied mutation.

### Required-mode positive controls through the shipped host

The replacement host contract validates the required mode in `session/new.modes.availableModes`,
then sends `session/set_mode` even when the adapter reports the same current mode. Missing modes and
failed RPCs stop session opening.

The installed adapters were then driven through `AcpHostSession.runPermissionBoundaryCanary`, not a
raw request counter:

```
Claude required mode: default
passed: true; permission: true; correlated denied tool: true; stop: end_turn

Codex required mode: read-only
passed: true; permission: true; correlated denied tool: true; stop: end_turn
```

This closes the Codex bridge spike's unmeasured correlation item. Both the host-authored rejection
and the terminal update for the same session/tool-call pair were observed.

The production-shape `ClaudeListenerModel.start()` and `CodexListenerModel.start()` were then run
against the installed bridges. Each exact model canary reached ready and each model closed cleanly;
the Codex run used the repository-local 1.1.9 executable installed by the preceding spike.

## Teardown failure reproduction and fix

Before changing `ClaudeListenerModel.prompt`, a named pure causal control ran the real model/engine
classes with injected ACP handles:

```
result statuses: retry_pending, retry_pending, failed
opens:           3
closes:          3
persisted code:  acpchildexiterror
```

Every prompt raised `AcpChildExitError`; every close raised `child_exit_timeout`. The shipped model
discarded the close error, cleared the handle, and allowed the engine to open another worker.

The source audit found the same suppression in Grok's prompt, runtime close, and failed-canary
cleanup paths. OpenCode's prompt path already throws the close error and retains the worker home.
Grok's host close also only sent SIGTERM without waiting; it now follows the bounded
SIGTERM→SIGKILL→confirmed-exit contract used by the other hosts, so a surviving process produces
`child_exit_timeout` instead of a successful close.

After the fix, the same Claude model/engine control establishes:

```
runtime error:   exact child_exit_timeout object
opens:           1
closes:          1
persisted state: failed
persisted code:  child_exit_timeout
second process:  terminal failed record; opens remains 1
```

`ListenerEngine` persists `child_exit_timeout` and rethrows it. `runListenerRuntime` classifies that
escape as fatal and its existing `finally` path does not suppress model close failures. Grok now
propagates the same cleanup error from all three suppressed paths.

## Pure gates added

- `tests/host-acp-codex.test.ts` and `tests/listener-codex-model.test.ts` are named explicitly in the
  root `npm test` literal list.
- The generic host tests require `initialize`, `session/new`, and `session/set_mode` in that order,
  and show the open fails when the required mode is absent.
- Claude and Codex fake process tests assert the provider-specific mode id in the exact RPC.
- D-050 tests cover the Claude engine boundary and all three Grok suppression sites.
- CLI, detached argv, durable status, and host-limit copy tests include Codex.

## Not established

- API-key authentication for Claude or Codex. The production sanitizer strips the relevant
  variables; the measured paths used HOME-backed login state.
- Codex behavior without an existing ChatGPT/Codex login.
- A production CommonSwarm listener connected to the hosted service. The live probes exercised the
  local ACP process and host session only.
- Any database migration, edge function, deployment, npm publication, or production change.
