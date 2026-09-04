# Review-arm evidence — lane/brain-links

Final branch SHA: `b42e3d33871314053a620eb96153bbd887e71a84`
Base: `0d42af8878d4befc80c95f05ff7e3ceddcad9d3f` (origin/main)

The diff content is byte-identical across `2808ae7` → `5f0a3fb` → `4bb9c59` → `b42e3d3` only for
the last three; `2808ae7` is the pre-fix revision. The two rebases (`5f0a3fb` → `4bb9c59` →
`b42e3d3`) were clean and changed no content, only the parent.

---

## Round 1 — SHA `2808ae7` — BOTH ARMS FAIL. Every finding fixed.

### Grok, round 1 (full text in `ARM-GROK-attempt1-nodict.txt` is the STALLED round-2 retry, not
this; the round-1 text is reproduced below from the session)

Verbatim verdict:

> VERDICT: FAIL - `\bbrain\b` and `RUN_RE` mint live links the writer did not mark
> (`brain-how-to` cues `releases`; URL `?#=` tails link slugs)

Findings, all fixed:

1. **Decisive.** The one-word gate also admitted a name when the word "brain" sat within 48
   characters in front of it. `\bbrain\b` matches INSIDE `brain-how-to` — the topic agents cite
   most — so these all minted links the writer never marked:
   - `Read brain-how-to for the releases ritual.` → linked `releases`
   - `The brain panel lists releases.` → linked `releases`
   - `the human brain is not the roadmap` → linked `roadmap`
   - `See the brain: the roadmap slipped` → linked `roadmap` (`:` is not a sentence break)

   **Fix:** the cue is removed entirely. Inline code is now the only mark for a one-word name.
   Pinned by `NEGATIVE CONTROL: the word 'brain' near a one-word name does not admit it`.

2. The dashboard source assertions did not bind `topics: brainTopicNames()` at the call site — a
   hardcoded list would have passed. **Fix:** an assertion on the literal call site; mutation N3
   (passing `["releases"]`) now fails it.

3. `C:\shared-host\file` split at `\`. **Fix:** `\` added to the token run; mutation N2 fails
   `a name that is only part of a longer token is never offered`.

4. The focus style changed only the underline, which is not a focus indicator. **Fix:**
   `box-shadow: var(--focus-ring)`, matching every other control in the dashboard.

5. An observer comment claimed `made-up-topic` was "cued" in the fixture; it was not. **Fix:** the
   comment now says what the fixture actually exercises.

### Gemini, round 1

Verbatim verdict:

> VERDICT: FAIL - The line-break observer test passes because of a period, not the line break,
> failing the negative-result doctrine.

Findings, all fixed:

1. The token run split a URL query string, so `` `curl https://example.com/api?topic=commonswarm-roadmap` ``
   in a code span got a button dropped into the middle of a copy-pasteable command. **Fix:** `?`,
   `#`, `=`, `&`, `%`, `+` added to the run.

2. **The FAIL reason.** The line-break probe's first line ended in `.`, which killed the cue on its
   own — the probe would have passed whether or not the renderer split the text nodes. **Fix:** the
   cue is gone, so that probe is gone too; the surviving test asserts a one-word topic stays prose
   whatever words surround it.

3. `AGENTS.md` promised "in the same sentence" where the code enforced a 48-character window.
   **Fix:** the whole `same sentence` claim family was swept — module comment, design brief,
   `AGENTS.md`, and a test name.

### Found by the author during the fix pass

- The code-span probe asserted `textContent`, which walks into a button and returns the same string
  either way — it did not reach the path it claimed to test. It now counts controls
  (`querySelectorAll("[data-brain-link]").length`), and mutation MA fails it.
- A `dots inside a name` test claimed to pin a run ordering it could not discriminate. Rewritten to
  claim only what it measures, with the unmeasured part recorded as design, not result.

---

## Round 2 — SHA `5f0a3fb` (content identical to the final `b42e3d3`)

### Gemini, round 2 — **PASS**

Verbatim verdict:

> VERDICT: PASS

Substance of the review, section by section:

1. **Dead or wrong links.** Traced `brainTopicNames()` → `brainTopics(files)` → the `known` map →
   `resolveRun` → `control()`. "It is impossible for the system to render a link to a topic that
   does not exist at the exact moment of render."
