# Streaming "dream feature" — second recovery sweep

**Written:** 2026-09-04 · **Lane:** read-only recovery · Nothing was edited, moved, or committed.

## Verdict

**Recovered in full.** The design work survives, is byte-identical to the original, and is already
committed to `main` as `6e43370`. Its first two phases are shipped code in production.

Commit `6e43370` captured the *output* completely. This sweep closes the one lead that recovery left
open, and identifies four *provenance* artifacts still transcript-only. None changes the design.

## 1. State of the recovery commit

`6e43370`, 3 files, +744 lines: `docs/research/2026-09-01-streaming-into-the-web-ui.md` (431),
`docs/research/2026-09-01-L35-live-agent-panel.md` (24),
`docs/org/2026-09-04-streaming-research-recovery.md` (289).

Fidelity verified by md5 this sweep:

```
64eae2beed646298c9bf9d681a11b97f  docs/research/2026-09-01-streaming-into-the-web-ui.md
64eae2beed646298c9bf9d681a11b97f  scratchpad/reboot-survival/streaming-investigation.md
9184ad1129a785102b9997957550fab4  docs/research/2026-09-01-L35-live-agent-panel.md
9184ad1129a785102b9997957550fab4  scratchpad/reboot-survival/L35-live-agent-panel.md
```

The committed copies are the *final, edited* 41,733-byte version — not the 36,481-byte first `Write`
the transcript captured. Git now holds the better copy. The risk named in the recovery memo §6 is closed.

Sections confirmed present: `1. Executive summary`, `2. What exists today`, `3. Transport options`,
`4. Feature A — streaming message composition`, `5. Feature B — the live agent view`,
`6. Privacy and security model`, `7. Phased plan`, `8. Open questions and what I could NOT establish`.

## 2. What this sweep newly established

### 2.1 The Codex session store — the prior recovery's one open lead — is EMPTY

The memo closed with: *"**Not reached:** the `.codex/logs_2.sqlite` session store was not queried. If
anyone still believes a separate CLI-streaming survey exists, that is the one place left to look."*

It was queried. **It is not there.**

`/Users/yulanbot/.codex/thread_history_1.sqlite` (93 MB, 11,063 rows in `thread_items`):

| Probe | Rows |
|---|---|
| `stream-json` | 12 |
| `include-partial-messages` | 10 |
| `xterm` | 3 |
| `capture-pane` / `asciinema` / `profile photo` / `live terminal` / `terminal interface` / `streaming-investigation` | 0 |
| `cswarm` (positive control) | 458 |
| `streaming` (positive control) | 47 |

All 12 `stream-json` hits were read in context. All are `commandExecution` or `mcpToolCall` items;
**none is design work**. Three unrelated sources: (1) the OpenClaw routing cheat-sheet echoed into a
shell (2026-09-02 19:47:56, thread `01a063a6`); (2) `codex --help` / `claude --help` output
(2026-08-31 18:45:00, thread `01a0591f`); (3) one `ps` listing — see 2.2.

`/Users/yulanbot/.codex/logs_2.sqlite` (402 MB, 60,115 rows): all five probes 0; `cswarm` control
1,133. `state_5.sqlite` `thread_artifacts`: 0 rows.

**No separate CLI-streaming-mechanism survey was ever written.** Closed against the last place it
could hide.

### 2.2 A relevant technical fact the report never had

The one non-cheat-sheet hit, 2026-09-02 21:23:55, thread `01a063a6` (the L42 bridge lane):

> `16996 16995 S 01:20:12 0.1 0.8 /opt/homebrew/lib/node_modules/@agentclientprotocol/claude-agent-acp/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude --output-format stream-json --verbose --input-format stream-json --permission-prompt-tool stdio --disallowedTools AskUserQuestion --tools default --setting-sources=user,project,local --permission-mode default --allow-dangerously-skip-permissions --include-partial-messages --session-id=46e48ed3-52f0-4854-87ef-44ee37961591 --replay-user-messages`

Measured evidence for the operator's research question. The ACP bridge already launches Claude Code
with `--output-format stream-json` **and** `--include-partial-messages`. The partial-token stream is
produced at the process boundary today; the ACP layer converts it into the `session/update`
notifications the report describes. The report reached the same conclusion from the other end
(reading `src/host/`) without seeing this command line.

