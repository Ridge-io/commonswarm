# Lead exact-arm review records (D-036 arm 1)

D-036 requires **each lane to record its own two arms**. The inversion arms were landed as files as
they ran. The Lead's exact arms were performed and reported in-session but **not written down** —
which, by our own doctrine, is indistinguishable from not having run them. This file corrects that.

> **Correction, 2026-08-03.** Commit `0988697` and the evidence index both stated "both D-036 arms
> PASS" for `df2f4c9` while `docs/evidence/` contained only the builder's own completion report and
> the Gemini inversion. A builder report is **not** an arm — D-036 excludes the authoring context. As
> the record stood, one arm was recorded and two were claimed. The findings below are the missing
> arm, written down after the fact and labelled as such.

Reviewer: ClaudeCswarm (Claude), acting as the exact arm. Non-authoring in every case below — the
code was written by DeepSeek (A2) or by Codex workers (Trestle, Keystone, Corbel).

---

## `ab1b240` — Runtime A2 credential escape · **PASS**

Contract: `docs/design/contracts/RUNTIME-A2-CREDENTIAL-ESCAPE-GOAL.md`. Delta `cc18bf3..ab1b240`,
four owned files.

- **Post-catch order is exactly frozen.** `CommandHttpError` is handled first; 401/403 restore
  `reply_ready` with `failureCode: null` and rethrow the identical error; every other HTTP status
  skips the classifier entirely and falls to the existing typed retry/terminal logic. Server-controlled
  message text therefore cannot reach name/wording classification.
- **`postAttempts` survives.** `record` is reassigned from the `write()` that increments it *before*
  the `try`, so the catch's `...record` spread carries the incremented value.
- **A throwing classifier cannot strand the record.** It restores `reply_ready`/null and rethrows the
  classifier's own exception, not the poster's.
- **`isAbort` is name-only** in both engine and runtime; the message regex is gone.
- **`signalAbortError()` sets `name = "AbortError"` explicitly**, so name-only recognition still
  catches a genuine caller abort — I checked this rather than assuming, because name-only recognition
  fails silently if the thrower uses a plain `Error`.
- **The delegated predicate cannot misclassify an abort as credential**: `isFollowCredentialFailure`
  matches only `/secret is absent/i` plus typed 401/403 and the two renewal classes.

## `5f5018a` — Server Phase B control repair · **PASS**

Contract: `docs/design/contracts/SERVER-PHASE-B-HARNESS-FINAL-REPAIR-GOAL.md`. Delta
`d972c3f..5f5018a`, one file.

- **The seam is additive.** With `timingControl` omitted, `monotonicNow`/`sleep`/`pollBlockedBackends`
  default to `performance.now()`, `delay`, and the real SQL poll — production behaviour unchanged.
- **The control is deterministic, not timing-lucky.** The injected clock advances only at the sleep
  boundary, so a 75 ms deadline forces exactly `[50, 25]` requested sleeps. No tolerance window.
- **Both predecessor mutants fire a named assertion**: `Date.now()` yields `remaining=25` against
  `sleepMs=50` and trips `assert.ok(sleepMs <= remaining)`; a direct `delay(50)` bypasses the injected
  sleep entirely and leaves the trace `[]`, tripping the `deepEqual`.
- The original real-SQL assertions are retained *before* the new deterministic arm, so the test did
  not trade real coverage for determinism.

## `e3dc295` — Server Phase C · **PASS**

Contract: `docs/design/contracts/SERVER-PHASE-C-PREFLIGHT-CORRECTIONS.md`. Delta `5f5018a..e3dc295`.

- **Zero production contamination**: `git diff 5f5018a..e3dc295 -- supabase/` is **empty**, and the
  production command function remains byte-identical to accepted Phase-A `3039cce`.
- **Purely additive**: 845 insertions, 0 deletions, one file.
- The discriminating conflict-audit detail `resolved concurrent idempotency race` is present — the
  spec's second resolver-path discriminator, which an ordinary replay conflict does not write.
- The mutant reached **both** complete late topologies and failed 0/2 with the required outcomes
  (allowed: claim bucket 0 instead of 1; denied: 409 instead of 429). The spec explicitly refuses
  compile/startup/timeout/cleanup failures as mutant evidence, and this was none of those.

## `df2f4c9` — the four production-review corrections · **PASS**

Specification: `production-delta-exact-review-PASS-1-major.md`. Delta `1f7c9ac..df2f4c9`.

- **MAJOR fixed minimally and correctly**: `sender_owner_relation: signal.…` → `ref.…`, returning the
  server-generated value the ledger already stored rather than recomputing it.
- **Correction 2 applied at BOTH ACK sites** — the initial read *and* the post-insert re-read. I
  checked the second site specifically; a fix applied to only one would have left the enumeration
  vector open on the race path.
- **Correction 4 was fixed at the layer all paths flow through.** The finding named two call sites;
  the fix removed the delivery markers from the shared `SIGNAL_CAPABILITIES` constant, so the
  foreign-workspace path at `read/index.ts:289` stopped advertising *automatically*. I verified that
  path independently rather than trusting the report, since a constant-level fix is exactly the kind
  that looks complete and isn't.