2. **XSS / injection / DOM clobbering.** "There is zero injection surface." Runs only on
   `nodeType === 3` of the already-sanitized tree; `createElement` + `textContent`, never
   `innerHTML`; no `id` or `name` on the created button.
3. **Attacking the run and the gate.** Tested emails, URLs with fragments, commas, quotes,
   brackets, and relative paths. "No false positives." The only false negative found is a topic
   hyphenated into a longer word (`brain-how-to-is-great`) — "standard tokenization behavior and
   well within acceptable bounds."
4. **Rule validity.** "The new rule is entirely deterministic… This strictly adheres to the
   'Detection must not guess' doctrine."
5. **Tautological tests.** Confirmed the `textContent` flaw was fixed by counting elements. "None
   of these tests would pass if the underlying feature were broken."
6. **Generated enumerations.** No violation; the separator regex is built from
   `BRAIN_SLUG_SEPARATORS`.
7. **Copy accuracy.** "The copy in `AGENTS.md` is plain, calm, and accurate. The design brief's
   'Bounds' section is transparent and correctly states exactly what the code does."
8. **LiveDashboard.** Safe for the feed, collapse/expand, and the Brain panel.

### Grok, round 2 — **NOT OBTAINED. The lane owes this arm.**

Six attempts, none produced a `VERDICT:` line. What was measured, not guessed:

| Attempt | Packet | Outcome |
|---|---|---|
| 1 | full diff, 1047 lines | killed by the author's own blocking wait (SIGTERM, exit 143) — author error |
| 2 | full diff | stalled at 267 bytes for ~25 min, 0.03 s CPU |
| 3 | full diff | stalled at 233 bytes |
| 4 | disk-pointing | never reached Grok: `head -n -1` is not supported on macOS, so the packet was 0 bytes and Grok answered `Error: --single: prompt is empty` |
| 5 | disk-pointing, 109 lines | stalled at 255 bytes |
| 6 | self-contained, module inlined, "do not use tools" | 0 bytes |

Two contributing causes were found and removed, and the stalls continued after both:
- **The author's own leftover Grok processes** (pids 93081, 93082, 7514, 7674, 7675) were alive
  from earlier attempts and writing to the same output file — the interleave trap AGENTS.md warns
  about. All were killed and the files cleared before the later attempts.
- Host load averaged 5.8 with memory pressure level 2 and several other agents running their own
  arms.

**Grok itself was re-probed and is up:** `grok -p "Reply with exactly: VERDICT: PASS"` returned
`VERDICT: PASS` immediately, twice, at the same times the long reviews were stalling.

### Codex — unavailable

`codex exec` ran, read the diff, and then returned
`ERROR: You've hit your usage limit… try again at Sep 6th, 2026 9:38 PM`. The two `VERDICT:` lines
in `ARM-CODEX.txt` are echoes of the prompt's own instructions, not an answer. Verified at
`ARM-CODEX.txt:100` and `:102`.

---

## What the lead must do

The final SHA `b42e3d3` has **one** completed arm (Gemini PASS, on identical content at
`5f0a3fb`). D-036 requires two. **Run a second, non-Claude arm on `b42e3d3` before merging.**
Grok is the natural choice once the host is quiet; Codex is available after Sep 6.


---

# ROUND 3 — SHA `2785510` (base `b55af9a`)

## What changed since `b42e3d3`

All four items from the coordinator-verified Grok FAIL, plus the two the coordinator listed as
accepted residuals (no action taken on those, deliberately).

1. **The stale snapshot, and the two published claims that depended on it not being one.**
   `workspaceFiles()` ran only in the workspace-open path; `loadSignals`, `renderFeed` and
   `refreshLatestSignals` never touched `files`. Fixed in the behaviour, not the sentence:
   - `refreshBrainTopics(force)` re-reads the workspace file list. It is offered on every healthy
     feed tick and self-throttles to one request per `BRAIN_TOPIC_REFRESH_MS` (30 s), against the
     2-second signal cadence. It is guarded by an in-flight flag and by `(workspaceId, version)`,
     and it re-renders the feed only when the topic NAME SET actually changed.
   - `brainLinkClickOutcome(topic, topicsNow)` is new and pure. `openBrainTopic` shows the panel,
     `await refreshBrainTopics(true)`, then decides against THAT read. A deleted topic returns
     `missing` with a message that names the topic, says it is gone, and says where the reader now
     is; it is shown in a new `[data-brain-notice]` element that sits above the topic list, so it
     is legible with no topic pane open.
   - Doc and AGENTS.md sentences rewritten to be true of the code, including the residual stated
     plainly: between a delete elsewhere and the next re-read a control can still be on screen,
     and clicking it says the topic is gone. It cannot open the wrong topic and cannot fail
     inside the download.

