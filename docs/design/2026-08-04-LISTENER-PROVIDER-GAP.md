# Why Claude Code and Pi are not listener providers, and what it would take

> **D-044 update, 2026-08-04:** the local cross-owner sandbox requirement below is retired. Every
> sender relation now reaches the operator's worker and cwd with provenance in the prompt. The
> CommonSwarm server authority model is unchanged.
>
> **D-049 update, 2026-08-05:** v0.1.6 ships the Claude provider. The implementation lane described
> by `docs/evidence/2026-08-05-d049-d050/README.md` explicitly selects Claude `default` mode and adds
> a Codex provider that selects `read-only`; both modes passed the full host deny-correlation canary.
> Statements below that say Claude was never accepted or that no bridge was run describe the earlier
> audit and are superseded.

Measured 2026-08-04 against production v0.1.5. Prompted by a second-machine dogfood where **no
installed host qualified**, which made the connect path unreachable on that laptop.

## The requirement

~~`cswarm listen start` rejects anything but `grok` or `opencode`.~~ **Superseded:** v0.1.6 added
Claude, and the 2026-08-05 lane adds Codex. The provider list remains a protocol boundary — the
listener drives its host over **ACP (Agent Client Protocol) on stdio**, and
each adapter spawns a process already speaking it:

- `src/host/grok.ts` — spawns the grok binary in its ACP mode, version-checked, then `initialize` and
  `session/new`.
- `src/host/opencode.ts:312` — spawns `opencode acp --pure`.

A provider must therefore **be an ACP server**. Everything else in the adapter — isolation env,
permission callbacks, cwd handling — sits on top of that.

## What each host actually offers

| Host | Installed | ACP mentions in `--help` | Native ACP |
|---|---|---|---|
| `grok` | 0.2.114 | 1 | yes |
| `opencode` | 1.18.3 | 1 | yes (`acp --pure`) |
| `claude` | 2.1.221 | **0** | **no** |
| `pi` | 0.83.0 | **0** | **no** |

The zeros are meaningful rather than an artifact of terse output: opencode's whole `--help` is 12
lines and still surfaces its ACP subcommand, and claude's is 13.

**So this is a protocol gap, not a policy exclusion.** Nothing in the codebase decided Claude Code
should be unsupported; it simply does not speak the protocol the listener requires.

## How Buzz does it — prior art, measured

Operator asked how `block/buzz` (Block's open-source agent desktop) supports Claude Code and Codex.
The answer is the mechanism above, and it is worth copying.

**Buzz does not implement adapters. It installs and spawns other people's.** From `crates/buzz-acp`:

- The agent command is configurable — `BUZZ_ACP_AGENT_COMMAND` (default `goose`) plus
  `BUZZ_ACP_AGENT_ARGS` (default `acp`). It spawns N subprocesses and sends ACP `initialize` to each.
- Adapters are **ordinary global npm packages, discovered on `PATH`**:
  - Claude Code → `npm install -g @agentclientprotocol/claude-agent-acp`
  - Codex → `npm install -g @agentclientprotocol/codex-acp`
- Goose is spawned directly as `goose acp`.

So Buzz's harness is the same shape as ours: resolve an executable, spawn it, speak ACP. Our
`grok.ts` and `opencode.ts` already do exactly this. **Adding Claude Code is adopting a published
adapter, not writing a protocol implementation.**

**Package versions, verified on npm 2026-08-04** — all four exist, and the scope matters:

| Package | Version |
|---|---|
| `@agentclientprotocol/claude-agent-acp` | **0.64.2** |
| `@agentclientprotocol/codex-acp` | **1.1.9** |
| `@zed-industries/claude-code-acp` | 0.16.2 |
| `@zed-industries/codex-acp` | 0.16.0 |

~~"`@zed-industries/claude-code-acp` is published at v0.16.2… the same bridge Zed uses."~~ **Superseded
same day.** That package exists but is the older home; the adapters now live under
`@agentclientprotocol`, which is two major-ish generations ahead (0.64.2 vs 0.16.2). I named the stale
one before checking whether a newer scope existed. **Use `@agentclientprotocol/claude-agent-acp`.**

~~Adopting Codex costs almost nothing extra once Claude Code is done — same mechanism, one more
package.~~ **Superseded 2026-08-05:** the Codex spike found that an unchanged Claude adapter copy
fails closed at the listener canary because `codex-acp` starts in `agent` mode. A `read-only` mode
control did emit permission requests, so implementation cost remained unmeasured at that point. See
`docs/evidence/2026-08-05-codex-acp/bridge-spike.md`. **Resolved later 2026-08-05:** the explicit
`session/set_mode` contract and the Codex host/listener implementation are measured in
`docs/evidence/2026-08-05-d049-d050/README.md`.

### Installing it during onboarding

Operator direction: make installing the adapter part of onboarding. That matches
`AGENTS.md` § *Onboarding: ask for the minimum, detect the rest* — the system can see whether the
adapter is on `PATH`, and a missing dependency it can install is not a question worth asking. The
honest constraint is that `npm install -g` mutates the user's machine, so it needs consent once, not a
silent install, and the failure path has to be legible: Buzz's own tracker carries a Windows issue
where adapter installation fails with `Unknown channel: agentHostClientProxy` and **no adapter files
are created**, which is the shape of failure to design against.

This matters more than it looks. On the dogfood laptop:

- `grok` 0.2.114 is below the pinned 0.2.117 **and** returns `402 Payment Required` (usage exhausted),
  so the version is moot;
- `opencode` 1.18.3 is below the pinned 1.18.10;
- `claude` 2.1.221 is current and funded — **and is the one host the connect path will not accept.**

A user whose only working agent CLI is Claude Code cannot connect an agent at all. That is not a
theoretical population.

## Pi

No native ACP surface and no bridge found. Closing it would mean either upstream ACP support or
writing a bridge, both larger than adopting an existing one. Not recommended ahead of Claude Code.

## What this does not establish

- **Whether the bridge actually works end to end with our adapter.** Nothing was built or run; this is
  a capability audit, not a spike. The bridge's ACP version, its permission-request behaviour, and
  whether it honours a working directory the way `grok.ts` and `opencode.ts` expect are all unmeasured.
- **Whether cross-owner isolation can be enforced through it.** This is the load-bearing question and
  the reason this is not a small task. `grok.ts:177-200` disables skills, rules, agents, MCPs, hooks
  and six tool classes by environment variable for cross-owner turns. D-041's MAJOR-2 already records
  that OpenCode has *no* equivalent surface, leaving it dependent on the forced-ask path alone.
  **A Claude Code adapter needs its own answer to that question before it ships, not after.** If the
  bridge exposes no way to constrain tools, that is a reason not to adopt it — the same conclusion the
  D-041 packet reached for OpenCode.
- Whether the version pins (grok 0.2.117, opencode 1.18.10) are still the right floors.
