# Spike: can `@agentclientprotocol/codex-acp` back a listener provider?

Run 2026-08-05 against package **1.1.9** and its installed **`codex-acp`** binary. The
driver is [`bridge-spike.ts`](./bridge-spike.ts). It speaks ACP over stdio and imports the
repository's exported `sanitizeChildEnv`; it does not reproduce the sanitizer.

## Verdict

**Stop before implementation.** The adapter speaks ACP protocol version 1 and runs under the
sanitized environment, but the session starts in `agent` mode. In that mode a requested shell write
emitted **zero** `session/request_permission` requests and created the file. An unchanged copy of the
Claude provider would fail CommonSwarm's canary and block listener startup because that canary
requires both a permission request and a correlated denied-tool update.

No `src/host/codex.ts` was written because the assigned spike boundary required stopping on this
result. The spike does not establish implementation cost. A host-owned `read-only` mode override may
be small, but it still needs the full CommonSwarm canary measurement before a provider proceeds.

## Installed artifact

```
package: @agentclientprotocol/codex-acp 1.1.9
binary:  codex-acp
--version: @agentclientprotocol/codex-acp 1.1.9
initialize agentInfo.version: 1.1.9
resolved @openai/codex: 0.145.0
runtime npm integrity: sha512-/PSPSFujjjmiyVFvG2yu/grOFhsWdokTH8t2KGWhXSo/M5n/dIDsnbsnO82/7bLtIoDuzQf7ATBUMWqPWQINlQ==
```

The runtime entry matters because `codex-acp` declares `@openai/codex` with a caret range. The same
adapter version can resolve a later Codex package on a future install.

The package install used `--no-save --package-lock=false`; neither manifest changed.

## Protocol and authentication path

The stdio exchange completed all three required calls:

```
initialize     -> protocolVersion: 1
session/new    -> non-empty sessionId
session/prompt -> stopReason: end_turn
```

`ACP_PROTOCOL_VERSION` is 1 and `src/host/session.ts` rejects any other value. No shim or
negotiation would be needed for this package version.

Initialization advertised `api-key` and `chat-gpt` auth methods. The no-tool prompt completed on
this machine with the existing login still reachable when `HOME` was retained. The spike did not
measure the login's storage mechanism.

## Actual sanitized environment

The driver passed `sanitizeChildEnv({...process.env, SWARM_CODEX_ACP_SPIKE_SENTINEL: ...})` directly
to `spawn`:

```
ambient parent keys:  79
probe parent keys:    80 (ambient plus the sentinel)
child keys:           12
stripped probe keys:  68
HOME survives:        true
SWARM sentinel:       stripped
```

The sentinel is the positive control for the deny path. The stripped keys included the ambient
`CODEX_CI`, `CODEX_MANAGED_BY_NPM`, `CODEX_MANAGED_PACKAGE_ROOT`, and `CODEX_THREAD_ID` names. The
adapter still initialized, created a session, and completed a model turn. This establishes the
existing ChatGPT login path on this machine with `HOME` retained. It does not establish API-key auth:
`CODEX_API_KEY` and `OPENAI_API_KEY` are not allowlisted by `sanitizeChildEnv`.

## Permission result: default mode cannot pass the current host gate

`session/new` reported these modes:

```
available: read-only, agent, agent-full-access
current:   agent
```

The production host's `session/new` request sends `cwd`, an empty MCP list, and
`_meta: {yoloMode:false}`. It does not send a mode or call `session/set_mode`.

The driver then asked Codex to use a shell command to create a canary file inside a fresh temporary
working directory:

```
session/request_permission count: 0
prompt stopReason:                end_turn
canary file exists:               true
canary contents:                  "CODEX_ACP_DEFAULT_MODE_CANARY"
```

This is the blocking result for the assigned build boundary. A listener provider built by copying
`claude.ts` would fail closed during startup: the host canary sees no permission request, does not
enable prompts, and rejects listener readiness. The direct driver bypassed that readiness gate only
to measure the adapter's default behavior.

### Diagnostic control: the adapter can ask when mode is changed

To prove the zero was not a broken request observer, the same process and session then received:

```
session/set_mode { modeId: "read-only" } -> {}
```

The same-shaped write prompt then produced:

```
session/request_permission count: 1
option kinds: allow_once, allow_always, allow_always, reject_once
selected by driver: reject_once
prompt stopReason: end_turn
canary file exists after deny: false
```

The control establishes that version 1.1.9 can emit the expected request and that the driver detects
and denies it. It also narrows the failed condition: the adapter's default `agent` mode bypasses the
permission boundary exercised by CommonSwarm's current session handshake.

## What this spike did not establish

- Whether CommonSwarm should add a provider-specific `session/set_mode` step. That is a session
  contract change, not the requested copy of `claude.ts`, and needs its own design and canary proof.
- Whether setting the host-owned `INITIAL_AGENT_MODE=read-only` after sanitization is sufficient.
  The installed adapter documents that option, but this run changed mode through ACP instead.
- Whether a read-only-mode denial emits every correlated terminal update required by
  `AcpHostSession.runPermissionBoundaryCanary`; this driver measured the request, denial response,
  and absent
  file, not the host session's full correlation predicate.
- API-key authentication under `sanitizeChildEnv`; the relevant variables are stripped.
- Behaviour without an existing Codex/ChatGPT login under `HOME`.
- A production listener turn, any CLI wiring, packaging, or Windows launch behavior.
