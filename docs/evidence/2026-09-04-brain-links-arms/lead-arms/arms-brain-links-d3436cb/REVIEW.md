You are an ADVERSARIAL reviewer for CommonSwarm. Find what is WRONG. An empty PASS is not a review.
The patch is /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/arms-brain-links-d3436cb/DIFF.patch; read it with your file tools. BEFORE your findings, quote back the FIRST line of that file verbatim (it begins 'diff --git'); a reply without that quote-back did not read the right file. The repo is
/Users/yulanbot/Developer/Ridge.io/cloud-swarm; read any file on the branch with
`git show lane/brain-links:<path>`. Do not edit anything.

## What the patch claims (lane/brain-links @ d3436cb)
When a signal body names a brain topic, the web feed renders it as a button that opens that topic,
Markdown-rendered, in the existing Brain panel. Detection is validated against the live topic list
already in the browser (`brainTopics(files, …)`, the same list the panel can open), so a link cannot
point at a topic that does not exist. Collision rule: a slug containing `-`, `_` or `.` links on exact
match anywhere; a one-word topic (`roadmap`, `releases`) links ONLY inside inline code. A nearby word
"brain" is NOT a cue (an earlier version used it; `\bbrain\b` matched inside `brain-how-to`). Parsing
and validation live in `site/src/lib/brain-links.ts`; LiveDashboard.astro gets four hunks (an
import, two helpers, the render hook after `setSanitizedMessageMarkdown`, CSS). One paragraph is
added to AGENTS.md telling agents to save durable objects into the brain.

## Doctrine that binds it (AGENTS.md)
Detection must not guess — a wrong automatic answer is worse than none. Any user-facing
enumeration must be generated from the constant that enforces it. Sweep the whole claim family.
A negative result must reach the path it claims to test. The product voice is plain and calm.

## Check, with an attempted refutation each, citing the diff
1. Injection: the render hook runs AFTER the sanitizer. Find any way a signal body can produce a
   link, an attribute, or script through this pass — a topic name containing `<`, `"`, `javascript:`,
   a `data-` attribute, or Markdown that survives sanitization and is then re-parsed here.
2. False links: construct a body where text that is NOT a live topic becomes a button. Consider a
   topic that is a prefix/suffix of another (`roadmap` vs `commonswarm-roadmap`), a topic name with a
   trailing `.` at sentence end, a URL containing a topic slug in its path or query, a fenced code
   block, an existing `<a>`, and a body written before the topic existed.
3. Missed links the operator would expect: `There's a brain topic for CommonSwarm-roadmap` must
   link on the canonical slug; check case folding and the visible text is preserved.
4. The word gate: a one-word topic links only inside inline code. Is that enforced in the parser,
   or only in a test? Would a topic named `brain` or `the` cause harm?
5. Live-list binding: what if `files` is empty or stale when signals render (race at load, topic
   deleted after render, topic created after render)? Does a click on a deleted topic fail
   honestly?
6. The four LiveDashboard hunks: does the render hook run once per message or on every re-render,
   and can it double-wrap an already-linked span? Line ranges 1001, 3273-3288, 3797-3804, 9491-9522.
7. Tests: for each new assertion, would it FAIL if the behaviour regressed? Name any that assert
   `textContent` where the path being tested is an attribute or a node type. The PM claims 23 tests
   and a mutation for each; spot-check five.
8. AGENTS.md paragraph: is every sentence true of the shipped CLI (`cswarm brain put`), and does it
   tell agents anything they cannot do?

Your LAST line must be exactly `VERDICT: PASS` or `VERDICT: FAIL`.

## What changed since b42e3d3 (the SHA a Grok arm failed)
1. The topic list is no longer a workspace-open snapshot: `refreshBrainTopics(force)` re-reads it on
   healthy feed ticks (throttled to one request per 30 s) and on every click; a click decides against
   THAT read via a pure `brainLinkClickOutcome(topic, topicsNow)`; a deleted topic yields `missing`
   with a notice naming it, shown above the topic list. Design doc lines 111/123 rewritten to state the
   residual (a control can be on screen between a delete elsewhere and the next re-read; clicking it
   says so) instead of denying it.
2. A one-word topic links only when the inline code span EQUALS the name — `cswarm brain put` gains no
   control when a topic is named `brain`; `` `brain` `` alone still does.
3. AGENTS.md no longer says "anywhere in a sentence"; it names `<pre>`, links and URLs as exceptions.
4. The observer fixture now carries the case its comment describes.
Re-check all eight items against THIS diff; verify each of the four claims above against the code.

## A prior Gemini pass on this exact diff returned FAIL on one claim — re-judge it with this evidence
It claimed `isLinkable` compares a lowercased code span against a `topic` that "preserves its
original case", so a one-word topic with uppercase could never link. Measured against the code:
`canonicalBrainTopic(value)` (the CLI/protocol canonicaliser that every stored topic passes through)
is `value.trim().toLowerCase()` followed by a lowercase-only regex that REJECTS anything else, with
the message "brain topics use N or fewer lowercase letters, numbers, dots, dashes, or underscores".
So every stored topic name is lowercase; `brainTopics(files)` derives names from those stored
names; `known.set(topic.toLowerCase(), topic)` therefore stores a lowercase value; and the equality
in `isLinkable` is lowercase-to-lowercase. The live workspace has 0 of 40 topics with uppercase.
If you disagree, show a reachable path that puts an uppercase character into `topics[]`; otherwise
do not repeat that finding. The prior pass's other two points (re-render cannot double-wrap; the
`textContent` assertions are weaker than the node-count gates beside them) are accepted as notes,
not defects. Re-run all eight checks; decide on what remains.

## What changed since 2785510 (rounds 4-5)
- A forced refresh waits out any in-flight read and then takes its own (`createBrainTopicReader`),
  and `brainLinkClickOutcome` refuses to `open` on a non-fresh list even if the stale list holds the
  name. Verify BOTH locks in the code and that each has a test that goes red without it.
- Panel re-renders on a background tick are gated on `app.dataset.channelView`; the cadence tick
  fires only from `refreshLatestSignals` (feed views). Verify an unsaved Files/Brain edit survives.
- AGENTS.md names `BRAIN_SLUG_SEPARATORS` rather than the characters, with a drift test.
- The "click re-reads first and is authoritative" sentence is restored, naming both locks.
Re-run all eight checks on THIS diff.

## What changed since 56a9496 (round 6) — a Gemini arm FAILED 56a9496 on these three, all verified
1. `read()` now resolves a boolean "I replaced the list for the workspace active NOW"; every early
   return (workspace/version guard, sampleMode) resolves false; only true marks fresh. Verify a
   workspace switch mid-read makes a click `missing`, and that the test for it goes red on mutation.
2. `RUN_RE` now includes `;` and `,`, AND the trailing-punctuation trim strips them, so
   `https://x/a;commonswarm-roadmap` does not linkify mid-URL while `see shared-host, then …` still
   links. `'`, `(`, `)` deliberately stay out (commoner in prose than URLs) — is that bound stated?
3. A background read rebuilds the feed and NOTHING else; `openBrainTopic` rebuilds Brain after its own
   read. Verify no `renderFiles()`/`renderBrain()` on the background path, and that unsaved Brain
   edits survive a background read.
Also: negatives paired with positive counts; `` `roadmap.` `` links; the brief names the separator
constant. Re-run all eight checks on THIS diff.
