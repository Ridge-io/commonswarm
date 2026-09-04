Review ONE small follow-up commit in the CommonSwarm repo. Its parent lane already landed on
main after seven review rounds; this commit closes three items the coordinator routed to a
follow-up. Review FRESH.

COMMIT: 70af7219a0e4bc94de1e95b1c283e36e24391d3e
BASE:   c27a6af8a666a9ca430fd83697d2c5e2dd56c01c
BRANCH: lane/brain-links-types

## The patch

ABSOLUTE PATH: /private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-bl-types/arms-70af7219a0e4bc94de1e95b1c283e36e24391d3e/grok/DIFF.patch

Read that exact absolute path. Do NOT resolve a relative path and do NOT review any other patch on
this machine -- other lanes run arms here concurrently.

**Before any findings, quote back the FIRST `diff --git` line of that file, verbatim.** If it is
not exactly this, stop and say you have the wrong patch:

    diff --git a/docs/design/2026-09-04-BRAIN-LINKS-IN-SIGNALS.md b/docs/design/2026-09-04-BRAIN-LINKS-IN-SIGNALS.md

## What the parent feature is

When an agent names a workspace "brain topic" in a signal body, the app turns that name into a
button that opens the topic, Markdown-rendered, in the Brain panel. `brainLinkClickOutcome` decides
a click against a freshly re-read topic list and returns one of three outcomes: `open`, `missing`,
or `abandoned` (the reader has left the workspace the click was made in).

## What this commit does -- exactly three things

1. **`BrainLinkOutcome` did not declare `abandoned`** although the function returns it, so
   `site/src/lib/brain-links.ts` did not typecheck (TS2322). The member is added. Then a GATE:
   `site/tsconfig.brain-links.json` is a narrow project over that one file, and
   `site/src/lib/brain-links-types.test.mjs` runs tsc over it. Whole-site tsc cannot be the gate:
   `tsc -p site/tsconfig.json` reports 69 errors, 68 of them pre-existing in `../src/protocol/*`
   and `astro.config.mjs`, so a new line is unreadable there. The repo-root tsc covers only
   `src/**` and never looks at `site/`.
2. **The observer source-shape test pinned the FOURTH argument** of `brainLinkClickOutcome` but not
   the third, so a call site passing a constant for `listIsFresh` stayed green. Both positions are
   now pinned in one match, which pins their ORDER too.
3. **A bound recorded, no code change:** a topic named `1.5` is slug-shaped (a dot is a separator)
   and links in ordinary prose. The coordinator ruled that an intended link, since the topic exists
   under exactly that name.

## Binding doctrine (AGENTS.md)

- "A negative result must reach the path it claims to test": ask what a probe would return if the
  feature WERE working; if the answer is the same, the probe measured nothing.
- "Claim controls prove stability, not truth" -- check each claim against what the system does.
- "An enumeration inside a message must be generated, not typed."
- "Sweep the whole claim family" -- tests, comments, docs.
- "State what you did NOT establish alongside what you did."

## Measured gates on THIS SHA (after `npm run build` and a site build)

- repo-root `npx tsc --noEmit` exit 0; `npm run check:tests` clean;
  `cd site && npx tsc --noEmit -p tsconfig.brain-links.json` exit 0.
- `npm test`: 740 tests, 740 pass, 0 fail.
- `npm --prefix site test`: exit 0, 323 tests, 322 pass, 0 fail.
- `npm run test:p1-cli`: 408 tests, 407 pass, **1 fail** --
  `guard: the allowlist covers every identity currently on main`. That failure is NOT from this
  commit: this branch's only commit is authored by an allowlisted identity, and the guard reads
  `origin/main`'s history, where exactly one commit (`e65af99`, the parent lane, already merged)
  carries an author address absent from `scripts/check-commit-identity.sh`. It is reported to the
  coordinator, not fixed here -- widening a security allowlist is not this lane's call.
- Mutation for item 2, applied then restored: replacing `listIsFresh` with a constant `true` in
  argument position 3 turns the dashboard source-shape test red (paste in the report).
- The type gate carries its own positive control INSIDE the test: it copies the file, removes the
  union member exactly as the defect had it, and asserts tsc fails naming "abandoned".

## What I want

1. Is the narrow tsconfig honest, or does it buy a green by excluding what matters? Could this gate
   pass while `brain-links.ts` is genuinely broken -- consider `types: []`, `skipLibCheck`, and the
   fact that the file imports nothing.
2. Does the positive control in `brain-links-types.test.mjs` actually reach the path it claims?
   Attack it: the compiler resolution, the string replacement, the assertion on the message.
3. Does the new third-argument pin actually discriminate, or is it satisfiable by a call site that
   is still wrong? Is pinning source SHAPE the right control here, and what does it not cover?
4. Is the `1.5` bound stated accurately against what the code does?
5. Anything in this commit that breaks the feed, the Brain panel, or the parent lane's behaviour?
6. Any user-facing string enumerating what the code enforces without being generated from it?
7. Is the copy plain and accurate -- the tsconfig comment block, the test comments, the commit
   message's claims about why site tsc is not the gate?

At most 700 words. You MUST end with exactly one line:
VERDICT: PASS
or
VERDICT: FAIL - <one line reason>
