# Onboarding field audit — what we ask that we could detect

Applying `AGENTS.md` § *Onboarding: ask for the minimum, detect the rest*. Audited 2026-08-04 against
`main` at `cecb9f2`. **Post-0.1.5; nothing here is a v0.1.5 change.**

## The web surface is already close

`/start` and `/app` ask for an email address and nothing else. The dashboard's only other inputs are
an invite email and a roster filter. No field here is a candidate for removal.

## The CLI is where the principle is broken

`cswarm listen start` (`src/cli.ts:324`) presents **thirteen** flags:

```
--agent-token-stdin [--url <url> --anon-key <key>] --workspace-id <uuid>
[--provider grok|opencode] [--cwd <absolute-path>] [--model <model>] [--effort <level>]
[--permissions deny|allow] [--grok-executable <path>] [--opencode-executable <path>]
[--foreground] [--json]
```

This is the surface a person meets when connecting their first agent — the step that decides whether
the product works for them. Four of these can be answered by the system.

| Flag | Today | Could be | Notes |
|---|---|---|---|
| `--provider` | defaults to `"grok"` (`cli.ts:2547`) | **detected** | The environment says which agent CLI is running. `swarm/src/hooks.ts` `detectHost()` is the prior art. A fixed default of `grok` is wrong for every opencode user, and wrong silently. |
| `--workspace-id` | **required** | **detected when unambiguous** | `src/cloud/workspaces.ts:602` already lists a session's workspaces. A user with exactly one workspace is being asked to paste a UUID the system can see. Ask only when the count is greater than one. |
| `--grok-executable` / `--opencode-executable` | explicit path | **resolved from `PATH`** | Both binaries are normally on `PATH`. Keep the flags as overrides. |
| `--model` | explicit | **removed from the prompt** | Already designed: `docs/design/2026-08-03-AGENT-SELF-IDENTIFY.md`. |

Target: **`cswarm listen start --agent-token-stdin`** for the common case, with every other flag
available as an override.

## The constraint

Each detection must return a value or nothing, per `AGENT-SELF-IDENTIFY`'s scar: a Codex agent spawned
from a Claude session detects as claude-code if you read an inherited variable, and *"mislabelling a
family is worse than not knowing it."*

Applied here:

- **`--provider` detected wrongly launches the wrong runtime.** If detection is uncertain, ask. Do not
  fall back to a fixed `grok`, which is today's behaviour and is a silent wrong answer rather than a
  question.
- **`--workspace-id` must not be guessed.** Auto-select only at a count of exactly one. Two workspaces
  means asking, because posting a signal into the wrong workspace is visible to the wrong people.
- **Executable resolution should report what it chose**, so a wrong `PATH` entry is diagnosable.

## What this audit does not cover

The invite-acceptance path, `cswarm login`, and workspace creation were not audited. The counts above
are of flags in the usage string, not of the arguments a user typically supplies — someone following
the connect prompt may already pass fewer.