### 2.3 The report does NOT survey the CLI streaming flags — confirmed by count

Against `docs/research/2026-09-01-streaming-into-the-web-ui.md`: `stream-json` 0,
`include-partial-messages` 0, `xterm` 0, `capture-pane` 0, `asciinema` 0, `pty` 2. Re-confirms the
memo. The report answers "what do the agent terminals expose" **entirely through the ACP path** —
the correct seam, because that is the layer CommonSwarm owns.

## 3. What commit 6e43370 did NOT capture

All four are provenance, not design. All are still only in Claude Code transcripts.

### 3.1 The operator's original typed words, with the Slack screenshot

`/Users/yulanbot/.claude/history.jsonl` line **12175**, and
`/Users/yulanbot/.claude/projects/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/c7c21373-a768-419a-b116-ef9927e17959.jsonl`
line **18127** (line 18122 is the enqueue at `2026-09-01T16:29:32Z`):

> "spin up a subagent (opus 5) to thuroughly investigate how we could support streaming in the app.
> My dream scenario is that we support sreaming responses directly into the frontend ui when agents
> are sending messages, but also that I be able to directly view the TUI of any agent connected to
> the swarm via streaming so that in the web browser i could go and look at exactly what any agent
> is doing in thatmoment just as if i opened their terminal minalm **[Image #39]** i imagine it
> would be great to have a sidebar like this opene wheever i click any agent, and instead of the
> profile photo of lori like in this example, it showed their actual TUI and any other agent status
> that are relevant and live"

The committed memo quotes a cleaned-up paraphrase. Two things are lost: the ask came with **an
attached Slack screenshot** (`[Image #39]`, the profile panel of a person named Lori), and the
phrase was "dream **scenario**", never "dream feature".

### 3.2 The full research brief

`.../c7c21373-a768-419a-b116-ef9927e17959/subagents/agent-a077a6382d73ae9db.jsonl` **line 1** — a
~5,000-character, 8-section brief. The commit quotes only the dream paragraph out of it. Its six
demands: (1) name the exact seams where partial output could be captured; (2) enumerate real
transport options with measured constraints; (3) reconcile streaming against "Durable by default";
(4) *"BE HONEST: if 'exactly what any agent is doing' is only achievable for listener-run work, say
so plainly … this product has a hard rule against surfaces that imply more than they measure"*;
(5) the privacy/redaction model, citing the prior credentials-in-`ps`-argv incident; (6) effort
sizing with a first shippable slice.

Dispatch: parent session line **18137** (`Agent` tool_use, model `claude-opus-5[1m]`), line **18138**
(`agentId: a077a6382d73ae9db`, `2026-09-01T16:35:36Z`). Meta:
`{"agentType":"general-purpose","description":"Investigate live agent streaming","spawnDepth":1,"model":"opus"}`.

### 3.3 The subagent's own closing summary

`agent-a077a6382d73ae9db.jsonl` **line 176**, 3,817 characters. Not identical to the report; carries
two operational notes the report does not:

> "**Feature B splits three ways, and the split is the honest answer:** Listener-run agents
> (`cswarm listen`): we can show a rich structured activity view — phase, current tool with title,
> streaming text. **Not a terminal.** … Credential-holding agents (most of them): **nothing is
> observable between posts.** … A human's cmux tab or interactive session: **flatly impossible.**"

> "**Usable throughput is about 2 frames/sec per channel.** At 10/sec, 5 of 30 arrived — and **all
> 30 `send()` calls returned `"ok"`.** Silent loss behind a success-shaped ack."

> "**One check first (30 min, no code):** re-measure the Realtime ceiling and look up the project's
> quota. If it really is ~2 frames/sec, that dictates one topic per agent and a 500 ms coalescing floor."

> "Five files are modified in the shared checkout … **Not mine** — mtimes predate my first probe."

### 3.4 The raw sub-research, and the fact that half of it never finished

Four `Explore` subagents were spawned (`spawnDepth:2`, `parentAgentId:a077a6382d73ae9db`). **Two of
the four were interrupted and never reported.** This is new — the memo lists all four as if they
contributed.

| Agent | Topic | Lines | Outcome |
|---|---|---|---|
| `agent-a464bd8988be05b6a.jsonl` | Map edge functions + DB schema | 111 | **Completed** — 30,195-char report at line 111 |
| `agent-a2e7f2bdd69ae9e88.jsonl` | Dashboard fetch and render paths | 38 | **Completed** — 5,933-char report at line 38 |
| `agent-ae4aa679857ad4645.jsonl` | Map listener + ACP host streaming | 79 | **INTERRUPTED** — line 79 is `[Request interrupted by user]` |
| `agent-a797ceaf94264ec82.jsonl` | Map dashboard refresh + realtime | 32 | **INTERRUPTED** — line 32 is `[Request interrupted by user]` |

The two that died are the two closest to the operator's research question. Their **prompts survive**
at line 1 of each and are the best statement of what still needs answering. From
`agent-ae4aa679857ad4645.jsonl:1`:

> "The goal is to find every seam where PARTIAL / IN-PROGRESS agent output already exists in memory
> and could be captured for streaming to a web UI. … Enumerate the exact event type names / method
> names it handles (e.g. `session/update`, agent_message_chunk, tool_call, tool_call_update, plan,
> thought). **At what granularity do they arrive — per token, per chunk, per whole message?**"

**The parent redid that work itself** after the interruption — its tool log shows "Find ACP update
handling", "Read session update handler", "Read sanitize and types", "Read stderr-tail", "Find where
host events are wired" (lines 89-111) and "Read entity-panel, signal-feed, client options" (line
145). The report is complete; only the parallel raw notes were lost. The bolded granularity question
was **never measured** (report §8 item 6).

