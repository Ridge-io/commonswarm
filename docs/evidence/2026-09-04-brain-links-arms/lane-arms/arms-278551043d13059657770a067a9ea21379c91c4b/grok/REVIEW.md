You are reviewing ONE commit in the CommonSwarm repo (a coordination service for people and AI
agents). This is round 3. Rounds 1 and 2 both returned FAIL; every finding was fixed. Review this
commit FRESH -- do not assume the fixes are correct.

COMMIT: 278551043d13059657770a067a9ea21379c91c4b
BASE:   b55af9a51ec842c21dbf56f2c86a4730413d7bb8
BRANCH: lane/brain-links

## The patch you must review

ABSOLUTE PATH: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-brain-links/arms-278551043d13059657770a067a9ea21379c91c4b/grok/DIFF.patch

Read that exact absolute path. Do not resolve any relative path, and do not review any other
patch file on this machine -- several other lanes are running arms here at the same time.

**Before any findings, quote back the FIRST `diff --git` line of that file, verbatim.** If it is
not exactly this, you are reading the wrong patch and must stop and say so:

    diff --git a/AGENTS.md b/AGENTS.md

## What the feature is

When an agent names a workspace "brain topic" in a signal body, the web app turns that name into
a button that opens the topic, Markdown-rendered, in the existing Brain panel.

Brain topics are FILES named `brain--<topic>.md`. Slugs are canonicalized by canonicalBrainTopic
(`src/cloud/brain.ts`): `/^[a-z0-9][a-z0-9._-]*$/`, lowercase, bounded length -- so `brain`,
`the`, `get`, and `roadmap` are all LEGAL topic names.

`site/src/lib/message-markdown.ts` renders a message body: escape the whole input, apply a small
markdown subset, then allowlist-sanitize before `innerHTML`. This lane's pass runs AFTER that, on
text nodes only.

## Binding doctrine from AGENTS.md

- "Detection must not guess." A false or dead link is worse than no link.
- "An enumeration inside a message must be generated, not typed."
- "A negative result must reach the path it claims to test": ask what a probe would return if the
  feature WERE working; if the answer is the same, the probe measured nothing.
- "Claim controls prove stability, not truth": a test pinning a user-readable string reviews a
  CLAIM; check each claim against what the system actually does.
- "Sweep the whole claim family" -- tests, comments, and docs included.
- "Honesty is not sufficient": when a command returns while work continues, say what the reader
  must do next.
- "Durable by default"; "State what you did NOT establish alongside what you did."

## What earlier rounds found, and what changed

ROUND 1 (`2808ae7`) -- both arms FAIL.
- The one-word gate also accepted a nearby word "brain" as a cue. `\bbrain\b` matches INSIDE
  "brain-how-to", so "Read brain-how-to for the releases ritual" linked "releases". CUE REMOVED.
- The token run split a URL query string, so a button landed inside a copy-pasteable curl command.
  `? # = & % +` added to the run.
- A Windows path split at `\`. Backslash added to the run.
- The line-break probe did not reach the boundary it claimed to test.
- AGENTS.md said "in the same sentence" where the code enforced a 48-character window.

ROUND 2 (`b42e3d3`) -- Grok FAIL, verified by the coordinator.
- **The topic list was a SNAPSHOT.** `workspaceFiles()` ran only when a workspace opened; the feed
  poll never refreshed it. So a topic created after load never linkified, and a topic DELETED
  after load kept a control whose click failed inside the download with "The topic could not be
  loaded" -- a dead control -- while the docs claimed the app renders no dead link.
  FIX: a bounded re-read off the feed tick (one request per 30 s vs the 2 s signal cadence), plus
  `brainLinkClickOutcome`, which decides every click against a FRESH read.
- **A one-word topic named like a CLI word linked inside every code snippet.** A topic named
  `brain` passed the gate because the span merely CONTAINED it, so `cswarm brain put` gained a
  control. FIX: a one-word topic links only when the span IS exactly that word.
- AGENTS.md "recognised anywhere in a sentence" was false inside `<pre>`, `<a>`, and URLs.
- An observer comment described a fixture case the fixture did not contain.

## Measured gate results on THIS SHA

- `npx tsc --noEmit`: exit 0. `npm run check:tests`: clean. The new site lib also typechecks
  standalone under --strict, with a positive control (an injected type error was reported).
- `npm test`: 735 tests, 735 pass, 0 fail.
- `npm --prefix site test` against a freshly built `site/dist`: exit 0, 299 tests, 298 pass, 0 fail.
- `npm run test:p1-cli`: 367 pass, 0 fail.
- Mutation-tested this round, each applied then restored with the NAMED test observed to fail:
  code span CONTAINS instead of EQUALS; click decides against the snapshot; the missing-topic
  message loses its "where you are" clause; the click does not re-read before deciding; the feed
  tick stops offering a re-read; a missing topic falls through to open() instead of the notice.

## What I want from you

1. Trace it: can a control render for, or OPEN, a topic the workspace does not hold? Consider the
   snapshot/refresh/click-revalidation interaction and its races (workspace switch mid-await,
   concurrent Brain-panel save, in-flight guard).
2. Any XSS, injection, or DOM-clobbering path? The pass runs on the sanitized tree.
3. Attack the token run and the two gates. Give a concrete sentence a real agent would write where
   this links something unintended, or fails to link something intended.
4. `refreshBrainTopics` overwrites the shared `files` array. Does that break the Files panel, the
   Brain panel's open pane, or an in-flight Brain save?
5. Does any test assert something that would pass even if the feature were broken?
6. Does any user-facing string enumerate something the code enforces without being generated from
   the enforcing constant?
7. Is the copy plain and accurate? Check the design brief's "Bounds" section and the AGENTS.md
   paragraph clause by clause against the code.
8. Anything that breaks the existing feed, collapse/expand, or Brain panel.

Answer in at most 900 words. You MUST end with a line of exactly this form:
VERDICT: PASS
or
VERDICT: FAIL - <one line reason>
An empty or reasoning-free reply is not a review.
