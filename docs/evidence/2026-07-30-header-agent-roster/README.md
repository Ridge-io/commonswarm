# Workspace-header agent roster — implementation evidence

Date: 2026-07-30. Branch: `swarm/Lead7/header-agent-roster`. Owner: Lumen (implementation),
under Lead7 goal "Workspace-header agent roster redesign".

## Governing inputs (swarm inbox, Lead7)

1. Dogfood findings: at 1360x757 the only Add-an-agent door's rect was top≈1377 (below the
   fold); generated avatars mixed three border-radii (50%, 7.68px, 6.72px 50% 50% 6.72px) on
   identical 32px initial tiles; at 390x844 the collapsed rail left no Add-agent or
   agent-management control; feed auto-update (22→23) must be preserved.
2. Correction: roster moves OUT of the rail into a Slack-style header stack button opening
   an accessible dialog/sheet: Add agent first, then the full searchable/scrollable roster
   with model, owner, and permission-aware Remove. Rail keeps workspaces/account/details
   and must not grow with agent count. Escape/close/focus-restore/keyboard semantics and
   mobile layout required.
3. Stale-roster finding: polling updated signals (22→33) while the roster/count stayed at 7
   and new agents rendered as `Agent 582065` fallbacks. Header roster must refresh on
   unknown agent-authored signals, bounded, no request storm; 2s polling preserved.

## What shipped

- Rail agent section deleted (`data-agent-list`, `data-add-agent-rail`, the mobile
  collapse sync). Rail now: workspaces, Members, Pending access, Workspace details,
  account foot (re-pinned with `margin-block-start: auto`).
- Header: one stack button (up to 3 overlapping uniform circular tinted initials + live
  count, `aria-haspopup="dialog"`, `aria-expanded`, dynamic aria-label
  "N agents — view and manage agents"). Hidden when zero agents (empty channel carries
  the CTA). Own row at ≤52rem so visibility never depends on workspace-name length.
- Native `<dialog>`: Add an agent first (hidden in sample mode), filter input, scrollable
  roster (max-block-size, rows = avatar + name + model · owner + role-aware Remove with
  the unchanged confirm and `data-agent-error`). Escape/backdrop/X close; `close` event
  re-syncs aria-expanded; native focus restore to the stack button; opening focus lands
  on Add (or the filter in sample mode). Same element becomes a bottom sheet ≤52rem.
- Avatars: one shape (circle), hue tint kept; initials now `--text` on the tint (the
  pastel-ink rule was tuned for the dark palette and washed out in light mode).
- Unknown-agent bounded roster refresh: a poll page containing a signal from an unknown
  agent principal triggers one roster+member refetch (single flight + 10s cooldown),
  updating stack, dialog, counts, and feed author names. Polling cadence untouched.
- `global.css`'s `* { margin: 0 }` zeroes the UA's dialog-centering margin; restored
  explicitly (`margin: auto`, re-anchored to bottom in the sheet media query).
- `workspace-entry.observer.test.ts`: two assertions locking the rail roster retired with
  a dated, attributed comment; successor assertions live in the new observer.

## Gate results (this worktree, exact files)

- `cd site && rm -rf dist && npm run build` — 8 pages, clean.
- `cd site && npm test` — **52/52 pass** (44 prior + 8 new header-roster tests).
- root `npm test` — **112/112 pass**.
- root `npm run check:tests` — clean.
- RED control: the new observer failed before implementation (rail hooks present, dialog
  hooks absent) and passes after; it also caught two real defects during bring-up
  (an early-terminated block comment, and anchor collisions in my own test).
- Built-artifact control: `dist/app/index.html` contains `data-roster-dialog`,
  `data-roster-open`, `data-add-agent-dialog`; zero occurrences of `data-agent-list` /
  `data-add-agent-rail`.

## Browser verification (browser-harness, Chrome via CDP, local `astro preview`)

Viewports are Lead7's two dogfood sizes. All interactions keyboard-driven
(Enter/Escape via trusted CDP key events).

1360x757, sample channel:
- Stack button rect top 106 / bottom 150 — inside the viewport (the old rail Add was at
  top≈1377). aria-label "3 agents — view and manage agents".
- All six visible avatars' computed border-radius = "50%" (was three mixed shapes).
- Feed live: 3 rows, "3 updates"; polling code path unchanged.

Keyboard semantics, two consecutive cycles:
- Enter on the focused stack button opens the dialog (aria-expanded true); Escape closes
  it (native cancel), aria-expanded re-syncs false, focus returns to the stack button.
- X button and backdrop click also close and restore focus.
- Filter: "orb" → 1 row (Orbit); "zzz" → "No agents match “zzz”."; reopening resets it.

Dialog, non-sample variant (throwaway local build with sampleMode forced off, reverted):
- "Add an agent" visible, positioned above the filter, receives initial focus; Enter
  closes the dialog and opens the existing "Who runs this agent?" view with focus on the
  first choice.

7-agent variant (throwaway sample data, reverted):
- aria-label "7 agents — view and manage agents"; stack caps at 3 initials; dialog lists
  all 7 rows and scrolls (scrollHeight 431 > clientHeight 320).

390x844:
- Stack button fully inside the viewport (left 16 / right 119 / top 315) on its own
  header row. Found and fixed here: `flex-direction: column` + the new `flex-wrap: wrap`
  produced a second flex COLUMN pushing the button to left 386 (mostly clipped); the
  stacked header now sets `flex-wrap: nowrap`.
- Dialog is a bottom sheet: full width (0–390), bottom-anchored (bottom = 844),
  rounded top corners, focus inside, Escape closes and restores.

Light mode (emulated prefers-color-scheme):
- Stack and feed avatar initials use `--text` (rgb(16,20,42)) on the hue tint — legible;
  the previous pastel-ink tint was a dark-palette leftover.

Screenshots (this directory):
- `desktop-channel.png` / `desktop-light.png` — header stack in the channel, dark + light.
- `desktop-dialog.png` — the management dialog (sample mode: Add hidden, filter focused).
- `desktop-dialog-7.png` — 7-agent scrollable roster (throwaway data).
- `mobile-channel.png` / `mobile-sheet.png` — 390x844 header row + bottom sheet.

## Not established here

- No live-backend session was used (DB lanes are fenced by Lead7): the signed-in Remove
  round-trip, the unknown-agent refresh against a real join, and the Add-visible dialog
  on production were verified by observer tests, code review, and the throwaway local
  variants above — not against the live deployment.
- A removed agent's row disappears via the existing full `openWorkspace` reload, which
  closes the dialog; focus is handed to the stack button (or the empty channel's Add
  door). Removing several agents in a row re-opens the dialog per removal.
- The pending-access rail details can still lag a consumed token until the next full
  workspace open; the unknown-agent refresh does not refetch access statuses.
- Dark-mode screenshot set was captured with the user's Chrome in dark; light mode was
  verified under emulated prefers-color-scheme.