The two completed reports are detailed `file:line` maps the report distils only in part. Before
resuming phases 3-5, read `agent-a464bd8988be05b6a.jsonl:111` (the `read`/`command` edge functions,
keyset cursor rules, the 100-row page cap, full verb list) and `agent-a2e7f2bdd69ae9e88.jsonl:38`
(every dashboard timer with cadence, the PostgREST-vs-edge-function split, entity-panel wiring).

## 4. The design, as it stood

**Feature A — stream a reply into the transcript as it is written.** Achievable, MEDIUM. Partial
text already exists and is already redacted: `src/host/session.ts:719` calls
`this.events.update?.(sanitized)` once per ACP `session/update`. Payload (`src/host/types.ts:60-70`)
carries `kind: agent_message_chunk | agent_thought_chunk | tool_call | tool_call_update | plan |
available_commands_update | unknown`, plus text, toolCallId, title, status, toolKind. Those chunks
are concatenated into the final message and thrown away; the `updates` array is even retained per
turn and never sent.

The trap: `renderFeed` calls `list.replaceChildren()` at `LiveDashboard.astro:3431` and rebuilds the
whole transcript every 2 seconds with no keying. A bubble appended into that `<ul>` is wiped twice a
second. Render the provisional bubble as a **sibling outside** the `<ul>` and Feature A stays MEDIUM
instead of LARGE.

**Feature B — the live agent view.** Achievable as a structured activity stream, never as a
terminal, and only for some agents. Three-way split quoted at 3.3. From report §5.1a:

> "**We cannot show a terminal**, because there is no terminal — the child is a JSON-RPC subprocess
> over stdio pipes, not a pty. There are no ANSI frames to forward. A 'TUI view' of a listener agent
> would be something we *render*, not something we *capture*."