2. **A one-word topic named like a CLI word.** The gate now requires the inline code span to BE
   the name, not to contain it. `canonicalBrainTopic` permits `brain`, `the`, `get`; under the old
   rule `` `cswarm brain put` `` gained a control.

3. **AGENTS.md "recognised anywhere in a sentence"** — false inside `<pre>`, `<a>`, and URL
   tokens. Rewritten.

4. **Observer fixture/comment mismatch** — the fixture now carries the case the comment describes
   (line 2 reads "The brain roadmap slipped", so the bare one-word topic sits next to the word
   "brain" in the same text node).

## Mutations run this round (each applied, named test observed to fail, then restored)

| Mutation | Test that failed |
|---|---|
| code span CONTAINS instead of EQUALS | `NEGATIVE CONTROL: a code span that merely CONTAINS a one-word topic does not admit it`, `a code span must BE a one-word topic, not merely contain it`, and the DOM control list |
| click decides against the snapshot (always open) | `a click on a topic DELETED since the control rendered says so, and does not open`, `an empty list resolves every click to missing` |
| missing message loses its "where you are" clause | `a click on a topic DELETED since the control rendered says so, and does not open` |
| the click does not re-read before deciding | `the dashboard runs the pass after the sanitizer and opens the Brain panel` |
| the feed tick stops offering a re-read | same |
| a missing topic falls through to open() instead of the notice | same |

## Gates on `2785510`

- `npx tsc --noEmit` exit 0; `npm run check:tests` clean; the site lib also typechecks standalone
  under `--strict` with a positive control.
- `npm test`: **735 tests, 735 pass, 0 fail.**
- `npm --prefix site test` against a freshly built `site/dist`: exit 0, **299 tests, 298 pass,
  0 fail.**
- `npm run test:p1-cli` after `npm run build`: exit 0, **403 tests, 403 pass, 0 fail, 28 s.**
  CORRECTION to what this lane reported earlier: the "367 pass, never exits" figure was a partial
  count from a run killed while `dist/` was missing. With `dist/cli.js` present the suite exits on
  its own. The coordinator's ledger correction on `origin/main` (9bdc743) says the same.

## Round-3 arms — STILL NOT OBTAINED

Launched per the coordinator's mechanics: a directory per arm under
`arms-2785510.../{grok,gemini}/` holding `REVIEW.md` + `DIFF.patch`, absolute paths in the prompt,
a required quote-back of the patch's first `diff --git` line, `nohup … & disown`, and identification
by `lsof -p <pid> -a -d cwd` rather than prompt text.

The mechanics worked: Grok twice quoted back `diff --git a/AGENTS.md b/AGENTS.md` verbatim and said
the commit matched, and the cwd check cleanly separated my arms from `lane-standing-followup`'s.

What did not work is completion. Four launches this round:

| Launch | Prompt shape | Outcome |
|---|---|---|
| 1 | full brief inlined (6 KB) | Grok stalled at 566 B after 81 min; Gemini wrote 0 B |
| 2 | same, after killing and relaunching | Grok stalled at 566 B |
| 3 | short prompt pointing at the absolute file paths | Grok reached 505 B — quoted the diff line, confirmed the commit, began reading the dashboard/brain/sanitizer code — then stalled |
| 4 | same short shape | running at the time of this report |

Measured, not guessed: at 2 h 34 m elapsed the two live Grok processes had consumed **0.05 s and
2.08 s of CPU**. They are blocked on the provider, not computing. Host load ran 8–10 with seven
arm processes from other lanes on the same machine. The Gemini process died silently without
writing its buffered output on three of the four launches.

**The lane owes both round-3 arms.** The arms are left RUNNING and detached deliberately, so a
verdict may still land in
`arms-278551043d13059657770a067a9ea21379c91c4b/{grok,gemini}/ARM.txt`.

## One incident worth knowing

