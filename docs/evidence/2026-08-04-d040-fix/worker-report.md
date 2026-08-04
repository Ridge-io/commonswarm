# D-040 listener brick fix report

> **Current-state note, 2026-08-04 (D-044):** this report records the earlier sandbox implementation.
> Its per-turn isolation and tool-deny controls are now retired; server authority remains unchanged.

Branch: `fix/v015-d040`  
Base: `175f894f7e3a3e9ec822b5a187331fee7fccd3c5`  
Fix commit: `de848ee5f213e200e6265a99b84a0cf084f25996` (`fix(listener): prevent durable delivery bricking`)  
Push status: not pushed

## Fix 1 — C-1: stale durable leased recovery

Changed `src/listener/runtime.ts` so every restored `leased` journal record is
recovered before the durable claim path can replay its expired command. If a
matching terminal effect exists, the runtime prepares and sends its ACK, then
clears the journal. If no terminal effect exists, the runtime waits through the
lease plus safety margin, clears the journal, and re-claims with a new command.
A recent `claim_pending` durable recovery remains an exact command replay. An
attempt older than the server's maximum lease plus the safety margin is now
cleared before replay, because an ambiguous successful claim may otherwise
return its stored, expired lease forever.

Causal controls:

- `C-1: an expired durable leased claim without an effect clears and re-claims`
- `C-1: an expired durable leased claim with a terminal effect ACKs before clearing`
- `C-1 composition: an expired leased claim with a resumable effect re-claims and finishes`
- `C-1 composition: a live leased claim with a resumable effect replays immediately`
- `C-1 composition: an unverified terminal-shaped effect does not brick recovery`
- `C-1 composition: stale claim_pending clears before durable replay`

Exact red output before the fix:

```text
✖ C-1: an expired durable leased claim without an effect clears and re-claims (4.162667ms)
  AssertionError [ERR_ASSERTION]: C-1 stale durable lease must recover instead of stopping fatally
  + actual - expected

  + 'fatal'
  - 'cancelled'

✖ C-1: an expired durable leased claim with a terminal effect ACKs before clearing (0.402042ms)
  AssertionError [ERR_ASSERTION]: C-1 terminal durable recovery must ACK instead of replaying the expired claim
  + actual - expected

  + 'fatal'
  - 'cancelled'

✖ C-1 composition: an expired leased claim with a resumable effect re-claims and finishes (4.555041ms)
  AssertionError [ERR_ASSERTION]: C-1 resumable recovery must not classify a nonterminal effect as terminal
  + actual - expected

  + 'fatal'
  - 'cancelled'

✖ C-1 composition: a live leased claim with a resumable effect replays immediately (4.120917ms)
  AssertionError [ERR_ASSERTION]: C-1 live durable recovery must replay the stored claim immediately
  + actual - expected

  + []
  - [ 'claim_44444444444444448444444444444444_0' ]

✖ C-1 composition: an unverified terminal-shaped effect does not brick recovery (0.446667ms)
  AssertionError [ERR_ASSERTION]: C-1 unverified terminal-shaped effects must recover instead of stopping fatally
  + actual - expected

  + 'fatal'
  - 'cancelled'

✖ C-1 composition: stale claim_pending clears before durable replay (4.060209ms)
  AssertionError [ERR_ASSERTION]: C-1 stale claim_pending must clear instead of fatally replaying an expired lease
  + actual - expected

  + 'fatal'
  - 'cancelled'
```

Green output after the fix:

```text
✔ C-1: an expired durable leased claim without an effect clears and re-claims (1.92225ms)
✔ C-1: an expired durable leased claim with a terminal effect ACKs before clearing (0.404625ms)
✔ C-1 composition: an expired leased claim with a resumable effect re-claims and finishes (2.523084ms)
✔ C-1 composition: a live leased claim with a resumable effect replays immediately (4.888584ms)
✔ C-1 composition: an unverified terminal-shaped effect does not brick recovery (0.4305ms)
✔ C-1 composition: stale claim_pending clears before durable replay (2.156416ms)
```

