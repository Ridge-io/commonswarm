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
| `Agent-Model-Source` | how `Agent-Model` was obtained. The audit's honesty field. Required. |
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
| `runtime-config` | read out of the runtime's session-scoped state on disk. A measurement. |
| `runtime-ambiguous` | more than one runtime's variables were visible, so the model may belong to a **parent** session. Weaker than any other `runtime-*` value. |
| `declared` | a person or a lead supplied it. **An assertion, not a measurement.** |
| `none` | nothing readable; `Agent-Model` is the `unknown` sentinel. |

An audit that treats `declared` and `runtime-transcript` as the same quality of evidence is
measuring what people remembered to type, which drifts in the flattering direction.

### Two sentinels, deliberately distinct

- `Agent-Model: none`, `Agent-Family: human` — no agent wrote this. A person did.
- `Agent-Model: unknown`, `Agent-Family: unknown` — an agent wrote it, and its runtime exposed
  nothing we could trust.

**The family beside `unknown` is not always `unknown`.** A runtime keeps whatever family it can
establish without reading a model. Claude Code serves Anthropic models and nothing else, so an
unreadable transcript still gives `Agent-Model: unknown`, `Agent-Family: anthropic`,
`Agent-Model-Source: none` — measured, not assumed. `agy` is the opposite case and that is why it
differs: `agy models` lists 15 ids including `claude-opus-4-6-thinking` and `gpt-oss-120b-medium`,
so the tool being Google's says nothing about the family, and it stays `unknown`. The rule is the
same in both places — the family describes the MODEL — and it lands differently because the two
runtimes differ.

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
| `claude-code` | yes | `CLAUDE_CODE_SESSION_ID` → `~/.claude/projects/*/<id>.jsonl`, last main-chain `.message.model` | `runtime-transcript` |
| `agy` | **no** | version only, from `ANTIGRAVITY_LS_VERSION` | `none` |

Measured on this machine, 2026-09-04. **Each line says what its environment was**, because that is
the thing being measured: setting another runtime's variable on top of a live session is the nested
case, and it now reports `runtime-ambiguous` rather than the clean source a reader might expect.