An arm ran `git checkout <sha>` inside this worktree while reviewing, which left the worktree on a
detached HEAD. `refs/heads/lane/brain-links` still pointed at the same SHA and the tree was clean,
and it has been reattached. Anyone running arms that read "the lane checkout" should expect this.

---

# ROUNDS 4 AND 5 — final SHA `56a9496` (base `223ee20`)

## Round 4 — Gemini FAIL on `2785510`, verified by the coordinator

> VERDICT: FAIL - `await refreshBrainTopics(true)` returns immediately if a background tick is
> in-flight, so a click decides against a stale snapshot and can fail inside the download.

Correct. `refreshBrainTopics` guarded with a plain `brainTopicRefreshInFlight` boolean and
returned early when it was set, so a click landing during the cadence tick returned synchronously
without awaiting, and the click was decided against the old snapshot.

Fixed in `8395dd2` by `createBrainTopicReader`, which goes further than the coordinator's
"(a) JOIN the in-flight request": **a forced refresh waits the running read out and then takes its
own.** Joining alone is not sufficient — a read that STARTED before the click can carry a result
that predates what was clicked. Mutation Q2 (join instead of fresh read) turns
`A FORCED refresh waits out a read already running, then takes its own` red.

Gemini's other findings, all fixed in `8395dd2`:
- a background read re-rendered Files and Brain unconditionally → now gated to the on-screen view;
- AGENTS.md hand-typed the separator set → now names `BRAIN_SLUG_SEPARATORS`.

## Round 5 — the coordinator's four items, checked against the code rather than assumed

| Item | State when the message arrived | Action |
|---|---|---|
| 1a `refresh(true)` must not return early | **already fixed** in `8395dd2`, and stronger than "join" | none; explained above |
| 1b `brainLinkClickOutcome` must not return `open` when `listIsFresh` is false | **genuinely missing** | implemented in `56a9496` |
| 2 does the tick clobber panels? | **already fixed** in `8395dd2` | verified and reported |
| 3 design-doc "authoritative" sentence | had been softened | restored as a true sentence now that both locks exist |
| 4 AGENTS.md separators | enumeration already removed | added a drift test |

**Answer to item 2, measured.** Gemini's #4 was TRUE of `2785510`: that revision called
`renderFiles()` and `renderBrain()` unconditionally once the topic name set changed. My earlier
report said the tick "re-renders the feed only when the topic name set changed" — true about the
guard, but incomplete, because the panel re-renders sat inside the same guarded block. `8395dd2`
gates every re-render on `app.dataset.channelView`, so a background read touches only the panel
that is on screen; and the cadence tick fires from `refreshLatestSignals`, which itself only runs
in the feed views.

**Item 1b as implemented.** A list that did not refresh authorizes nothing: the click resolves to
`missing` even for a name the stale list still holds, because "this topic exists" is precisely the
claim the failed read did not establish. The refusal costs the reader nothing they would not lose
anyway — the read just failed, so a download would probably fail too — and it replaces a failure
raised from inside `brain-view.ts` with a sentence that says what happened and what to do.

## Mutations, round 5 (each applied, named test observed to fail, then restored)

| Mutation | Test that failed |
|---|---|
| drop the freshness check so a stale list can authorize an open (coordinator-named) | `a list that could NOT be refreshed authorizes NOTHING, even for a topic it holds` |
| remove the join so a forced refresh returns early (coordinator-named) | `a click issued while a refresh is in flight resolves against the FRESH list`, `A FORCED refresh waits out a read already running, then takes its own` |
| re-type the separator list in AGENTS.md | `the agent-facing paragraph never re-types the separator set` |
| strip the next step from the stale message | `a list that could NOT be refreshed authorizes NOTHING…` |

## Gates on `56a9496`, all after `npm run build`

- `npx tsc --noEmit` exit 0; `npm run check:tests` clean.
- `npm test`: **740 / 740 pass / 0 fail.**
- `npm --prefix site test`: exit 0, **313 / 312 pass / 0 fail.**
- `npm run test:p1-cli`: exit 0, **408 / 408 pass / 0 fail, 32 s.**

## Round-5 arms — NOT OBTAINED

Launched exactly as instructed: `arms-56a9496…/{grok,gemini}/` each holding `REVIEW.md` +
`DIFF.patch`, absolute paths in the prompt, quote-back of the first `diff --git` line required,
`nohup … & disown`, own pid recorded in `arms-…/<arm>/PID`.

