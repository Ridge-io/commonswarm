# D-034 browser fetch deadlines

**Date:** 2026-07-29  
**Implementer:** Mica  
**Original implementation base:** `f4b54d291ac030c688074f452b578ae5aa6e1ac3`

**Original reviewed candidate:** `8a55899eccf609a70e326565d6b7ce8dbd4a5344`

**First integration parent:** `75e032de0e41666019870bd2930a4bb3b6985b46`

**Current integration parent:** `2c3d9860b6fa117b5ee9fbf2445fb7c52deeab63`

## Scope

This is the browser half of D-034. It is disjoint from Tundra's CLI signal-read lane:
production changes are confined to `site/src/lib/commonswarm.ts`.

The browser had three user-blocking reads/writes with no application deadline:

- the `postCommand` fetch used by `createWorkspace` on `/start`;
- `myWorkspaces`, used by both `/start` and `/app`; and
- `feed`, used by `/app`.

If the provider accepted a connection but never produced an answer, signup or the dashboard
could remain on a loading state forever.

## Decision

Each of those operations now owns a 30-second `AbortController` deadline and clears its timer
when the operation settles.

- The create deadline covers both the initial fetch and `response.text()`. A timeout or other
  transport loss is an **unknown write outcome**: the workspace may already have committed.
  The error therefore says to reload before trying again and never says that nothing happened.
- Membership and feed calls propagate the deadline with the Supabase PostgREST builder's
  production `.abortSignal(...)` call. They are reads, so their timeout says that nothing
  changed and retry is safe.
- No dashboard or signup component, edge function, CORS policy, backend ceiling, or deployment
  was changed.

The same behavioral observer is reachable from both projects:

- root: `npm run test:p1-cli` reaches `tests/p1-cli/**/*.test.ts`;
- site: `npm --prefix site test` runs that exact observer file.

The fake fetches never answer on their own. They assert that the production call site supplied
an `AbortSignal` and reject only when that signal aborts. One additional fake returns headers
but leaves the response body pending, proving the create timer survives until the body is read.

## Production-call-site mutations

Each mutation was applied, enumerated in the source, run against its named observer, restored
with `apply_patch`, and followed by a green focused run.

### Create command signal removed

Removing `signal: deadline.controller.signal` from the production `fetch` produced:

```text
mutation applied: postCommand signal propagation absent
✖ D-034: create fetch settles with an explicit unknown outcome at the deadline
tests 1
pass 0
fail 1
AssertionError: observer never reached the create-workspace fetch call site
```

Restored:

```text
✔ D-034: create fetch settles with an explicit unknown outcome at the deadline
tests 1
pass 1
fail 0
```

### Signup membership signal removed

Removing `.abortSignal(signal)` from the production `myWorkspaces` query produced:

```text
mutation applied: myWorkspaces signal propagation absent
✖ D-034: signup membership read settles safely at the browser deadline
tests 1
pass 0
fail 1
AssertionError: observer never reached the membership read fetch call site
```

Restored:

```text
✔ D-034: signup membership read settles safely at the browser deadline
tests 1
pass 1
fail 0
```

### Dashboard feed signal removed

Removing `.abortSignal(signal)` from the production `feed` query produced:

```text
mutation applied: feed signal propagation absent
✖ D-034: dashboard feed read settles safely at the browser deadline
tests 1
pass 0
fail 1
AssertionError: observer never reached the dashboard feed fetch call site
```

Restored:

```text
✔ D-034: dashboard feed read settles safely at the browser deadline
tests 1
pass 1
fail 0
```

## Gates

All gates are pure and slot-free; no local database or deployment was touched.

### Original candidate

These counts bind to the original `8a55899` candidate before the dashboard/connect observer
suite landed on main:

```text
npm run check:tests
exit 0

npm run build
exit 0

npm test
tests 82
pass 82
fail 0
cancelled 0
skipped 0

npm run test:p1-cli
tests 128
pass 128
fail 0
cancelled 0
skipped 0

npm --prefix site test
tests 4
pass 4
fail 0
cancelled 0
skipped 0

npm --prefix site run build
7 pages built
exit 0
```

### First rebase integration

The candidate was then rebased onto exact parent `75e032d`. That base expanded the standard
site test command with dashboard/connect observers. The resolved package script preserves
every base glob, appends the D-034 browser observer, and retains the dedicated
`test:browser-deadline` command.

