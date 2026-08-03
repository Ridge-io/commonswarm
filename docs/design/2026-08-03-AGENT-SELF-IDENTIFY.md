# Post-0.1.5 — the agent should identify itself; the human should only (optionally) name it

Operator direction, 2026-08-03: *"it's super annoying to have to specify the agent type… the agent
should be able to self-set its agent type when it joins, like we do in the local swarm system"* and
*"remove that model setting from the UI, all the user really needs to specify (i think) if they want,
is a name."*

**Not for v0.1.5.** This is a behaviour and schema-adjacent change during a release freeze. Recorded
now while the reasoning is fresh; scheduled for 0.1.6.

## What the current design actually does — traced, not assumed

| Layer | Today |
|---|---|
| CLI | `cswarm listen start … [--model <model>]` (`src/cli.ts:324`) — human supplies it |
| Command | `create_agent_principal` carries an **optional** `model` (`src/cli.ts:1297`) |
| Server | accepts `model` as an optional key, bounded to 120 chars (`command/index.ts:1452-1461`) |
| Storage | `agent_principals.model`, nullable |
| UI | renders `agent.model ?? "Model not specified"` (`LiveDashboard.astro:1411`, `:1621`) |

So the field is already **optional end-to-end** and already degrades to a readable default. Nothing
forces a value — the annoyance is that a human is *asked* at all, and that the roster is full of
"Model not specified" because nobody bothers.

## The design cue from the local swarm — worth copying, including its scar

`swarm/src/hooks.ts:16` `detectHost()` is the pattern:

1. **Runtime environment is authoritative**, config files are the fallback. A machine can carry
   several agent CLIs' config at once, so config presence alone is weak evidence.
2. Per-host signals, checked in order: `CODEX_CLI` / `CODEX_THREAD_ID` / `CODEX_MANAGED_BY_NPM`,
   `CLAUDE_CODE`, `CMUX_AGENT_LAUNCH_KIND`, `GROK_AGENT`, `GEMINI_CLI`.
3. **It returns `null` when it cannot tell.**

And the scar, in a comment that cost someone real debugging:

> `CLAUDE_CODE_ENTRYPOINT` is **inherited by every child process**, so a codex or grok agent spawned
> from a Claude session would be misdetected as claude-code. *"Mislabelling a family is worse than not
> knowing it."*

That sentence is the whole design. A roster showing **"Model not specified"** is honest. A roster
confidently showing **the wrong model** — because the value leaked in from a parent process — is
worse than the blank, and it would be believed.

This is the same shape as everything else this release keeps finding: a confident wrong answer beats
a blank only in appearance.

## Proposed change

**Remove the model question from the human's path.**

- The **agent** reports its own host/model at `create_agent_principal` time, detected the way
  `detectHost()` does it — runtime env first, config as fallback, **`null` when unsure**.
- The **human** is asked for a name, optionally, and nothing else.
- `--model` stays available as an explicit override for the case where detection is wrong and someone
  needs to correct it — but it stops being something anyone is *prompted* for.
- The UI drops the model field entirely and keeps rendering whatever the agent reported.

## Design constraints to carry over, learned here rather than guessed

- **Never infer from an inheritable signal.** The `CLAUDE_CODE_ENTRYPOINT` trap applies directly: our
  listener spawns child processes, so any detection running inside a spawned host must not read a
  variable its parent exported. If a signal can leak across a spawn, it is not evidence.
- **`null` is a valid, honest answer.** Do not add a "best guess" fallback that fills the column with
  something plausible.
- **The agent asserts, the server records.** The server already bounds the field at 120 chars and
  treats it as optional; it should not start *trusting* it for authorization. This is display
  metadata, not identity — `sender_owner_relation` is the field that carries authority, and this
  release already fixed a bug where a replay could change it (D-036 era, `durable-delivery.ts:424`).
  Keep those two firmly separate.
- **Detection belongs in the CLI, not the edge function.** The server cannot see the agent's
  environment and must not try to infer from a user agent string.

## Why the local swarm is the right source

It has run a real multi-host fleet for months — Codex, Claude Code, Grok, Gemini, a2a agents — and
its detection code carries comments explaining what was tried and why it failed. That is exactly the
kind of prior art worth importing rather than re-deriving, and importing the *comment* matters as
much as the code.

## Open question for the operator

Should an agent be able to **change** its reported model after joining (e.g. a host that switches
model mid-session), or is it fixed at principal creation? Fixed is simpler and matches the current
schema; mutable is more truthful but adds a command surface. **Not decided.**