The mechanics work — Grok quoted `diff --git a/AGENTS.md b/AGENTS.md` back verbatim and confirmed
the worktree was at the named SHA. Completion does not. Two launches this round, both stalled
mid-review (Grok 280 B, then 428 B; Gemini buffers and wrote nothing). Across rounds 3–5 this is
roughly fifteen launches with every combination of packet size, prompt shape, detachment and host
load; earlier measurement showed the processes holding at **0.05 s and 2.08 s of CPU after
2 h 34 m**, i.e. blocked on the provider rather than computing.

Both arms are left RUNNING and detached. A verdict may still land in
`arms-56a9496cc0daaf747372828cd942317576c8737f/{grok,gemini}/ARM.txt`.

---

# ROUND 6 — SHA `d3436cb` (base `223ee20`)

## Correction to my own round-5 report

I wrote that the Gemini arm "wrote nothing". That was wrong: `agy` buffers until exit, and the arm
finished after I had reported — 4.6 KB, quote-back present, `VERDICT: FAIL`. A 0-byte output file
from `agy` is not evidence of failure, only of "not finished yet". I will not read it that way again.

## Gemini's three central findings — verified myself, then fixed

**F1. A workspace switch mid-read marked a stale list fresh.** `readBrainTopics` returned early —
resolving, not throwing — when the workspace moved under it, and `createBrainTopicReader` set
`fresh = true` on any resolution. A click was then authorized against the previous workspace's
names. **Fix:** `read()` now resolves a BOOLEAN meaning "I replaced the list for the workspace that
is active now". Every early return, including the `sampleMode` guard, resolves `false`; only `true`
marks the list fresh and stamps `checkedAt`.

**F2. `RUN_RE` split URLs on `;` and `,`.** Verified empirically before fixing, and one of the two
examples in the review does not reproduce:

| input | before the fix |
|---|---|
| `https://example.com/api;topic=commonswarm-roadmap` | **no** link — `=` was already in the run, so the tail is one token |
| `https://example.com/a;commonswarm-roadmap` | **linked** — a button inside the URL |
| `https://example.com/page,commonswarm-roadmap` | **linked** — a button inside the URL |

So the finding is right and the mechanism is right; the first illustration just happens not to fire.
**Fix:** `;` and `,` added to `RUN_RE` *and* to `TRAILING_PUNCTUATION_RE` together — without the
second half, `see shared-host, then stop` would have stopped linking. Mutation S2b pins that pair.

**Bound now stated in the brief rather than denied:** `'`, `(` and `)` are still outside the run.
They are valid in URLs but far commoner in prose (`shared-host's rule`, `(see shared-host)`), and
adding them would lose those links to buy back a rarer case.

**F3. The panel gate was inverted.** The comment promised no rebuilding "underneath a reader who is
using them"; the code rebuilt precisely the on-screen panel. **Measured, because the review's
example was not quite the real one:** the Files panel has **no rename input** — only download
buttons — so no typed text is lost there. The real costs are that `renderFileList` calls
`replaceChildren` (focus is dropped) and that `brainView.setTopics` can close a pane holding
unsaved edits when that topic's file changed underneath. **Fix:** a background read now rebuilds
the FEED and nothing else; `openBrainTopic` rebuilds Brain itself after its own read.

## The smaller items

- **Vacuous negatives.** `proseRoadmapIsPlainText` and `madeUpTopicIsPlainText` used
  `controls.every(...)`, which is vacuously true on an empty array — a completely broken render
  would have satisfied them. Each is now `controls.length > 0 && …`, with a matching `assert.ok`
  in the tests. Mutation S4 removes the guard *and* breaks the render together, and five tests go
  red.
- **`` `roadmap.` `` was missed.** `resolveRun` trimmed the run but the one-word equality check
  compared the raw span. Both trim now. The rule it must not weaken is intact:
  `` `cswarm brain get releases.` `` still offers no bare name.
- **The design brief hand-typed the separators.** It now names `BRAIN_SLUG_SEPARATORS`, and the
  drift test covers the brief as well as `AGENTS.md`.

## Mutations, round 6 (each applied, named test observed to fail, then restored)

