# App-backlog specs: D-036 arm record

Eight operator-requested items (brain topic `app-backlog`, prioritised order) each got a specification under `docs/design/2026-09-06-*.md`, on branch `spec/app-backlog`. **Final SHA: `7d98f1e`.** Authored by CSwarmStrategist (`2121f81d`), 2026-09-06. This directory holds every arm output, one file per spec × SHA × arm; the maps under `maps/` are the read-only code maps the drafts were written from.

## Process, and where it stopped

Rounds: `e4d85c8` (toolbar only), `fa44311` (seven specs; Gemini inversion, Opus measured, Grok exact), `93792ef` (Gemini all eight, Opus three, Grok toolbar + heartbeat), `ede7d04` (Gemini all eight, Grok heartbeat + model + brain), `53dd29f` and `c57e247` (Gemini all eight). Every finding was folded into the next draft; the drafts record which round they folded in their status line. Two Grok files from `fa44311` (`markdown-wordwrap-qa`, `no-truncation`) contain two interleaved runs; their findings were read and folded but those files are not clean reviews. Grok reads the working tree, not the SHA named in its prompt, so a Grok file dated at one SHA may describe the draft that was on disk when it ran; each file says which.

**Arms stopped at the bound the lead set** ("if an arm round costs more than it finds, stop at consensus-with-bounds and say so"): the last Gemini pass (`c57e247`) passed six of eight and its two FAILs were small gaps, folded at `7d98f1e` without another pass. Gemini's verdicts are not stable across passes on unchanged text (long-messages passed at `53dd29f` and failed at `c57e247` on new questions), so a further pass would have found new small gaps, not defects. **No arm has read `7d98f1e`.** The diff from the last reviewed draft of each spec is a few sentences (`git diff c57e247 7d98f1e -- docs/design/`).

## What each arm family found

- **Opus (measured):** the boundary defects nobody else saw: an exact-keys parser 400s the whole reconcile read; `SELECT p.*` on the principals view would republish the plaintext `wake_id`; an anon socket cannot join the workspace activity topic without a read policy that would leak every member's frames. Each changed a design, not a sentence.
- **Grok (exact):** wrong or moved file:line, tests and functions that do not exist, typed lists, unowned files, missing sibling-lane order, `--limit 200` on a CLI whose maximum is 100.
- **Gemini (inversion):** contract holes a lane author would have to invent, and two inversions the specs adopted: a CSS media query instead of a `matchMedia` listener, and keeping the audit row on `file_download_url`.

## Status per spec at `7d98f1e`

| item | spec | draft | last PASS | last FAIL and what it was | folded after the last arm |
|---|---|---|---|---|---|
| 0 | HEARTBEAT-ON-WAKE-SOCKET | 5 | Gemini `c57e247` | Grok `ede7d04` (phase guard, timer until capability, serializer, code set, supervisor path) | those five, at `8f0d553` |
| 1 | VERCEL-TOOLBAR-OFF | 2 | Gemini `c57e247`; Grok `e4d85c8` | Grok `93792ef` (the REST field exists) | that, at `af23f11` |
| 2 | NO-TRUNCATION | 6 | — | Gemini `c57e247` (tier-0 layout, fixture file in L3) | those two, at `7d98f1e` |
| 3 | MARKDOWN-WORDWRAP-QA | 5 | Gemini `c57e247` | Gemini `53dd29f` (serving, brain screenshots, fixture-6 absence) | those, at `1ca5cfc` |
| 4 | LONG-MESSAGES | 4 | Gemini `53dd29f` | Gemini `c57e247` (export count, resize, storage semantics) | those three, at `7d98f1e` |
| 5 | AGENT-COLOURS | 5 | Gemini `c57e247` | Gemini `53dd29f` (row-scoped variable, mapped live rows, filter DOM) | those, at `c57e247` |
| 6 | MODEL-PER-AGENT | 5 | Gemini `c57e247` | Grok `ede7d04` (enable path, creation fold, sibling orders) | those, at `22eba33` |
| 7 | BRAIN-WIKI | 6 | Gemini `c57e247` | Grok `ede7d04` (lone-name acceptance, open-panel refresh, prefix clear owner, sibling orders) | those, at `53dd29f` |

"Last PASS" and "last FAIL" name the arm and the SHA of the file it read. Opus FAILs at `93792ef` (heartbeat, model, brain) were all folded at `af23f11`, `7e0520e`, and `27b8fba`; no Opus pass ran after that, by choice (cost).

## Not established

