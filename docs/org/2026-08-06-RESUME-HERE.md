# Resume here — CswarmLead, end of 2026-08-05 session

Written on standing down. **Verify every SHA by hash, not by branch name.** Braced revisions
only: `"${R}:src/..."`, never `"$R:src/..."`.

## Refs as they actually are

```
lead/logout-wedge      654810f4e55a902158ce19b70507acb2e28433db   RED -- do not land
lead/hide-scrollbars   d271109...                                  LANDED TO PRODUCTION (site)
lead/d059-pooler-raise 492d5f4...                                  docs only, unreviewed
main                   0ee75306229216014c62746a77282345578808ec    unchanged this session
```

`lead/logout-wedge` carries **two** unrelated pieces of work (logout fix + bounded recovery).
If that bundling is wrong, split it — the review arms were asked and had not objected.

---

## 1. DONE AND LIVE

**Production pooler raised, twice: `pool_size` 15 → 30 → 38 (final).**
Operator authorised one more raise and no more; the measurement independently agrees the tier
is exhausted (ceiling 41 with zero margin against `max_connections=60`).

- Resting-demand fault **FIXED** — solitary failures 42% → 0%, durable across 3h.
- Isolated-burst fault **FIXED** — a single 8-way burst scores zero on every arm.
- Sustained-burst fault **NOT FIXED**, not fixable by `pool_size` here. Absorbs ~24 concurrent,
  then cliffs; **self-clears within ~7 min of load stopping** (upper bound, not a value —
  measured with load *ceasing*, and fielded 0.1.6's retry storm is load that need not cease).

Full evidence with the pre-registered decision matrix: `docs/evidence/2026-08-05-pooler-raise/`.

**Scrollbars hidden site-wide and DEPLOYED** to commonswarm.com. Verified on the deployed page
with paired present/absent controls; all routes 200, `/nope.sh` 404.

---

## 1a. ARRIVED AFTER STAND-DOWN — read before touching anything

Both arms reported after the team was released. Neither is a production issue; both change
tomorrow's first moves.

### Plumb: SPLIT THE LANES (do this first, it is cheap and it unblocks everything else)

`lead/logout-wedge` carries two independent pieces of work, **and the auth lane still has open
blockers**. So every D-056 correction currently forces both exact arms to re-review unrelated
auth code, and neither fix can ship or roll back without the other. Split into separate SHAs so
the D-036 decision sets are legible.

### Plumb: a non-author adversarial control already exists, pushed

```
plumb/d056-adversarial-31829df @ 41c9be9d87ed0e27df7c2ed534d647cc685960a5
```

Intentionally RED against `31829df`, written for cherry-pick. It contrasts one continuous burst
`[ok, refused, refused]` against two incidents `[ok, refused, ok, refused, ok]` at tolerance 1 —
the lifetime-counter defect. **It should now PASS on `654810f`**, which added the per-burst
reset. *Cherry-pick it and confirm that, rather than trusting this sentence.* Plumb also
verified the positive mutation control: adding the reset makes it 1/1 while the burst arm still
terminates.

Plumb separately confirmed the `stop.reason === "error"` assertion **is** sufficient to
distinguish code exhaustion from the harness abort — its blind spot was counter lifetime, not
abort attribution.

### CORRECTION — "the veto is not relaxed" was wrong, and it is in commit messages

Plumb: ordinary retries were **already delayed**, so *"it only blocks an IMMEDIATE retry"*
distinguishes nothing and overstates what is preserved. `retryable:false` now buys the same
delayed rearm other retries get, through a second branch. **Record it as a bounded override of
the veto.** Corrected in `signals.ts` in place; the earlier commit messages still carry the
overstatement and cannot be edited — this is the correction of record.

Same message: *"delayed retry is the opposite of amplification"* was **false**. It is bounded,
rate-limited amplification — less than fielded 0.1.6's unbounded retry, more than zero, landing
on the saturated service. Also corrected in place.

### Plumb: LOGOUT BLOCKERS REMAIN on `4a63121` — the auth lane is NOT clear

`4a63121` fixed only the terminal `local-only` line. Still open:

- the reproduced **refresh-200 / logout-403** path still returns `signed-out`, and `cli.ts`
  still prints "Signed out on all devices" / "on this device" — both assert the server outcome
  the library swallowed;
- **`README:268-270`, `site/src/pages/privacy.astro:234`, `site/src/pages/terms.astro:265`
  still assert session termination.** Legal-surface copy, so worth care;
- `--local` names no-server credential deletion as ordinary local logout and explains the hazard
  only *after* deletion.

### Verity: the exact seam behind the RED gate

`runInboxFollow` accepts the tolerance option but **`src/cli.ts` never passes it** — grep
returns zero — so a spawned CLI always gets the default and always sleeps the real budget. That
is precisely why the two failures are the spawn-the-real-CLI cases and not the unit ones: units
inject, e2e cannot.

`tests/p1-cli/follow-backoff-e2e.test.ts` carries a `timeoutMs` defaulting to **30s, now below
the 60s budget**, so it kills the child and reads as a failure rather than a wrong result. Raise
it — a test whose timeout is under the budget it exercises is measuring the harness.

**Two constraints on the env override, so it does not become a test-only affordance:**
1. Wire it as a **real product knob** — a supervised host wants tolerance `0` in *production*.
   That is the stronger justification, and the test fix falls out of it for free.
2. Read it **once at startup**, never per-arm. A per-arm read would let it change mid-stream,
   which is a state surface nobody would test.

## 2. THE BRANCH IS RED — start here tomorrow

`test:p1-cli` is **156 pass / 2 fail**. `npm test` is 497/0. The cause is understood and is
**not a logic defect**:

```
✖ D-051/D-055/D-056: a refused read is tolerated ... then exits with a frame
✖ D-056: the exit status separates a refusal from a revoked credential
```

Both spawn the **real CLI**, which now sleeps real backoff, so a 60s refusal budget exceeds
their timeouts.

**The intended next step, ~30 minutes:** make the budget injectable from outside the process —
an env override (e.g. `CSWARM_REFUSAL_TOLERANCE_MS`). This is wanted for its own sake, not just
for tests: a **supervised** host should be able to set `0` and get the strict veto back, since
tolerance exists for the *unsupervised* path. Wire it at the `runInboxFollow` call site,
`src/cli.ts:2460`.

---

## 3. What bounded recovery is, and what it is NOT

The **0.1.7 ship gate**, per the operator's "small fix first".

**Why it exists.** Pooler exhaustion reaches `read` as a generic `XX000`. `XX000` is **not** in
that function's `RETRYABLE_CODES` (`53300` is — control: 1 vs 0), so a *transient* busy spell is
reported to clients as *permanent*. Post-D-051 the client honours `retryable:false` as a veto
(`src/cloud/signals.ts`, `serverRefusedRetry` → `return false`), and `cswarm inbox --follow` has
**no supervisor**. So the first burst killed an unsupervised receiver, silently, per host — and
`install.sh` serves `latest`, so 0.1.7 would have reached every new install at once.

**The veto is NOT relaxed.** `isRetryableFollowError` is untouched; a refusal still blocks an
*immediate* retry. A separate per-burst **time window** absorbs refusals, each after the full
jittered backoff. Refusal now means "not now", not "never".

**Scope, stated honestly:** the 60s default **does not cover the ~420s observed window**. Seven
minutes of silence is its own bad outcome. Short spells survive in process; longer ones need a
restart — which is what **exit 75** is for. *A release note must not imply it survives the full
fault.*

---

## 4. Open design question, unresolved

**Verity's arithmetic (not measurement):** to cover 420s *with* the 30s backoff cap takes ~24
attempts; *without* the cap, ~11. **The cap is what forces the request count up**, so raising
the cap on the refusal path specifically would buy the same window for less than half the
requests. Nobody has evaluated that option.

Verity's position: any budget small enough to be safe is too small to survive, and any budget
large enough to survive is real added load onto the exact fault, times the fleet — so the
arithmetic favours **supervision** over tolerance. Counter-consideration not yet weighed: the
right comparison is against the **fielded** alternative, not against silence. 0.1.6 retries this
same fault unbounded at a measured 13.2 frames/min, so a bounded budget is *less* load than what
is in production today.

---

## 5. Deferred deliberately (operator: "the bar is that it works")

Recorded, not built:

- **`--local` habituation.** A user on a persistently bad network learns plain `logout` "fails"
  and `--local` "works", then accumulates unrevoked live sessions. Copy cannot fix this; a real
  control would be *state* (record that a session was left unrevoked so `status` surfaces it).
  Not critical to the core loop.
- **Flag registration has no coverage.** `--local` parsed as value-taking because `local` was
  missing from `BOOLEAN_FLAGS` — the feature was unusable from the CLI while every test passed.
  A *coverage* failure, not a code one, and it deserves its own defect entry.
- **Emission of 3 of the 4 terminal auth codes** is unverified. Under retain-by-default an entry
  that never appears simply never matches, so the failure mode is retention — safe. Dead code,
  not a hazard.
- **Plumb's parent-token retry route** (signOut 5xx asymmetry) — no delayed
  production-equivalent retry was executed.
- **The `data type_name` deny-list key that `hasOwnProperty` cannot match** (Verity). Written
  down, not built.
- **Site/README copy asserting session termination** (`README:268-270`, `privacy.astro:234`,
  `terms.astro:265`). Real, and it is legal-surface wording, but it is not a core-loop defect —
  it goes in the copy pass, not in the auth fix.

---

## 6. For the operator, unchanged and still owed

- **The `read` deploy vehicle is unnamed.** The freeze lift for the `EMAXCONNSESSION` classifier
  is not recorded in the register — no scope, no rollback, no statement of how the coupled
  D-040/41/42 changes stay disabled. One `read` deploy flips capability advertisement. The
  classifier is architecturally right and **operationally unexecutable** until this exists.
- **Our own dogfood fleet shares the production pool.** Measured: 8 seats targeting
  `ukezjcnxjvkpkeezxaew`. The "resting demand ~17" that was being clipped at 15 is substantially
  *our own agents competing with users for the same 38 slots*. Two decisions belong to the
  operator: tier upgrade, and whether the fleet stays on the production pool.
- **No rollback/yank procedure exists** for a bad release, while `install.sh` serves `latest`.

---

## 7. The plan, and how much of it to trust

`docs/org/2026-08-06-JUST-WORK-PLAN.md` (v2) survived two adversarial reviews that produced six
BLOCKING findings against v1. Its central claim is deliberately narrowed: **not** "nothing has
been run end to end" (falsified by charter item 4) but *"not run by a stranger, and not re-run
since the 0.1.6-era changes."* Falsification criteria are declared in it, before testing,
because without thresholds the hypothesis cannot lose.

Next action in that plan is **not** the expensive two-machine run. It is a cheap first-value
slice with actual strangers, plus a **day-2 leg** — expired session, network loss mid-follow,
lapsed invite — because the one bug this all rests on was a day-2 defect a cold walk would never
have reached.