The repo had already ruled on this before the research began — `src/host/stderr-tail.ts:9-16` keeps
raw child stderr local-only after a real incident (*"must never ride an error object … and never
will"*), and `docs/design/SWARM-CLOUD.md:992` chose the structured stream over a terminal tab.
Recommendation: **do not reverse it**; reversal is an operator call with its own security review.

**The panel already existed.** `LiveDashboard.astro:719-740` markup, `:1951-1965` `openEntityPanel`,
`:1785-1798` `entityControl` making every name a button, view model
`site/src/lib/entity-panel.ts:16-56`, chartered by `docs/design/contracts/UI-ENTITY-PANEL-GOAL.md`.
The ask was to fill its first field and put it where the avatar goes. The report's mock, line 306 of
the committed file:

```
┌─ mercury                                    AGENT ─┐
│  operated by Tom Yulan                             │
│  ┌──────────────────────────────────────────────┐  │   ← where the avatar is
│  │ ● LIVE            [listener · claude · 4m12s]│  │
│  │ Working  ask 8f3a…  "audit the retry path"   │  │
│  │ Phase    prompting                           │  │
│  │ Now      Read  src/cloud/signals.ts          │  │
│  │ ▸ Grep  "nextFollowBackoffMs"        done    │  │
│  │ ▸ Read  src/cloud/delivery.ts        done    │  │
│  │ ▸ Read  src/cloud/signals.ts      running    │  │
│  └──────────────────────────────────────────────┘  │
│  PRINCIPAL  …existing fields, unchanged…           │
└────────────────────────────────────────────────────┘
```

**Transport: Supabase Realtime broadcast on a private channel.** Measured live against production
2026-09-01: subscribe + round-trip OK; anon key on a private channel is refused (`CHANNEL_ERROR —
Unauthorized`, so authorization is active and fail-closed); at 2 frames/sec, 400-byte payload, two
clients — 20/20 delivered, p50 54 ms. At ~4/sec, 4 of 20. At ~10/sec, 5 of 30 — while
`channel.send()` returned `{"ok": 30}`. **Loss is silent behind a success-shaped ack, so any design
needs a sequence number and must treat delivery as best-effort.** Rejected: `postgres_changes`
(browser reads go through the `swarm_read.signals` **view**, and views cannot join a publication —
and a subscribe returns `SUBSCRIBED` even for `nosuchschema.nope`, so `SUBSCRIBED` is not evidence);
edge-function SSE; tail-table polling (`SIGNAL_CREDENTIAL_LIMIT` is 120/hour); Storage blobs; WebRTC.

**Privacy:** opt-in per listener (`--share-activity`, **default off**), the CLI states what it shares
once at start, presence visible both ways, watch scope operator-only first — *"narrowing after
teammates have been watching each other's machines is a retraction."* Reuse `stderr-tail.ts`'s
redactor; do not write a second one. No panel copy may assert who can or cannot see something.

**Phases:** 1 live status in the panel (M) — **SHIPPED**; 2 tool-call activity log (S) — **SHIPPED**;
3 streaming reply text (M) — not built; 4 Realtime wake for the feed (S–M) — not built; 5 raw
terminal view (L) — **not recommended**.

Phases 1-2 are live code: commit `f5304a0` "Add private live agent activity panel", 2026-09-01
22:06:58, 23 files, +1807/-74, reached `main` via `release/0.1.46`. It produced
`src/listener/activity.ts` (`ACTIVITY_FRAME_INTERVAL_MS = 750`, `ACTIVITY_HEARTBEAT_MS = 15_000`),
`src/host/credential-redaction.ts` (the shared redactor the report demanded),
`site/src/lib/agent-activity.ts` (including the honest `"not-instrumented"` state),
`supabase/functions/activity/`, and a Realtime migration.

## 5. Searched and found nothing — do not repeat these

Every path resolved with `ls`/`find` before searching; every keyword sweep carried a positive control
on the same invocation.

**Git (`/Users/yulanbot/Developer/Ridge.io/cloud-swarm`)**

- `git stash list` — empty.
- `git branch -a` — `main`, `lane/mobile-fix`, `lane/standing-default` (both at `6e43370`, no extra
  commits at the time of the sweep), four `origin/*` refs. `git worktree list` — 3 entries.
- `git fsck --lost-found` — 88 dangling commits, 18 dangling trees, 1 dangling blob. Matches the
  prior recovery's finding that these are amend/rebase autosaves of known main-line work.
- `git log --all -S` pickaxe: `streaming-investigation` → only `6e43370` and `468b7cd` (which merely
  names the file); `stream-json`, `xterm`, `capture-pane` → **only `6e43370` itself**, i.e. the
  memo's own §5 text. Positive control `entity-panel` → 6 commits. **No other commit on any ref has
  ever contained this material.**

**Codex** — `/Users/yulanbot/.codex/thread_history_1.sqlite`, `logs_2.sqlite`, `state_5.sqlite`,
`memories_1.sqlite`, `goals_1.sqlite` (enumerated by `find`, all tables listed). Nothing, per §2.1.
`/Users/yulanbot/.config/cswarm/codex-home/` exists but is a 2026-09-01 19:07 snapshot with a
137-byte `session_index.jsonl` — a sandbox home, not a session archive.

**Listener state** — `/Users/yulanbot/.cswarm/listeners/`, 35 directories, 21 `events.ndjson` files
(4 to 170,614 lines each). Probes across the whole `~/.cswarm` tree: `profile photo` 0 files,
`terminal interface` 0, `streaming-investigation` 0, `entity panel` 0. Positive control `agent`: 126
files. Runtime operational logs; no design content.

**CommonSwarm brain** — `cswarm brain ls` returns **38 topics**; enumerated, not sampled. No topic
covers this design. Four plausible candidates fetched in full: `commonswarm-roadmap`, `app-backlog`,
`operator-requests`, `knowledgebase-design`. Only mention is one line in `app-backlog`: *"Streaming
research recovery runs in the background and blocks nothing."* The brain records that the recovery
happened; it holds none of the content. (The flag is `--agent-token-file`, not `--credential`.)

**Claude Code transcripts** — 779 `.jsonl` files across the whole `~/.claude` tree.
`/Users/yulanbot/.claude/todos/` **does not exist** (no directory — not an empty one).
`history.jsonl` holds the operator prompt at line 12175 and nothing else on the topic. **Only the
2026-09-01 `c7c21373` session and its subagents discuss this design.** False positives ruled out by
reading: `-Users-yulanbot--openclaw-workspace/5a9598f1-*.jsonl` ("profile photo" + "terminal", but a
2026-08-25 LinkedIn-security note); `3c051ddb-*` (Aug 5) and `6b2df269-*` (Aug 13) ("right column",
"Slack-style", but the earlier Slack-shape-UI work, before the window).

**Contamination warning for anyone repeating a transcript grep.** Raw `rg -l` counts for these
phrases are dominated by *today's own recovery sessions echoing the search terms*. Files with mtime
2026-09-04 14:0x-14:19 — including `ca9bad51-*`, `217f4138-*`, `9fe82563-*` and their subagents —
are this task, not evidence. `9fe82563-*` contains a near-verbatim restatement of the operator's
2026-09-04 question and will look like a 2026-09 design discussion. It is not. Filter by mtime
before counting.

**Gone for good.** `/private/tmp/claude-501/.../c7c21373-.../scratchpad/streaming-investigation.md`,
the original write target, was reaped from tmp. Immaterial — the edited copy that superseded it is
in git.

## 6. Still not established

Carried forward from report §8, unchanged by this sweep:

1. Whether the Realtime rate ceiling is per-channel, per-client, or a project quota, and whether it
   is raisable. The report measured ~2 frames/sec; L35 re-measured 10 frames/s in a short window
   (`docs/org/2026-08-29-RESUME-HERE.md:943`). The two disagree; the true saturation ceiling is
   deliberately deferred. The shipped coalescer runs at 750 ms (~1.33/s), under both.
2. Whether `realtime.send()` (broadcast-from-database) is available on this project.
3. The edge-function wall-clock limit; whether Cloudflare buffers `text/event-stream` on
   `api.commonswarm.com`. Only matter if SSE is revisited.
4. Realtime cost on this plan. Nobody has looked.
5. **Whether the four providers differ in chunk granularity.** The report read only the shared ACP
   path, not each adapter. Claude, Codex, Grok, and OpenCode may stream at very different rates,
   changing the coalescing budget per provider. The Explore agent briefed to answer this
   (`agent-ae4aa679857ad4645`) was interrupted before it could.
6. **The report ran no live listener.** Every claim about the ACP event stream was read from source,
   not observed in flight; "a few tokens to a sentence" was inferred, not measured. Per the repo's
   live-control rule, a phase-3 lane must start a real listener with `--state-dir <temp>` and paste
   its output before repeating those numbers.

Also carried forward: the report found stale claims in committed docs
(`UI-ENTITY-PANEL-GOAL.md` says the `read` function is not deployed — it is, measured 405-vs-404;
`command/index.ts:655` describes a "Realtime fan-out" that did not exist at the time). Those
corrections have not been applied to the artifacts they describe.

**Not established by this sweep:** no Realtime measurement was re-run, no listener was started, and
the shipped phase-1 panel was not verified as behaving described — the commit was read, not the
running product.
