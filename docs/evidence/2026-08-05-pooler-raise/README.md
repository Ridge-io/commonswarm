# Production pooler raise — pool_size 15 → 30

**Date:** 2026-08-05
**Operator-authorised.** CswarmLead executed the dashboard change personally.
**Project:** `ukezjcnxjvkpkeezxaew`, named `cloud-swarm-dev`, **which IS production**
(re-measured tonight, see §1). Compute tier **Micro**.

This file is the durable record. The decision matrix in §4 was **pre-registered before the
click**, so post-hoc interpretation cannot drift.

---

## 1. Target confirmed (Verity, independently re-derived — not inherited)

| link | value |
|---|---|
| `supabase/.temp/project-ref` | `ukezjcnxjvkpkeezxaew` |
| live deployed meta tag on `commonswarm.com/start` | `commonswarm:url` → `https://ukezjcnxjvkpkeezxaew.supabase.co` |
| positive control (`commonswarm:url`) | 1 match |
| paired absent control (`zzz-not-here`) | 0 matches |

Both controls on the same invocation. The dashboard itself labels the branch **PRODUCTION**.

## 2. Cause — measured in the database, not inferred from logs

Prior evidence was a log inference. Tonight it was observed directly in `pg_stat_activity`:

```
max_connections                 = 60
superuser_reserved_connections  = 3
application_name='Supavisor'    = 15   <-- PINNED AT EXACTLY THE POOL LIMIT
non-Supavisor backends          = 15
total                           = 30
```

**There is exactly ONE Supavisor pool**, so `pool_size` does not multiply across
user+db combinations on this project. Absolute ceiling with zero margin = **42**.

Resource state before: memory **42%**, CPU **7%**, disk IO **1%**. The binding
constraint is `max_connections`, not memory.

## 3. Client-side baselines (Wren, `launcher/cswarm-probe.sh`, unmodified between runs)

Arm C is the positive control: it proves the harness and gateway are sound, so a
post-change reading of "everything failed" is distinguishable from "the probe broke."

| arm | path | BASELINE 21:26:51Z | BASELINE2 21:32:02Z |
|---|---|---|---|
| A — 30 solitary | read | 15/30 failed | 10/30 failed |
| B — concurrency-8 | read | 8/8 failed | 7/8 failed |
| C — unauth control | — | 8/8 clean 401 | 8/8 clean 401 |
| D — 20 solitary | **command** | 13/20 failed | 11/20 failed |
| D — concurrency-8 | **command** | 8/8 failed | 7/8 failed |

Wren's measured caveat, which reshaped the protocol: **the solitary arm drifts more than any
plausible fix effect** (25/33/50/67% across the day). Concurrency-8 is the primary detector;
solitary is secondary and a move inside its band means nothing.

`retryable:false` captured verbatim on the read path — see §6.

## 4. Decision matrix — PRE-REGISTERED BEFORE THE CLICK

The inherited rule was *"if the probe does not move, revert; that also falsifies the
inference."* **That rule is defective** and was replaced before execution. If demand also
exceeds the new ceiling, the pool simply re-pins, the probe still shows failures, and the
rule would revert a working change while recording a true hypothesis as falsified.

