Review ONE commit in the CommonSwarm repo (a coordination service for people and AI agents).
ROUND 5. Rounds 1-4 all returned FAIL; every finding was fixed. Review FRESH.

COMMIT: 56a9496cc0daaf747372828cd942317576c8737f
BASE:   223ee201edc3815c39a001200812e7802884f741
BRANCH: lane/brain-links

## The patch

ABSOLUTE PATH: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-brain-links/arms-56a9496cc0daaf747372828cd942317576c8737f/grok/DIFF.patch

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
LEGAL topic names and no stored topic can carry uppercase. `site/src/lib/message-markdown.ts`
escapes, renders a small markdown subset, then allowlist-sanitizes before `innerHTML`; this
lane's pass runs AFTER that, on text nodes only.

## Binding doctrine (AGENTS.md)

- "Detection must not guess." A false or dead link is worse than no link.
- "An enumeration inside a message must be generated, not typed."
- "A negative result must reach the path it claims to test."
- "Claim controls prove stability, not truth" -- check each claim against what the system does.
- "Sweep the whole claim family" -- tests, comments, docs.
- "Honesty is not sufficient": say what the reader must do next.
- "State what you did NOT establish alongside what you did."

## What earlier rounds found (all fixed; verify the fixes, do not re-file them)

R1: a nearby word "brain" was accepted as a cue for one-word topics -- `\bbrain\b` matches inside
"brain-how-to", so "Read brain-how-to for the releases ritual" linked "releases". Cue removed. The
token run split URL query strings and Windows paths; `? # = & % + \` added.

R2: the topic list was a SNAPSHOT (`workspaceFiles()` ran only on workspace open), so a deleted
topic kept a control whose click failed inside the download. A one-word topic named like a CLI word
linked inside every code snippet because the span merely CONTAINED it. Fixed by a re-read plus
click revalidation, and by requiring the code span to EQUAL the name.

R3: that first re-read fix was broken -- a plain in-flight boolean made the forced read return
early, so a click during the cadence tick decided against the old snapshot. Fixed by
`createBrainTopicReader`: a forced refresh waits out a running read and then takes its OWN fresh
read (joining is not enough -- a read that STARTED before the click can predate what was clicked).
Background reads now re-render only the panel that is on screen.

R4: `brainLinkClickOutcome` still returned `open` whenever the list contained the name, so
`listIsFresh` only changed the wording of the missing message. Now a list that did not refresh
authorizes NOTHING -- the click resolves to `missing` even for a name the stale list still holds.
AGENTS.md no longer re-types the separator set; it names `BRAIN_SLUG_SEPARATORS`, with a drift
test.

Already refuted, do NOT re-file: "a one-word topic with uppercase can never link". canonicalBrainTopic
lowercases, so no stored topic carries uppercase.

## Measured gates on THIS SHA (after `npm run build`)

- `npx tsc --noEmit` exit 0; `check:tests` clean; the site lib typechecks standalone under
  `--strict` with a positive control.
- `npm test`: 740 tests, 740 pass, 0 fail.
- `npm --prefix site test` (freshly built `site/dist`): exit 0, 313 tests, 312 pass, 0 fail.
- `npm run test:p1-cli` after `npm run build`: exit 0, 408 pass, 0 fail, 32 s.
- Mutations this round, each applied then restored with the NAMED test observed to fail: drop the
  freshness check so a stale list can authorize an open; remove the join so a forced refresh
  returns early; re-type the separator list in AGENTS.md; strip the next step from the stale
  message.

## What I want

1. Trace it: can a control render for, or OPEN, a topic the workspace does not hold? Attack
   `createBrainTopicReader` -- forced/unforced interaction, concurrent clicks, workspace switch
   mid-await, a read that rejects, and the `sampleMode` early return inside the injected `read`.
2. Any XSS, injection, or DOM-clobbering path?
3. Attack the token run and the two gates. Give a concrete sentence a real agent would write where
   this links something unintended or misses something intended.
4. Does `readBrainTopics` overwriting the shared `files` array still break the Files panel, the
   Brain pane, or an in-flight Brain save?
5. Does any test assert something that would pass if the feature were broken?
6. Any user-facing string enumerating what the code enforces without being generated from it?
7. Copy accuracy -- check the design brief's "Bounds" section and the AGENTS.md paragraph clause by
   clause against the code.
8. Anything that breaks the existing feed, collapse/expand, or Brain panel.

At most 900 words. You MUST end with exactly one line:
VERDICT: PASS
or
VERDICT: FAIL - <one line reason>
