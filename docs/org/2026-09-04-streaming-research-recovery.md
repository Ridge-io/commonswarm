# Recovery: the streaming "dream feature" research — FOUND

**Written:** 2026-09-04 · **Status:** recovered, verified on disk, and its first slice is already shipped.

The operator asked on 2026-09-04 whether the streaming planning/research project from "a few days ago"
still existed. It does. This file records where it is, what it concluded, what happened to it, and the
one risk that will destroy it.

---

## 1. Where it is

**The report:**
`/Users/yulanbot/Developer/Ridge.io/cloud-swarm/scratchpad/reboot-survival/streaming-investigation.md`

- 41,733 bytes, 431 lines, mtime **2026-09-01 18:27**, md5 `64eae2beed646298c9bf9d681a11b97f`
- Title: `# Streaming into the web UI — design investigation`
- Header: `**Date:** 2026-09-01 · **Branch:** main @ 619ff1f · **Status: investigation only.**`

**It is NOT in git and never was.** `git check-ignore -v` returns `.gitignore:29:scratchpad`. It exists
only as an untracked file in this working tree on `yulanbots-mac-mini`. No commit, no stash, no dangling
object, and no second copy anywhere under `/Users/yulanbot` holds it. **This is why it read as lost.**

**The lane brief cut from it:**
`/Users/yulanbot/Developer/Ridge.io/cloud-swarm/scratchpad/reboot-survival/L35-live-agent-panel.md`
(3,138 bytes, same mtime). Same gitignored directory, same risk.

**The tracked pointer that survives in git:** `docs/org/2026-08-29-RESUME-HERE.md:371-373`.

---

## 2. Provenance — how the work was run

It was a Claude Code **native subagent**, exactly as the operator remembered.

| Item | Value |
|---|---|
| Parent session transcript | `/Users/yulanbot/.claude/projects/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/c7c21373-a768-419a-b116-ef9927e17959.jsonl` |
| The launch prompt in that parent | line **18137** |
| Lead subagent transcript | `.../c7c21373-a768-419a-b116-ef9927e17959/subagents/agent-a077a6382d73ae9db.jsonl` (176 lines; line 1 is the full prompt) |
| Subagent metadata | `agent-a077a6382d73ae9db.meta.json` — `{"agentType":"general-purpose","description":"Investigate live agent streaming","spawnDepth":1,"model":"opus"}` |
| Launched | 2026-09-01T16:35:36Z |

It fanned out to four `Explore` subagents in the same directory (all `spawnDepth:2`,
`parentAgentId:a077a6382d73ae9db`):

- `agent-a797ceaf94264ec82` — "Map dashboard refresh + realtime"
- `agent-ae4aa679857ad4645` — "Map listener + ACP host streaming"
- `agent-a464bd8988be05b6a` — "Map edge functions + DB schema"
- `agent-a2e7f2bdd69ae9e88` — "Dashboard fetch and render paths"

### The operator's ask, verbatim, as it was given to the subagent

