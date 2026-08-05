# /goal — empty-workspace CTAs, and the redundancy/line-break problems

Operator, 2026-08-04, from two screenshots of the **deployed** app. Site-only. Sequence after the
participants redesign — same file.

## 1. A new workspace needs TWO calls to action

> *"In a new empty workspace we should have two CTAs really — Add an agent, but also invite a
> collaborator (a human teammate)."*

The empty state today offers **only** `Add an agent`, under the heading *"Add your first agent."*

That is the wrong single choice, and it is wrong in a way that matters commercially: **connecting an
agent is currently blocked for most people.** The CLI accepts only Grok 0.2.117 or OpenCode 1.18.10
(`src/cli.ts:2551-2556`, pins at `:2699`); anyone whose assistant is Claude Code cannot complete it.
A new workspace whose only door is the one door most visitors cannot walk through is a dead end.

Inviting a human works today, needs no CLI, and is the other half of the product — this is a
coordination service for *people and agents*, and the empty state currently names only agents.

Build **two peer actions**: `Add an agent` and `Invite a collaborator`. Neither subordinate to the
other. Adjust the heading so it does not promise only the agent path.

## 2. The new-workspace form says "workspace" three times

Observed on the create screen, top to bottom:

```
NEW WORKSPACE          ← eyebrow
Name the
new workspace.         ← heading, broken mid-phrase
Create another shared feed for the people and AI agents
working together.      ← body
Workspace name         ← field label
[                    ] [ Create workspace ]
```

Four surfaces to say one thing. Collapse it. The eyebrow and the field label are the weakest — a
labelled input under a heading that already says "name the workspace" is chrome, and `AGENTS.md` says
chrome is not information.

**"Create another shared feed…"** is also wrong for anyone creating their first workspace from an
empty account. The copy branches at `LiveDashboard.astro:1054-1057` (`hasWorkspace ? … : …`) — the
branch exists; the *another* wording just leaks into the wrong arm or reads oddly in both.

## 3. Line breaking is bad in several places

`Name the / new workspace.` splits mid-phrase. The body wraps to a stranded `working together.`
Line-height on the body is loose enough to read as two separate paragraphs.

Set sensible measure and wrapping so headings break at phrase boundaries. Use `text-wrap: balance`
(or equivalent) for headings and `pretty` for body where supported. **Do not fix this with hard line
breaks** — they break at every other viewport width.

## 4. The rail reserves empty space — root cause found

The `PEOPLE & AGENTS` list shows one member and then a large empty gap before the disclaimer.

**Cause:** `.dashboard__sidebar-agent-list` sets **`block-size: 14rem`** — a *fixed* height — as well as
`max-block-size: 14rem`. So it always occupies 14rem, whether it holds one row or fifty.

**Fix: keep `max-block-size`, drop the fixed `block-size`.** The list then shrinks to its content and
still caps at 14rem with its own scroll.

**This preserves Lead7's ruling** (`docs/evidence/2026-07-30-header-agent-roster/`) — the rail must not
grow with agent count — because the *maximum* is what enforces that. The fixed height was never the
constraint; it was an over-implementation of it.

**The geometry test must still pass**: it renders three agents beside fifty and compares heights. With
a max only, three and fifty no longer occupy the same height — three is *shorter*. **Update the test to
assert the real property — the list never exceeds the cap and scrolls beyond it — rather than deleting
it.** State clearly in your report what you changed it to and why.

## 5. Redundant disclosures

`Members 1` and `Workspace details` sit below a `PEOPLE & AGENTS` section that already lists the
members. Two of these three are the same information. Collapse or remove; say which and why.

Also: a visible box is rendered around the `STREAMS (broadcast)` heading in the deployed shot, which
reads as a stuck focus ring on a non-interactive element. Find it and remove it.

## Constraints

No new colour literals — the dashboard is at zero and a test asserts it. Do not weaken
`header-roster.observer.test.ts`. Do not touch `tokens.css`.

## Gate

Baseline from the tree you start on; state it. Count must not drop. Add an observer for the two-CTA
empty state.

**Render and look, in both light and dark.** Include the images. A section that reads as a flat list
passed three structural verifications today; screenshots are the only check that caught it.

`NODE_OPTIONS` here references a deleted preload; export `NODE_OPTIONS="--max-old-space-size=4096"`.
