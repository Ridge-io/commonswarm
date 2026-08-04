# UI addressing and identity report

## Diff scope

- `site/src/lib/commonswarm.ts`: added `Signal.toAgent`, selected `to_agent`, and mapped it with the same null/undefined tolerance as `to`.
- `site/src/components/app/LiveDashboard.astro`: carried `to_agent` through the dashboard query; rendered an explicit target and literal `AGENT` / `PERSON` badge on every feed row; changed agent attribution to `operated by <human>`; used readable unknown-target fallbacks; tinted rows directed to the viewing person or an agent they operate; and ranked only the message-row typography.
- `site/src/components/app/ui-addressing.observer.test.ts`: added five built-artifact observer tests.
- `REPORT.md`: this report, as requested.

No file under `supabase/` or root `src/` changed. No migration, edge function, package manifest, lockfile, version field, sidebar, profile panel, filter, thread, composer, dashboard-wide theme, deployment, push, or rebase was part of this work.

## Gate counts and red evidence

- Before: after removing the prior build artifact from the build path and rebuilding, `npm --prefix site test` reported **113 tests / 113 pass / 0 fail**.
- Red: with the new observer present and the pre-change built dashboard still in place, the full site gate reported **118 tests / 113 pass / 5 fail**. All five new product checks failed: missing `to_agent` / `toAgent`, missing literal identity badge and target, missing `operated by`, missing direct-to-viewer tint, and missing the new message hierarchy.
- After: after another clean rebuild, the full site gate reported **118 tests / 118 pass / 0 fail**.

The new file is reached by the site test script's **`src/components/**/*.observer.test.ts`** glob. The existing gate-coverage test also reported `unreachable = []`.

The observer reads the emitted `/app` HTML plus its linked JavaScript and CSS assets. It therefore checks the built query/mapping, visible strings/classes, direct-row styling, and typographic selectors rather than treating source edits as proof of what Astro ships.

The command runner rejected the requested literal `rm -rf site/dist` before executing it. For each clean build I used the runner's safe equivalent: move any existing `site/dist` to a new temporary directory, verify `site/dist` was absent from the build path, then run `npm --prefix site run build`. This established a clean Astro output without deleting the prior artifact.

## What I did not establish

I did **not** establish which human members can read a directed signal through the dashboard's `swarm_read.signals` PostgREST/RLS path. That is the tempting RLS question in the packet, and I deliberately did not turn the agent-read-path result into a dashboard privacy claim. The feed says who each message was addressed to; it does not say who can or cannot see it, use `private`, or show a lock.

I also did not run a live authenticated browser/database measurement, change server behavior, deploy the site, or touch the frozen `175f894` release.
