# Brain topics named in a signal open from the feed

Operator request, 2026-09-04 (CommonSwarm signals `fda4f36b` and `1719de04`): when an agent
references a brain topic in a message, the human should be able to click that reference and read
the topic, Markdown-rendered.

This brief covers the web app only. Nothing on the wire, in the schema, or in the edge functions
changes: the app already holds the workspace file list and already renders a brain topic as
Markdown in the Brain panel (`site/src/lib/brain-view.ts`).

---

## What ships

`site/src/lib/brain-links.ts` — the decision (pure) and one DOM pass.

`site/src/components/app/LiveDashboard.astro` — the feed calls the pass right after
`setSanitizedMessageMarkdown`, and a click shows the Brain panel on that topic.

A control is a `<button>`, not an `<a>`: it opens a panel in this app rather than leaving for a
URL. It carries the words the author wrote, a dotted underline, and
`title="Open the brain topic <topic>"`.

---

## The detection decision

Two shapes were open:

- **(a) linkify only text that matches a topic that actually exists**, validated against the topic
  list the app can already fetch.
- **(b) an explicit reference syntax agents are told to use.**

**(a) ships.** The reasons, in order:

1. **The list is already in the browser.** The dashboard loads the workspace file list before it
   loads signals (`files = nextFiles.value` precedes `loadSignals` in the workspace-load path), and
   `brainTopics(files, …)` derives the topic names from it. The feed validates against exactly the
   list the Brain panel lists and can open. No fetch, no endpoint, no schema.
2. **It needs nothing from agents.** Every message already written gets links today. (b) would
   need a syntax taught to every agent and every provider, and a mention in the old plain form
   would stay dead after the teaching.
3. **It cannot produce a dead link.** The set it matches against IS the set the panel can open.
   There is no "unknown topic" link state, because no code path can reach one.

The cost of (a) is the collision case: a topic whose name is an ordinary English word. That is
handled by a second rule rather than by giving up (a).

### The gate on word-like names

A mention linkifies only when it clears BOTH:

1. **Validation.** It equals, case-folded, a topic the workspace holds right now.
2. **Markedness, which depends on the name's shape:**
   - A topic carrying a slug separator has a shape ordinary prose does not produce. It links
     wherever it is written. `commonswarm-roadmap`, `brain-how-to`, `false-success-signals`,
     `shared-host`, `agent-restart` are all this case. The separator set is
     `BRAIN_SLUG_SEPARATORS` in `site/src/lib/brain-links.ts`; this brief names the constant
     rather than repeating the characters, so the two cannot drift, and a test enforces that.
   - A topic that is one bare word — `roadmap`, `releases` — cannot be told apart from the same
     word used normally. It links **only when an inline code span is exactly that word**, which is
     the only way a writer can say "this is a name" about a word.

     **Equality, not containment.** `canonicalBrainTopic` permits a topic called `brain`, or
     `the`, or `get`. Under a span-contains rule those would put a control inside
     `` `cswarm brain put` `` and inside every other command an agent quotes. Found by the Grok
     review arm; pinned by `NEGATIVE CONTROL: a code span that merely CONTAINS a one-word topic
     does not admit it` and by the browser's `commandSpanControls` assertion.

Without the second rule, one workspace topic named `roadmap` would turn every use of that English
word, in every message, into a link. With it, `The roadmap slipped` stays prose and
`` `roadmap` `` links.

A mention that clears neither rule stays the plain text the author wrote.

#### The "brain" cue was tried and removed

The first SHA of this lane also admitted a one-word name when the word "brain" sat within 48
characters in front of it. The Grok review arm killed it, and the reason generalises: **the word
boundary in `\bbrain\b` falls inside `brain-how-to`** — the topic agents are told to cite most —
so `Read brain-how-to for the releases ritual.` minted a link on `releases` that nobody marked.
`The brain panel lists releases.` and `See the brain: the roadmap slipped` did the same.

A proximity cue on an English word is a guess, and doctrine says detection must not guess. One
wrong live link costs more than every plain mention the cue would have caught, and backticks —
which agents already use — cannot misfire. `NEGATIVE CONTROL: the word 'brain' near a one-word
name does not admit it` in `brain-links.test.mjs` pins all six of the cases the arm found.

### What is deliberately NOT linkified

- **Inside a fenced block (`<pre>`).** That text is what the author typed and must stay byte for
  byte.
- **Inside a link (`<a>`).** A control nested in a link is not reachable by keyboard.
- **Inside a URL, a path, an address, a query string, a fragment, or a sub-delimiter.** The
  scanner keeps the machine punctuation inside one token, so `https://example.com/api?topic=roadmap`
  and `https://example.com/a;shared-host` are each a single run that equals no topic. Three arms
  widened this set, each with a measured case: `?` and `=` (a button landed inside a copy-pasteable
  `curl` command), `\` (a Windows path split), and `;` and `,` (both valid URL sub-delimiters, so
  the slug after one became its own run and was offered from the middle of a URL).

  **Bound, stated rather than denied:** `'`, `(` and `)` are NOT in the run. They are valid in
  URLs but far commoner in prose — `shared-host's rule`, `(see shared-host)` — and adding them
  would lose those links to buy back a rarer case. A URL carrying one next to a topic name can
  still split.