- No arm read `7d98f1e`; see the diff above.
- No live control ran for any spec; every spec names the live control its lane owes (`--state-dir <temp>` on the local stack, or real Chrome).
- Claude/Codex bridge model mapping: unmeasured; the model spec promises only the measurement.
- Production row counts for the model backfill; iOS Safari rendering; hosted Realtime latency of the awaited `realtime.send`.

## Verdict table (generated from the files)

| spec | SHA reviewed | arm | file | verdict lines | last verdict |
|---|---|---|---|---|---|
| agent-colours | 53dd29f | gemini | `agent-colours/53dd29f/gemini.txt` | 1 | VERDICT: FAIL |
| agent-colours | 93792ef | gemini | `agent-colours/93792ef/gemini.txt` | 1 | VERDICT: FAIL |
| agent-colours | c57e247 | gemini | `agent-colours/c57e247/gemini.txt` | 1 | VERDICT: PASS |
| agent-colours | ede7d04 | gemini | `agent-colours/ede7d04/gemini.txt` | 1 | VERDICT: FAIL |
| agent-colours | fa44311 | gemini | `agent-colours/fa44311/gemini.txt` | 1 | VERDICT: FAIL |
| agent-colours | fa44311 | grok | `agent-colours/fa44311/grok.txt` | 1 | VERDICT: FAIL |
| brain-wiki | 53dd29f | gemini | `brain-wiki/53dd29f/gemini.txt` | 1 | VERDICT: PASS |
| brain-wiki | 93792ef | gemini | `brain-wiki/93792ef/gemini.txt` | 1 | VERDICT: FAIL |
| brain-wiki | 93792ef | opus | `brain-wiki/93792ef/opus.txt` | 1 | VERDICT: FAIL |
| brain-wiki | c57e247 | gemini | `brain-wiki/c57e247/gemini.txt` | 1 | VERDICT: PASS |
| brain-wiki | ede7d04 | gemini | `brain-wiki/ede7d04/gemini.txt` | 1 | VERDICT: FAIL |
| brain-wiki | ede7d04 | grok | `brain-wiki/ede7d04/grok.txt` | 1 | VERDICT: FAIL |
| brain-wiki | fa44311 | gemini | `brain-wiki/fa44311/gemini.txt` | 1 | VERDICT: FAIL |
| brain-wiki | fa44311 | grok | `brain-wiki/fa44311/grok.txt` | 1 | VERDICT: FAIL |
| brain-wiki | fa44311 | opus | `brain-wiki/fa44311/opus.txt` | 1 | VERDICT: FAIL |
| heartbeat-on-wake-socket | 53dd29f | gemini | `heartbeat-on-wake-socket/53dd29f/gemini.txt` | 1 | VERDICT: PASS |
| heartbeat-on-wake-socket | 93792ef | gemini | `heartbeat-on-wake-socket/93792ef/gemini.txt` | 1 | VERDICT: FAIL |
| heartbeat-on-wake-socket | 93792ef | grok | `heartbeat-on-wake-socket/93792ef/grok.txt` | 1 | VERDICT: FAIL |
| heartbeat-on-wake-socket | 93792ef | opus | `heartbeat-on-wake-socket/93792ef/opus.txt` | 1 | VERDICT: FAIL |
| heartbeat-on-wake-socket | c57e247 | gemini | `heartbeat-on-wake-socket/c57e247/gemini.txt` | 1 | VERDICT: PASS |
| heartbeat-on-wake-socket | ede7d04 | gemini | `heartbeat-on-wake-socket/ede7d04/gemini.txt` | 1 | VERDICT: PASS |
| heartbeat-on-wake-socket | ede7d04 | grok | `heartbeat-on-wake-socket/ede7d04/grok.txt` | 1 | VERDICT: FAIL |
| heartbeat-on-wake-socket | fa44311 | gemini | `heartbeat-on-wake-socket/fa44311/gemini.txt` | 1 | VERDICT: FAIL |
| heartbeat-on-wake-socket | fa44311 | grok | `heartbeat-on-wake-socket/fa44311/grok.txt` | 1 | VERDICT: FAIL |
| heartbeat-on-wake-socket | fa44311 | opus | `heartbeat-on-wake-socket/fa44311/opus.txt` | 1 | VERDICT: FAIL |
| long-messages | 53dd29f | gemini | `long-messages/53dd29f/gemini.txt` | 1 | VERDICT: PASS |
| long-messages | 93792ef | gemini | `long-messages/93792ef/gemini.txt` | 1 | VERDICT: FAIL |
| long-messages | c57e247 | gemini | `long-messages/c57e247/gemini.txt` | 1 | VERDICT: FAIL |
| long-messages | ede7d04 | gemini | `long-messages/ede7d04/gemini.txt` | 1 | VERDICT: PASS |
| long-messages | fa44311 | gemini | `long-messages/fa44311/gemini.txt` | 1 | VERDICT: FAIL |
| long-messages | fa44311 | grok | `long-messages/fa44311/grok.txt` | 1 | VERDICT: FAIL |
| markdown-wordwrap-qa | 53dd29f | gemini | `markdown-wordwrap-qa/53dd29f/gemini.txt` | 1 | VERDICT: FAIL |
| markdown-wordwrap-qa | 93792ef | gemini | `markdown-wordwrap-qa/93792ef/gemini.txt` | 1 | VERDICT: FAIL |
| markdown-wordwrap-qa | c57e247 | gemini | `markdown-wordwrap-qa/c57e247/gemini.txt` | 1 | VERDICT: PASS |
| markdown-wordwrap-qa | ede7d04 | gemini | `markdown-wordwrap-qa/ede7d04/gemini.txt` | 1 | VERDICT: FAIL |
| markdown-wordwrap-qa | fa44311 | gemini | `markdown-wordwrap-qa/fa44311/gemini.txt` | 1 | VERDICT: FAIL |
| markdown-wordwrap-qa | fa44311 | grok | `markdown-wordwrap-qa/fa44311/grok.txt` | 2 | VERDICT: FAIL |
| model-per-agent | 53dd29f | gemini | `model-per-agent/53dd29f/gemini.txt` | 1 | VERDICT: PASS |
| model-per-agent | 93792ef | gemini | `model-per-agent/93792ef/gemini.txt` | 1 | VERDICT: FAIL |
| model-per-agent | 93792ef | opus | `model-per-agent/93792ef/opus.txt` | 1 | VERDICT: FAIL |
| model-per-agent | c57e247 | gemini | `model-per-agent/c57e247/gemini.txt` | 1 | VERDICT: PASS |
| model-per-agent | ede7d04 | gemini | `model-per-agent/ede7d04/gemini.txt` | 1 | VERDICT: PASS |
| model-per-agent | ede7d04 | grok | `model-per-agent/ede7d04/grok.txt` | 1 | VERDICT: FAIL |
| model-per-agent | fa44311 | gemini | `model-per-agent/fa44311/gemini.txt` | 1 | VERDICT: FAIL |
| model-per-agent | fa44311 | grok | `model-per-agent/fa44311/grok.txt` | 1 | VERDICT: FAIL |
| model-per-agent | fa44311 | opus | `model-per-agent/fa44311/opus.txt` | 1 | VERDICT: FAIL |
| no-truncation | 53dd29f | gemini | `no-truncation/53dd29f/gemini.txt` | 1 | VERDICT: FAIL |
| no-truncation | 93792ef | gemini | `no-truncation/93792ef/gemini.txt` | 1 | VERDICT: FAIL |
| no-truncation | 93792ef | grok | `no-truncation/93792ef/grok.txt` | 0 | (none) |
| no-truncation | c57e247 | gemini | `no-truncation/c57e247/gemini.txt` | 1 | VERDICT: FAIL |
| no-truncation | ede7d04 | gemini | `no-truncation/ede7d04/gemini.txt` | 1 | VERDICT: FAIL |
| no-truncation | fa44311 | gemini | `no-truncation/fa44311/gemini.txt` | 1 | VERDICT: FAIL |
| no-truncation | fa44311 | grok | `no-truncation/fa44311/grok.txt` | 1 | VERDICT: FAIL |
| toolbar | 53dd29f | gemini | `toolbar/53dd29f/gemini.txt` | 1 | VERDICT: PASS |
| toolbar | 93792ef | gemini | `toolbar/93792ef/gemini.txt` | 1 | VERDICT: PASS |
| toolbar | 93792ef | grok | `toolbar/93792ef/grok.txt` | 1 | VERDICT: FAIL |
| toolbar | c57e247 | gemini | `toolbar/c57e247/gemini.txt` | 1 | VERDICT: PASS |
| toolbar | e4d85c8 | gemini | `toolbar/e4d85c8/gemini.txt` | 1 | VERDICT: FAIL |
| toolbar | e4d85c8 | grok | `toolbar/e4d85c8/grok.txt` | 1 | VERDICT: PASS |
| toolbar | ede7d04 | gemini | `toolbar/ede7d04/gemini.txt` | 1 | VERDICT: PASS |