The composition control was added after exact-SHA review found that the first
implementation sent every non-null persisted effect to the terminal ACK mapper.
The final implementation ACKs only effect shapes accepted by the ACK mapper.
Resumable `received`, `prompting`, `reply_ready`, and `posting` effects with an
expired lease wait out the safety margin, clear it, re-claim, and resume through
the durable engine. A still-live durable lease falls through to the existing
exact-command replay immediately, preserving its attempt budget. A
terminal-looking but unverified record cannot recreate the fatal brick.
The stale `claim_pending` control was added after exact-SHA review found the
remaining ambiguous-response route: after the maximum possible lease and the
safety margin, the old command is cleared and a new ordinal is claimed. The
existing recent-replay control now pins its clock and continues to prove that a
live ambiguous attempt reuses the exact command rather than duplicating it.

The first exact-SHA Codex review found that matching only the signal ID before
the recovery shortcut could ACK a terminal-shaped effect whose immutable body,
deadline, kind, or owner relation did not match the authoritative delivery.
New leases now persist a SHA-256 binding over those authoritative immutable
fields. Recovery takes the direct ACK shortcut only when the effect matches that
binding. A legacy lease without a binding clears and re-claims, which reaches
the existing authoritative comparison before processing or ACKing.

That review control was demonstrated red first:

```text
✖ C-1 review: recovered terminal effects must match authoritative signal fields before ACK (4.280916ms)
  AssertionError [ERR_ASSERTION]: C-1 recovered terminal effect with mismatched immutable fields must not be ACKed

  1 !== 0
```

Green output after the binding was added:

```text
✔ C-1: an expired durable leased claim with a terminal effect ACKs before clearing (3.018125ms)
✔ C-1 review: recovered terminal effects must match authoritative signal fields before ACK (0.283041ms)
```

## Fix 2 — MAJOR-3: unknown failure classification

Changed `ackForTerminalEffect` so an unrecognised terminal `failureCode` maps to
the server-accepted `failed_terminal` / `local_effect_failed` pair. It no longer
throws a plain fatal error while the journal remains `leased`.

Causal control:

- `MAJOR-3: failureCode error ACKs local_effect_failed and the runtime survives`

Exact red output before the fix:

```text
✖ MAJOR-3: failureCode error ACKs local_effect_failed and the runtime survives (0.592791ms)
  AssertionError [ERR_ASSERTION]: MAJOR-3 unknown failure classification must not brick the listener
  + actual - expected

  + 'fatal'
  - 'cancelled'
```

Green output after the fix:

```text
✔ MAJOR-3: failureCode error ACKs local_effect_failed and the runtime survives (0.544083ms)
```

The green control also asserted that the ACK carried
`lastErrorCode: "local_effect_failed"` and that the active journal record was
cleared.

## Fix 3 — MAJOR-4: mid-run stale ACK is not credential loss

Changed stale `delivery_unavailable` recognition to depend on the active lease
being expired and the exact typed `DeliveryHttpError` tuple
`403/delivery_unavailable`, regardless of whether the ACK was pending at startup.
Genuine 401/403 credential handling remains unchanged for non-expired leases.

Causal control:

- `MAJOR-4: a mid-run expired lease 403 clears stale state without credential stop`
- `MAJOR-4: delivery_unavailable at exact lease expiry clears stale state`

Exact red output before the fix:

```text
✖ MAJOR-4: a mid-run expired lease 403 clears stale state without credential stop (0.465291ms)
  AssertionError [ERR_ASSERTION]: MAJOR-4 mid-run stale delivery_unavailable must not report credential loss
  + actual - expected

  + 'credential'
  - 'cancelled'
```

Green output after the fix:

```text
✔ MAJOR-4: a mid-run expired lease 403 clears stale state without credential stop (0.326542ms)
```

Exact server-boundary red and green output added after exact-SHA review:

