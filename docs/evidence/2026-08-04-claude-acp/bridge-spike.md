# Spike: does `@agentclientprotocol/claude-agent-acp` work as a listener provider?

Run 2026-08-04 against the **actual binary**, not against documentation. Package **0.64.2**, binary
`claude-agent-acp`.

## Why the spike existed

No released CommonSwarm has ever accepted Claude Code as a listener provider — v0.1.4 took `grok`
only, v0.1.5 takes `grok` and `opencode`, and `src/host/` holds exactly those two adapters. The
capability has never existed, so the laptop that "could not connect" was fully up to date.

Two questions had to be answered before writing any adapter. Both came from the Fable plan review, and
**one of them invalidated my first spike.**

## Result 1 — protocol compatibility: exact

```
initialize -> protocolVersion: 1
```

`ACP_PROTOCOL_VERSION = 1` (`src/host/bounds.ts:17`), and `session.ts:414` throws on any mismatch.
**Exact match — no negotiation, no shim.** `session/new` with a `cwd` returns a real session id;
`session/prompt` on a tool-free prompt returned `stopReason: "end_turn"` with real token usage.

`authMethods: []` and no `authenticate` method exists on our side — consistent, nothing to wire.

## Result 2 — it survives the listener's env, which my first spike did not test

**My first run used my own shell environment. The listener does not.** `sanitizeChildEnv`
(`src/host/env.ts:37-38`) drops every key matching
`(SWARM|SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|AUTH|COOKIE)`.

Re-run using the **real exported function**, not an approximation:

```
keys stripped: 70
auth-relevant stripped: CLAUDE_CODE_ENTRYPOINT, CLAUDECODE, CLAUDE_CODE_SESSION_ID,
                        CLAUDE_CODE_EXECPATH, CLAUDE_PID, SSH_AUTH_SOCK, … (13 total)
HOME survives: true
initialize: OK v1
session/new: OK
```

**It still works.** `HOME` survives, which is what carries keychain/OAuth credentials.

**The residual risk, unmeasured:** a user authenticated by `ANTHROPIC_API_KEY` rather than keychain
would have that key stripped — `API_KEY` matches the deny pattern — and get an auth-less child. I did
not test that path because this machine authenticates by keychain. **It must present legibly rather
than as a crash, and it is not yet known what it does.**

## Result 3 — the host DOES ask permission

This was the blocking unknown. Our whole model layer — the deny canary,
`enablePromptsAfterCanary`, the permission callback — assumes the host emits
`session/request_permission`. If the bridge ran permissive and never asked, those semantics would be
vacuous.

Prompted with a request requiring a file-write tool:

```
session/request_permission received: 1
options: [ {kind:"reject_once", optionId:"reject"},
           {kind:"allow_once",  optionId:"allow"},
           {kind:"allow_always",optionId:"allow_always"} ]
```

**It asks, with exactly the option shape our permission layer already handles.**

`session/prompt` returned no response in that run — **correct behaviour, not a failure**: the turn
blocked pending the permission answer the spike deliberately never sent.

Update kinds observed: `available_commands_update`, `usage_update`, `agent_message_chunk`,
`tool_call`, `tool_call_update`.

## Verdict

**This is not a protocol integration. It is spawning a binary that already speaks our exact dialect
and already asks permission the way we expect.** D-044 retired the isolation apparatus that makes
`opencode.ts` 869 lines, and there is no auth artifact to copy into a private home.

## What this spike did NOT establish

- Behaviour on a machine **without Claude Code installed** — the bridge embeds
  `@anthropic-ai/claude-agent-sdk` rather than shelling out to the `claude` binary, so it may not need
  it, but this machine has it.
- Behaviour for a user with **no Claude auth at all**, and for an `ANTHROPIC_API_KEY` user whose key is
  stripped. This is the stranger's failure mode and the one that most needs to be legible.
- A full turn driven to completion **through our own session layer** rather than a hand-rolled client.
- Anything about `@agentclientprotocol/codex-acp`. Its "near-free" status is my assumption with **zero
  spike evidence**; it needs its own measurement.
