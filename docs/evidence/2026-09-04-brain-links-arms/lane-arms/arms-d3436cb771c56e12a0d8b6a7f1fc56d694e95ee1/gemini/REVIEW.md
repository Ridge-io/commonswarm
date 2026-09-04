Review ONE commit in the CommonSwarm repo (a coordination service for people and AI agents).
ROUND 6. Rounds 1-5 all returned FAIL; every finding was fixed. Review FRESH.

COMMIT: d3436cb771c56e12a0d8b6a7f1fc56d694e95ee1
BASE:   223ee201edc3815c39a001200812e7802884f741
BRANCH: lane/brain-links

## The patch

ABSOLUTE PATH: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-brain-links/arms-d3436cb771c56e12a0d8b6a7f1fc56d694e95ee1/gemini/DIFF.patch

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

R1 a nearby "brain" was a cue for one-word topics (`\bbrain\b` matches inside "brain-how-to");
cue removed. R2 the topic list was a snapshot, and a one-word topic linked inside any code span
that merely CONTAINED it; fixed by a re-read plus click revalidation and by span equality. R3 the
re-read used a plain in-flight boolean so a forced read returned early; fixed by
`createBrainTopicReader`, which waits out a running read then takes its own. R4
`brainLinkClickOutcome` still opened whenever the list held the name; a non-fresh list now
authorizes nothing.

R5 (Gemini, coordinator-verified) -- fixed in THIS commit:
- `readBrainTopics` returned early (resolving) on a workspace switch and the reader marked the
  list fresh on ANY resolution, so a click could be authorized against the previous workspace.
  `read()` now resolves a BOOLEAN and only `true` marks fresh; every early return resolves false.
- `RUN_RE` lacked `;` and `,`, both valid URL sub-delimiters, so `https://x/a;shared-host` split
  and put a button inside a URL. Both added to the run AND to the trailing-punctuation trim.
- The panel gate was inverted: the comment promised no rebuilding under a reader, the code
  rebuilt exactly the on-screen panel. A background read now rebuilds the FEED and nothing else.
- Negative snapshots used `controls.every(...)`, vacuous on an empty array; each is now paired
  with a positive count. `` `roadmap.` `` in backticks was missed; the equality check now applies
  the same trim the run does. The design brief no longer hand-types the separator set.

Already refuted, do NOT re-file: "a one-word topic with uppercase can never link"
(canonicalBrainTopic lowercases). Also note the Files panel has NO rename input -- only download
buttons -- so a `renderFiles()` rebuild drops focus but loses no typed text.

## Measured gates on THIS SHA (after `npm run build`)

- `npx tsc --noEmit` exit 0; `check:tests` clean; the site lib typechecks standalone under
  `--strict` with a positive control.
- `npm test`: 740 tests, 740 pass, 0 fail.
- `npm --prefix site test` (freshly built `site/dist`): exit 0, 318 tests, 317 pass, 0 fail.
- `npm run test:p1-cli`: exit 0, 408 pass, 0 fail.
- Eight mutations this round, each applied then restored with the NAMED test observed to fail:
  reader marks fresh on any resolution; readBrainTopics resolves true after a workspace switch;
  drop `;`/`,` from the run; keep them in the run but not the trim; background read rebuilds the
  on-screen panel again; negatives drop their positive count while the render is broken; the code
  span equality stops trimming; the brief re-types the separators.

## What I want

1. Trace it: can a control render for, or OPEN, a topic the workspace does not hold? Attack
   `createBrainTopicReader` and the boolean contract -- concurrent clicks, a read that resolves
   false while another resolves true, workspace switch mid-await, rejection.
2. Any XSS, injection, or DOM-clobbering path?
3. Attack the token run and the two gates. Give a concrete sentence a real agent would write where
   this links something unintended or misses something intended.
4. Does `readBrainTopics` overwriting the shared `files` array still cost a reader anything?
5. Does any test assert something that would pass if the feature were broken?
6. Any user-facing string enumerating what the code enforces without being generated from it?
7. Copy accuracy -- check the design brief's "Bounds" section and the AGENTS.md paragraph clause
   by clause against the code.
8. Anything that breaks the existing feed, collapse/expand, or Brain panel.

At most 900 words. You MUST end with exactly one line:
VERDICT: PASS
or
VERDICT: FAIL - <one line reason>
