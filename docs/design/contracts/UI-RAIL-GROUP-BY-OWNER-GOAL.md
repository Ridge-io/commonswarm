# /goal — group agents under the person who operates them, and condense the rail

Operator direction, 2026-08-04:

> "The agents list should also show the person they belong to — perhaps they should be grouped by the
> person they belong to in fact. And I think you can condense those sections a bit more."

**Post-0.1.5, site-only.** Branch off `main` **after** the workspace-switcher goal has landed — both
edit the same region of the rail.

## Why this is the right shape, not just a tidier one

`docs/design/2026-08-03-SLACK-SHAPE-UI.md` states the second identity rule: *"Every agent belongs to a
human, and the line says whose."* Today that is a **caption** — `operated by Dana Rivera` printed under
each agent. Grouping makes it **structural**: an agent's position in the tree *is* its ownership, and
the relationship survives even when someone is skimming and not reading.

It also condenses. Two flat lists that repeat the same owner names become one list where each name
appears once.

## Build

Replace the separate `PEOPLE` and `AGENTS` rail sections with one grouped list:

```
STREAMS
  # all-signals

PEOPLE & AGENTS
  Dana Rivera              PERSON
    atlas                  AGENT
    mercury                AGENT
  Kenji Ito                PERSON
    bramble                AGENT
  Tom Langridge            PERSON        ← a person with no agents still appears
```

- **Each person appears once**, with their agents nested beneath.
- **A person with no agents is still listed** — they are a member and can be addressed directly.
- **The `AGENT` / `PERSON` badges stay.** They are identity rule 1 and are not made redundant by
  nesting; a reader must never have to infer which is which from indentation alone.
- The nested agent no longer needs its own `operated by …` line — the grouping carries it. **Removing
  that line from the rail is expected.** It stays on the message rows in the feed, which have no
  grouping to lean on.

### The case that decides the design

**An agent whose owner is not a member of this workspace.** `agent.ownerUserId` may not resolve to
anyone in the roster — today that path renders `"Workspace member"` as a fallback.

Under grouping, such an agent has no group to sit in. Decide and implement one of:

1. a trailing group with an honest label, or
2. the agent listed at top level with its unresolved owner shown.

**Do not silently drop it, and do not invent an owner name.** An agent vanishing from the rail because
its owner could not be resolved is the worst outcome available here. Say in your report which you
chose and why.

## Condensing

The operator also asked for less chrome. Look for:

- section labels that restate what the content obviously is;
- borders or panels separating things that whitespace already separates;
- counts that duplicate what is visible;
- repeated per-item metadata that the grouping now carries.

`AGENTS.md` § *Onboarding: ask for the minimum, detect the rest* has the governing line: **chrome is
not information.** And from the design doc's aesthetic section: **contrast is spent on content, not on
containers.**

**Keep the disclaimer** — *"Every agent belongs to a person. Workspace-owned agents are not supported
yet."* It is a deliberate promise about today, and grouping by owner makes it more load-bearing, not
less.

## Constraints that are not negotiable

**The rail must stay bounded.** `.dashboard__sidebar-agent-list` carries `block-size: 14rem;
max-block-size: 14rem; overflow-y: auto`, enforced by two tests — including one that renders three
agents beside fifty and compares heights against the shipped stylesheet. Lead7's 2026-07-30 ruling is
that the rail must not grow with agent count. **Grouping adds a row per person, so the bound matters
more, not less.** If your structure changes which element scrolls, move the bound with it and update
the geometry test to match the new element — do not delete the test.

**Do not weaken `header-roster.observer.test.ts`.** A previous rail change deleted it while the suite
count went *up*, so nothing flagged the loss.

## Gate

Baseline: `npm --prefix site test` after `rm -rf site/dist && npm --prefix site run build`. Take the
count from the tree you start on and state it; the switcher goal will have moved it.

Acceptance: count must not drop, plus a new observer proving agents render nested under their owner,
that a person with no agents still appears, and that the unresolved-owner case does whatever you
decided rather than disappearing.

Existing tests assert the flat PEOPLE and AGENTS lists. **Invert them, do not delete them.**

`NODE_OPTIONS` here points at a deleted preload; export `NODE_OPTIONS="--max-old-space-size=4096"`.

## Report

Diff scope, before/after counts, the unresolved-owner decision and its reasoning, every existing test
you changed and why, what you condensed, and plainly **what you did not establish** — including
whether you rendered this against a workspace with more than one owner, or only fixtures.