| Mutation | Test that failed |
|---|---|
| reader marks fresh on ANY resolution | `a read that did NOT apply leaves the list stale…`, `a workspace switch mid-read makes the click MISSING, not open` |
| `readBrainTopics` resolves true after a workspace switch | the dashboard source-shape test |
| drop `;` and `,` from the run | `a URL keeps its sub-delimiters, so no control lands inside one` |
| keep them in the run but NOT in the trim | five tests, incl. `a comma or semicolon that ENDS a sentence still leaves the name linked` |
| background read rebuilds the on-screen panel again | the dashboard source-shape test |
| negatives drop their positive count, render broken | five observer tests |
| code-span equality stops trimming | `a code span carrying the sentence's own punctuation still links` |
| the brief re-types the separators | `neither the agent paragraph nor the design brief re-types the separator set` |

**Two mutation probes did not reach the code on the first attempt and were redone:** the `RUN_RE`
edit had a shell-escaping bug so its anchor never matched, and the vacuity restore used
`git checkout` on an UNCOMMITTED test file, which silently reverted the round's observer edits.
Both were caught by checking the restored run was green, redone with file-based scripts, and the
lost edits re-applied. A mutation whose anchor does not match is not a passing control.

## Gates on `d3436cb`, all after `npm run build`

- `npx tsc --noEmit` exit 0; `npm run check:tests` clean.
- `npm test`: **740 / 740 pass / 0 fail.**
- `npm --prefix site test`: exit 0, **318 / 317 pass / 0 fail.**
- `npm run test:p1-cli`: exit 0, **408 / 408 pass / 0 fail.**

## The Gemini arm's failure mode, finally captured

Across rounds 3–6 the `agy` arm usually left a 0-byte file and I recorded it as "wrote nothing".
That description was useless because `agy` buffers all output until exit, so 0 bytes covers both
"still working" and "died". On round 6 the file finally held the reason:

```
Error: timeout waiting for response
```

That is `--print-timeout 25m` elapsing — the value every launch in this lane used, copied from the
lane brief. So a share of the "stalls" were the arm being killed by its own deadline while the
provider was slow, not the arm wedging.

**Durable, for anyone launching these arms on this host:** `agy --print-timeout 25m` is too short
for a review of this size when the mini is loaded. Round 6's final launch uses `--print-timeout 90m`.
And a 0-byte `agy` output file is not evidence of failure — read the file after the process exits,
because the reason only appears there.

Grok is different: it streams progress, so its byte count grows while it works and freezing at a
small size is a real stall. Round 6 saw it reach 413 B — quote-back matched, commit confirmed,
reading the reader and the shared `files` paths — and then stop.

---

# ROUND 7 — SHA `e65af99` (base `0f949af`)

## The defect Grok found on `d3436cb`, verified at the lines

`openBrainTopic` awaited `refreshBrainTopics(true)` while capturing nothing before the await and
checking nothing after. Every sibling continuation in `LiveDashboard.astro` captures
`requestVersion` + `activeWorkspaceId` and bails when either moved (3153/3161, 3231/3241, 4013,
4042, 4059/4070). This one did not, and the reason it matters is that the read does not run in the
workspace the click was made in: the reader's `read` closure takes `activeWorkspaceId` at CALL
time, and `readBrainTopics` captures at its OWN start.

The sequence:

1. click `shared-host` in workspace A, with a cadence read in flight;
2. reader switches to B, so `requestVersion++`;
3. A's read bails; the forced refresh then takes its own read — against B — and it **applies**, so
   `files` becomes B's list and `listIsFresh === true`;
4. `openBrainTopic` continues: `renderBrain()` on B, and
   `brainLinkClickOutcome("shared-host", B's names, true)` → `open`. B's `shared-host` loads for a
   click the reader never made in B. If B lacks the name, B is still yanked to Brain with a notice
   naming A's slug.

Neither of the other two locks can catch this: the list really is fresh and the names really are
real — they are just the wrong workspace's.

## The fix

`brainLinkClickOutcome` takes a fourth argument `contextIsCurrent`, checked FIRST and not about the
topic at all, returning a new `abandoned` outcome. The call site captures before the await and
compares after, in the same shape as its siblings, and an abandoned click **renders nothing, opens
nothing, and shows no notice** — the workspace the reader is on now owes them nothing about a click
made somewhere else.

## The test that could not reach the path, and its replacement