```text
✖ MAJOR-4: delivery_unavailable at exact lease expiry clears stale state (3.51875ms)
  AssertionError [ERR_ASSERTION]: MAJOR-4 exact lease deadline must be stale rather than credential loss
  + actual - expected

  + 'credential'
  - 'cancelled'

✔ MAJOR-4: delivery_unavailable at exact lease expiry clears stale state (2.224208ms)
```

The stale check is inclusive because the server accepts an ACK only while
`leased_until > statement_timestamp()`; equality is already expired.

The negative boundary control also passed:

```text
✔ MAJOR-4: delivery_unavailable before lease expiry remains credential loss (0.328625ms)
```

## Fix 4 — MAJOR-1: OpenCode worker cwd lifetime

Changed `src/listener/opencode-model.ts` so the worker handle owns its canary
cwd. The directory is removed only after the handle's original `close()`
resolves. Pre-handle failure paths still remove it in `finally`, and repeated
close calls share one close/cleanup promise.

Causal control:

- `OpenCode worker canary denies on empty cwd then openWorkCwd retargets`

Exact red output before the fix:

```text
✖ OpenCode worker canary denies on empty cwd then openWorkCwd retargets (9.242375ms)
  AssertionError [ERR_ASSERTION]: Got unwanted rejection: MAJOR-1 worker process cwd must exist for the lifetime of its handle
  Actual message: "ENOENT: no such file or directory, stat '/var/folders/bb/7n7qfbls651d80fs4r9wdyk40000gn/T/cswarm-opencode-canary-29vYnH'"
```

Green output after the fix:

```text
✔ OpenCode worker canary denies on empty cwd then openWorkCwd retargets (9.280375ms)
```

The control asserts both halves: the cwd exists after `ensureWorker` returns and
is `ENOENT` after the worker handle closes.

The timeout boundary was also demonstrated red first:

```text
✖ openSession failure propagating child_exit_timeout retains home directory in model (15.633917ms)
  AssertionError [ERR_ASSERTION]: Got unwanted rejection: MAJOR-1 child_exit_timeout must retain the cwd of a possibly live child
  Actual message: "ENOENT: no such file or directory, stat '.../cswarm-opencode-canary-fXfAr6'"

✔ openSession failure propagating child_exit_timeout retains home directory in model (15.113917ms)
```

Ordinary pre-handle failures still remove the cwd. `child_exit_timeout` retains
it because deleting the OS cwd of a possibly live child would recreate MAJOR-1.
Handle close removes it after a verified close or an ordinary non-timeout close
failure; a timeout retains it. The worker canary cwd now lives inside the
owner-marked worker home, so the existing dead-owner home sweep eventually
reclaims both after a timed-out child exits.

The eventual-cleanup ownership boundary was also demonstrated red first after
exact-SHA review identified the orphan risk:

```text
✖ openSession failure propagating child_exit_timeout retains home directory in model (18.411583ms)
  AssertionError [ERR_ASSERTION]: MAJOR-1 retained child cwd must stay inside the owner-marked home for eventual sweep

  true !== false

✔ openSession failure propagating child_exit_timeout retains home directory in model (10.530542ms)
```

The first exact-SHA Codex review also found a pre-handle gap: if creating or
securing the canary cwd failed after the auth-bearing worker home was prepared,
the home was neither released nor retained. The outer worker-open failure path
now runs the same release-or-retain discipline before settling the pending open.

Exact red and green output:

```text
✖ MAJOR-1 review: canary cwd creation failure releases the prepared worker home (6.595167ms)
  AssertionError [ERR_ASSERTION]: Missing expected rejection: MAJOR-1 pre-handle canary cwd failure must release its prepared worker home

✔ MAJOR-1 review: canary cwd creation failure releases the prepared worker home (5.533792ms)
```

The next exact-SHA Codex review found a cancellation race while the registered
worker home was in `pre-spawn`: `close()` could release the home while canary-cwd
preparation was suspended, after which the continuation could call
`openSession` outside the pending-open ownership map. The worker path now
rechecks both the open generation and exact pending entry after canary-cwd
preparation and immediately before starting the session.

