Review ONE commit in the CommonSwarm repo (a coordination service for people and AI agents).
This is ROUND 4. Rounds 1-3 all returned FAIL; every finding was fixed. Review FRESH.

COMMIT: 8395dd28ad0aa8c83fd8f316a77ff6ec851ebb47
BASE:   98146d5d12964d94aad3cea0aaf0abe88e00532e
BRANCH: lane/brain-links

## The patch

ABSOLUTE PATH: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-brain-links/arms-8395dd28ad0aa8c83fd8f316a77ff6ec851ebb47/gemini/DIFF.patch

Read that exact absolute path. Do NOT resolve a relative path, and do NOT review any other patch
on this machine -- other lanes run arms here concurrently.

**Before any findings, quote back the FIRST `diff --git` line of that file, verbatim.** If it is
not exactly this, stop and say you have the wrong patch:

    diff --git a/AGENTS.md b/AGENTS.md

## The feature

When an agent names a workspace "brain topic" in a signal body, the app turns that name into a
button that opens the topic, Markdown-rendered, in the Brain panel.

Topics are FILES named `brain--<topic>.md`. canonicalBrainTopic (`src/cloud/brain.ts`) allows
`/^[a-z0-9][a-z0-9._-]*$/` -- so `brain`, `the`, `get`, `roadmap` are all LEGAL topic names.
`site/src/lib/message-markdown.ts` escapes, renders a small markdown subset, then allowlist-
sanitizes before `innerHTML`; this lane's pass runs AFTER that, on text nodes only.

## Binding doctrine (AGENTS.md)

- "Detection must not guess." A false or dead link is worse than no link.
- "An enumeration inside a message must be generated, not typed."
- "A negative result must reach the path it claims to test."
- "Claim controls prove stability, not truth" -- check each claim against what the system does.
- "Sweep the whole claim family" -- tests, comments, docs.
- "Honesty is not sufficient": say what the reader must do next.
- "State what you did NOT establish alongside what you did."

## What earlier rounds found (all fixed; verify the fixes)

R1: a nearby word "brain" was accepted as a cue for one-word topics -- `\bbrain\b` matches inside
"brain-how-to", so "Read brain-how-to for the releases ritual" linked "releases". Cue removed.
The token run split URL query strings and Windows paths. `? # = & % + \` added.

R2 (Grok, coordinator-verified): the topic list was a SNAPSHOT -- `workspaceFiles()` ran only on
workspace open -- so a deleted topic kept a control whose click failed inside the download. Also,
a one-word topic named like a CLI word linked inside every code snippet because the span merely
CONTAINED it. Fixed by a re-read plus click revalidation, and by requiring the span to EQUAL the
name.

R3 (Gemini): **that first re-read fix was broken.** It guarded with a plain in-flight boolean and
returned early when set, so a click landing while the cadence tick was in flight returned
synchronously without awaiting -- deciding against the old snapshot and reaching the same download
failure. Fixed by `createBrainTopicReader`: a forced refresh waits out a running read and then
takes its OWN fresh read (joining is not enough -- a read that started before the click can predate
what was clicked). Gemini also flagged that a background read re-rendered panels a reader might be
using (now gated to the on-screen view), and that AGENTS.md enumerated the slug separators (now
removed, pointing at BRAIN_SLUG_SEPARATORS instead).

## Measured gates on THIS SHA

- `npx tsc --noEmit` exit 0; `check:tests` clean; the site lib typechecks standalone under
  `--strict` with a positive control.
- `npm test`: 740 tests, 740 pass, 0 fail.
- `npm --prefix site test` (freshly built `site/dist`): exit 0, 311 tests, 310 pass, 0 fail.
- `npm run test:p1-cli` after `npm run build`: exit 0, 408 pass, 0 fail, 30 s.
- Mutations this round, each applied then restored with the NAMED test observed to fail:
  reintroduce the early-return in-flight guard; make the forced refresh JOIN instead of taking a
  fresh read; drop the cadence throttle; report a failed read as fresh; make a stale list still
  claim to be current; let a background read rebuild off-screen panels.

## What I want

1. Trace it: can a control render for, or OPEN, a topic the workspace does not hold? Attack
   `createBrainTopicReader` -- the in-flight/forced interaction, concurrent clicks, workspace
   switch mid-await, and a read that rejects.
2. Any XSS, injection, or DOM-clobbering path?
3. Attack the token run and the two gates. Give a concrete sentence a real agent would write where
   this links something unintended or misses something intended.
4. Does `readBrainTopics` overwriting the shared `files` array still break the Files panel, the
   Brain pane, or an in-flight Brain save?
5. Does any test assert something that would pass if the feature were broken?
6. Any user-facing string enumerating what the code enforces without being generated from it?
7. Copy accuracy -- check the design brief's "Bounds" section and the AGENTS.md paragraph clause
   by clause against the code.
8. Anything that breaks the existing feed, collapse/expand, or Brain panel.

At most 900 words. You MUST end with exactly one line:
VERDICT: PASS
or
VERDICT: FAIL - <one line reason>