- **Migration untouched**: `git diff 1f7c9ac..df2f4c9 -- supabase/migrations/` is empty, so the
  additive/forced-RLS finding still stands.

## What these arms did not establish

Static and diff-level review only. I ran the pure gates myself for A2 but did not re-execute the DB
suites, the mutant runs, or the red-then-green proofs recorded by the workers — those counts are read
from their reports. No arm here establishes deployment, production behaviour, or real-load capacity.

~~**The production delta still has only ONE arm.** … that inversion must run before the release is
landed.~~ **Dead as of 2026-08-03**: the cross-family inversion ran over
`origin/main..HEAD -- supabase/` and is on disk as
`production-delta-d036-inversion-arm-gemini-PASS.md` (PASS, no CRITICAL). Caveat kept honest: that
inversion covered `supabase/` only, so `src/cloud/command-client.ts` has an exact arm at delta scope
but no inversion at delta scope. Stage 7b must therefore be scoped to the full
`origin/main..freeze` delta rather than to whatever moved most recently.

---

# Second batch — added 2026-08-03 after the M4 checkpoint

> **The same correction, a second time.** M3 caught me claiming "both arms" for `df2f4c9` when only
> one was on disk. M4 caught the identical thing for `f30974a`, `0f5bbcf`, and `9f0c5a1`. Commit
> `b7cdb5b` says "Runtime C accepted (both arms)" while its diff adds only the inversion arm. Writing
> the finding down at M3 did not stop me repeating it, which is worth recording plainly: the fix was
> a habit, not a document. These three arms were performed at the time; they were not written down.

## `f30974a` — Runtime C · **PASS**

Contract: `docs/design/contracts/RUNTIME-C-GOAL.md`. Delta `b7a0866..f30974a`, three files.

- **Frozen files provably untouched**: `git diff b7a0866..f30974a --stat -- src/listener/engine.ts
  src/cloud/command-client.ts src/cloud/delivery.ts src/listener/delivery-journal.ts` → empty. Run by
  me, not read from the report.
- **Scope exact**: `runtime.ts +768`, `supervisor.ts +72`, `tests/listener-runtime.test.ts +1179`.
  The optional `durable-runtime.ts` was not created — correct, since it was permitted only if needed.
- **Gates re-run by me**: root `npm test` 365/365 at the time of review.
- **Work item 1 verified independently and found PARTIAL** — see
  `runtime-c-fixture-repair-VERIFIED-PARTIAL.md`. The named control prints red per-test; the whole
  file still wedges under the mutant from cumulative leakage. Not a product defect (unmutated: green
  in ~2s). This is the one place the worker's claim was narrower than the goal, and it was caught by
  applying the mutant rather than reading the report.
- **Host-switch reachability**: recorded as unreachable, no teardown API added — the correct outcome
  for a case that cannot occur.

## `0f5bbcf` — Runtime D · **PASS**

Contract: `docs/design/contracts/RUNTIME-D-GOAL.md`. Delta `b7cdb5b..0f5bbcf`, five files.

- **Frozen files untouched**: diff over `engine.ts`, `runtime.ts`, `command-client.ts`,
  `delivery-journal.ts` → empty.
- **Scope exact**: the five authorized files, 524 insertions.
- **`src/cloud/delivery.ts` was permitted for a comment only** — I read the diff rather than assuming:
  a three-line JSDoc clarification on `DeliveryRow.leaseId` plus a missing trailing newline. Nothing
  functional. This was worth checking precisely because "comment only" is easy to overrun.
- **The reducer hardening landed as specified**: unknown listener events take the bounded-metadata
  path instead of being silently logged as an ACK by fallthrough.
- **Gates re-run by me**: `npm test` 365/365.

## `9f0c5a1` — config restore fix · **PASS**

Contract: `docs/design/contracts/CONFIG-RESTORE-FIX-GOAL.md`.

> **My error in that contract:** it directed the worker's deliverable to gitignored `scratchpad/`,
> which is the exact anti-pattern `AGENTS.md` names and which this release has already corrected
> twice. The evidence below is therefore the Lead's own measurement, taken directly against the
> database.

- **Scope**: one file, five lines (`git show --stat 9f0c5a1`). `git show 9f0c5a1 -- supabase/ src/`
  → empty, so neither the migration nor production code moved.
- **The fix is correct in kind**: `SELECT value::text` and restore that text with a single `::jsonb`
  cast, replacing a `JSON.stringify` of an already-parsed value. It round-trips instead of re-encoding.
- **Measured against the live local database, after the fix**:
  - `SELECT key, value, jsonb_typeof(value) FROM swarm.config WHERE key='delivery_retention_days'`
    → `delivery_retention_days | 30 | number` (was the string `"\"30\""`).
  - `SELECT swarm.purge_terminal_signal_deliveries();` — the no-argument cron path that previously
    failed with `invalid input syntax for type integer: ""30""` — now **succeeds**.

## Standing note

Runtime C, Runtime D, and the config fix each also carry a cross-family inversion arm on disk
(`runtime-c-d036-inversion-arm-gemini-PASS.md`, `runtime-d-d036-inversion-arm-gemini-PASS.md`, and
the inversion recorded in the config-fix worker's own gate list). With the records above, every
landed SHA in this release now has both arms **written down**, not merely asserted.
