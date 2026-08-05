# /goal — redesign the People & Agents rail section

Operator, 2026-08-04: *"Improve the design of the people and agents section, it's bad looking."*

**This packet is written from a rendered screenshot, not from the markup.** I built the section with
the shipped stylesheet and realistic data and looked at it —
`docs/evidence/2026-08-04-ui-and-sandbox/rail-before.png`. Every problem below is observed. Reproduce
it yourself before changing anything; the failures are obvious on sight and invisible in the DOM.

## What is wrong, in priority order

**1. The grouping is invisible — this is the big one.** Agents were nested under their operator
earlier today. On screen, `Tom Langridge`, `atlas`, `mercury`, `Kenji Ito`, `bramble` all sit at the
**same left edge with identical row treatment**. It reads as a flat list of five unrelated things. The
entire point of the change — ownership as structure rather than caption — is lost. **Nothing in the
rendering says atlas belongs to Tom.**

**2. Person and agent rows are visually identical.** Same avatar diameter, same layout, same weight.
Only a small text badge distinguishes a human from software.

**3. The badges shout and repeat.** `PERSON`/`AGENT`/`AGENT`/`PERSON`/`AGENT` in letterspaced caps
under every name — five badges in five rows, restating what position should convey. This is the
`AGENTS.md` rule *chrome is not information* on a list that is mostly chrome.

**4. Presence dots on people.** Every row carries a green dot, humans included. We do not track human
presence. A green dot next to a person's name asserts "online", which is a claim we cannot support —
the same class of error as any other unbacked UI claim.

**5. Names render in a serif.** Wrong for a dense navigation list and inconsistent with the rest of the
shell.

**6. The ownership disclaimer is a wrapping paragraph inside the navigation.** Two lines of policy prose
at the bottom of a scrollable list. **Keep the sentence** — it is a deliberate promise — but it does not
belong at that weight in that place.

**7. No vertical rhythm.** Rows, section label and disclaimer all sit at one indent with even spacing,
so nothing groups.

## What to build

Make **ownership legible without a caption**:

- **Indent agents under their operator**, or use another structural device that makes the parent-child
  relation unmistakable at a glance.
- **Differentiate the two row types** — a person is the heading of a group, an agent is a member of
  one. Different sizes, different weights.
- **Drop the per-row `AGENT` badge once nesting carries it.** Keep an unmistakable marker of what is
  software — identity rule 1 stands, and a reader must never *infer* agent-ness. A small glyph or a
  distinct avatar treatment satisfies it; a repeated caps chip on every row is not the only way.
- **Presence only where we have data.** Agents may have it. People do not. Remove the dot from person
  rows rather than showing an unbacked signal.
- Fix the serif; match the shell.
- Move the disclaimer out of the scrolling list, or make it markedly quieter.

Governing lines, both already in the repo: **contrast is spent on content, not on containers**, and
**chrome is not information**.

## Constraints

- **The rail must stay bounded.** `.dashboard__sidebar-agent-list` carries `block-size: 14rem;
  max-block-size: 14rem; overflow-y: auto`, enforced by two tests including one that renders three
  agents beside fifty and compares heights. Grouping adds a row per person, so this matters more. **If
  your structure changes which element scrolls, move the bound and update the test — never delete it.**
- Do not weaken `header-roster.observer.test.ts`.
- **Use only existing tokens.** No new colour literals — the dashboard is at zero and there is a test
  asserting that.
- Do not touch `tokens.css`.

## Verify by looking, not only by asserting

Render the section with realistic data — at least two people, one with multiple agents, one with none,
plus an agent whose owner is unresolved — **and look at it in both light and dark.** Save the images.

A test can prove a class exists. It cannot tell you the result looks like a flat list, which is
precisely the defect that shipped today because everyone including me verified structure and nobody
looked.

## Gate

Baseline: `npm --prefix site test` after `rm -rf site/dist && npm --prefix site run build`. State it.
Count must not drop. Add an observer for whatever structural property carries the nesting, so a later
change cannot silently flatten it again.

`NODE_OPTIONS` here references a deleted preload; export `NODE_OPTIONS="--max-old-space-size=4096"`.

## Report

Diff scope, before/after counts, **the before and after images**, every existing test you changed and
why, and plainly what you did not establish.
