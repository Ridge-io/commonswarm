# Agent-authorship commit trailers

Every commit records the model that wrote it, so past work can be audited as new models ship.

**This tags work from now on. Past commits are not labelled and must not be backfilled.**
See [No backfill](#no-backfill) — it is the one rule that keeps the audit worth reading.

---

## The trailer block

A commit written by an agent gets a block like this in its message footer:

```
Agent-Name: CSwarmDevLead
Agent-Model: claude-opus-5
Agent-Family: anthropic
Agent-Tool: claude-code 2.1.257
Agent-Model-Source: runtime-transcript
```

| key | meaning |
|---|---|
| `Agent-Name` | the seat, not the model. Defaults to `git config user.name`. |
| `Agent-Model` | the model id, **read off the runtime**. Required. |
| `Agent-Family` | the family of the **model**, not of the tool. Required. |
| `Agent-Tool` | the agent CLI and its version. |
| `Agent-Model-Source` | how `Agent-Model` was obtained. The audit's honesty field. |
| `Agent-Human-Edit` | `yes` when a person changed the diff an agent produced. |
| `Reviewed-By-Model` | one D-036 review arm. May repeat; git keeps every occurrence. |

The accepted values live in `scripts/lib/agent-trailer-vocab.sh` and nowhere else. Every list
printed by the scripts — required keys, families, sources, supported runtimes — is built from
those arrays at print time, so this table is documentation and the arrays are the definition. If
they ever disagree, `tests/p1-cli/agent-trailers.test.ts` fails.

### `Agent-Model-Source` is the field to read first

| value | what it means |
|---|---|
| `runtime-transcript` | read out of the agent's own live session record. A measurement. |
| `runtime-env` | read out of a variable the runtime itself set. A measurement. |
| `runtime-config` | read out of the runtime's session-scoped state on disk. A measurement. |
| `declared` | a person or a lead supplied it. **An assertion, not a measurement.** |
| `none` | nothing readable; `Agent-Model` is the `unknown` sentinel. |

An audit that treats `declared` and `runtime-transcript` as the same quality of evidence is
measuring what people remembered to type, which drifts in the flattering direction.

### Two sentinels, deliberately distinct

- `Agent-Model: none`, `Agent-Family: human` — no agent wrote this. A person did.
- `Agent-Model: unknown`, `Agent-Family: unknown` — an agent wrote it, and its runtime exposed
  nothing we could trust.

Both pass the gate. They answer different questions, and collapsing them would lose the
difference between "not applicable" and "not established".

---

## How the model is read

**The model string is read from the runtime, never typed.** A hand-typed model name is a claim
with no control on it, and it goes stale the day a seat is upgraded — silently.

No runtime on this machine exports its model as an environment variable. Enumerated 2026-09-04 by
running `env` inside a live session of each and by scanning the installed binaries for the
variables they set. Three of four can still be recovered, always the same way: an environment
variable carries a **session id**, and a session record the runtime wrote carries the model.

| runtime | model | mechanism | source recorded |
|---|---|---|---|
| `codex` | yes | `CODEX_THREAD_ID` → `~/.codex/sessions/**/rollout-*-<id>.jsonl`, last `turn_context` → `.payload.model` | `runtime-transcript` |
| `grok` | yes | `GROK_SESSION_ID` → `~/.grok/sessions/*/<id>/summary.json` → `.current_model_id` | `runtime-config` |
| `claude` | yes | `CLAUDE_CODE_SESSION_ID` → `~/.claude/projects/*/<id>.jsonl`, last main-chain `.message.model` | `runtime-transcript` |
| `agy` | **no** | version only, from `ANTIGRAVITY_LS_VERSION` | `none` |

Verified output on this machine, 2026-09-04:

```
$ scripts/agent-trailers.sh --detect          # inside Claude Code
model=claude-opus-5   family=anthropic  tool=claude-code 2.1.257  source=runtime-transcript
$ CODEX_THREAD_ID=<a real thread> scripts/agent-trailers.sh --detect
model=gpt-5.6-sol     family=openai     tool=codex 0.147.0        source=runtime-transcript
$ GROK_SESSION_ID=<a real session> scripts/agent-trailers.sh --detect
model=grok-4.6        family=xai        tool=grok 1.0.13          source=runtime-config
$ ANTIGRAVITY_AGENT=1 scripts/agent-trailers.sh --detect
model=unknown         family=unknown    tool=agy 1.1.26           source=none
```

### Why `agy` returns `unknown`

Every candidate source failed in a way that would produce a **wrong** value rather than no value.
The child environment carries conversation, trajectory and project ids but no model. No settings
file records a selected model. The CLI log prints the `--model` *flag*, which is empty when the
flag is not passed. The per-conversation SQLite trajectory records an internal alias that does not
round-trip: a session launched with `--model gemini-3.1-pro-high` stored `gemini-pro-agent`, and
others stored `gemini-pro-default` or the placeholder enum `MODEL_PLACEHOLDER_M318`.

A wrong automatic answer is worse than an absent one, so `agy` gets the sentinel. A lane that
needs agy's model must declare it.

`Agent-Family` is also left `unknown` for `agy`, and that is not an oversight. `agy models` lists
15 ids including `claude-opus-4-6-thinking` and `gpt-oss-120b-medium`, so the tool being Google's
does not make the model Google's. **The family describes the model, not the tool.**

### Why config files are not read

`~/.codex/config.toml` and `~/.grok/config.toml` both record a `model`, and both record the
**configured default only**. `codex exec -m <other>` and an in-session `/model` switch do not
change them. Reading either would give a confident wrong answer on exactly the lanes worth
auditing — the ones where somebody deliberately chose a different model.

### Detector order is load-bearing

`claude-code` is probed **last**. A Claude Code session that shells out to `grok` or `agy` leaves
every `CLAUDE_*` variable in the child's environment; measured, both probes reported the *parent's*
`CLAUDE_CODE_SESSION_ID`. A detector that tested `CLAUDECODE` first would label every nested lane
as Claude Code and sign another family's work with Anthropic's name.

**The residual, stated because it is the one way this can produce a confident wrong value.** The
probe order only protects the runtimes that are IN the list. A runtime that is not listed and that
inherits `CLAUDE_*` from a Claude Code parent falls through to the `claude-code` probe, which reads
the *parent's* transcript and records the parent's model with source `runtime-transcript` — a
measurement of the wrong session, and nothing in the trailer says so. `opencode` is the live
example: it is installed on this host and this repo already treats it as a provider
(`tests/host-acp-opencode.test.ts`), and it is not in `AGENT_TRAILER_RUNTIMES`. Its environment was
not enumerated here, so no detector was written for it — writing one from a guess is the defect this
whole file exists to avoid.

If you commit from a runtime that is not in the list, declare the model:

```sh
CSWARM_AGENT_MODEL=<the model> CSWARM_AGENT_FAMILY=<its family> git commit -m "..."
```

The durable fix is to enumerate that runtime's environment and session records the way the four
above were, then add it to `AGENT_TRAILER_RUNTIMES` **before** `claude-code`.

---

## Recording who wrote the diff, not who ran the command

When a lane runs in its own runtime, this is automatic: the hook runs inside that lane's session,
so it reads that lane's model.

When a **lead commits a diff another model wrote**, the lead must say so rather than letting their
own runtime sign for work it did not do:

```sh
CSWARM_AGENT_MODEL=gpt-5.6-sol \
CSWARM_AGENT_FAMILY=openai \
CSWARM_AGENT_TOOL='codex 0.147.0' \
CSWARM_AGENT_NAME=Marque \
  git commit -m "feat: ..."
```

That records `Agent-Model-Source: declared`, which is exactly right — it was asserted, not
measured, and the audit should be able to tell.

## Marking human edits

If a person edits an agent's diff, say so, or the audit credits a model for work a human did:

```sh
CSWARM_HUMAN_EDIT=1 git commit -m "fix: ..."
```

This adds `Agent-Human-Edit: yes` and leaves the model fields alone: the agent still wrote most of
it, and both facts matter.

## Recording review arms

`Reviewed-By-Model` records a D-036 arm. Git keeps repeated trailer keys, so add one per arm:

```
Reviewed-By-Model: grok-4.6 (xai) VERDICT=PASS
Reviewed-By-Model: gemini-3.1-pro-high (google) VERDICT=PASS
```

Over time this answers a question the repo currently tracks by hand: which reviewer family finds
real defects.

---

## Escape hatch: a commit with no agent author

A person wrote it by hand. Say so explicitly rather than leaving the field blank — a blank field
is indistinguishable from a forgotten hook, which is the thing the gate exists to catch.

```sh
CSWARM_AGENT_MODEL=none git commit -m "docs: fix a typo"
```

That produces `Agent-Model: none`, `Agent-Family: human`, `Agent-Model-Source: declared`, and the
gate accepts it.

If an **agent** wrote it but the runtime exposed no readable model, the honest value is the other
sentinel:

```
Agent-Model: unknown
Agent-Family: unknown
Agent-Model-Source: none
```

The emitter produces this automatically. **Do not type a model name you did not read off the
runtime.** A wrong value passes the gate and is invisible forever after; an `unknown` is a hole
you can see and count.

Merge commits are exempt. Their message is written by git or GitHub, not by an agent, and their
parents carry the trailers.

---

## No backfill

**Commits made before this existed have no trailers, and must not be given any.**

Nobody can reliably recover which model wrote a commit from 2026-07. Reconstructing it from
memory, from a session log that may not exist, or from "that lane was usually Codex" produces
data that looks exactly like a measurement and is not one. That would poison the comparison the
trailers exist to support: a model's measured performance would be contaminated by guesses made
about it after the fact, in the direction of whatever the person doing the backfill believed.

If you need to know who wrote something older, say "not established" and stop.

### Grace: a commit whose own tree has no hook

Two things keep the gate off old work, and both are needed.

The workflow resolves only the commits a push or PR **adds**, so it never walks all of history.
That alone is not enough: a `pull_request` event checks `base.sha..HEAD`, which contains every
commit a branch already had before this landed. Enumerated 2026-09-04 on this checkout, eleven
branches carried twenty non-merge commits with no `Agent-Model` between them. Every one would have
failed the first time it was pushed or opened as a PR, for work written before the rule existed.

So the checker also skips by what the commit itself contains:

> **A commit whose own tree does not contain `scripts/hooks/prepare-commit-msg` is not required to
> carry trailers.** Every commit that does contain it is.

**A date was tried first and does not work.** Six of those twenty commits were authored *after* the
hour this feature was written, by five lanes that were running at that moment off an older `main`.
Their checkouts had no hook and could not have had one, so a cutoff timestamp failed work for a rule
that did not exist where it was written. Moving the date forward does not fix it either: a cutoff in
the future skips every commit and leaves the gate green while checking nothing. The commit's own
tree answers the question exactly, with no clock and nothing to maintain. Once this is on `main`,
every commit built on it carries the hook and is checked; there is no cutoff to update and no window
in which the rule is wrong.

The path is a constant, `AGENT_TRAILER_HOOK_PATH` in `scripts/lib/agent-trailer-vocab.sh`. The gate
reads it, `--help` prints it, the failure message names it, and `npm run hooks:install` installs
into the same directory, so the enforcement and the sentences describing it cannot drift apart.

- **Skipped commits are counted and reported separately**, never folded into the checked count:
  `agent-trailers OK: 3 commit(s) checked in ...; 1 skipped as having no ... in their own tree`. A
  gate that silently drops commits from its own total tells a reader that work was audited when it
  was not.
- **The path must name a real file.** A constant pointing at nothing would skip every commit and
  leave the gate green while checking nothing. The self-test carries one assertion whose only job is
  to fail on that, because the fixtures are built from the constant and therefore cannot notice it.
- **Scope.** Deleting the hook would grant a commit grace. That is the same accident-guard scope as
  the rest of this — it catches a checkout that never had the hook, not somebody who means to evade
  it — and unlike a back-dated commit, deleting the hook is a visible line in the diff.

---

## Setup and enforcement

```sh
npm run hooks:install     # git config core.hooksPath scripts/hooks
```

Two layers, deliberately:

- **`scripts/hooks/prepare-commit-msg`** — ergonomics. It adds the block so nobody has to
  remember. It **never blocks a commit**: if the emitter fails it warns and exits 0, because a
  trailer tool that stops work gets turned off, and then the audit has holes in it.
- **`.github/workflows/agent-trailers.yml`** — the guard. `--no-verify` skips the hook and a
  standing ruling permits that, so the hook cannot be the guard.

**What "guard" does and does not mean today.** Probed 2026-09-04: `main` has no branch protection
and no rulesets on it, so a failing check shows a red X and blocks nothing. Read the job. Making it
actually block a merge is a repository setting, not a file in this repo, and nobody has flipped it.
Do not read the workflow's existence as a merge gate until that is done.

### What the gate does not do

It is an **accident guard**, the same scope as `scripts/check-commit-identity.sh`.

- GitHub runs the workflow that ships **with the ref under test**, so a change that edits the
  workflow, the checker, or the vocabulary passes both. It cannot stop someone who means to.
- It **cannot verify that a trailer is true**. `Agent-Model: claude-opus-5` typed by a human is
  indistinguishable from one read off a runtime. `Agent-Model-Source` is what lets a later reader
  weigh them differently.

What it does buy: the field is never silently absent, and absence is the failure mode that
correlates with the commits most worth auditing.

### The gate is mutation-tested on every run

`scripts/check-agent-trailers.sh --self-test` builds a commit with no trailers and requires the
checker to reject it, then requires it to accept the same commit once tagged. CI parses the
assertion count out of the output and fails if it is missing or below a floor — an exit code
cannot certify that a test run happened.

Measured 2026-09-04 on this host: 37 assertions pass, and a checker mutated to always return 0
fails 7 of them. The number grows as assertions are added, so CI floors it rather than pinning it;
the floor is what tells "the suite did not run" apart from "the suite passed".

Fix commits that are missing trailers:

```sh
git commit --amend --no-edit                                   # the last one
git rebase -r --exec 'git commit --amend --no-edit' <base>      # several
```

---

## Auditing

The whole point — one command, offline, no API:

```sh
# every commit and the model that wrote it
git log --format='%h %(trailers:key=Agent-Model,valueonly) %s'

# how much work each model did
git log --format='%(trailers:key=Agent-Model,valueonly)' | sort | uniq -c | sort -rn

# only the measured ones; declared values are assertions
git log --format='%(trailers:key=Agent-Model-Source,valueonly)' | sort | uniq -c

# which review families signed off
git log --format='%(trailers:key=Reviewed-By-Model,valueonly)' | sort | uniq -c
```

Trailers live in the commit object, so they survived this repo's 2026-08-10 move — which created
`Ridge-io/commonswarm` rather than renaming, rewriting history and changing every SHA. Labels
would not have.

For a PR body, generate the block from the commits rather than typing it:

```sh
scripts/pr-agent-trailers.sh origin/main..HEAD
```