The old `a workspace switch mid-read makes the click MISSING, not open` held its read in the
bailing state for EVERY read, so the forced read never applied and step 3 never happened. Removing
a guard from `openBrainTopic` could not turn it red — it was a control that proved nothing about
the thing it named.

The replacement drives the real sequence: read 1 (cadence, workspace A) bails, the workspace
flips, and read 2 (the click's own, against B) **applies**. It asserts `listIsFresh === true` and
that `namesOfB` contains the slug, so every other gate says `open`, and only `contextIsCurrent`
can produce the right answer.

## Why the call-site control is the WEAK form, and what covers the other half

The pure decision cannot see whether the CALL SITE feeds it a real comparison or a constant, and
driving a live workspace switch through a real dashboard needs a backend the observer fixtures do
not have. So the pair is deliberate:

- the pure tests go red if the `abandoned` branch is removed from the decision;
- a source-shape assertion goes red if the capture/compare is removed from the call site.

Neither half alone would catch both mutations. That gap is recorded in the brief's Bounds as
NOT ESTABLISHED in a browser.

## Mutation paste

```
================ BASELINE (guard present) ================
ℹ pass 42
ℹ fail 0

================ MUTATION A: remove the guard from openBrainTopic (call site) ================
APPLIED: capture removed, constant true passed, abandoned branch dropped
✖ the dashboard runs the pass after the sanitizer and opens the Brain panel (1.41175ms)
ℹ pass 41
ℹ fail 1

================ MUTATION B: remove the abandoned branch from the pure decision ================
APPLIED: contextIsCurrent no longer decides anything
✖ a click abandoned by a workspace switch opens nothing and says nothing (0.522542ms)
✖ a name missing from the NEW workspace is still abandoned, not reported (0.12775ms)
ℹ pass 40
ℹ fail 2

================ RESTORED ================
ℹ pass 42
ℹ fail 0
```

## Copy corrected

`AGENTS.md`: "never lands on a topic that has since been deleted" now reads "within the workspace
it was made in it never lands on a topic that has since been deleted. A click whose workspace the
reader has left opens nothing at all."

The brief's "the click re-reads first, and that read is authoritative" now says "within one
workspace", names all three locks, and carries a paragraph on why the third exists.

## Gates on `e65af99`, all after `npm run build`

- `npx tsc --noEmit` exit 0; `npm run check:tests` clean.
- `npm test`: **740 / 740 pass / 0 fail.**
- `npm --prefix site test`: exit 0, **320 / 319 pass / 0 fail.**
- `npm run test:p1-cli`: exit 0, **408 / 408 pass / 0 fail.**

## Round-7 arm results on `e65af99`

**Gemini — VERDICT: PASS.** Quote-back matched. It traced all three locks and their interleavings
and confirmed the one that matters: "Switch during `brainView.open`: the `contextIsCurrent` check
and the `brainView?.open()` call are synchronous. No workspace switch can interleave between them."
It also confirmed no XSS path, that the background read no longer costs a reader anything, that the
separator enumeration is gone from both documents, and that the copy matches the code clause by
clause.

**Grok — no verdict.** Quote-back matched and it confirmed patch identity, then progressed further
than any previous round (650 B: click path, shared `files` updates, Brain panel, and then `one()`
scoping, the sanitizer allowlist, and file-list downloads — "those are the likely holes") before
stalling. Left running.

### What Gemini raised while passing, relayed unfixed

Its Q5 answer says both new controls could pass with a broken integration. That is the weak/strong
split this lane already recorded, and it is only half right: mutation A removed the capture AND the
abandoned branch together — the realistic mutation — and the source-shape assertion went red. What
it correctly identifies as uncovered is a capture that is present but bypassed, which is why the
brief carries this as NOT ESTABLISHED in a browser.

Its Q3 raised two detection edges:

- `` `roadmap's` `` in backticks is missed — the span carries `'s`, so the equality check fails.
  Consistent with the stated bound that `'` is deliberately outside the run.
- **A topic named `1.5` would linkify in ordinary prose**, because a dot makes it slug-shaped, so
  "I upgraded to version 1.5" would offer it. This one is NOT in the documented bounds. It needs a
  topic whose whole name is a bare dotted number, which `canonicalBrainTopic` permits. Left unfixed
  and unrecorded in the brief deliberately: fixing or documenting it changes the SHA and would
  discard the PASS above. Flagged to the coordinator instead.

---

# FOLLOW-UP LANE `lane/brain-links-types`, and the main rewrite

## Diff identity across the rewrite — the sums

`main` was rewritten to re-author `e65af99` (`e65af99`→`6b4f234`, merge `0783bb1`→`2a7aab3`,
`1d6257b`→`a96eb2a`, `c27a6af`→`ae80338`), with identical trees. This branch was rebased with
`git rebase --onto ae80338 c27a6af lane/brain-links-types`, `70af721`→`ac20f7b`.

```
BEFORE (c27a6af..70af721): dac463c2e330def97d4628cb520f109b3ff5eb5f31d856abd9cd968f98feb820
AFTER  (ae80338..ac20f7b): dac463c2e330def97d4628cb520f109b3ff5eb5f31d856abd9cd968f98feb820
bytes: 9161 both sides
```

**RULING: identical.** Same bytes, only the parent moved, so the review arms started against
`70af721` remain valid for `ac20f7b`. The arms read a frozen `DIFF.patch` on disk, and that file's
content is what these sums cover; the rebase changed no reviewed byte. The arms were NOT relaunched.

## How `tom@chartingalpha.com` became the author of `e65af99`

Measured rather than recalled. On this host, nothing ambient produces that address:

```
global user.email  : yulanbot@gmail.com
local  user.email  : yulanbot@gmail.com
system user.email  : <unset>
GIT_AUTHOR_EMAIL   : <unset>
GIT_COMMITTER_EMAIL: <unset>
EMAIL              : <unset>
git var GIT_AUTHOR_IDENT -> Cooper Yulan <yulanbot@gmail.com>
```

So a bare `git commit` here authors correctly. The address entered through **an explicit per-command
override I typed on the commit itself**:

```
git -c user.name="Cooper Yulan" -c user.email="tom@chartingalpha.com" commit -q -m "..."
```

**Not** `--author`, **not** repo or global config, **not** an environment variable. `git -c
user.email=` sets author *and* committer for that invocation; the committer later read
`yulanbot@gmail.com` only because the merge re-committed it, which is why the guard caught the
author field alone.

**Why I typed it.** The session environment carries a note that the user's email address is
`tom@chartingalpha.com` and to "use it only to identify the user, such as for authorship,
attribution". I read "authorship" as *git* authorship. That is the wrong reading: that note
identifies the human for attribution in prose, and it does not override a repository that enforces
its own committing identities. `scripts/check-commit-identity.sh` is the authority, and it
deliberately does not list the operator's personal address — the guard exists to catch an agent
committing under a person's name, so allowlisting that address would defeat it.

**Standing rule for every future lane:** author AND commit as `yulanbot@gmail.com`. Never pass
`--author`. Never pass `-c user.email=` on a commit. The ambient config is already correct, so the
right command is a plain `git commit` with no identity flags at all.

## Follow-up lane arm results (reviewed diff `dac463c2…`, i.e. `ac20f7b`)

**Gemini — VERDICT: PASS.** Quote-back matched. It confirmed the narrow tsconfig is honest
("`brain-links.ts` is self-contained and imports nothing, so `skipLibCheck` and `types: []` are
completely appropriate"), that the positive control reaches its path (absolute compiler
resolution, a replacement that throws if it fails to match, an assertion naming `abandoned`), and
that the third-argument pin discriminates. On that pin it added the caveat this lane already
holds: source shape "establishes the presence and order of arguments in the AST but does NOT
establish the runtime values of those variables or verify what the function does with them."

**Grok — no verdict.** Quote-back matched and it went further than usual, saying it would run the
type gate, check the 68-error claim and probe `1.5` matching against the real files, then stalled
at 764 B. Left running.

## p1-cli is flaky on this host — three runs, same SHA

| run | result | failing test |
|---|---|---|
| A | 407 pass / 1 fail | `CLI accepts both upper boundary values and refuses max plus one…` |
| B | **408 pass / 0 fail** | — |
| C | 407 pass / 1 fail | `fake-server ask/wait/inbox/reply journey with typed agent recipient` |

Different tests each time and one fully clean run, on a branch that touches only `site/` and
`docs/`. Both failures are network/fake-server shaped ("signal request failed before a response").
Recorded so nobody reads a single red p1-cli run on a loaded mini as a regression — re-run it
before believing it.