Replacement (converged on independently by CswarmLead and by Plumb's inversion arm):

| probe | Supavisor count | verdict |
|---|---|---|
| failures collapse | — | fixed at this tier |
| failures persist | **pinned at 30/30** | pooler CONFIRMED, ceiling merely moved. **NOT a falsification.** |
| failures persist | **below 30** | genuine falsification |

Plumb's addition, adopted: **a residual unrelated red is an investigation, not an automatic
rollback.**

## 5. The change, and what it did

```
pool_size 15 -> 30      saved 2026-08-05T21:34:54Z
dashboard: "Successfully updated pooler configuration"
max_client_connections: UNTOUCHED at 200 (fixed for Micro)
no deploy, no code change
```

Applied-check — **the change is applied, not merely saved**, verified by a stronger
instrument than the dashboard's own confirmation:

| time | Supavisor conns | total backends |
|---|---|---|
| pre-change | **15** (pinned at old ceiling) | 30 |
| +59s (21:35:53Z) | **23** — above the old ceiling | 39 |
| +101s (21:36:35Z) | **30** — re-pinned at the new ceiling | 46 |

**The fleet consumed every connection made available within 100 seconds.** That is direct
evidence the pool was the binding constraint — those connections could not exist before —
and equally that demand exceeds 30 as well.

Resource cost: memory **42% → 46%** for 15 extra connections (~2.7 MB each). CPU and disk IO
unchanged. Memory is not the limiting factor; `max_connections = 60` is.

## 5a. Result — IMPROVED BUT NOT FIXED (four post-change runs, script unmodified)

Wren's bar was pre-committed before the click: concurrency-8 to ≤20%, **holding across both**
post-change probes, unauth control clean. It was **not** met, and was not revised after the
numbers were seen.

| arm | before (2 baselines) | after (4 runs) |
|---|---|---|
| read solitary | 25/60 = **42%** | 0/60 = **0%** |
| command solitary | 24/40 = **60%** | 5/40 = **12%** |
| read concurrency-8 | 15/16 = **94%** | 11/40 = **27%** (rounds 1,0,0,7,3) |
| command concurrency-8 | 15/16 = **94%** | 24/40 = **60%** (rounds 3,6,8,3,4) |
| unauth control | clean | clean on all four runs |

**The improvement is durable.** The +15 min run existed to catch "helps for ninety seconds
then degrades." It did not degrade — read solitary was 0/30 at +2 min and 0/30 again at +15.

**A single post-change round would have read as a clean win** (round 1 command c8 was 3/8).
Rounds 2–4 were 6/8, 8/8, 3/8. The extra rounds are the only reason the verdict is honest.

### The headline (Wren's framing, and it is the right one)

**Steady-state fleet demand is ~17; the old ceiling was 15.** The pool sat *below the fleet's
resting demand*. That is why solitary requests with no concurrency at all were failing 42% of
the time — a categorically worse fault than "tight under burst."

### Unexplained: the asymmetry

Read fell to 27%, command only to 60% — same pool, same credential, same concurrency,
interleaved. Candidate (CswarmLead, **untested**): the command path writes inside
`db.begin`/`SET LOCAL` and holds a pool slot for the transaction, while a read returns its
slot after one SELECT — so command burns more connection-*seconds* per request. Competing
explanation that this does not rule out (Wren): the command path simply does more work per
request for unrelated reasons. Only a fixed-concurrency / varied-arrival-rate test, or reading
the command handler, separates them.

## 5b. Second raise — 30 → 38 (final; operator authorised one more and no more)

```
pool_size 30 -> 38      saved 2026-08-06T00:33:05Z
dashboard: "Successfully updated pooler configuration"
max_client_conn: UNTOUCHED at 200
```

Value chosen from measurement: 57 usable, non-Supavisor peaked at **16**, so the absolute
ceiling is **41**. Took **38** to leave 3 of margin — at 41 a PostgREST scale-up would begin
refusing the web app as well as the CLI. Wren independently checked the same arithmetic and
agreed 38 over 41. Post-change count: **sv 28 / non-Supavisor 16 / total 44** — not pinned,
10 slots free.

### BASELINE3 (pool still 30, taken immediately before the second click)

| arm | value |
|---|---|
| read solitary | 0/30 |
| command solitary | 3/20 |
| read c8 (4 rounds) | 17/32 = **53%** |
| command c8 (4 rounds) | 23/32 = **72%** |
| unauth control | 8/8 401 (fifth consecutive run) |

Rounds ran 00:32:27–00:32:43Z; the save was 00:33:05Z — **22 s later**, so they are clean
pre-change and do not straddle.

### FINDING: the baseline drifts on a fixed config — comparisons must use the immediate baseline

The **same** pool=30 config, same script, same workspace, measured **read c8 27% / command c8
60% at 21:50Z** and **53% / 72% at 00:32Z**. Nothing changed in between.

Any post-change result must therefore be compared against **BASELINE3**, never against the
21:50Z numbers. Comparing to the older, better readings would make a genuine improvement look
like a regression — the same failure mode as the defective revert rule in §4, arriving from
the opposite direction. **The immediately-before baseline paid for itself twice in one night.**

Consequence for pre-registration: an absolute threshold anchored to a drifting baseline tests
*which hour you measured in*, not the mechanism. Wren's amended, baseline-independent
prediction — *command c8 improves proportionally less than read c8* — is the sound form. It was
written 00:33:37Z, i.e. **32 s after the save but before any post-change data existed**; it is
scored as a genuine pre-registration on that basis, and the original absolute version is
retained unamended.

### FINDING: the resting-demand fault and the burst fault are decoupled

Read solitary was 0/30 at +2 min, 0/30 at +15 min, and 0/30 again **three hours later** — across
a window in which *concurrency* performance got materially **worse** (27% → 53%).

So `15 → 30` **durably fixed the resting-demand fault and did not fix the burst fault**, and the
two are independent. That is the precise statement of what the first raise bought, and it is why
"improved but not fixed" is the accurate verdict rather than a hedge.

## 5c. POST2 at pool 38 — and the end of the pool lane

**POST2 probe run (00:34:03–00:35:24Z) was PERFECT — every arm zero**, including both
concurrency-8 arms. The three extra rounds fired 3 seconds later (00:35:27–00:35:42Z) failed
at roughly half:

| arm | BASELINE3 (pool 30) | POST2 (pool 38) | relative improvement |
|---|---|---|---|
| read c8 (pooled) | 53% | 47% | 12% |
| command c8 (pooled) | 72% | **53%** | **26%** |
| read / command solitary | 0/30, 3/20 | **0/30, 0/20** | — |
| unauth control | clean | clean (sixth run) | — |

**The pooled mean hides the finding; the distribution is the finding.** One isolated burst
scored 0/8. Six bursts inside fifteen seconds scored ~50%. Same config, same credential,
ninety seconds apart.

### PREDICTION FALSIFIED — and it was CswarmLead's mechanism, not Wren's

Wren pre-registered *"command c8 improves proportionally LESS than read c8"*, with the
falsification condition stated in advance. **Command improved 26% against read's 12% —
falsified by better than a factor of two, in the direction named as disproving it.**

That prediction rested on the **transaction/connection-seconds hypothesis, which was
CswarmLead's** (command writes inside `db.begin` and holds a slot for the transaction; a read
returns its slot after one SELECT). Command responding *better* to more slots is evidence
against that mechanism. **The hypothesis is withdrawn**, not rescued in a weaker form. Wren's
proposed Test 2 was deprioritised on its own pre-commitment that a substantial command move
would make it *less* interesting — it was not run.

