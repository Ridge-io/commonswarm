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
- Site test gate: 30 passed, including the workspace-entry, signed-out app, prompt,
  compatibility-handoff, legal-draft/date/placeholder, metadata, and browser-deadline
  observers.
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

## Adversarial feedback closed before the final gate

The first exact-SHA Grok pass approved `9e7ebf6dad7f1e2f0b114441754a4a6299e6d74a`
but identified two medium product gaps and two low source-hygiene gaps:

- At widths below 52rem the agent rail disappears, so after the first agent joined there
  was no visible control for adding another. The channel header now owns an **Add agent**
  action whenever the active workspace has agents; at 34rem and below the header actions
  wrap in a full-width row.
- An unknown workspace-create outcome correctly warned the user to reload, but the
  dashboard then appended a generic sentence that said retry was safe. That suffix is no
  longer added to `WorkspaceOutcomeUnknown`.
- The old `/start` panels contained retired signup and assent language even though the
  compatibility route no longer imported them. Those orphaned components and their CSS
  were removed, and an observer enumerates the one test file that remains in that
  directory.
- The stale `Base.astro` comment claiming `/app` did not exist now describes the actual
  dormant multi-route navigation flag.

These changes alter the candidate SHA. The replacement SHA must receive fresh substantive
Grok and AGY/Gemini reviews after all gates pass; the first pass is evidence of feedback,
not the final model-inversion approval.

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