```
# a live Claude Code session, nothing else set
$ scripts/agent-trailers.sh --detect
model=claude-fable-5-1  family=anthropic  tool=claude-code 2.1.255  source=runtime-transcript

# one runtime only: the parent's markers cleared first
$ env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID CODEX_THREAD_ID=<a real thread> scripts/agent-trailers.sh --detect
model=gpt-5.6-sol       family=openai     tool=codex 0.147.0        source=runtime-transcript
$ env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID GROK_SESSION_ID=<a real session> scripts/agent-trailers.sh --detect
model=grok-4.6          family=xai        tool=grok 1.0.13          source=runtime-config

# the NESTED case: a real grok session inside a live Claude Code session, both markers present
$ GROK_SESSION_ID=<a real session> scripts/agent-trailers.sh --detect
model=grok-4.6          family=xai        tool=grok 1.0.13          source=runtime-ambiguous

# agy, whose model is deliberately not read
$ env -u CLAUDECODE -u CLAUDE_CODE_SESSION_ID ANTIGRAVITY_AGENT=1 scripts/agent-trailers.sh --detect
model=unknown           family=unknown    tool=agy 1.1.26           source=none
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

**Ordering is only half the answer, and saying otherwise was wrong.** Inheritance is symmetric. A
codex session that shells out to grok leaves `CODEX_THREAD_ID` in the child exactly as Claude Code
leaves `CLAUDE_*`, and codex is probed *first*. Measured 2026-09-04 from inside a Claude Code
session, `CODEX_THREAD_ID=fake scripts/agent-trailers.sh --detect` reported `tool=codex` and
discarded the Claude Code model it could otherwise read. An order can only ever be right for one
nesting direction, and this one is right for the nesting this repo runs: a Claude Code lead
spawning codex, grok or agy lanes.

So each entry in `AGENT_TRAILER_RUNTIMES` also names the environment variable that marks its
runtime, and the emitter counts how many are set:

- **one marker** — a clean read. The source stays `runtime-transcript` / `runtime-config`.
- **two or more** — the environment cannot say which runtime is innermost. The order still picks,
  but the source becomes `runtime-ambiguous`, and the PR summary counts it apart from the measured
  ones rather than inflating them.

**The other residual: a runtime that is not in the list at all.** It inherits the parent's
variables, matches nothing itself, and so raises the count by nothing — it falls through to the
parent's probe and is recorded as a clean measurement of the wrong session. `opencode` is the live
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

**Squash merges are exempt too, and they are not merge commits.** GitHub writes a *single-parent*
commit on the default branch whose message it generated from the PR, so the merge exemption does not
reach it and its tree contains the hook, so grace does not either. Measured on this repo's `main`:
`cf17894` and `297f1a4` are single-parent commits committed by `noreply@github.com`. Without the
exemption the first squash merge after this lands turns `main` red for a message no agent wrote.
The exemption keys on that committer address, which `scripts/check-commit-identity.sh` already
allows for the same reason. It therefore covers every commit GitHub generated — squash merges,
rebase merges, and edits made in the web UI — which is the intent: GitHub wrote those messages, so
no agent can be recorded as their author.

It is **narrow on purpose**: the author must not be that address as well. A squash merge keeps the
PR author (measured on `main`: `cf17894` and `297f1a4` are committed by GitHub and authored by
`tom@ridge.io`), while somebody running `git config user.email noreply@github.com` would set both
and stay caught.

**It does not close the evasion, and claiming that would be the defect this page keeps warning
about.** `GIT_COMMITTER_EMAIL=noreply@github.com git commit ...` sets only the committer and slips
through. Nothing in a repository can stop that: the only proof a commit came from GitHub is its
web-flow signature, which a runner cannot verify without the key. What the author test buys is that
the exemption cannot be turned on by a config somebody set once and forgot — it takes a deliberate
per-commit override. That is the accident-guard scope stated everywhere else here, and
`scripts/check-commit-identity.sh` has the same property with the same address.

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

The workflow resolves only the commits a push or PR **adds**, so it never walks all of history. It
resolves that range from `github.event.before` or the PR base, and falls back to `origin/main..HEAD`
and then to `HEAD~1..HEAD` when neither is reachable — a force-push to the default branch lands on
the first fallback and yields an EMPTY range, and the last fallback reads only one commit. The job
prints a warning annotation when the range it checked was empty, because a green check that audited
nothing looks the same as one that audited everything.
That alone is not enough: a `pull_request` event checks `base.sha..HEAD`, which contains every
commit a branch already had before this landed. Enumerated 2026-09-04 on this checkout, eleven
branches carried twenty non-merge commits with no `Agent-Model` between them. Every one would have
failed the first time it was pushed or opened as a PR, for work written before the rule existed.

So the checker also skips, and it asks **two** questions:

> **A commit must carry trailers only when BOTH are true: `scripts/hooks/prepare-commit-msg` is in
> its own tree, and it was authored at or after `AGENT_TRAILER_GRACE_BEFORE`.** Fail either and it
> is skipped.

**Neither question is enough on its own, and both failures were measured rather than argued.**

*The tree alone loses to a rebase.* A rebase replays an old commit onto a new base, so the commit's
tree picks up the hook from that base, while `git rebase` never runs `prepare-commit-msg`. The old
work ends up untagged **and** on the checked side. Measured 2026-09-04 in a fixture repo: a commit
with no hook in its tree had one after `git rebase` onto a base that carried it, still with no
trailers. That would force exactly the backfill this page forbids, on every old lane that rebases in
order to merge — which is all of them.

*The date alone loses to concurrent lanes.* Six of those twenty commits were authored **after** the
hour this feature was written, by five lanes running at that moment off an older `main`. Their
checkouts had no hook and could not have had one. Moving the date forward does not help either: a
cutoff in the future skips every commit and leaves the gate green while checking nothing, so the
self-test asserts the cutoff is in the past.

Together they cover each other, and neither needs maintaining: the date never moves, and the tree
answers for anything built before this landed.

Both live in `scripts/lib/agent-trailer-vocab.sh` as `AGENT_TRAILER_HOOK_PATH` and
`AGENT_TRAILER_GRACE_BEFORE`. The gate reads them, `--help` prints them, the failure message names
them, and `npm run hooks:install` installs into the same directory, so the enforcement and the
sentences describing it cannot drift apart.

- **Author date, not committer date.** A rebase rewrites the committer date and leaves the author
  date alone, which is the same reason the tree test is not enough by itself.
- **Skipped and exempt commits are counted and reported apart from the checked ones.** The gate
  prints `N of M commit(s) checked`, then a line for each of the two reasons the rest were not.
  Nothing read an exempt commit's trailers either, so counting one as checked tells a reader the
  audit opened a commit it never opened.
- **The path must name a real file and the cutoff must be in the past.** Either one broken would
  skip every commit and leave the gate green while checking nothing. The self-test carries one
  assertion for each, because its fixtures are built from those constants and so cannot notice them
  going wrong.
- **Scope.** Deleting the hook, or back-dating a commit, would grant it grace. That is the same
  accident-guard scope as the rest of this: it catches a checkout that never had the hook, not
  somebody who means to evade it.
- **The one case the conjunction does not cover: old work rebased after the cutoff.** A lane that
  branched before the hook existed, committed after the cutoff, and then rebases onto `main` ends up
  with the hook in its tree and an author date past the cutoff, so it is checked. There is no way
  left to tell it apart from work written with the hook — the original commits are gone. **Do not
  `--amend` those in your own session**: your runtime would sign for a model that did not write
  them, which is the wrong answer the sentinels exist to prevent. Tag them with the `unknown`
  sentinel, or declare the model if you know it:

  ```sh
  CSWARM_AGENT_MODEL=unknown CSWARM_AGENT_FAMILY=unknown \
    git rebase -r --exec 'git commit --amend --no-edit' <base>
  ```

  The gate's failure message says the same thing, because this is the moment somebody reaches for a
  plausible guess.

---

## Setup and enforcement

```sh
npm run hooks:install     # git config core.hooksPath scripts/hooks
```

`core.hooksPath` **replaces** the hooks directory for the whole checkout: git stops reading
`.git/hooks/` entirely, so any local hook you keep there stops running, silently. This checkout had
none when that was probed on 2026-09-04. If yours does, move it into `scripts/hooks/` or skip the
install. To undo:

```sh
git config --unset core.hooksPath
```

The setting is per checkout and per clone, which is what makes the hook opt-in: nothing in
`npm install` sets it, and `tests/p1-cli/agent-trailers.test.ts` fails if any lifecycle script
starts to.

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

What it does buy: no required field is ever silently absent, and absence is the failure mode that
correlates with the commits most worth auditing. `Agent-Model-Source` is one of the required ones
for exactly that reason — a bare `Agent-Model` with no source leaves a reader unable to tell a
measurement from something somebody typed, which is the distinction the whole page rests on.

### The gate is mutation-tested on every run

`scripts/check-agent-trailers.sh --self-test` builds a commit with no trailers and requires the
checker to reject it, then requires it to accept the same commit once tagged. CI parses the
assertion count out of the output and fails if it is missing or below a floor — an exit code
cannot certify that a test run happened.

**The count is deliberately not written down here.** It grows every time an assertion is added, and
a number in prose goes stale silently — this paragraph has already been wrong twice. CI floors the
count instead, which is what tells "the suite did not run" apart from "the suite passed". Run
`npm run check:agent-trailers` to see the current figure.

What is worth recording is the mutation result, because it is a property rather than a number:
measured 2026-09-04, a checker mutated to always return 0 fails several of these assertions, and a
hook path pointing at no file fails the one assertion that exists only to catch a gate skipping
every commit.

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
