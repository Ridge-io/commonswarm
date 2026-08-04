# /goal — the app adopts the marketing site's token system, with light and dark

Operator direction, 2026-08-04:

> "Bring the colour scheme, with light and dark mode, from the homepage back into the app. I like this
> new layout a lot, but I'd like the marketing and the app to match in aesthetics."

**Post-0.1.5, site-only.** Branch off `main` **after** the workspace-switcher and group-by-owner goals
land — all three edit `LiveDashboard.astro`.

## Measured state

| | Marketing pages | The dashboard |
|---|---|---|
| Token system | **`src/styles/tokens.css`, 180 tokens** | does not import it |
| Light/dark | **full** — `@media (prefers-color-scheme: dark)` plus `[data-theme]` overrides | **none** (`prefers-color-scheme` → 0 hits) |
| Colours | semantic tokens | **21 hardcoded literals** |

So the dashboard is not a different theme of the same system — it is a **second, parallel colour
system** that happens to sit under the same domain.

## Why this is smaller than it looks

`tokens.css` already does the hard part. It flips every elevation, text, border and accent token under
`@media (prefers-color-scheme: dark)`, scoped `:root:not([data-theme="light"])` so a future toggle can
force either direction. **Adopting the tokens gets light and dark without writing a dark theme.**

The tokens also carry **documented contrast ratios inline** — e.g. `--text: #10142a; /* min 16.06:1 */`,
`--accent: #4633b8; /* min 7.65:1 */`, `--border-interactive` annotated as clearing WCAG 1.4.11 on all
five elevations. Using them preserves accessibility work already done. **Introducing a new colour
discards it silently.**

## Build

1. **Import the token system into the dashboard** the way the marketing pages do.
2. **Replace all 21 hardcoded colours with tokens**, mapped by *role*:
   - page background → `--bg` / `--elev-0`, raised surfaces → `--bg-raised` / `--surface`
   - body text → `--text`, secondary → `--text-muted`, tertiary → `--text-faint`
   - hairlines → `--border`, emphasis → `--border-strong`, control edges → `--border-interactive`
   - the direct-to-you tint and selection → `--accent-dim` / `--accent`, ink on accent → `--accent-ink`
   - destructive (`Revoke`) → the danger tokens; success/warning states → `--success` / `--warning`
3. **Add no new colour values.** If a needed role has no token, say so in your report and use the
   nearest documented one rather than inventing a literal. A missing token is a finding.

### The trap specific to this conversion

**The dashboard's current literals are dark-theme values.** A naive substitution — swapping a dark
hex for the token whose *light* value looks similar — produces light-on-light or dark-on-dark in one
of the two schemes, and only one scheme gets looked at.

Map by **role**, not by resemblance. A dark panel background becomes `--surface`, which is dark in dark
mode and light in light mode. It does not become a token that is currently the same shade.

**Check both schemes.** A conversion verified only in the scheme your OS happens to be in is half a
conversion.

## Preserve

The Slack-shape work that just landed defines the layout and its typographic ranking. **This goal
changes colour, not structure.** Specifically, do not disturb:

- `.dashboard__sidebar-agent-list`'s `block-size: 14rem; max-block-size: 14rem; overflow-y: auto` —
  Lead7's bounded-rail ruling, enforced by two tests including a rendered three-versus-fifty height
  comparison;
- `header-roster.observer.test.ts`, which a previous rail change deleted while the suite count rose;
- the addressing chips, `AGENT`/`PERSON` badges, `operated by`, and the direct-to-you row treatment —
  the tint may change token, not disappear.

The governing aesthetic line from `2026-08-03-SLACK-SHAPE-UI.md` still holds: **contrast is spent on
content, not on containers.**

## Gate

Baseline: take it from the tree you start on and state it. Build first — `rm -rf site/dist &&
npm --prefix site run build`.

Acceptance: count must not drop, plus an observer proving **(a)** the dashboard's rendered CSS
references the shared tokens, **(b)** it carries a `prefers-color-scheme: dark` path, and **(c)** no
raw hex literal survives in the dashboard's colour declarations. That last one is the control that
stops the conversion being partial — a half-converted page passing a "uses tokens" check is exactly
the failure to guard against.

`NODE_OPTIONS` here points at a deleted preload; export `NODE_OPTIONS="--max-old-space-size=4096"`.

## Report

Diff scope, before/after counts, **the full mapping of the 21 literals to tokens**, any role that had
no token, every existing test you changed and why, and plainly **what you did not establish** — in
particular whether you rendered and looked at both light and dark, or only asserted the CSS.