- **Part of a longer token.** `non-shared-host` and `brain-how-to-v2` are their own runs and match
  nothing.

---

## Safety

The pass runs **after** `setSanitizedMessageMarkdown`, over the sanitized tree's **text nodes**
only. It builds elements with `createElement` and sets `textContent`; it never produces an HTML
string and never touches `innerHTML`. It therefore adds no injection surface to the renderer it
follows, and needed no change to `MESSAGE_MARKDOWN_TAGS` or the sanitizer's allowlist.

---

## Bounds, stated as bounds

- **A control is rendered from a snapshot; a click is decided from a fresh read.** `files` is
  loaded when a workspace opens, and `loadSignals`, `renderFeed` and `refreshLatestSignals` never
  touch it. The Grok review arm found both halves of what that cost: a topic created after load
  never linkified, and a topic DELETED after load kept a control whose click failed inside the
  download with "The topic could not be loaded" — a dead control.

  Two things now hold. A bounded re-read runs off the feed tick, at one request per
  `BRAIN_TOPIC_REFRESH_MS` (30 s) rather than at the 2-second signal cadence, so a created topic
  starts linkifying and a deleted one stops within that window while the reader is on the feed.
  And **the click re-reads first, and within one workspace that read is authoritative.** Three
  locks make the sentence true rather than aspirational. `createBrainTopicReader` guarantees a forced refresh returns only
  after a read that STARTED after the click. And `brainLinkClickOutcome` refuses to return `open`
  when that read did not succeed — a list that could not be refreshed authorizes nothing, even for
  a name it still holds, because "this topic exists" is the very claim the failed read did not
  establish. And the click captures `requestVersion` and `activeWorkspaceId` before it awaits and
  compares them after, so a click whose workspace the reader has left resolves to `abandoned`.
  Each of the three has been wrong once; all three are pinned by named tests.

  **Why the third exists.** `refreshBrainTopics(true)` does not run in the workspace the click was
  made in — it takes `activeWorkspaceId` when it is called, and `readBrainTopics` captures at its
  own start. So a click in A, a switch to B while a read is in flight, and the forced read runs
  against B and APPLIES: the list is fresh and the names are real, they are just the wrong
  workspace's. A slug that exists in both then opened in a workspace the reader never clicked in;
  one that does not yanked them to Brain with a notice naming A's slug. `contextIsCurrent` is
  checked first and is not about the topic at all. Found by the Grok review arm.

  **A second arm failed the first version of that fix, and it was right.** The read was guarded by
  a plain in-flight boolean and returned early when it was set, so a click landing while the
  cadence tick was in flight returned SYNCHRONOUSLY, without awaiting anything, and was decided
  against the old snapshot — reaching the download failure the fix existed to prevent. Reads are
  now serialized by `createBrainTopicReader`: a forced refresh waits out a read that is already
  running and then takes its own, because a read that STARTED before the click can carry a result
  that predates what was clicked. Joining is not enough. Pinned by `A FORCED refresh waits out a
  read already running, then takes its own`.

  What remains, stated plainly:
  - Between a delete elsewhere and the next re-read, a control can still be on screen. Clicking it
    opens the Brain panel and says the topic is gone, above the current list.
  - **If the click's own re-read fails** (the network is down), the list is not fresh and the
    click opens nothing at all. It says the list could not be refreshed, that CommonSwarm cannot
    tell whether the topic is still there, and to try again. That is a refusal, not a failure
    surfaced from inside a download — and it costs the reader nothing they would not lose anyway,
    since the read that just failed makes a successful download unlikely.
- **If the file list fails to load, nothing linkifies.** `fileLoadError` leaves the topic list
  empty, and an empty list is a no-op. That is the correct failure: no links beats wrong links.
- **A slug-shaped name links wherever it matches, including where the writer meant the words.**
  `The agent-restart path is slow` offers `agent-restart` if that topic exists. The link is not
  dead and its target is on the subject, but it was not deliberately written as a citation. This
  is the residual cost of choice (a), and it is accepted: the alternative is asking every agent
  to adopt a syntax.
- **A name with a suffix stays plain.** `see brain-how-to.md` is its own run and matches nothing.
  Correct rather than clever: `brain-how-to.md` is not a topic name.