### CONFIRMED: sustained-burst saturation, measured at the connection level

Three consecutive `pg_stat_activity` samples taken *during* a sustained burst:

```
sv 38 / non_sv 16 / tot 54
sv 38 / non_sv 15 / tot 53
sv 38 / non_sv 15 / tot 53
```

**Supavisor pinned at exactly 38/38 in all three**, against 28/38 during the isolated burst
that scored zero. The pool is fully consumed under sustained load and has 10 slots free under
isolated load.

### THE POOL LANE IS CLOSED — the tier is exhausted

Total is now 53–54 of 60, with 57 usable. The absolute pool ceiling is **41 with zero margin**,
so at most **3 slots remain**, and taking them puts the instance at the wall where PostgREST
begins being refused alongside the CLI. **There is no meaningful `pool_size` left on Micro.**
The operator capped this at one more raise; the measurement independently reaches the same
stopping point.

### Durability at 38, and the recovery finding

**Final run (00:59:01–01:00:26Z): perfect — every arm zero**, including both concurrency-8 arms
and a seventh consecutive clean unauth control.

*Protocol deviation, labelled rather than smoothed over:* this was scheduled for ~00:48:05Z
(+15 from the save). That time had already passed when the instruction arrived, and 816 requests
had just been driven through the pool (00:50:41–00:52:01Z) for the saturation measurement.
Running on time would have measured that burst, not the config. It ran at 00:59:01Z instead —
**7 minutes after burst end, 26 minutes after the save.** It is not a clean +15 and is not
presented as one; the on-time number was never taken.

**THE POOL SELF-CLEARS. Fault 3 is a queueing fault, not a leak or a wedge.**

```
00:50:47Z   pinned 38/38, refusing 82%
00:59:01Z   74 consecutive requests across four arms, ZERO failures, no intervention
```

**Recovery time is therefore ≤ 7 minutes — an upper bound, not a value.** No samples were taken
in between, so the real figure is likely far lower and is not claimed. Measuring it is cheap:
saturate, then probe at 30 s / 60 s / 120 s until clean.

This distinction changes what a fix must do. The fault is **not** "sustained load breaks the
pool until something restarts it." It is "sustained load saturates the pool, and it clears
itself once demand stops."

### The cliff, and why it argues for transaction mode specifically

The sustained burst absorbs roughly **24 concurrent requests**, then cliffs from 0/8 to 8/8 in a
single round and holds at 78–82% for as long as load continues.

**A cliff at ~24 concurrent against a pool of 38 means slots are held well beyond the work being
done** — which is precisely what session mode does and precisely what transaction mode fixes.
That is a mechanism-specific argument for the transaction pooler, stronger than "it was step 2
in the inherited plan."

### Three faults, named, with what fixed each

| # | fault | status |
|---|---|---|
| 1 | **Resting demand** — pool (15) below the fleet's idle draw (~17) | **FIXED** by 15→30, durably: 0/30 solitary at +2 min, +15 min, +3 h |
| 2 | **Isolated burst** — one 8-way burst atop resting demand | **FIXED** by 30→38: POST2 scored zero on every arm |
| 3 | **Sustained burst** — repeated bursts with no recovery gap | **NOT FIXED, and not fixable by `pool_size` on Micro.** Absorbs ~24 concurrent; cliffs 0/8 → 8/8 in one round; holds 78–82% while load continues; Supavisor pinned 38/38 across three samples; **self-clears within 7 min of load stopping** |

