# Why Claude Code and Pi are not listener providers, and what it would take

Measured 2026-08-04 against production v0.1.5. Prompted by a second-machine dogfood where **no
installed host qualified**, which made the connect path unreachable on that laptop.

## The requirement

`cswarm listen start` rejects anything but `grok` or `opencode` (`src/cli.ts:2547-2552`). That list is
not a preference — the listener drives its host over **ACP (Agent Client Protocol) on stdio**, and
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

## Claude Code: the gap is closable, and there is prior art

**`@zed-industries/claude-code-acp` is published at v0.16.2.** It is an ACP server that drives Claude
Code behind it — the same bridge Zed uses. An adapter would spawn the bridge rather than the `claude`
binary, and the rest of the existing adapter shape should apply.

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
