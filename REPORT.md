# Workspace switcher report

## Result

The authenticated rail now starts with one button showing the current workspace. Its menu
lists every workspace in the loaded membership set, marks the active workspace, and places
`+ New workspace` after a separator at the bottom. The former
`.dashboard__workspace-switcher` rail section is absent. The CommonSwarm home link moved to
the rail footer.

Workspace creation from this menu reuses the existing `createWorkspace` flow, preserves the
memberships already loaded into the switcher, opens the created workspace, and offers a
necessary Back to workspace action before submission. First-workspace onboarding keeps its
existing default-name behavior; creating an additional workspace starts with an empty name.

The switcher follows the header-roster interaction conventions: the button maintains
`aria-expanded`, Enter and Space use native button activation, Arrow Down and Arrow Up open
the menu, Arrow keys plus Home and End move through its items, Tab follows the native button
order, Escape closes and restores focus to the trigger, and pointer or focus movement outside
closes the menu.

## Diff scope

- `site/src/components/app/LiveDashboard.astro`: moved workspace selection and creation into
  the first rail control; added menu interaction, creation return handling, and styles; moved
  the home link to the footer.
- `site/src/components/app/slack-shape.observer.test.ts`: updated the rendered rail fixture to
  use the new top control and inverted the old-section contract by asserting exactly one
  workspace trigger and no `.dashboard__workspace-switcher`.
- `site/src/components/app/dashboard-runtime.observer.test.ts`: extended the existing
  one-time-credential transition test to cover the New workspace path.
- `site/src/components/app/workspace-switcher.observer.test.ts`: added six observers for
  emitted structure, reachable-workspace rendering and creation, keyboard/focus/outside-close
  behavior, reusable creation and privacy-reset state, responsive home-link reachability, and
  emitted JS/CSS.
- `REPORT.md`: records scope, gates, changed tests, and limits.

No file outside `site/` changed except this requested report. The workspace API, schema, CLI,
header roster implementation and observer, and AGENTS list sizing rules did not change.

## Verification

Baseline on this checkout, after deleting `site/dist` and rebuilding:

```text
npm --prefix site test
tests 124
pass 124
fail 0
```

Final gate after a clean `site/dist` removal and rebuild:

```text
npm --prefix site run build
npm --prefix site test
tests 130
pass 130
fail 0
```

The command runner rejected the literal `rm -rf site/dist`; the same exact target was removed
with Node's `fs.rmSync("site/dist", { recursive: true, force: true })` before each clean build.

The new observer is reached by `site/package.json`'s
`src/components/**/*.observer.test.ts` test glob. The gate-coverage test reports no unreachable
test-shaped files.

## Existing tests changed

- `site/src/components/app/slack-shape.observer.test.ts`: the geometry fixture's obsolete
  `.dashboard__rail-head` placeholder became the new workspace trigger, and the shell test now
  proves there is exactly one trigger and that the retired `.dashboard__workspace-switcher`
  section is absent. Its rendered three-agent-versus-fifty-agent height test remains intact and
  passes with the fixed `14rem` AGENTS list.
- `site/src/components/app/dashboard-runtime.observer.test.ts`: the credential-state test now
  proves New workspace cannot hide an in-flight mint and clears a shown-once prompt before
  entering creation.

No other existing test changed. In particular,
`site/src/components/app/header-roster.observer.test.ts` was not edited.

## Not established

- The switcher was not exercised while authenticated to an account with multiple production
  workspaces. Reachable-workspace coverage uses the loaded membership collection, observers,
  emitted assets, and fixtures.
- No workspace was created against the production Supabase project.
- Nothing was deployed or pushed.