### Remaining levers (none tonight, none of them this lane)

- **Transaction-mode pooling** instead of session mode — connections return to the pool between
  transactions rather than being held for the whole session. Session mode is the structural
  reason a small pool cannot absorb bursts. Highest-value and cheapest of the three, but it is a
  config change against a pooler that has never carried traffic here, so it needs its own
  before/after.
- **Compute upgrade Micro → Small** — the only way to buy more slots.
- **Reduce per-request demand** (`max: 4` per isolate × 3 functions). Note D-047 does **not**
  speak to `max: 4`; that constraint was inherited, not derived.

## 6. The server-side gap this exposed (Verity, verified at source)

`supabase/functions/read/diagnostics.ts` `RETRYABLE_CODES` contains **53300
`too_many_connections`** — which is *Postgres*-level exhaustion. **Supavisor-level exhaustion
never reaches Postgres, so it never produces 53300.** `EMAXCONNSESSION` appears nowhere in
`supabase/` or `src/`.

Therefore the `retryable:false` observed on the wire is a **default, not a judgement**. The
server tells clients not to retry a condition that is transient and would likely succeed on
retry.

**The operator lifted D-047 for this one classifier** (2026-08-05), scoped to it alone — not a
general unfreeze of `read`. D-036 still applies in full, and any deploy must positive-control
that capability advertisement is unchanged (v6 advertises neither `delivery_claim` nor
`delivery_ack`; 0.1.5 listeners must still select `cursor_fallback`).

**But the one-line fix may not exist in that form.** On enumeration of the operator's captured
read-path log line the error is:

```
{"event":"read_request_failure","phase":"parse","name":"PostgresError","code":"XX000",
 "severity":null,"routine":null,"constraint":null,"retryable":false}
```

`XX000` is Postgres's **generic** `internal_error` — a real server-side internal error is also
`XX000`. The distinguishing `EMAXCONNSESSION` token lives only in `message`/`detail`, the
denied field. So both obvious one-liners are **rejected**:

- adding `XX000` to `RETRYABLE_CODES` — one line, but over-broad; it would mark permanent
  internal errors retryable, applying a decision to inputs it was not derived from;
- reading `EMAXCONNSESSION` out of `message` — the denied field, and D-053 territory.

Open, pending enumeration of the thrown object for a **structural** discriminator (a distinct
error class for connect-time vs query-time failure, a non-denied phase field, `errno`/`syscall`
— the driver stamps `XX000` on *a connection it could not establish*, and that is structure,
not text). A message token-test is the fallback and is not yet authorised.

**Hard condition on any classification change** (Verity, correcting its own earlier framing):
pool exhaustion is *later-recoverable*, but immediate same-request retries **amplify** it.
Recoverability and retry-now are different claims — that distinction is what the D-051 veto
encodes. Flipping `retryable` to true without shipping its backoff contract in the same change
would re-arm the amplifier D-051 just removed.

## 7. What was NOT established

- **The dashboard log-search is a broken instrument and all of its results tonight are void.**
  `EMAXCONNSESSION`, `max clients` and `pool_size` each returned "no results" — and then the
  **positive control failed**: `ClientHandler`, a string observed scrolling in those same logs
  minutes earlier, also returned "no results". Both arms identical ⇒ not a result. No claim
  about post-change EMAXCONNSESSION rows is made here. (This is also why the operator's
  instruction was to verify client-side.)
- Whether Supavisor pins at its ceiling because of genuine demand **or** because it accumulates
  connections and does not release them. Those have different fixes and are not yet
  distinguished.
- Whether lowering `pool_size` force-drains existing session clients. The revert is therefore
  **not** provably instantaneous (Plumb).
- Whether the raise starves Auth / PostgREST / Storage under a real peak. Mechanism flagged,
  not measured.
- Whether `max: 4` per-isolate demand should be reduced. **D-047 does not speak to `max: 4`** —
  the inherited claim that it does was checked against the register and does not follow
  (Verity). Unclaimed; an operator question.
- The true command-path failure *rate*. The 56/56 figure is **56 of 56 logged
  `command_request_failure` rows in a 7-day window**, not a rate; the path under-logs
  (Plumb, exact review of `1802e65..25b4ac4` — premise preserved, scope narrowed).

## 8. Authority note

D-047's silence on pooler config means it does **not prohibit** this change. It does not
**authorise** it either — those are different, and the distinction is deliberate (Verity).
Authority for this change is the operator's direct instruction.