Exact red and green output:

```text
✖ MAJOR-1 review: close during canary cwd preparation cannot start an untracked worker (10.552916ms)
  AssertionError [ERR_ASSERTION]: MAJOR-1 close during canary cwd preparation must not start an untracked worker

  1 !== 0

✔ MAJOR-1 review: close during canary cwd preparation cannot start an untracked worker (3.464584ms)
```

## Fix 5 — MAJOR-2: OpenCode cross-owner hard tool denial

OpenCode 1.18.10 does expose a verified restriction surface. The local binary
reported `1.18.10`; official tag `v1.18.10` resolved to `7902e04`. That source
loads `OPENCODE_PERMISSION` after config merge in
`packages/opencode/src/config/config.ts`, and the request preparation path
removes hard-denied tools in `packages/opencode/src/session/llm/request.ts`.

Added a `denyTools` host option. Cross-owner isolated turns set it; same-owner
workers do not. The host emits the fixed value
`OPENCODE_PERMISSION='{"*":"deny"}'` after sanitising the parent environment,
so a hostile parent value cannot replace it. The existing forced-ask config and
ACP deny callback remain in place. The existing effective-config probe now
rejects every surviving `allow` and requires the hard-deny wildcard to be the final permission rule for restricted
children. Because 1.18.10 removes hard-denied tools before the model request,
the tool-dependent dynamic canary cannot run on that same child. Restricted
children therefore enable prompts only after the exact effective-config probe;
the same-owner worker retains the dynamic canary.

Causal control:

- `MAJOR-2: cross-owner child env hard-denies tools while same-owner does not`
- `MAJOR-2 composition: hard-denied OpenCode isolates do not run a tool-dependent canary`
- the MAJOR-2 env control also rejects a per-tool `allow` beside the wildcard deny

Exact red output before the fix:

```text
✖ MAJOR-2: cross-owner child env hard-denies tools while same-owner does not (1.704375ms)
  AssertionError [ERR_ASSERTION]: MAJOR-2 cross-owner child must carry OpenCode's verified hard-deny surface
  + actual - expected

  + undefined
  - '{"*":"deny"}'

✖ MAJOR-2 composition: hard-denied OpenCode isolates do not run a tool-dependent canary (18.15925ms)
  AssertionError [ERR_ASSERTION]: Got unwanted rejection: MAJOR-2 hard-denied isolates must not depend on a canary whose tools are filtered out
  Actual message: "hard-denied child exposes no tool for the canary"

✖ MAJOR-2: cross-owner child env hard-denies tools while same-owner does not (2.64425ms)
  AssertionError [ERR_ASSERTION]: Missing expected exception: MAJOR-2 hard-deny probe must reject any surviving per-tool allow
```

Green output after the fix:

```text
✔ MAJOR-2: cross-owner child env hard-denies tools while same-owner does not (0.553625ms)
✔ OpenCode cross-owner turns get fresh homes/cwds and always deny tools (15.444042ms)
✔ MAJOR-2 composition: hard-denied OpenCode isolates do not run a tool-dependent canary (10.739084ms)
✔ MAJOR-2: cross-owner child env hard-denies tools while same-owner does not (1.211084ms)
```

Live 1.18.10 effective-config positive control:

```text
{"wildcard":"deny","lastKey":"*","allows":[]}
```

The tagged-source trace and live probe are recorded durably in
`docs/evidence/2026-08-03-opencode-hard-deny.md`.

## Fix 6 — m-2: revoked-author comment

Corrected the comment in `supabase/functions/read/index.ts` to say that
`author.revoked_at` is filtered and a revoked/unresolved agent author falls to
`unknown`, matching the SQL four lines below it.

Causal control:

- `m-2: sender relation comment agrees that revoked agent authors are filtered`

Exact red output before the fix:

