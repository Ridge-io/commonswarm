# /goal — light/dark toggle in the app

Operator direction, 2026-08-04: *"Add a light-mode dark-mode toggle in the app."*

Site-only, small. Branch off `main`.

## The system already supports this

`site/src/styles/tokens.css` was written for a toggle and documents the contract at `:14-20`:

```
:root                                 the light palette. This is the product.
@media (prefers-color-scheme: dark)   dark, when the OS asks and nothing overrides.
[data-theme="dark"]                   dark, when a control asks.
```

The dark media block is scoped `:root:not([data-theme="light"])` (`:483-484`, a `(0,2,0)` selector
deliberately above the plain `[data-theme="dark"]`), so **`data-theme="light"` pins light on a dark OS
and `data-theme="dark"` pins dark on a light one.**

**So the toggle sets one attribute on the root element. Do not add colour values, do not add a second
media query, and do not touch `tokens.css`.**

## Build

**Three states, not two:** `system` (no attribute) · `light` · `dark`. Defaulting to the OS and being
able to *return* to it matters — a two-state toggle silently strips a user's OS preference forever the
first time they touch it.

- Persist the choice (`localStorage`).
- **`system` must remain live**: with no attribute set, a later OS change still flips the page. Do not
  resolve `system` to a literal value at click time and store that — it looks identical on the day and
  is wrong the next morning.
- Place it in the dashboard rail. Keyboard-reachable, with an accessible name that states the current
  state.

## The trap that makes this non-trivial

**Flash of wrong theme.** If the attribute is applied after hydration, a user who pinned dark loads the
page white, then it snaps. The stored preference must be applied **before first paint** — a small
inline script in the document head, ahead of the stylesheet.

This is the entire engineering content of the task. A toggle that works but flashes on every load is
the version people notice.

## Out of scope

The marketing pages (they already follow the OS correctly). A server-side or per-account preference —
this is a device setting. Any change to `tokens.css`.

## Gate

Baseline: `npm --prefix site test` after `rm -rf site/dist && npm --prefix site run build`. State it.

Acceptance: count must not drop, plus an observer proving **(a)** all three states set the expected
root attribute (or none, for `system`), **(b)** the choice survives a reload, **(c)** `system` does not
persist a resolved literal, and **(d)** the pre-paint script is present in the built output ahead of
the stylesheet — that last one is the control for the flash, and asserting it against the **built**
page rather than the source is the point.

Do not weaken `header-roster.observer.test.ts`. Do not disturb `.dashboard__sidebar-agent-list`'s
`14rem` bound.

`NODE_OPTIONS` here references a deleted preload; export `NODE_OPTIONS="--max-old-space-size=4096"`.

## Report

Diff scope, before/after counts, how you avoided the flash, every existing test you changed and why,
and plainly **what you did not establish** — including whether you loaded the page in both schemes or
only asserted the markup.
