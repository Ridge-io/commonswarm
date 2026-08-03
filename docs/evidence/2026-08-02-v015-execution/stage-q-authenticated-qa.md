# Stage Q — authenticated production QA (in progress)

Target: https://commonswarm.com (production, currently v0.1.4).
Browser: controlled Chrome window, authorized by operator decision 7.
Session state at start: an existing signed-in session as **Ridgeio**.

## Public controls (re-measured at QA start)

`/`, `/start`, `/app`, `/invite` → 200. `/nope-qa-control` → 404 (negative control).
`/start` backend meta present (1), service-role credential marker **0**.

## What works

- `/app` dashboard loads and renders. Three workspaces listed (CommonSwarm Build, Dogfood Workspace,
  uxtest-r1-92cb361a).
- Feed renders six updates with correct per-signal attribution, including
  `Model not specified · owned by Ridgeio` — the owner-relation display path is working.
- Roster expands correctly: **Ridgeio · owner**, **Tom Langridge · member**.
- Workspace details expands with a workspace ID and a "Copy workspace ID" control.
- Mobile 390×844: **no horizontal scroll** (`scrollWidth` 390 == `clientWidth` 390). Workspaces
  become a horizontally scrollable strip; the feed reflows and reads well; Sign out reachable.

## QA-008 (new) — "Remove" control renders one letter per line

**Severity: MINOR, user-visible, on the live dashboard.**

In the members roster, the Remove button for a member renders as a vertical stack of single
characters — `R e m o v e` — instead of a horizontal label.

Measured, not eyeballed:

```
button.dashboard__text-button   width 21px   height 171px
parent li.dashboard__agent      display grid, width 247px
                                grid-template-columns: 189.594px 21.4062px
button computed overflow-wrap: break-word
```

The name span consumes 190px of a 247px grid, leaving ~21px for the action column; `overflow-wrap:
break-word` then breaks the word at every character.

**Not an artifact of instrumentation.** First observed after forcing `<details>` open via JS, so it
was re-checked from a fresh page load with an ordinary click on the summary element. It reproduces.

**Narrowest correction:** `white-space: nowrap` on `.dashboard__text-button`, so the label cannot
break and the `auto` column takes its intrinsic width. Alternatively size the grid explicitly
(`minmax(0, 1fr) auto`).

**Mobile note:** at 390×844 the same button measures 0×0 because the roster is not rendered in that
layout. Whether member management should be reachable on mobile is a product question, recorded here
rather than assumed to be a defect.

## Not yet established — the largest remaining gap

The **cold-browser sign-in** has not been exercised. A note in the production feed from five days ago
records the same gap in the operators' own words:

> "Next unproven leg is the WEB sign-in at /start — cswarm login only exercised the loopback redirect
> arm, not the commonswarm.com one."

Testing it requires either signing out of the operator's live session or driving a fresh browser
profile. That is an operator decision, not mine to take unilaterally, and it is pending.

Also still to run: workspace creation, add-own-agent with automatic prompt completion, live feed
update within five seconds, second-human invite consumption with pending-access clearing,
remove/revoke with history remaining attributable, and focused keyboard/accessibility controls.
