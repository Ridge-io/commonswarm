# Workspace-first entry candidate — 2026-07-29

## Claim under test

A public **Create a workspace** action enters `/app`, the product surface. A signed-out
visitor sees email first (with GitHub alongside it); a signed-in visitor with no workspace
sees workspace creation; and the new workspace opens as an empty shared channel whose
prominent next action is **Add an agent**. That action retains the existing scoped,
one-time copy-paste prompt flow.

`/start` survives only as a compatibility handoff. It copies the incoming query and URL
fragment to `/app` before `location.replace`, so saved links and old auth callbacks do not
re-enter a second onboarding controller.

## Candidate measurements

All commands below were run from the isolated
`Lead7--workspace-first-entry` worktree after rebasing onto the then-current `origin/main`.

- `npm test`: 99 passed.
- `npm run test:p1-cli`: 131 passed.
- `npm run check:tests`: passed.
- `npm run build`: passed.
- `npm run check:edge`: all three edge-function entrypoints passed `deno check`.
- Clean configured site build: seven static routes built.
- Site test gate: 26 passed, including the workspace-entry, signed-out app, prompt,
  compatibility-handoff, legal-draft, metadata, and browser-deadline observers.
- Built-artifact enumeration found eight `/app` links and zero `/start` links on the home
  page; `/app` contained non-empty backend URL and anon-key metadata; the sampled built
  routes contained zero service-role JWT markers.
- The built `/start` artifact contained the query copy, fragment copy, and
  `location.replace` handoff and contained zero instances of the retired “Getting started”
  checklist. The artifact probe included an explicit nonzero negative control.
- Local browser checks at 1280px and 375px wide found the signed-out form fully visible,
  no horizontal overflow at 375px, email before GitHub, and no duplicate `main` landmark.
  `/start?source=legacy#compat-test` arrived at
  `/app?source=legacy#compat-test`.

## Deliberately not established by this artifact

- These are candidate and local-build measurements, not proof that production serves the
  candidate.
- No production identity was created and no persistent production workspace was consumed.
- The hosted signed-in sequence from workspace creation through agent join and first signal
  still requires a fresh authenticated browser session and a deliberately chosen workspace.
- The already-deployed command edge function was separately reviewed and deployed; these UI
  measurements do not re-establish its hosted clock, fresh-auth, or database ceilings.

Production deployment and signed-in verification must be reported separately and must name
any ceiling that remains.