> "support streaming responses directly into the frontend ui when agents are sending messages, but also
> that I be able to directly view the TUI of any agent connected to the swarm via streaming so that in
> the web browser i could go and look at exactly what any agent is doing in that moment just as if i
> opened their terminal. i imagine it would be great to have a sidebar [like Slack's profile panel]
> opened whenever i click any agent, and instead of the profile photo it showed their actual TUI and
> any other agent status that are relevant and live."

This is the same ask the operator restated on 2026-09-04. It was split into **Feature A** (streaming
message composition) and **Feature B** (live agent view).

The report was originally told to write to
`/private/tmp/claude-501/.../c7c21373-.../scratchpad/streaming-investigation.md` and was copied into
`scratchpad/reboot-survival/` to survive a reboot. The `/private/tmp` original is gone.

---

## 3. What it concluded

### 3.1 The headline finding

**Feature A is achievable and cheap to capture. Feature B is achievable only as a structured activity
stream, never as a terminal — and the "terminal" half was already ruled out in writing before this
research started.**

The report's own table (§1):

| What the operator asked for | Verdict |
|---|---|
| "see exactly what any agent is doing, as if I opened their terminal", for an agent running through `cswarm listen` | **Achievable as a structured activity stream, NOT as a terminal.** We already receive typed ACP events — message chunks, thoughts, tool calls with titles and statuses, plans. Richer than a scraped pane. It will not look like a TUI. |
| The same, for an agent that only holds a credential and posts with `cswarm note` / `ask` / `reply` | **Not achievable at all.** We are not in that process. We see nothing between posts. This is most agents today. |
| A raw pixel/ANSI copy of a human's interactive terminal (a cmux tab) | **Not achievable, and the repo has already ruled against building toward it.** |

Why there is no terminal to stream (§5.1a, verbatim):

> "**We cannot show a terminal**, because there is no terminal — the child is a JSON-RPC subprocess over
> stdio pipes, not a pty. There are no ANSI frames to forward. A 'TUI view' of a listener agent would be
> something we *render*, not something we *capture*."

The pre-existing decision it collided with, `src/host/stderr-tail.ts:9-16`:

> "That privacy concern is real, so the capture stays **LOCAL-ONLY** … **It must never ride an error
> object** … That is why `AcpChildExitError` carries no tail field **and never will**."

and `docs/design/SWARM-CLOUD.md:992`:

> "**visibility and tunability are met by the structured stream, not by a terminal tab.**"

Recommendation (§5.3): **do not reverse it.** Reversing it is an operator call with its own security
review, listed as Phase 5 "for completeness", not as a phase of this work.

### 3.2 The capture seam already exists

`src/host/session.ts:719` — `this.events.update?.(sanitized)` — fires once per ACP `session/update`
notification, carrying `SanitizedSessionUpdate` (`src/host/types.ts:60-70`): kind, text, toolCallId,
title, status, toolKind. **Those chunks were being consumed and discarded.** Redaction already ran on
that path (`src/host/sanitize.ts`). Nothing had to be invented to capture partial output.

### 3.3 The panel already existed

The Slack-style panel the operator described was already built and already opened on click:
`LiveDashboard.astro:719-740` (markup), `:1951-1965` (`openEntityPanel`), `:1785-1798` (`entityControl`
makes every name a button), view model `site/src/lib/entity-panel.ts:16-56`. Chartered by
`docs/design/contracts/UI-ENTITY-PANEL-GOAL.md` and specified in
`docs/design/2026-08-03-SLACK-SHAPE-UI.md:123-140`.

Report §2.4: "**The operator's ask is precisely: fill in that first field with something live, and put it
where the avatar is.**" §5.2 carries an ASCII mock of the panel with the live box annotated
`← where the avatar is`.

### 3.4 The transport answer

Measured live against production on 2026-09-01 (§3.1):

| Probe | Result |
|---|---|
| Broadcast channel subscribe + round-trip | SUBSCRIBED, round-trip OK |
| Private channel with anon key, no user JWT | `CHANNEL_ERROR — Unauthorized` (authorization active, fail-closed) |
| 2 frames/sec, 400-byte payload, two clients | 20/20 delivered, p50 **54 ms**, max 133 ms |
| ~4/sec | 4 of 20 delivered |
| ~10/sec | 5 of 30 delivered |
| `channel.send()` return at 10/sec | **`{"ok": 30}` for 30 sends of which 5 arrived** |

Two load-bearing findings: usable throughput measured at **~2 frames/sec per channel**, and **the loss is
silent with a success-shaped ack** — so any design must carry a sequence number and treat delivery as
best-effort.

Options table (§3.2): **Realtime Broadcast on a private channel — recommended** (only option with
sub-100 ms latency, working auth, zero new infrastructure; `@supabase/realtime-js` was already a
transitive dependency). Rejected: `postgres_changes` (browser reads go through the `swarm_read.signals`
**view**, and views cannot join a publication — it would deliver nothing; and a `postgres_changes`
subscribe returns `SUBSCRIBED` even for `nosuchschema.nope`, so `SUBSCRIBED` is not evidence);
SSE from an edge function (possible but worse — no streaming response exists anywhere in `supabase/`,
and the wall-clock ceiling forces reconnects); polling a tail table (`SIGNAL_CREDENTIAL_LIMIT` is
120/hour per credential); storage blobs; WebRTC (against the architecture).

### 3.5 The obstacle nobody would have guessed

§4.4: `renderFeed` calls `list.replaceChildren()` at `LiveDashboard.astro:3431` and rebuilds the whole
transcript every 2 seconds, with no keying and no diffing. A provisional streaming bubble appended into
that `<ul>` gets wiped twice per second. The recommended way out is to render the provisional bubble
**outside** the `<ul>` as a sibling element, leaving `renderFeed` untouched — which keeps Feature A
MEDIUM instead of LARGE.

### 3.6 Privacy model

Opt-in per listener at start (`--share-activity`, **default off**); the CLI states what it shares once at
start; presence visible both ways. Watch scope: **operator-only first**, widen deliberately — "narrowing
after teammates have been watching each other's machines is a retraction." Redaction: port
`stderr-tail.ts`'s `CREDENTIAL_PREFIX_RE` and its zero-width-joiner normalisation into a shared module;
**do not write a second redactor.** And §6.4: no copy on the panel may assert who can or cannot see
something.

### 3.7 The phased plan

| # | Phase | Size | Shipped? |
|---|---|---|---|
| 1 | Live status in the entity panel (listener publishes a coalesced status frame; panel subscribes; honest not-instrumented state) | M | **YES** |
| 2 | Tool-call activity log in the panel | S | **YES** (same commit) |
| 3 | Streaming reply text — Feature A, provisional bubble in the transcript | M | **NO** |
| 4 | Realtime wake for the feed (hint only; cursor replay stays delivery-of-record) | S–M | **NO** |
| 5 | Raw terminal view — the literal ask | L | **NO. Not recommended.** Needs a reversal of `src/host/stderr-tail.ts:9-16` and its own security review. |

---

## 4. What happened to it — the first slice shipped

The report did not die in the scratchpad. It became lane **L35**, and L35 landed.

**Commit `f5304a0d15a5a92dd4a2dbe5c80f5d3695a5b5e8` — "Add private live agent activity panel", 2026-09-01
22:06:58 -0500.** 23 files, +1807/-74. It reached `main` through `release/0.1.46`.

Files it produced, all present on `main` today:

- `src/listener/activity.ts` — the coalescer. `ACTIVITY_FRAME_INTERVAL_MS = 750`, `ACTIVITY_HEARTBEAT_MS = 15_000`
- `src/host/credential-redaction.ts` — the shared redactor the report demanded, extracted out of `stderr-tail.ts`
- `site/src/lib/agent-activity.ts` — browser side, including the `"not-instrumented"` state and the copy `"Not instrumented — this agent has no listener"`
- `site/src/components/app/ActivityFeed.astro`
- `supabase/functions/activity/{index,core}.ts`
- `supabase/migrations/20260902000003_realtime_agent_activity.sql`
- `tests/listener-activity.test.ts`, `tests/p1-local/activity-realtime-auth.test.ts`
- `LiveDashboard.astro` wiring: `subscribeAgentActivity` at `:1835`, `[data-agent-activity]` at `:1827/:1906`

So the panel with a live section where the avatar would be **exists in production today** for
listener-run agents, and says "not instrumented" for the rest.

### The measurement the report demanded was re-run and moved

The report said §3.1's ~2 frames/sec was load-bearing and must be re-measured before choosing a frame
rate. L35 did re-measure: **10 frames/s in a short window** — recorded in
`docs/org/2026-08-29-RESUME-HERE.md:943`. The shipped coalescer runs at 750 ms (~1.33 frames/s), well
under both numbers. **The true saturation ceiling is still deliberately deferred** and is listed as such
in that same line.

---

## 5. What was NOT established, then and now

From the report's own §8 (still open):

1. Whether the Realtime rate ceiling is per-channel, per-client, or a project quota, and whether it is raisable. **Still deferred.**
2. Whether `realtime.send()` (broadcast-from-database) is available on this project. Not called.
3. The edge-function wall-clock limit on this project. Not verified (only matters if SSE is ever chosen).
4. Whether Cloudflare buffers `text/event-stream` on `api.commonswarm.com`.
5. Realtime cost on this plan. Nobody has looked at it.
6. Whether the four providers differ in chunk granularity. Read from the shared ACP path only.
7. Whether presence-gating the publish is worth it.
8. The report ran **no live listener**. Every claim about the ACP event stream was read from source, not observed in flight; chunk granularity ("a few tokens to a sentence") was inferred, not measured.

Corrections the report found in other artifacts (§8 items 10-13), which should be checked before anyone
trusts those documents: `UI-ENTITY-PANEL-GOAL.md` says the `read` function is not deployed (**dead** — it
is deployed, measured 405-vs-404) and cites `AgentAccessStatus` at a stale line; `supabase/config.toml`
cites stale `command/index.ts` line numbers; `command/index.ts:655` describes a "Realtime fan-out" that
did not exist at the time.

### Established by this recovery, on 2026-09-04

- The report does **not** discuss `stream-json`, `--output-format stream-json`,
  `--include-partial-messages`, `xterm.js`, tmux `capture-pane`, or asciinema. Those terms are absent
  from the file. It answers "how do agent CLIs expose streaming data" purely through the ACP path and
  argues a pty/ANSI route is the wrong shape. If a separate CLI-mechanism survey was ever written, **it
  is not on this disk.**
- `scratchpad/reboot-survival/L42-live-bridge-measurement.md` is **not** a follow-up to this work. It is
  the ACP provider-version/bridge measurement lane. Do not cite it as the streaming re-measurement.
- No `L35-report.md` exists in `scratchpad/reboot-survival/`. The lane's own report was not written back
  to that directory, so the L35 measurement detail survives only as the one line in
  `docs/org/2026-08-29-RESUME-HERE.md:943`.

---

## 6. The risk

**The report and its lane brief live under a gitignored `scratchpad/` directory on one machine.** Any
`git clean -xdf`, worktree prune, disk wipe, or laptop swap destroys them permanently, and there is no
second copy anywhere on this host. The only surviving trace in git would be three lines in
`docs/org/2026-08-29-RESUME-HERE.md` and the shipped Phase 1 code.

If this work is to be kept, it must be copied into `docs/research/` or `docs/design/` and committed.
That is an operator call — this recovery was read-only and moved nothing.

---

## 7. Search record (so nobody repeats the hunt)

**Found by:** grepping raw Claude Code transcripts for typed human/subagent prompts, and by two parallel
read-only sweeps (git across 24 repos; disk across scratch and CLI state). Both converged on the same
file independently.

**Searched and empty** (recorded so a future hunt starts elsewhere):

- Git: 24 repos under `/Users/yulanbot/Developer/Ridge.io`. `cloud-swarm` has no stashes; ~100 dangling
  commits are all amend/rebase/`cmux last turn baseline` autosaves of known main-line work; exactly one
  dangling blob, an unrelated Python patch script. `log -S'xterm'` and `log -S'stream-json'` are empty in
  every repo. `fireclaw-v2`'s `xterm`/SSE hits are 2026-03 mission-console work; `prompteden-gtm`'s SSE
  hit is a 2026-06 pipeline API; `swarm`'s "streaming" hit is stdout-to-logfile.
- `/Users/yulanbot/.claude/todos/` — **does not exist**.
- `/Users/yulanbot/.claude/plans/` — 3 files, none related.
- `/Users/yulanbot/.claude/history.jsonl` — 2 "streaming" lines, neither related.
- `find /Users/yulanbot/.claude -type d -name memory` — no such directory.
- `/tmp`, `/private/tmp`, `/var/folders/**/T/` — name-pattern sweep since 2026-08-24: no match. The
  original `/private/tmp/claude-501/.../scratchpad/streaming-investigation.md` is **gone**.
- `/Users/yulanbot/Documents`, `/Desktop`, `/Downloads` — zero `.md` files modified since 2026-08-24.
- `/Users/yulanbot/.cmux/` — only `hooks/`, no session logs. `Library/Application Support/cmux/` does not
  exist. `/Users/yulanbot/.codex/` — history.jsonl has no match; session state is a 400 MB SQLite blob
  that was **not** parsed.
- CommonSwarm brain (36 topics) and `docs/org/*RESUME-HERE.md` — excluded from this hunt by instruction;
  the resume file was nevertheless the one tracked pointer that corroborated the find.

**Adjacent but explicitly NOT the target:** `docs/research/ACP-AND-BUZZ.md` (2026-07-24/28),
`docs/research/AGENT-ORCHESTRATION-UX.md`, `docs/design/2026-08-03-SLACK-SHAPE-UI.md`,
`docs/design/contracts/UI-ENTITY-PANEL-GOAL.md` (commit `efbe2e5`, 2026-08-04) — the last two are cited
*by* the report and are its inputs, not it. `/Users/yulanbot/Developer/Ridge.io/CLI_AGENT_ROUTING.md:56`
is where `--output-format stream-json --include-partial-messages` lives on this disk; it is a 2026-05/06
routing cheat-sheet and is unrelated.

**Not reached:** the `.codex/logs_2.sqlite` session store was not queried. If anyone still believes a
separate CLI-streaming survey exists, that is the one place left to look.
