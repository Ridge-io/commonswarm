# /goal — Claude Code as a listener provider

**The top-priority gap.** No released CommonSwarm has ever accepted Claude Code: v0.1.4 took `grok`
only, v0.1.5 takes `grok` and `opencode`, `src/host/` holds exactly those two. Claude Code is the
market's default assistant, so **a beta invite is close to meaningless for most recipients**, and the
empty-workspace CTA points at exactly that door.

Read `docs/evidence/2026-08-04-claude-acp/bridge-spike.md` first. It is measured against the real
binary and it decides most of the design.

## What the spike already settled

- Bridge: **`@agentclientprotocol/claude-agent-acp@0.64.2`**, binary **`claude-agent-acp`**.
  (Not `@zed-industries/claude-code-acp` — that is the older package at 0.16.2. Both resolve, which is
  how you install the stale one and think it worked.)
- **Protocol match is exact.** It answers `initialize` with `protocolVersion: 1`; ours is `1`
  (`bounds.ts:17`) and `session.ts:414` throws on mismatch. No negotiation, no shim.
- **It works under the real `sanitizeChildEnv`** — 70 keys stripped including every `CLAUDE_*`. `HOME`
  survives and carries keychain auth.
- **It emits `session/request_permission`** with `reject_once`/`allow_once`/`allow_always` — the shape
  our permission layer already handles. The deny canary is meaningful.
- `authMethods: []`. No auth step to wire.

## Build

`src/host/claude.ts` + `src/listener/claude-model.ts`, plus `control.ts:37`, the `cli.ts` allowlist,
`listenerHostLimits`, and the usage/failure copy.

**Model it on `grok.ts` (264 lines), not `opencode.ts` (869).** Roughly 500 of opencode's lines are
isolated-home apparatus — auth copying, owner markers, `sweepStaleOpenCodeHomes`, forced-ask config
generation, the hostile-config probe, retained-home bookkeeping. **D-044 retired the rationale for all
of it**, and the spike shows there is no auth artifact to relocate. `ClaudeListenerModel` mirrors the
post-D-044 `grok-model.ts`.

**Copy exactly three things from `opencode.ts`, because grok's versions are wrong for an npm shim:**

1. **PATH-walk + `realpathSync` executable resolution** (`opencode.ts:120-163`). Grok's bare-name
   passthrough does not resolve an npm bin shim to one absolute path, and probe and spawn must agree.
2. **Verified `SIGTERM` → `SIGKILL` → confirmed-exit teardown** (`:710-733`). Grok's close fires
   SIGTERM and does not wait.
3. The env-consistent version probe — probe with the same env you spawn with.

**Do NOT copy the isolated-home or canary-cwd lifecycle.** D-041's MAJOR-1 — a worker living out its
life with a deleted cwd — lived precisely there.

## Version pinning, and the remedy that was missing

Pin exactly, as grok (0.2.117) and opencode (1.18.10) are pinned. A floor would assert forward
compatibility we have not measured.

**But the dogfood failure was pin-without-remedy, not pinning.** On the operator's laptop both hosts
sat below their pins and the message did not say how to fix it. So the failure text must contain the
install command verbatim:

```
npm install -g @agentclientprotocol/claude-agent-acp@0.64.2
```

`listenerFailureMessage` (`cli.ts:2698`) hardcodes the grok/opencode pins — update it.

## Fix the silent default — this is half the defect

`cli.ts:2550` is `args.optional("provider") ?? "grok"`. An agent that omits `--provider` **silently
becomes grok** and then fails on grok's version pin or a `402 Payment Required`. A Claude Code user is
told to fix a tool they never chose, and never learns their own runtime was unsupported. The honest
message at `:2551-2556` is only reachable by guessing.

**Make `--provider` explicit**, and have the error name every supported provider with its install
hint. Check `site/src/components/connect/agent-prompt.ts` and the tests for bare `listen start`
invocations first.

## Also: say what works without a listener

A Claude Code user is **already useful** without any of this — `cswarm working-on`, `note`, `ask` and
`feed` are provider-agnostic commands the agent runs itself. The listener is only *detached receipt*.
The unsupported-provider error and the connect copy should say so: **you can post and read now; live
receipt needs an adapter.** That unblocks a stranger even if the adapter slips.

## Out of scope tonight

Any `supabase/functions` deploy — **D-047 FREEZE stands; 0.1.6 is CLI + site only.** Codex (its
"near-free" status is an assumption with zero spike evidence — it gets its own measurement). Pi.
Auto-installing the adapter (print the command). Provider auto-detection. Removing the ACP permission
path (D-044 left that explicitly undecided). Touching grok/opencode pins or refactoring `opencode.ts`.

## Gate

Baseline on `main`: root **399/399**, p1-cli 143/143, p1-local 4/4, p1-server 69/69, site 142/142,
build/check:tests/check:edge all 0.

Tests must be **named in a script that runs them** — a file under `tests/support/` reached by no glob
is not a gate, and this repo has been bitten by that three times. Acceptance: count moves up; grep for
the old allowlist string returns 0 **with a positive control on the same invocation**.

**Then a live end-to-end**: `cswarm listen start --provider claude` against a real workspace, a real
signal handled, `lastSignalId` set. A green suite is not evidence here — four brick defects shipped
under one.

`NODE_OPTIONS` on this machine references a deleted preload; export
`NODE_OPTIONS="--max-old-space-size=4096"` and propagate it into anything you spawn.

## Report

Diff scope, before/after counts, the live end-to-end result, what you copied from `opencode.ts` and
what you deliberately did not, and plainly **what you did not establish** — especially the
`ANTHROPIC_API_KEY` user whose key is stripped by the sanitizer, and behaviour with no Claude auth at
all. Those are the stranger's failure modes and they must be legible, not a crash.