Content identity against reviewed `8a55899` was measured after the rebase:

```text
IDENTICAL site/src/lib/commonswarm.ts
IDENTICAL tests/p1-cli/browser-fetch-deadline.test.ts
IDENTICAL docs/evidence/2026-07-29-d034-browser-fetch-deadlines.md (before this integration record)
IDENTICAL site/package-lock.json
SUPERPOSITION site/package.json:
  base dashboard/connect test command preserved
  D-034 observer appended
  dedicated deadline command identical
```

The full gates were then rerun on the composed tree:

```text
npm run check:tests
exit 0

npm run build
exit 0

npm test
tests 82
pass 82
fail 0
cancelled 0
skipped 0

npm run test:p1-cli
tests 128
pass 128
fail 0
cancelled 0
skipped 0

npm --prefix site test
tests 17
pass 17
fail 0
cancelled 0
skipped 0
D-034 browser observers included 4

npm --prefix site run build
7 pages built
exit 0
```

### Current rebase integration

The previously approved browser patch was rebased again onto exact parent
`2c3d9860b6fa117b5ee9fbf2445fb7c52deeab63`. That base added the root
`tests/command-cors.test.ts` entry and the site's `test:onramp` command. The resolved tree
preserves the root `package.json` byte-for-byte and preserves every site script from the base.
The base site `test` command is unchanged except for appending the D-034 observer; the
dedicated `test:browser-deadline` command is also retained.

Content identity was measured against the prior exact approved candidate `4be37fc`:

```text
IDENTICAL site/src/lib/commonswarm.ts
  blob a09dd43926746575543a822a4178ef3cc019fb22
IDENTICAL tests/p1-cli/browser-fetch-deadline.test.ts
  blob 3e0e3889fc307a230b5cc355a8fb6decee868a84
IDENTICAL site/package-lock.json
  blob 807e29a185508a03bb0afeb082afd002b77c149f
IDENTICAL root package.json against 2c3d986
SUPERPOSITION site/package.json:
  every base script preserved, including test:onramp
  every base test glob preserved
  D-034 observer appended
  dedicated deadline command identical
```

The full gates were rerun on the current composed tree:

```text
npm run check:tests
exit 0

npm run build
exit 0

npm test
tests 86
pass 86
fail 0
cancelled 0
skipped 0
command-cors tests included 4

npm run test:p1-cli
tests 128
pass 128
fail 0
cancelled 0
skipped 0

npm --prefix site test
tests 17
pass 17
fail 0
cancelled 0
skipped 0
D-034 browser observers included 4
start on-ramp observer included

npm --prefix site run build
7 pages built
exit 0

npm --prefix site run test:onramp
7 pages built
17/17 rendered checks passed
exit 0
```

## Rejected alternatives

- **`Promise.race` against a timer.** Rejected because it settles the caller but leaves the
  provider request and response body running. The production call sites need cancellation,
  not only a second promise that wins a race.
- **Report a create timeout as “nothing was created.”** Rejected because the command can
  commit before the response is lost. That sentence would turn a recovery action into a
  duplicate workspace.
- **Clear the create timer as soon as response headers arrive.** Rejected because body reading
  can also stall. The response-body observer is the positive control for this boundary.
- **Edit dashboard/start components to add component-local timers.** Rejected because both
  components use the same browser library. A library deadline covers every current caller
  without overlapping dashboard work or inventing different outcome language per component.
- **Change Tundra's CLI signal implementation.** Rejected as a separate, already-owned lane.

## Not established

- This does not establish that 30 seconds is the ideal product threshold; it matches the
  repository's existing command and renewal deadlines.
- This does not add deadlines to Supabase Auth calls (`getSession`, OAuth, OTP, or sign-out).
  They are outside the three D-034 production call sites measured here.
- This does not establish behavior for an arbitrary injected fetch implementation that ignores
  `AbortSignal`. Production uses browser fetch and Supabase's fetch path; the observers model
  the required abort contract.
- Aborting a create request does not prove that server-side work stopped. The UI deliberately
  treats the durable outcome as unknown.
- This does not establish deployed behavior, browser-version coverage, live-provider latency,
  or CORS behavior. No deploy was authorized or performed.
