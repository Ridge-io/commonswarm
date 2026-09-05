# In-app update notice

App-backlog item 5. The app detects that a newer build of itself is being served and offers one
control that reloads onto it.

## What it is about, and what it is NOT about

**It is about the app build only.** It says nothing about the `cswarm` CLI, and nothing about the
version any agent is running. That limit is measured, not assumed, and it is the first thing to
re-check if anyone widens this notice.

### The released CLI version has a source

`site/src/lib/release.ts` exports `CLI_VERSION` from the repo-root `package.json` `version`, which
is the same field that feeds `CLI_BUILD_VERSION` for the binary's own `--version`. `/download` is
built from it. Anything that needs to state the shipping CLI version reads it from there and does
not re-type it.

### The version an agent is RUNNING is not exposed to the app

Enumerated, not pattern-matched. The richest path is `agentAccessStatuses()`
(`site/src/lib/commonswarm.ts`), which POSTs `resource: "renewal_grants"` to the `read` edge
function. **Which SQL function answers depends on who is asking**, and the browser is always the
human branch: with a human session JWT, `supabase/functions/read/index.ts` runs
`swarm_read.renewal_grant_roster(workspace_id)` and returns. `renewal_grant_for_token` is the
agent-token branch of the same endpoint and the app never reaches it. Both declare the same
nineteen columns today, so the answer is the same either way, but a successor re-deriving this
should read the ROSTER function.

**The list below is a hand-typed snapshot and can drift; re-derive it from the migration rather
than trusting this copy** — `swarm_read.renewal_grant_roster` in
`supabase/migrations/20260904000001_standing_grant_resume.sql`:

renewal_grant_id, principal_id, owner_user_id, agent_name, model, kind, horizon_expires_at,
bound_device_id, last_used_at, last_used_device_id, last_used_from, new_host_at, suspended_at,
revoked_at, token_id, issued_at, token_expires_at, first_used_at, token_revoked_at.

None of them is a version. It is not the only path either, and the others are no better: the
`members` resource returns `principal_id, name, owner_user_id` for agents and `user_id,
display_name` for people, and neither the feed nor the delivery receipts carry a version. The
`version` on an activity frame is that frame's schema version, not a CLI version. Where a running
version DOES exist:

- `cswarmVersion` in `src/listener/control.ts` is a field of the LOCAL listener control file. It is
  what `cswarm listen status` and `cswarm resume` read off the host's own disk. It never leaves the
  machine.
- `cswarm_version` in `src/cli.ts` is a field inside a FEEDBACK submission body. It is descriptive
  context on a feedback row, not agent state, and nothing under `supabase/` reads it back per agent.

**So an "your agent is behind" notice cannot be built honestly today.** It would need the listener
to report its version to the server on a durable write and a read-path column to carry it back.
That is a server change with a migration, not an app change, and it is out of this lane.

## How a new build is detected

Two signals. Neither covers a build on its own, and the second one exists because the first was
measured and found short.

**Signal 1 — served assets against running assets.** Every Astro build emits
`/_astro/<name>.<contenthash>.<js|css>`, and the hash tracks that asset's content: it changes when the
content changes, and a build that changes nothing re-emits the same name. A rename changes the
path too, which is also a build worth reloading for. The page reads its own set out of the DOM once at boot, before any poll, and
compares it with the set in the HTML the server returns for the same path. This one is certain
(the code being served is not the code in this tab) and it needs no history, so it also catches a
build that was deployed before this page ever loaded.

**Signal 2 — our served markup against the first our-markup this tab saw.** It reads
`<live-dashboard>`, not the whole document. Everything this build renders is inside that element,
and bytes that are not ours — an injected analytics or preview toolbar, a proxy's per-request id —
land outside it. Comparing the whole document would have flapped on those and cried wolf. Signal 1 alone does not see
a build that changed only markup. That is measured, not supposed: a build with one word changed in
a component template produced a different `/app/index.html` and byte-identical `/_astro` names,
because component markup is inlined into the page rather than into a hashed asset. Copy changes
are most of what ships, so an asset-only check would have missed most builds. Signal 2 compares
the served page against the first page this tab was served.

**Why the served page and not a generated build id.** A build id is a CLAIM about the build; a
stale or half-deployed one would lie in exactly the case this exists for. These bytes ARE the
build. Nothing new has to be kept in step, so nothing can drift.

**Why it cannot fire on nothing.** A rebuild that changes no source produces the same asset names
and the same bytes, so both comparisons are equal and no notice appears.

**Dismissal is remembered against the WHOLE build**, both parts joined, never against whichever
half happened to differ. Storing one half let a dismissal silence a later build: dismissing an
asset change stored the asset set, and the next build that changed only markup carried that same
asset set and compared equal to it.

**One poll at a time, and none dropped.** Two in flight can settle out of order and baseline the
wrong page, so a second request does not start while one is open. It is not thrown away either:
coming back to the tab while a poll is open is exactly when a reader wants an answer, and the next
timer tick is five minutes off, so the request is remembered and run when the open one finishes.

**What it does when it cannot tell.** A failed fetch, a non-OK status, or a body with no hashed
assets in it — a login redirect, an SSO interstitial, an error page — all mean the poll learned
nothing. It does nothing and waits for the next one. Silence is the only honest output of a probe
that did not reach what it measures.

**Not covered, and named so nobody has to rediscover it.**

- A build deployed in the gap between this document loading and the first poll, which changed
  markup only: signal 1 sees the same assets and signal 2 takes the new page as its baseline. The
  next build after it is detected normally.
- A change to a file `/app` does not reference from its own HTML — a lazily imported chunk whose
  hash moved, or something under `public/`. The app has no dynamic imports today (`import(` count
  in `LiveDashboard.astro` is 0, and the built page emits no `modulepreload`), so there is no such
  chunk to miss; adding one would open this gap.
- A change to markup OUTSIDE `<live-dashboard>` that also leaves every asset hash alone: a `<head>`
  edit in the layout, for instance. Signal 1 covers head changes that touch a stylesheet or script,
  which is most of them.

## The notice

One row at the top of the product shell, above the sample-data notice, hidden until a different
build is seen. It reads "This page is out of date." and carries two buttons: Update, which
reloads, and "Not now".

**Out of date, not "new".** What the page detects is that it is not running what the server is
serving. A rollback is that too, and the earlier wording called a rollback a new version.

The sentence is that short on purpose. The buttons already say what the choices are, so repeating
them cost height: measured at 390x844, the longer wording wrapped to two lines and "Not now"
wrapped inside its own button, taking the bar to 128px against a 73px app bar. It is 53px at
390x844 and at 320x568, one row, with both controls keeping a 44px target.

This bar is a grid item, and a grid item's automatic minimum is its min-content width. Without an
explicit `min-inline-size: 0` it sized to its buttons and overflowed: measured 394.6px inside a
320px shell, and the shell clips its overflow, so Update was off-screen and unpressable.

Dismissal is remembered in memory only, against the WHOLE build that triggered it — both signals'
values joined, never just the half that happened to differ. Storing one half is a real bug and was
one: see "Dismissal is remembered against the WHOLE build" above. A reload gets the new build
anyway, so there is nothing to persist; and if a THIRD build ships, it differs from the dismissed
one and the notice returns. The bar is dismissible because the operator's standing
complaint about this app is chrome eating the reading area on a phone.

## Polling

Only while the document is visible, and once when it becomes visible again. A hidden tab is not
being read, and the reload happens on the reader's schedule, not ours.
