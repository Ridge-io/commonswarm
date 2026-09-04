Review ONE commit in the CommonSwarm repo (a coordination service for people and AI agents).
ROUND 7. Rounds 1-6 all returned FAIL; every finding was fixed. Review FRESH.

COMMIT: e65af99cae44cf533ca1c77a9339d68fe05d71cf
BASE:   0f949afdb5d51380217b8ea2eb96dbd2e81f1914
BRANCH: lane/brain-links

## The patch

ABSOLUTE PATH: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-brain-links/arms-e65af99cae44cf533ca1c77a9339d68fe05d71cf/grok/DIFF.patch

Read that exact absolute path. Do NOT resolve a relative path and do NOT review any other patch on
this machine -- other lanes run arms here concurrently.

**Before any findings, quote back the FIRST `diff --git` line of that file, verbatim.** If it is
not exactly this, stop and say you have the wrong patch:

    diff --git a/AGENTS.md b/AGENTS.md

## The feature

When an agent names a workspace "brain topic" in a signal body, the app turns that name into a
button that opens the topic, Markdown-rendered, in the Brain panel.

Topics are FILES named `brain--<topic>.md`. canonicalBrainTopic (`src/cloud/brain.ts`) is
`trim().toLowerCase()` plus `/^[a-z0-9][a-z0-9._-]*$/`, so `brain`, `the`, `get`, `roadmap` are
LEGAL topic names and no stored topic carries uppercase. `site/src/lib/message-markdown.ts`
escapes, renders a small markdown subset, then allowlist-sanitizes before `innerHTML`; this lane's
pass runs AFTER that, on text nodes only.

## Binding doctrine (AGENTS.md)

- "Detection must not guess." A false or dead link is worse than no link.
- "An enumeration inside a message must be generated, not typed."
- "A negative result must reach the path it claims to test."
- "Claim controls prove stability, not truth" -- check each claim against what the system does.
- "Sweep the whole claim family" -- tests, comments, docs.
- "Honesty is not sufficient": say what the reader must do next.
- "State what you did NOT establish alongside what you did."

## Fixed in earlier rounds -- verify, do not re-file

R1 a nearby "brain" was a cue for one-word topics; removed. R2 the topic list was a snapshot, and a
one-word topic linked inside any code span that CONTAINED it; fixed by a re-read plus click
revalidation and by span equality. R3 the re-read used a plain in-flight boolean so a forced read
returned early; fixed by `createBrainTopicReader`, which waits out a running read then takes its
own. R4 a non-fresh list still authorized an open; it now authorizes nothing. R5 a workspace switch
mid-read marked a stale list fresh (`read()` now resolves a boolean); `;` and `,` were missing from
the token run so URLs split; the panel gate was inverted; negatives used a vacuous `.every()`;
`` `roadmap.` `` was missed; the brief hand-typed the separators.

R6 (Grok, coordinator-verified) -- fixed in THIS commit. `openBrainTopic` awaited
`refreshBrainTopics(true)` capturing nothing before the await and checking nothing after, while
every sibling continuation in the file captures `requestVersion` + `activeWorkspaceId` and bails.
So: click in workspace A while a cadence read is in flight; reader switches to B; A's read bails;
the forced read then runs against B and APPLIES -- fresh list, B's names -- and B's copy of the
slug opened for a click the reader never made in B, or B was yanked to Brain with a notice naming
A's slug. `brainLinkClickOutcome` now takes `contextIsCurrent`, checked FIRST, returning a new
`abandoned` outcome; the call site captures before the await and compares after; an abandoned click
renders nothing, opens nothing, shows no notice. The previous "workspace switch" test could not
reach that path and was replaced with one whose second read APPLIES against B.

Already refuted, do NOT re-file: "a one-word topic with uppercase can never link"
(canonicalBrainTopic lowercases). The Files panel has NO rename input -- only download buttons.

## Measured gates on THIS SHA (after `npm run build`)

- `npx tsc --noEmit` exit 0; `check:tests` clean.
- `npm test`: 740 tests, 740 pass, 0 fail.
- `npm --prefix site test` (freshly built `site/dist`): exit 0, 320 tests, 319 pass, 0 fail.
- `npm run test:p1-cli`: exit 0, 408 pass, 0 fail.
- This round's mutations, each applied then restored with the NAMED test observed to fail:
  (A) remove the capture/compare and the abandoned branch from the call site -> the dashboard
  source-shape test goes red; (B) remove the `!contextIsCurrent` branch from the pure decision ->
  `a click abandoned by a workspace switch opens nothing and says nothing` and `a name missing from
  the NEW workspace is still abandoned, not reported` both go red.

## What I want

1. Trace it: can a control render for, or OPEN, a topic the workspace does not hold? Attack the
   THREE locks together -- `createBrainTopicReader`'s serialization, `listIsFresh`, and
   `contextIsCurrent` -- and their interleavings: two clicks in flight, a switch between the
   capture and the await, a switch during `brainView.open`, rejection.
2. Any XSS, injection, or DOM-clobbering path?
3. Attack the token run and the two gates. Give a concrete sentence a real agent would write where
   this links something unintended or misses something intended.
4. Does `readBrainTopics` overwriting the shared `files` array still cost a reader anything?
5. Does any test assert something that would pass if the feature were broken? Say so specifically
   for the new workspace-switch test and the source-shape assertions.
6. Any user-facing string enumerating what the code enforces without being generated from it?
7. Copy accuracy -- check the design brief's "Bounds" section and the AGENTS.md paragraph clause by
   clause against the code.
8. Anything that breaks the existing feed, collapse/expand, or Brain panel.

At most 900 words. You MUST end with exactly one line:
VERDICT: PASS
or
VERDICT: FAIL - <one line reason>