- **A click made in a workspace the reader has left does nothing at all.** No render, no open, no
  notice: the workspace they are on now owes them nothing about a click made somewhere else. The
  decision is `brainLinkClickOutcome`'s `abandoned`, pinned by `a click abandoned by a workspace
  switch opens nothing and says nothing`.
- **A click after the topic is deleted names the topic and says it is gone.** The panel opens
  first so the click feels answered, the list is re-read, and `brainLinkClickOutcome` returns
  `missing` with the message the notice shows. Pinned by `a click on a topic DELETED since the
  control rendered says so, and does not open`, which also asserts the old download failure is
  NOT what the reader gets.
- **A background re-read rebuilds the feed and NOTHING else.** An earlier revision rebuilt
  whichever of Files or Brain was on screen, which was the exact opposite of what its own comment
  promised. Measured harm, since the arm's example was not quite the real one: the Files panel has
  **no rename input** — only download buttons — so nothing typed is lost there, but
  `renderFileList` calls `replaceChildren`, which drops focus; and `brainView.setTopics` can close
  a pane that is holding unsaved edits when that topic's file changed underneath. Both panels are
  rebuilt on entry by `activateWorkspaceView`, and `openBrainTopic` rebuilds Brain itself after
  its own read, so neither needs a background rebuild to stay correct.
- **A read that did not apply reports the list as stale.** `readBrainTopics` returns early —
  resolving, not throwing — when the workspace moved under it, and the `read` wrapper does the
  same when there is nothing to read. The reader used to mark the list fresh on any resolution, so
  a click after a workspace switch was authorized against the previous workspace's names. `read`
  now resolves a boolean and only `true` marks the list fresh. Found by the Gemini arm.
- **A code span may carry the sentence's own punctuation.** `` `roadmap.` `` links: `resolveRun`
  already trimmed the run, and the one-word equality check now applies the same trim. It does not
  weaken the rule — a span with other words in it, `` `cswarm brain get releases.` ``, still
  offers no bare name.
- **NOT ESTABLISHED: run-ordering for a topic name that ends in a dot.** `resolveRun` tries the
  untrimmed run before the trimmed one. That ordering only changes an answer for a topic whose
  name ends in `.` — legal per `canonicalBrainTopic`, produced by nothing today — so it is design,
  not a measured result.
- **NOT ESTABLISHED in a browser: the workspace-switch guard at the call site.** The DECISION is
  pure and unit-tested, and removing its `abandoned` branch turns two named tests red. That the
  call site feeds it a real comparison rather than a constant is held by a source-shape assertion
  — the weak form, chosen because driving a live workspace switch through a real dashboard needs a
  backend the observer fixtures do not have. Removing the capture at the call site turns that
  assertion red, so the pair covers both halves; neither half alone would.
- **NOT ESTABLISHED: the re-read cadence in a browser.** `createBrainTopicReader` is covered
  directly by unit tests, including the in-flight race, the throttle, and a failing read; the
  dashboard's use of it is covered by source-shape assertions. No test drives a live dashboard
  through a create or a delete and watches a control appear or disappear; that needs a backend the
  observer fixtures do not have.
- **NOT ESTABLISHED: production.** This lane hands back a branch. Nothing was deployed, and the
  live site was not fetched.

---

## Tests and their gates

| File | Gate that runs it |
|---|---|
| `site/src/lib/brain-links.test.mjs` | `npm --prefix site test` via the `src/lib/*.test.mjs` glob |
| `site/src/components/app/brain-links.observer.test.ts` | `npm --prefix site test` via the `src/components/**/*.observer.test.ts` glob |

Both are reached by existing globs; no `package.json` change was needed.

Every assertion was mutation-tested: the mutation was applied, the named test was observed to
fail, and the file was restored. The mutations run were — removing validation, removing the
word-gate, dropping the URL punctuation from the token run, restoring the removed "brain" cue,
canonicalizing the visible text, dropping the trailing plain segment, and (in the browser)
removing the `PRE` skip, removing the `A` skip, forcing `marked`, moving the pass in front of the
sanitizer, and passing a literal topic list at the call site.

### Review arms

Both arms ran on the first SHA (`2808ae7`) and both returned FAIL. Every finding was correct and
every one is fixed here.

**Grok** — the decisive one: `\bbrain\b` matches inside `brain-how-to`, so the cue minted links
on one-word topics in ordinary agent prose. The cue is gone. Grok also found that the dashboard
source assertions did not bind `topics: brainTopicNames()` at the call site — a hardcoded list
would have passed — that a Windows path split at `\`, that the focus style changed only the
underline, and that an observer comment described a fixture case that did not exist.

**Gemini** — the token run split a URL query string, so a button could land inside a
copy-pasteable `curl` command; the line-break probe did not reach the boundary it claimed to test
(its first line ended in a period, which killed the cue on its own); and `AGENTS.md` promised "in
the same sentence" where the code enforced a 48-character window.

Two findings were mine, during the fix pass: the code-span probe asserted `textContent`, which
walks into a button and returns the same string either way — it did not reach the path it claimed,
and now counts controls instead; and the first `dots inside a name` test claimed to pin a run
ordering it could not discriminate, so it was rewritten to claim only what it measures.

Both arms were then rerun on the fixed SHA.

---

## The other half of the ask: encourage agents to save durable objects

The operator also asked that agents be encouraged to save durable objects into the brain. That is
copy, not code, and most of it already exists: `BRAIN_END_OF_TASK_NUDGE` prints
`Durable finding? cswarm brain put <topic> — see brain get brain-how-to` after a replied delivery.

What this lane adds is the new consequence, in `AGENTS.md`: a topic name written in a signal is
now a control a human can click, so naming the topic is worth more than paraphrasing it — and a
one-word topic name should be written in backticks so it is recognised.