```text
✖ m-2: sender relation comment agrees that revoked agent authors are filtered (1.32975ms)
  AssertionError [ERR_ASSERTION]: m-2 comment must not instruct readers to undo the live revoked-author filter

  true !== false
```

Green output after the fix:

```text
✔ m-2: sender relation comment agrees that revoked agent authors are filtered (0.4355ms)
```

## Required final gates

Run in the required order, after the last code/test edit:

```text
npm test
tests 390
pass 390
fail 0
```

This is 376 to 390, satisfying the required increase.

```text
npm run build
tsc
exit 0

npm run check:tests
tsc -p tsconfig.tests.json
exit 0

npm run check:edge
Check supabase/functions/command/index.ts
Check supabase/functions/read/index.ts
Check supabase/functions/capability/index.ts
exit 0
```

## Exact-SHA review gate

Both required arms reviewed exact fix SHA
`de848ee5f213e200e6265a99b84a0cf084f25996` against exact base
`175f894f7e3a3e9ec822b5a187331fee7fccd3c5`, read-only, after the final
amendment. Neither arm changed the tree.

- The Codex exact-review arm returned a substantive no-bug verdict and
  `CLEAR`. It traced all six fixes, confirmed the recovered-terminal signal
  fingerprint, the canary-preparation release-or-retain path, and the
  close-during-preparation ownership guard, and found no concrete introduced
  bug. Its read-only sandbox could run the focused runtime controls and
  `check:tests`, but not filesystem-backed tests because `mkdtemp` returned
  `EPERM`; the required writable-environment gates above independently cover
  the complete 390-test suite.
- The inversion arm's result metadata identifies the actual model as
  `claude-opus-5` (Anthropic), as required for Codex-authored code by D-039.
  It ran 54 turns and returned a substantive `Blocking: false` verdict. It
  independently ran `npm test` (390/390), `test:p1-cli` (143/143), build,
  `check:tests`, and `check:edge`; traced the client/server lease boundary and
  all six fixes; and structurally confirmed all three findings repaired during
  the earlier review rounds. Its statement that a Gemini/Kimi arm remained
  necessary applied D-036 without D-039's later author-family ruling and is
  therefore not the operative process result.

The inversion reported six nonblocking residuals: near-expiry live lease and
`claim_pending` replays can stop once before self-healing on the next start;
the hard-deny probe seam is not fenced against a future caller setting
`skipConfigProbe`; its defense-in-depth scan checks top-level string allows,
not arbitrary nested values; legacy journals lack a signal fingerprint and
therefore clear/re-claim rather than taking the recovered ACK shortcut; and
the journal format is forward-only across a package downgrade. None restores
the permanent repeated-start brick, bypasses the effective wildcard deny, or
changes this packet's acceptance result.

## What this did not establish

- No hosted Supabase or production deployment was exercised. `test:p1-local`
  and `test:p1-server` were not run because the packet's final gate did not ask
  for a database slot. The stale replay controls use the production runtime and
  journal seams with an injected delivery client that reproduces the verified
  protocol rejection.
- No billable OpenCode model turn was asked to invoke a denied tool. Fix 5 is
  established by the local 1.18.10 effective-config probe, the exact tagged
  source's hard-deny/tool-removal path, the child-env control, and the
  listener-to-host handoff and canary-composition controls. The dynamic ACP
  permission canary is not run on a child whose tools are all removed; the ACP
  deny callback remains fail-closed if OpenCode unexpectedly issues a request.
  This is not an OS sandbox; it is a second hard-deny path within OpenCode.
- The downstream POSIX symptom of relative paths resolving from an unlinked cwd
  was not separately reproduced. Fix 4 establishes the directory lifetime
  directly before and after handle close.
- Deferred m-1 and m-3 were not changed. No migration,
  `durable-delivery.ts`, generated protocol bundle, package version, or site
  file was changed.
- The commit exists only on `fix/v015-d040`; it was not pushed, merged, deployed,
  or applied to `main`.
