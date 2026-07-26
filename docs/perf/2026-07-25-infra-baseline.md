# Infra / cost / performance baseline — 2026-07-25

Agent: Ledger (infra, cost & performance lane). **Read-only round. No deploy, migrate,
or config change was made.** Every number below was produced by execution on this
machine against hosted project `ukezjcnxjvkpkeezxaew`; nothing is cited from a report.

---

## 1. WHAT IS ACTUALLY DEPLOYED — confirmed

`supabase functions list` (project `ukezjcnxjvkpkeezxaew`):

| function | status | version | updated (UTC) |
|---|---|---|---|
| `command` | ACTIVE | **6** | 2026-07-25 13:29:25 |
| `read` | ACTIVE | **1** | 2026-07-25 13:29:13 |

`supabase migration list --linked` — remote matches local, all four applied:
`20260723000001`, `20260724000001`, `20260724000002`, **`20260724000003` (signals)**.

The Lead's stated deploy state (read v1, command v6, migration `..._signals`) is
**confirmed by execution**, not accepted on report.

Project identity: `cloud-swarm-dev`, org `qqlcrtbkvpvimowcgrzs` (ChartingAlpha),
region **us-east-1** (N. Virginia), created 2026-07-23, `ACTIVE_HEALTHY`.

---

## 2. LATENCY — the paths a user actually hits

Whole-command wall time, cold Node process each time, n=7, milliseconds.
This is what the human waits, not what the server logs.

| path | min | p50 | max |
|---|---|---|---|
| `node -e ''` (runtime floor) | 48 | **52** | 63 |
| `coswarm --help` (CLI parse, no network) | 85 | **88** | 102 |
| `coswarm workspaces` | 448 | **507** | 639 |
| `coswarm feed --limit 20` | 460 | **583** | 749 |
| `coswarm inbox` | 496 | **509** | 545 |
| `coswarm status` | 568 | **665** | 975 |
| **`coswarm note` (post a signal)** | 1321 | **1405** | **3985** |

### Decomposition — instrumented `fetch`, per round trip

Local `--import` shim wrapping global fetch. Server untouched.

```
coswarm feed (READ)                                        total 516ms
  #1 POST /auth/v1/token        start=+67ms   166ms  200
  #2 GET  /rest/v1/memberships  start=+278ms  142ms  200
  #3 GET  /rest/v1/workspaces   start=+279ms  140ms  200
  #4 GET  /rest/v1/signals      start=+420ms   95ms  200

coswarm note (WRITE)                                      total 1248ms
  #1 POST /auth/v1/token        start=+60ms   136ms  200
  #2 GET  /rest/v1/memberships  start=+233ms  108ms  200
  #3 GET  /rest/v1/workspaces   start=+233ms  107ms  200
  #4 POST /functions/v1/command start=+352ms  889ms  200
```

Three things fall out of this, and each is a separate lever:

1. **Every single command re-authenticates and re-discovers.** A token refresh plus a
   memberships read plus a workspaces read run *before any work*, on every invocation
   — **even when `--workspace-id` is passed explicitly.** That is ~290ms of fixed
   preamble on every command, and it is three of the four round trips.
2. **`POST /functions/v1/command` is 889ms for one signal.** It is the single largest
   component of the slowest path a user has.
3. Node itself is cheap: 52ms runtime, 88ms to parse the CLI. **Startup is not the
   problem. The wire is.**

### Raw platform floor — unauthenticated, n=15, TTFB

| endpoint | p50 | spread |
|---|---|---|
| `GET /auth/v1/health` | ~140ms | 100–201 |
| `POST /functions/v1/read` (401) | **197ms** | 181–302 |
| `POST /functions/v1/command` (400) | **560ms** | 479–1333 |

Steady state across 15 back-to-back requests — **this is not cold start.** `command`
costs ~2.8× `read` to *reject* a request. Section 4 explains why.

---

## 3. COST — the honest answer is that there is nothing to optimise yet

**Measured usage drivers, hosted, 2 days since stats reset:**

- Database size **12 MB** (of which the `swarm` schema is 136 kB table + 672 kB index).
  Free-tier limit is 500 MB; we are at ~2%.
- WAL 80 MB (Postgres floor, not our traffic).
- Cache hit rate: index 0.97, table 1.00.
- **Total query execution time across the entire database, over two days: ~0.64 seconds.**
- Live rows in the whole product: 3 signals, 2 workspaces, 2 users, 3 memberships.

**Conclusion: variable spend for coswarm to date rounds to zero.** Every dollar this
project costs is fixed compute. There is no usage curve to bend, and any time spent on
query or egress optimisation right now would be spent against noise.

**Plan and dollar figure — INFERRED, not measured. Stated as such.**
Org `ChartingAlpha` holds **four `ACTIVE_HEALTHY` projects**; the sibling org
`ChartingAlpha-Free` holds three, all `INACTIVE`. Supabase Free caps an org at two
active projects and pauses idle ones — the contrast is strong evidence ChartingAlpha
is on a paid plan. On Pro at list price that implies ~$25/mo org + ~$10/mo per Micro
instance less a $10 credit, so **cloud-swarm's marginal cost is on the order of
$10/month** and is 100% fixed.

**What I could not verify and why:** the Supabase CLI exposes no billing or usage
surface, and the access token in the keychain is a `go-keyring` blob the CLI decrypts
internally — the Management API rejected it (`JWT could not be decoded`). Settling the
plan, the compute size, and the actual invoice needs either the org billing page or a
new Management API PAT. **Minting a PAT is an account write. I did not do it. It needs
your clearance.**

**The infra question that actually matters is not the $10.** The only coswarm project
that exists is named **`cloud-swarm-dev`**. P3-1 shipped to it, the dogfood runs
against it, and R1 will measure against it. There is no separate production project.
That is a launch-readiness decision, not a cost one, and it is currently being made by
default.

---

## 4. RAISED — an unauthenticated request writes to the database

**Confirmed by execution.**

`handleRequest` validates `command_id` and, on failure, calls `standaloneAudit(...)`
— which opens a transaction and inserts a row into `swarm.audit_log` — **and only then
returns 400. The bearer credential is not read until after this point.**

```
supabase/functions/command/index.ts (origin/main)
  2928  async function handleRequest(request: Request)
  2933    const parsed = await readBody(request)
  2936    const kind = commandKind(body)
  2937    if (!COMMAND_ID_RE.test(body.command_id)) {
  2942      await standaloneAudit({...})     <-- DB transaction + INSERT
  2947      return json(400, ...)
  2950    const credential = bearer(request)  <-- auth begins HERE
```

Proof, not inference: `swarm.audit_log` held **19** rows before this round. I sent 20
malformed unauthenticated `POST`s (body `{}`) plus 6 legitimate signal posts. It now
holds **45**. `19 + 26 = 45`, exact.

Why it matters, in the order it will bite:

- **Cost.** The anon key is public by design. Anyone holding it can drive unbounded
  `audit_log` inserts, WAL, and storage growth without ever authenticating.
- **Latency.** This is the whole explanation for §2's 560ms rejection path — the 400
  is slow *because it does a database transaction first*. `read` rejects in 197ms
  because it does not.
- **Ordering.** Auditing an unauthenticated malformed request before authenticating it
  is a layer doing real work on behalf of a caller it has not yet identified.

**Boundary — what I did not verify:** I did not test sustained rate to find out whether
any limiter eventually engages, and 20 requests did not trip one. I did not check
whether the audited fields are length-bounded. I am not calling this exploited or
exploitable at scale — I am calling it measured.

### 4a. Boundary closed — the limiter cannot cover this path

**Follow-up trace, same round.** I said above I had not established whether a rate
limiter runs before this write. **It cannot.** `enforceSignalRate` sits at
`index.ts:2518` — inside the main `db.begin`, *after* authentication — and
`incrementSignalBucket` keys its bucket on the identified principal. A limiter keyed on
the caller's identity is structurally incapable of running before the caller is
identified.

That is stronger than §4 as originally filed. The pre-auth audit INSERT is not merely
unlimited in practice; it is **unlimitable by the mechanism that exists**. The fix is to
move the write after `bearer()`, not to tune a limit.

**Consequence for measurement, and it is bigger than my probes:** any unauthenticated
traffic to `/command` inflates `swarm.audit_log`. Row deltas on that table are therefore
**not a safe metric substrate for any round** unless the round also controls for
malformed unauthenticated requests.

---

## 5. RAISED — the human feed and the agent feed are two implementations

> **⚠ SUPERSEDED IN PART — read §10f before acting on this section.** Vane calibrated
> this down (both paths select from the same `swarm_read.signals` view; no divergence
> exists today), and a follow-on claim of mine about `read/index.ts:193` being redundant
> was **wrong** and is retracted in §10f. What survives: the predicates are written twice,
> and the latency point — which is now **measured**, see §10d.

`coswarm feed` as a human hits **`GET /rest/v1/signals`** (PostgREST, `swarm_read`
schema, RLS). An agent credential hits **`POST /functions/v1/read`** (`src/cloud/signals.ts`,
`humanSignals` vs `agentSignals`).

This is deliberate, and it is not a defect. It is worth naming anyway: the same query —
filters, staleness cut-off, ordering, limit — is written twice, and the two must stay
in agreement forever or two users will see different feeds of the same workspace.

**Consequence for what has been measured so far:** the 95ms feed number in §2 is the
**human** path only. **The `read` edge function has never been timed under a real agent
credential** — not by me, and I found no evidence of it elsewhere. Minting an agent
token is a write, so I stopped. If R1 is going to make claims about agent feed latency,
that measurement does not exist yet.

---

## 6. RAISED — `npm run test:p1-cli` is environment-dependent — RED **and** GREEN demonstrated

> **✅ CLOSED with a demonstrated pair.** Same commit, same machine, only the environment
> changed. Quill freed the local stack; I re-ran immediately.
>
> | local Supabase stack | result | exit |
> |---|---|---|
> | **down** | 66 pass / 3 fail | **1** |
> | **up** | **69 pass / 0 fail** | **0** |
>
> The code was never the variable. **`69/69` is a property of the environment, not of the
> commit** — shown in both directions rather than asserted.
>
> **⚠ The 69/69 headline is now stale, and the reason proves the point.** Re-run later:
> **72/72 exit 0**. The suite grew because *the checkout moved under me* — I joined on
> `quill/p3-1-signals` @ `4d6be3c`; it is now `quill/cli-first-errors` @ `bfa0a1d` with a new
> `tests/p1-cli/cli-errors.test.ts`. **The pair still stands** (both halves same commit, same
> hour, environment the only variable), but the current baseline is **72/72 exit 0 on
> `bfa0a1d` with the stack up**. Quote the commit or don't quote the number.
>
> **And a hazard that surfaced with it: Quill and I are operating in the same working tree.**
> This suite spawns its own `supabase functions serve` against the same local stack Quill was
> taking G-A1 REDs on. It was safe only because I asked first and Quill cleared the window.
> One branch switch, or one unannounced run, and both of us get results we cannot attribute.

Charter §4 warned that stopping the local Supabase stack silently removed the ability
to *run* three tests. I checked what is runnable rather than what is running.

```
$ npm run test:p1-cli
66 passing
3 failing            exit code 1
✖ fixture bridge is idempotent and CLI client drives cradle-to-grave
✖ one-command invite link accept converges after a live local double-run
✖ live project reads list, select, and render status across two memberships
   Error: Command failed: supabase status -o json
```

All three are in `tests/p1-cli/local-integration.test.ts`. OrbStack is not running, so
`supabase status` exits non-zero, so `environment()` throws in `before()`.

The code is fine. The point is the **failure mode**: there is no skip guard, so
"the local stack is down" and "the CLI is broken" produce a byte-identical RED and the
same exit 1. That is standing-hunt item #2 wearing a test harness — a signal that
cannot distinguish the object it is measuring from its environment.

**This also bounds a claim already in circulation.** "CLI 69/69" is true with the stack
up. On this machine as it stands it is 66/69 and exit 1. Anyone treating 69/69 as a
property of the commit rather than of the environment will be wrong.

---

## 7. CHECKED CLEAN — nothing found

- **`SELECT swarm.purge_expired_rate_buckets()`** is the #1 query by total execution
  time (11.7%, 43 calls). It is **not** on the request path — it is invoked by a pg_cron
  schedule in `20260723000001_p1_schema.sql:848`. 75ms total across two days. Not a cost.
- **Cold starts** — 15 back-to-back requests to each function showed no cold-start
  signature. The `command` overhead is steady-state, not boot.
- **Connection pooling** — both functions build a module-level `postgres()` pool
  (`max: 4`, `idle_timeout: 20`). Not per-request connection setup.
- **Database size** — no growth problem exists at any horizon presently visible.
- **DNS/TLS** — Cloudflare-fronted, connect 15–50ms, TLS 36–78ms. Not a factor.

---

## 8. LOCAL ENVELOPE — my lane, and the charter's headline number needs a correction

Now: **swap file total 5.12 GB, 4.26 GB used, 860 MB free. Physical memory 15 GB used,
~750 MB unused, 2.0 GB compressor. System-wide free 51%.** OrbStack/Docker down. No
local Supabase stack.

**A correction, offered on day one because the charter says to offer it on day one.**
The charter records "swap 14.2 GB used of 15.4 GB" before reclaim and "8.1 GB used"
after, and reads as a 14.2 → 8.1 improvement in a fixed quantity. It is not fixed.
**macOS grows and shrinks the swap file dynamically**, and the *total* has moved
15.4 → 6.1 → 5.12 GB across today. "Swap used" at two different totals is not a
comparison — 4.26 GB of 5.12 GB is **83% of the file consumed**, which reads far worse
than the raw number suggests, while 14.2 of 15.4 was 92%. The reclaim was real; the
metric is unstable and will mislead the next person who quotes it.

**Use `memory_pressure` and compressor size as the standing gauge, and record the
denominator whenever swap is quoted.** I will report against that from here.

Current read: this machine is loaded but not in crisis. It has room for the fan-out
the charter describes, and not much room for another resident tab.

### 8a. End-of-session envelope — and the 12 GB gate is a lagging indicator

```
swap        6.56 GB used of a 7.17 GB total   ->  free 612 MB. 91% CONSUMED.
compressor  7.21 GB   (was 2.00 GB at baseline — 3.6×)
unused RAM  118 MB
free %      30%       (was 51% at baseline)
disk free   32 GB of 460 GB
```

The operational gate in use is *"swap used > 12 GB"*. **It cannot fire before the machine is
already at the wall.** macOS grows the swap *file* on demand, so "swap used" has no fixed
denominator — the total moved 15.4 → 6.1 → 5.1 → 7.2 GB across one day. A 12 GB *used*
threshold is only reachable after macOS has grown the file past 12 GB, which it does
silently while disk allows. The gate fires *after* the system has spent another ~5 GB of
disk avoiding the problem.

**The number that actually moved is the compressor: 2.0 → 7.2 GB** — memory the kernel had
to compress because it could not free it, and invisible in any swap-used reading. With
118 MB unused and 30% free, the honest description is *at the wall and holding*.

### 8a-i. The denominator is a directory listing — and my mechanism for it was unsourced

Vane established at the filesystem, and I reproduced:

```
ls /System/Volumes/VM/swapfile* | wc -l   -> 10 files
10 × 1 GB                                 -> 10240 M
sysctl -n vm.swapusage  total             -> 10240.00M      exact match
```

**`vm.swapusage total` is `count(swapfileN) × 1 GB` and nothing else.** The denominator moving
five times in thirty minutes was macOS creating and deleting 1 GB files in a directory — on
the **same APFS container** as the repo, worktrees, `node_modules`, and every build output.

**Vane's retroactive tool, confirmed:** `ls -lt /System/Volumes/VM/` recovers the growth curve
without having polled — `swapfile2 16:57, 3 17:10, 4 17:20, 5 17:21, 6 17:22, 8 17:37`, which
is exactly the curve I had reconstructed from five live readings.

**Its limitation, which I'd ship with it:** mtimes record **growth but not shrink**. A new file
gets a fresh mtime; a deletion leaves no trace. Files are also reused rather than allocated in
order (`swapfile7` Jul 20, `swapfile10` Jul 23, while 2–6 are today), so numbering is not
chronological. My 12.29 GB peak at 17:26 is visible; the shrink back to 9.2 GB is not.

**And a mechanism of mine, withdrawn.** I wrote that *"macOS enlarges the swap file on demand
and stops only when the volume is full."* Vane flagged it as unsourced. It is:
`man 8 dynamic_pager` documents only the swapfile **base name** and the `-F` flag — nothing
about when files are created, when growth stops, or about disk. No growth-policy knob in
`sysctl`.

**What survives is arithmetic, not policy:** swapfiles are files on that container, so their
total cannot exceed current size + container free space. That is a hard upper bound needing no
policy at all — enough to justify a disk gate. **Whether macOS stops earlier, and on what
signal, I did not establish.** The charter should say *"disk bounds the denominator"*, never
*"macOS grows until disk is full."*

### 8a-ii-FIX. The gate below was WRONG in its third condition — read 8a-iv first

> Vane caught it: **`disk free` is not independent of swap. The swapfiles *are* the disk.**
> `disk_free` and `swap_total` are one quantity with the sign flipped, so the "floor under the
> other two" was the swap excursion reported a second time — **two of three conditions were one
> measurement.** Corrected in §8a-iv. The `system free` and `swap used` conditions are unaffected.

### 8a-ii. FIRST GATE — specified at Lead6's request, tested, RED on delivery

Lead6 handed this lane the design after three failed attempts of its own (an absolute that
could not fire, a ratio with a disk-shadowed denominator, a trend from one sample).
Implemented at `scripts/envelope-check.sh` — exits 1 on RED so it can guard a spawn.

| condition | source | denominator | now |
|---|---|---|---|
| system free **< 35%** | `memory_pressure` | 16 GB physical — fixed | **29% RED** |
| swap used **> 8192 MB** | `vm.swapusage used` | none — absolute bytes | **12125 MB RED** |
| disk free **< 20 GB** | `df -k /` | volume size — fixed | 23 GB GREEN |
| compressor | `vm.compressor_bytes_used` | **recorded, not a trip** | 6.1 GB |

**Two of three RED on delivery**, without contrivance — the charter's demonstrable-RED
requirement satisfied by the gate as shipped.

**Why `swap used` absolute rather than a ratio.** Six samples at 2s intervals: `used` moved
12013 → 12007 → 11969 → 11981 → 11985 → 12042 MB while `total` and the file count sat still.
So `used` tracks pages actually written out and is **not** inflated by file creation — an empty
swapfile raises `total`, not `used`. It is monotonic in the quantity of interest (Vane's
argument, verified here).

**Why swap utilisation % is rejected rather than retuned.** Its denominator is
`count(swapfile) × 1 GB`, which Vane measured moving a **full gigabyte inside a 12-second
window**. The denominator changes on a shorter timescale than the gate is read, so two agents
checking the same gate seconds apart legitimately disagree. No constant fixes that.

**Why not a pageout rate.** Two samples, noisy, and I demonstrated the failure mode myself —
extrapolated a 6 GB/7min disk slope and withdrew it within sixty seconds. **Level, not rate.**

**Why compressor is recorded but not a trip.** Best *leading* indicator (2.0 → 7.2 GB today)
and best diagnostic, but it moves *with* free% rather than independently — free% was 51% at
compressor 2.0 GB, 29% at 6.1 GB. A fourth condition that fires when the first fires is
redundancy dressed as rigour.

**Constants are calibrated to one machine on one day.** 8192 MB is half of physical RAM paged
out, against a session that started at 4558 MB and sat under 6 GB while healthy; 20 GB is
anchored to the observed disk excursions. **The shapes are principled; the numbers are a single
sample and should be revisited on a second day of data.**

### 8a-iii. Correction — the disk floor *is* drifting down

I told Vane "two excursions, same floor, no downward drift." **There are now three and the
floor is falling:**

```
session start   32 GB
excursion 1     26 GB   → recovered to 28–29
excursion 2     26 GB
excursion 3   24.7 GB   → 23 GB → recovered to 28 GB
```

Peak swap total also rose, 12.29 → 13.31 GB. **Not projecting a rate** — three levels and a
direction, nothing more; I extrapolated once tonight and withdrew it inside a minute.

**Third reading, added after the fact so this section doesn't go stale the way the last one
did:** excursion 3 recovered too — disk back to 28 GB and swap used 12125 → 8552 MB. So the
floors have been 26 / 26 / 23 with reliable recovery each time. **Oscillating with a possible
slight downward drift in the floor, and a robust recovery** — which is a less alarming picture
than the paragraph above, and both readings are true of the data available when written. The
lesson is the one already recorded at §8a: this number wants a level gate, not a narrator.

For the gate: swap used at 8552 MB against an 8192 MB threshold means the constant sits close
to this machine's healthy/unhealthy boundary — useful calibration evidence, and an argument
that 8192 is neither decorative nor trigger-happy.

### 8a-iv. FINAL GATE — the third condition was measuring the second

**Vane's catch:** `disk_free` and `swap_total` are one quantity with the sign flipped. Verified
against nine `(disk, swap_total)` pairs from this session's own log:

```
components moved:              disk 9.0 GB,  swap_total 7.2 GB
SUM (disk + swap_total):       36.31 – 38.29   = 1.98 GB spread
SUM, unrounded df -k only:     37.72 – 38.01   = 0.29 GB
```

**Conserved to 0.29 GB across a 9 GB excursion.** So §8a-iii's *"the floor is falling"* was the
excursion in a mirror — disk fell **because** swap rose, and returned when swap shrank.

**And it kills a signal Vane kept.** Vane read a residual *"one to two gigabytes, probably fleet
debris"*, honestly bounded as unattributed. **It is almost entirely `df -h` rounding** — whole-GB
output means ±0.5 GB per reading and ±1 GB on a sum of two, which is the whole 1.98 GB spread.
On `df -k` the residual is 0.29 GB. **There is no measurable fleet debris in that signal.** My
own "32 → 26 → 24.7 → 23" was therefore wrong twice: a mirrored excursion, read with a blunt
ruler. `df -k` is now enforced in the script header.

**Conditions** (`scripts/envelope-check.sh`) — *superseded in one arm, see §8a-vi*:

| condition | source | why |
|---|---|---|
| system free **< 30%, worst of 3** | `memory_pressure` | fixed denominator, 16 GB physical. **Threshold and sampling both corrected — see §8a-v** |
| swap used **> 8192 MB** | `vm.swapusage used` | absolute, monotonic, no denominator |
| swap headroom **< 25 GB** | `df -k` + `swap_total` | **the conserved quantity** — space the swap system can occupy in total |
| compressor / swap_total / disk | — | printed as **diagnostics, not trips** |

**Both directions demonstrated on the unmodified gate** — which the first version could not claim:

```
under pressure   free 29%  RED  | swap used 12125MB  RED   → RESULT RED,   exit 1
on recovery      free 37% GREEN | swap used  7089MB GREEN  → RESULT GREEN, exit 0
```

A gate that only ever fires is not distinguishable from one that is stuck.

**Stated limitation:** I cannot produce a *live* RED for the headroom condition — it sits at
37 GB against a 25 GB trip, and reaching it means genuinely consuming 12 GB of disk. I verified
its **logic** instead (raising the threshold above current makes it fire). So: two conditions
with live RED-and-GREEN transitions, one with proven wiring and no live RED. Lead6 was told to
land it saying exactly that.

**25 GB is the weakest number in the spec** — roughly twice today's peak swap total plus room to
build. A placeholder, not a derived value.

**Not claimed:** I have not attributed compressor growth to any seat, and I am not
prescribing a headcount. The answer may simply be Chrome and twelve containers.

### 8b. The machine hosts TWO fleets, and this one is the smaller

Asked to rank what is safe to stop, the answer turned out not to be inside this fleet:

```sql
SELECT s.name, COUNT(*) FROM agents a JOIN swarms s ON s.id = a.swarm_id GROUP BY s.name;
  prompteden   11 seats
  cloud-swarm  10 seats
  uxtest        1 seat
```

**22 live agent seats. Ten are ours.** And every heavy process belongs to the other fleet:

| MB | process | path | age |
|---|---|---|---|
| 138 | tsc | `prompteden/wt-tally-veto-design` | 13m |
| 104 | esbuild | `prompteden/wt-moire-charts` | 15m |
| 86 | tsc | `prompteden/app` | 13m |
| 79 | tsc | `prompteden/wt-lattice-probe` | 7m |
| 75 | tsc | `prompteden/wt-anvil2-fix` | 15m |
| 53 | node | `prompteden/wt-moire-charts` | 2m |

**~535 MB of live TypeScript/esbuild across five PromptEden worktrees**, none in either repo in
scope. Charter §1 puts that out of scope; the resource constraint does not care.

**Ranked by what is actually in this fleet's gift:**

1. **Genuinely stale, ~130 MB** — the only clean reclaim we own: a **7-day-old** openclaw
   gateway (29 MB), two codex vendor procs (38 MB each, 19h and 1d2h), ten ChatGPT
   `cua_node` repls up to **4 days** old (~25 MB).
2. **Local Supabase stack — already gone, and it proves the thesis.** Zero supabase
   containers remain. Lead6 reported the reclaim "moved nothing"; it moved nothing because
   the whole stack was ~180 MB against a 6.8 GB compressor. **And the cost is live:
   `npm run test:p1-cli` is back to 66/69 exit 1** (§6). The charter's own recorded trap,
   executed.
3. **`next-server`, 168 MB** — out-of-scope repo, not ours to stop.
4. **Our ten seats — the only large lever we own, and a Lead decision at rotation.** 13
   `claude` procs ≈ 2.0 GB RSS, which **I cannot attribute between the two fleets** and did
   not guess.

**The charter change that follows:** §0 sizes this fleet against the whole machine. The real
constraint is *one 16 GB machine shared with another fleet whose scheduling we do not
control.* Without saying so, the next Lead repeats the same good-faith reclaim and gets the
same nothing.

**Boundaries:** no ppid walking, so the `claude` RSS is unattributed. RSS badly undercounts
here (process RSS ≪ 6.8 GB compressed), so every figure is a floor. And I have not spoken to
anyone on the PromptEden side — seat counts and paths come from the shared store and `ps`.

---

## 9. WHAT I CHANGED — full disclosure

Nothing was deployed, migrated, or configured. Two categories of hosted side effect,
both from measurements the task asked for:

1. **6 real signals posted** to workspace `3ab184b3-...` (Dogfood Workspace), bodies
   marked `infra latency probe N (Ledger, ignore)`, **TTL 1 minute** so they age out of
   the default non-stale feed immediately. Signals are immutable — they are still in
   the table and will appear under `--include-stale`. **Exclude them from any R1 or
   dogfood count.**
2. **26 `swarm.audit_log` rows** (19 → 45), per §4 — 20 from malformed probes, 6 from
   those signal posts.

Anyone measuring signal or audit volume in this workspace today needs both numbers.

---

## 10. THE THREE LEVERS, RANKED

> **⚠ SUPERSEDED — see §10e for the revised list.** Written before the root cause was
> found. Lever 2 below asks a question that §10c answered and §10e-root diagnosed.

1. **Drop the per-command preamble.** Three round trips (~290ms) before any work, on
   every invocation, including when the workspace is named explicitly. Cache the
   membership/workspace resolution and skip the refresh while the token is live. This
   is the largest win available and it touches no server code.
2. **Find the 889ms inside `command`** — narrowed below in §10a. Do not touch the
   transaction until one timed statement lands; the two candidate worlds have opposite
   fixes.
3. **Move the §4 audit write to after authentication.** Small change, removes an
   unauthenticated write path, and makes the 400 fast as a side effect.

---

## 10a. Narrowing the 889ms — arithmetic, explicitly not measurement

The whole command runs in **one interactive `db.begin`** (`index.ts:2279–2886`). On a
successful `post_signal` the sequential awaited statements are, at minimum:

```
BEGIN
  setTransaction                              SET LOCAL …
  SELECT value FROM swarm.config              (min_client_version)     :2364
  SELECT … FROM swarm.idempotency_keys        (replay check)           :2469
  INSERT INTO swarm.idempotency_keys          (claim)                  :2567
  INSERT INTO swarm.rate_buckets              (enforceSignalRate)      :2143
  SELECT head_seq FROM swarm.streams                                   :2614
  SELECT now_ms                                                        :2626
  UPDATE swarm.streams                                                 :2768
  INSERT/UPDATE swarm.idempotency_keys        (store response)         :2798
  insertAudit                                                          :2824
  SELECT display_name FROM swarm.users                                 :2843
COMMIT
```

≈ **13 round trips.** My probes passed `to=null`, so `signalTargetIsLive` (`:2506`) was
skipped; a *directed* signal adds one more.

**889ms / 13 ≈ 68ms per round trip.** That is the whole point. An edge isolate talking
to Postgres inside its own region should see single-digit milliseconds per statement,
putting this transaction near 65ms rather than 889ms. For comparison, one PostgREST
query **from this laptop** to us-east-1 measured **95ms** — the function's per-statement
cost is the same order as a cross-country round trip from a developer machine.

If that holds, **the transaction shape is not the problem and collapsing it into fewer
statements is the wrong fix.** The problem is placement: the isolate is not paying
intra-region latency to reach the database.

**This was division, not measurement** when first filed. It has since been **confirmed
black-box — see §10c.** No deploy was required; the deploy clearance was handed back
unspent.

### 10b. `prepare: false` contradicts our own recorded evidence

Both functions build their pool with `prepare: false`
(`command/index.ts:380`, `read/index.ts:18`). But `docs/evidence/p1-first-dogfood.md:51`
records our own finding:

> Transaction pooler (6543) needs `prepare:false` with the `postgres` pkg; session
> pooler (5432) doesn't — `SWARM_DATABASE_URL` uses session mode.

By the repo's own evidence, `prepare: false` is **not required on the connection we
actually use**, and it is set anyway on both functions. Cost: each of those ~13
statements re-parses and re-plans per execution instead of reusing a prepared plan.

**I have not measured the gain, and at 68ms/statement it is almost certainly not the
889ms.** It is filed because the config contradicts a finding we wrote down ourselves —
the kind of drift that outlives whoever introduced it.

---

## 10c. CONFIRMED — ~32ms per database round trip, and the deploy was not needed

Lead6 granted a timed-statement deploy. **I handed it back unspent.** The agent-token
clearance granted alongside it turned out to be the better instrument.

The `read` function has an **early-return branch** (`read/index.ts:159`): a request whose
`workspace_id` does not match the agent's principal workspace returns `200 {"signals":[]}`
after executing a *shorter prefix of the same code*. Same credential, same request shape,
same function, same isolate — **only the round-trip count differs.** A natural instrument
that was already deployed.

| path | round trips | TTFB p50 (n=15) |
|---|---|---|
| pre-DB 401 (bad token, returns before `db.begin`) | 0 | **197ms** |
| early return, wrong workspace | 9 | **484ms** |
| full signals read | 13 | **625ms** |

Three independent estimates of the slope:

```
(625 − 484) / 4   = 35.2 ms per round trip
(484 − 197) / 9   = 31.9 ms per round trip
(625 − 197) / 13  = 32.9 ms per round trip
```

**~32ms per database round trip.** Intra-region Postgres should be single-digit
milliseconds.

### It predicts the other function to 5%

The `command` pre-auth 400 path (§4) runs `BEGIN` + `setTransaction` + `insertAudit` +
`COMMIT` = 4 round trips, measured 560ms. So `command`'s boot floor is
`560 − 4×32 = 432ms` — against `read`'s 197ms, consistent with `command` being 90 KB of TS
plus `@supabase/supabase-js` plus a 42 KB protocol bundle.

```
predicted post_signal = 432 + 13×32 = 848ms
measured  post_signal =               889ms      (5% error, on a function not fitted)
```

**Model: `latency ≈ boot floor + (DB round trips × ~32ms)`.**

**Therefore the transaction shape is not the problem.** Collapsing statements treats the
symptom. The edge isolate is not paying intra-region latency to reach the database, and
that is placement/configuration — not the code Quill is about to touch for the §4 ship.

### 10d. Agent read path is 6.6× the human path

Same workspace, same nine signals, same `swarm_read.signals` view, n=15, TTFB p50:

| credential | route | p50 |
|---|---|---|
| human | `GET /rest/v1/signals` (PostgREST, one query) | **95ms** |
| agent | `POST /functions/v1/read` (13 round trips) | **625ms** |

This is the number §5 recorded as never having been measured. It now exists. **Any
latency claim about "the feed" must name the credential kind or it is off by 6.6×** — and
R1's entire subject is what an agent-driven persona experiences.

### 10e-root. ROOT CAUSE — the edge functions run in a different region from the database

```
x-sb-edge-region: us-east-2      where the functions RUN      (Ohio)
DB region:        us-east-1      where the database LIVES     (N. Virginia)
```

**10/10 samples, both `read` and `command`, every one `us-east-2`.** DB region from
`supabase projects list -o json`. Every one of the ~13 sequential round trips per request
is a **cross-region hop, Ohio ↔ N. Virginia.** That is the 32ms.

Model, arithmetic, and root cause now agree:

```
read  full feed   = 197 + 13×32 = 613     measured 625
command post_sig  = 432 + 13×32 = 848     measured 889
```

`cloud-swarm-dev` is the **only project in the org in us-east-1** — gbrain and PromptEden
are both us-east-2. This is almost certainly not a decision anyone made; it is the default
that fell out of choosing N. Virginia at project-create on 2026-07-23.

**Not established:** whether the edge region is settable per-project or is a property of
the platform/org that only a project move would change. And the ~400ms saving is
arithmetic from the fitted model, not an observation of a fixed system.

### 10e. Revised levers

1. **Region co-location — the big one.** See §10e-root. Worth roughly **400ms off every
   command and every agent read, with zero application change**. Dwarfs both code levers
   below. **Sequence matters: do not spend on 2 or 3 until the region question is
   answered.**
2. **Six round trips in `read` that compute nothing.** `read/index.ts:137-140` and
   `:175-176` are `SET TRANSACTION` / `SET LOCAL ROLE` / `SET LOCAL search_path` /
   `SET LOCAL lock_timeout` — six separate awaited round trips, ~190ms, **30% of the agent
   read path**, issuable as one statement. *Unverified:* that `postgres.js` `tx.unsafe()`
   runs multi-statement strings in simple-query mode on this driver version. Check before
   claiming the win.
3. **`command` calls GoTrue over the network on every human request.**
   `index.ts:2972` `await authClient.auth.getUser(credential)` is an HTTP round trip to
   `/auth/v1/user`, measured independently at ~140ms. A project-signed JWT can be verified
   locally against the JWT secret with no network call. And `@supabase/supabase-js` is
   imported (`:1`) **solely** for that one call — the only `authClient` use in 3037 lines.
   Removing it also shrinks the bundle behind the 432ms boot floor. Two wins, one change.
   **`supabase secrets list` shows `SUPABASE_JWKS` is already provisioned**, so the key
   material this needs is in place — no new secret, no new surface.

### 10f. A claim of mine that was wrong — corrected

I told Vane that `read/index.ts:193` (`inbox = false OR "to" = owner_user_id`) was
**redundant** with the view's `:59` predicate. **That was wrong.** Vane caught it; I tested
it rather than conceding it:

```
same agent credential, same workspace, include_stale=true, only `inbox` flipped:
  inbox=false  -> 9 rows, every one with to=null
  inbox=true   -> 0 rows
```

Were `:193` redundant, `inbox=true` would have returned the same 9. It returns zero.
`:59` is **visibility** (broadcasts + directed-to-me); `:193` is **mode** (in inbox mode,
require a non-null `to`). `:193` excludes exactly the broadcast rows `:59` admits.

**Consequence, which is the part that mattered:** deleting `:193` as redundant would
silently convert every agent's inbox into its feed — more rows, no error, no failure
signal. My claim would have licensed that.

Incidental finding from the same read: **all nine signals in the workspace have
`to=null`.** Not one directed signal exists in the entire dogfood history, so the agent
addressability gap Vane filed has never been exercised in practice.

---

## Boundaries — what this baseline does NOT establish

- The actual invoice, plan, or compute size. Inferred from project state and public
  pricing only (§3). PAT clearance held by Lead6; no further use for it this round.
- ~~`read` latency under a real agent credential~~ — **now measured, §10d.**
- ~~Whether any rate limiter engages before the §4 audit write~~ — **now settled, §4a.**
- **Why** a round trip costs 32ms. Region and pooler are candidates; neither tested.
- No individual statement has been timed server-side. §10c is a fitted slope from
  black-box timings that predicts a second function to 5% — a model, not a probe.
- The 197ms and 432ms boot floors bundle Cloudflare + TLS + isolate boot. Not separated.
- Lever 2's multi-statement assumption (§10e) is unverified.
- Latency from the second machine — the CLI is not installed there.
- Concurrent or sustained load. Every number here is a single sequential client.

---

## Appendix A — the `swarm` store (charter §1 puts the tooling repo in scope)

Two findings from `~/.swarm/swarm.db`, read-only via `sqlite3 -readonly`. Both were
corrections of claims already in circulation, one of them mine.

### A1. There is no relay. `to_agent` is the recipient column.

A finding had hardened into the successor baton as *"1,724 of 1,724 of Dana's messages to
one relay that is absent from the roster and returns `http_code=000`."* Three of its four
supporting facts do not hold:

```
sqlite3 -readonly ~/.swarm/swarm.db ".schema messages"
  -> id, swarm_id, from_agent, to_agent, body, delivered, created_at, kind, superseded_by
```

**No `via`, no `route`, no hop — the schema cannot express a relay.** `to_agent='UxDriver'`
means Dana *addressed* UxDriver.

- **UxDriver is identified in its own payloads**: id 10630 opens `"Dana — UxDriver (Ferry).
  GATE 5 DISPATCHED…"`, id 8339 `"UxDriver (Ferry driving)"`. It is the uxtest driver seat.
- **It is not dead** — it originated 10 messages to Dana, including *"YES. I HAVE AN
  EXPLICIT OPERATOR GO. EXECUTE."*
- **The `000` was the wrong port on the wrong host:**

| | 18790 | 18791 | 18792 |
|---|---|---|---|
| mini `127.0.0.1` | **200** (Anvil) | 000 | 000 |
| laptop `100.95.177.37` | — | **200** (Dana, per roster) | 000 |

The measurement curled `127.0.0.1:18792` — on the mini. Dana is on the laptop and its
endpoint is **18791**, which answers. Port 18792 answers on neither machine and belongs to
no agent on either roster.

**What survives, and it never needed the mechanism:** Dana addresses exactly one seat, so
its entire output lives in the `uxtest` swarm. A successor reading `swarm inbox --recent`
on cloud-swarm sees 1,006 messages and **not one from Dana**. The record gap is real; the
relay was not. (Atlas reached the same schema conclusion independently.)

### A2. A missing delivery row is not evidence of non-delivery

`messages.delivered` is not "the recipient has seen this" (Ferry's finding). The
per-recipient record is `message_deliveries.first_injected_at`. Joined across cloud-swarm:

```
delivered=1, status='acked'      919
delivered=1, status='injected'     4
delivered=1, NO ROW AT ALL        29
```

Of the 29: **5 are cmux** (ids 11563/11576/11601/11605/11606 against `MAX(id)=11609` — in
flight, benign). **24 are the two a2a seats: Dana 21/21, Anvil 3/3.** Across all swarms
Dana is **31/31**.

So the rule *"use `first_injected_at`, not `delivered`"* returns **NEVER SURFACED for every
message ever sent to an a2a agent**, including ones they demonstrably acted on. Pointed at
Dana it manufactures a drop finding every time.

**The tidy explanation is false, and I checked before publishing it.** I assumed a2a agents
are pushed rather than injected and so never get rows. Anvil disproves it — ids 6682–6689
in `prompteden` are `acked`/`injected`; ids 7739/9188/9327 in `cloud-swarm` are `NO ROW`.
Same agent, same class, different swarm.

**Deliberately not diagnosed.** Time, version, registration path, and push-vs-poll are all
live candidates; I tested none. Three invented mechanisms died in this fleet today and I
stopped at the observation on purpose.

**Final rule — Ferry's three-way split. My own two attempts at line 2 were both worse and
are withdrawn (A4).** Split by *question*, don't hedge:

| question | authority |
|---|---|
| Was this **sent**? | `messages.delivered`. **`delivered=0` is a real failure** — Dana's finding. |
| Was it **surfaced to a hook-injected (cmux) seat**? | `first_injected_at`. A missing row **is** anomalous (Ferry 129/130). |
| Was it **surfaced to an a2a seat**? | The store cannot say. |

### A4. Reconciled with Dana's landed drop finding — and my line 2 softened it

`docs/swarm-cli/2026-07-25-silent-message-drop.md` (origin/main) records **37 real drops**
found by Dana: `delivered=0`, no delivery row, spanning 15 hours, with `swarm redeliver`
returning 0/2 and the target endpoint serving `http_code=000` from its own loopback.

I re-derived the two populations and they are **different states of the same broken
signal**:

| | `delivered` | delivery row | count |
|---|---|---|---|
| Dana's proven drops (outbound → UxDriver) | **0** | none | **37** |
| Dana outbound, same recipient | 1 | none | 1,675 |
| Inbound to a2a seats (my A2) | 1 | none | 35 |

**1,712 of Dana's 1,724 outbound messages have no delivery row at all.** So Dana's doc is
right that *"`delivered=1` with zero rows in `message_deliveries` is the state that should
be impossible and is instead routine."*

**Which makes my A2 line 2 wrong in its emphasis, and I am correcting it rather than
defending it.** I wrote *"absence of a record is not a record of absence"* as reassurance.
It is true as logic and misleading as guidance: Dana proved that at least 37 messages in
precisely this family were really dropped. My framing would have licensed someone to wave
past the exact state Dana spent fifteen hours proving was dangerous.

**The two findings converge, and the convergence is the point:** a missing delivery row
means *the store cannot answer the question*. That ambiguity **is** the defect — and it is
why Dana's proposed fix is the right one: make an undeliverable send loud **at send time**,
and split `stored` from `delivered-to-recipient` so one column stops carrying two facts.

**Then Ferry corrected me back, and Ferry was right.** The doc had been amended after I read
it (my `git show` predated the correction header). Its corrected text says absence of a
delivery row does **not** mean failure, and the discriminator is `delivered`, not the
missing row:

```
Dana OUTBOUND  delivered=0, no row:    37   <- THE PROVEN DROPS
Dana OUTBOUND  delivered=1, no row: 1,675   <- fine
Dana INBOUND   delivered=1, no row:    32   <- fine
```

**Both of my line-2 drafts were wrong** — the first too reassuring, the second collapsing
two distinct questions the doc had just separated. Ferry's three-way split above replaces
both. My worry could not have landed anyway: the dangerous state is `delivered=0`, and no
version of line 2 touched that column.

### A5. ~~The doc's corrected premise is falsifiable~~ — **WITHDRAWN IN FULL, see A6**

> **⚠ EVERYTHING IN A5 IS WRONG.** I matched on a name across a swarm boundary and
> inherited an `agent_type` that was never in the data. The doc's "never" stands. A6 has
> the retraction and the mechanism. A5 is kept only so the error is legible.

The corrected doc says: *"Delivery rows are an artifact of the hook-injection path; **an a2a
recipient never gets them**."* **Anvil is an a2a recipient and got four.**

```
6682  prompteden   2026-07-23T11:48:22Z  acked
6684  prompteden   2026-07-23T12:09:21Z  acked
6687  prompteden   2026-07-23T12:25:23Z  injected
6689  prompteden   2026-07-23T12:37:04Z  injected
─────────────────────────────────────────────────  boundary
7739  cloud-swarm  2026-07-24T20:15:24Z  NO ROW
9188  cloud-swarm  2026-07-25T13:16:10Z  NO ROW
9327  cloud-swarm  2026-07-25T13:45:32Z  NO ROW
```

Same agent, same class. **"Never" is falsified by four rows with statuses and timestamps.**

The distinction is the entire disposition of question 3:

- *"a2a never gets rows"* = **design property.** Nothing broke; permanently unanswerable;
  nothing to do.
- *"a2a stopped getting rows on ~2026-07-24"* = **regression.** Something removed the
  instrumentation, and that loss is part of why a drop went unnoticed for fifteen hours.
  Question 3 becomes **recoverable**, with a defect behind it.

**The corrected doc closes a question the data says is open** — it replaced a wrong column
with a wrong universal, and the second error is quieter because it sounds like architecture.

Pitch reached the same boundary independently ("empty for every message since 2026-07-24",
a ~32-hour gap) and stopped. **Boundary endpoints: last row `2026-07-23T12:37:04Z`, first
absence `2026-07-24T20:15:24Z`.**

**Deliberately not diagnosed, again.** I ran no `git log` on the swarm repo and tested
nothing. Version, registration path, and a2a-vs-hook routing changes are all candidates.
Two agents have now walked to this boundary from different seats and both declined to
cross it; it needs someone who will read the a2a send path properly.

**Object-check that outlived the whole exchange:** everything above is the **mini's** copy
of the store. Dana's finding came from the laptop. Ferry queried the mini too. So there are
**two readings of one store, not two stores** — still the weakest joint in all of it.

### A6. A5 retracted — the "boundary" was a registration event

I claimed *"Anvil is an a2a recipient and got four [delivery rows]"*, falsifying the doc's
"never". **I never verified that the recipient of those rows was an a2a seat.**

```
SELECT name, agent_type, swarm, joined_at FROM agents WHERE name='Anvil'
  -> Anvil | a2a | cloud-swarm | 2026-07-24T20:15:02.767Z     ← ONE ROW. THE ONLY ROW.
```

**Anvil is not registered in prompteden at all.** That roster holds `AnvilCalvinAudit`
(headless) and `Anvil2` (cmux) — neither received ids 6682–6689, and the registration that
did no longer exists. I matched on a **name** across a swarm boundary and inherited a
**type** that was never in the data.

**And the "boundary" is the join event itself:**

```
Anvil a2a joined_at         2026-07-24T20:15:02.767Z
first row-less msg (7739)   2026-07-24T20:15:24.153Z    ← 21 seconds later
last row-bearing (6689)     2026-07-23T12:37:04.074Z    ← a day earlier, other swarm
```

I reported a seat's **creation timestamp** as the date instrumentation regressed. There is
no before-and-after — there is a seat that has been a2a for its entire existence and has
never had a delivery row.

**The one-line test I should have run first:**

```sql
SELECT a.name, a.agent_type, COUNT(d.message_id)
  FROM agents a LEFT JOIN message_deliveries d
    ON d.recipient = a.name AND d.swarm_id = a.swarm_id
 WHERE a.agent_type = 'a2a' GROUP BY a.name, a.swarm_id;
  -> Anvil/cloud-swarm 0   Dana/cloud-swarm 0   Dana/uxtest 0
```

**Every a2a seat, every swarm, zero rows.** The doc's wording stands and needs no edit.

Withdrawn: the falsification, the regression-vs-design fork, the suggested doc edit, and the
dated boundary I sent to Pitch. Ferry's line 3 was also weakened on my bad evidence and
should go back to *"surfaced to an a2a seat? the store cannot say."*

**Not recoverable by anyone:** `agents` does not retain historical `agent_type`, so what the
July-23 prompteden "Anvil" actually was cannot be determined from this database.

**The shape of the error, for the record:** I found a timestamp near a change, called it a
boundary, built a two-option disposition on it, and argued for one — in the same message
where I wrote *"I am deliberately not diagnosing."* A stated boundary is not a respected
one, which is the thing I spent the day telling other people.

*(Ferry's control group had the mirror problem — Keystone and Sonar are both `cmux`, so
"prompteden still writes rows today" never tested the a2a cell either. That confound was
real; it just wasn't what settled it.)*

### A7. The actual mechanism — found by Pitch, in the source

Everything above, mine and Ferry's, was a hunt for the right **object**. Pitch read the code
and found the right **variable**, and it is not a property of the agent at all:

> `message_deliveries` records that **a recipient read the store**. A **pushed** recipient
> never polls, so it never gets a row — **whatever kind of agent it is.**

So the final rule, general and mechanism-grounded rather than a statement about a2a:

| question | authority |
|---|---|
| Was this **sent**? | `messages.delivered`. **`delivered=0` is a real failure** — Dana's finding. |
| Was this **surfaced**? | A missing `message_deliveries` row means **"this seat does not read this store"**, *not* "the message did not arrive". For **polling** seats a missing row **is** anomalous (Ferry 129/130, Lead6 177/178). |

This also explains the anomaly that defeated both of our theories: Anvil's four prompteden
rows mean **that seat was polling on 07-23**, whatever it was registered as. My "regression"
was the wrong answer; Ferry's "the seat's class" was the last wrong answer before the right
one; Pitch's *what the seat **does*** is the cause.

**And Pitch then produced the confirming evidence — also Pitch's, not mine** (Atlas credited
it to me; I checked the store and corrected it). Everyone else, me included, kept producing
*zeros*, and a zero cannot separate "no rule fires" from "a per-class rule excludes". Pitch
queried the one seat whose class nobody had looked at — `AnvilCalvinAudit`, the store's only
`headless` agent:

```
7588   2026-07-24T18:57:54   acked_at 19:00:43   ← ROW
7608   2026-07-24T19:01:25   acked_at 19:01:33   ← ROW
7621   2026-07-24T19:18:35   (no row)
9748   2026-07-25T14:21:49   (no row)
11271  2026-07-25T20:23:29   (no row)
```

**Two rows then three absences, within one seat** — class, swarm, endpoint and agent held
constant, only reading behaviour varying. A per-class rule yields 5/5 or 0/5 and cannot
produce this. It is the only evidence in the thread that could not have come out the same
way under the wrong hypothesis.

Second confirmation, and the sharper half: `first_injected_at` is **empty** on both rows
while `acked_at` is **set** — so they were written by `acknowledgeMessages`
(`mailbox.ts:220`), the explicit read/ack path, **not** the hook injector. That identifies
the *writer*, not merely the presence of a row.

### A8. Bundle-vs-runtime — checked, and the mechanism survives it

Ferry flagged that Pitch's mechanism should not be treated as closed until someone verified
the **running binary** against the source, and nobody had. The chain:

```
~/.local/bin/swarm            3-line bash shim
  -> swarm/bin/swarm          launcher, ENTRY=bin/swarm-entry.mjs   (line 17)
  -> bin/swarm-entry.mjs      await import('../dist/index.js')      (line 3)
```

**The running code is `dist/`, not `src/`** — the bundle-vs-runtime gap is real and that is
where it lives.

```
dist/mailbox.js   built    2026-07-25 16:41
src/mailbox.ts    modified 2026-07-21 11:09     ← build postdates source by 4 days
```

And Pitch's claim verified **in the built artifact**, not the source: `agent_type` appears
**0 times in both** `src/mailbox.ts` and `dist/mailbox.js`, while `dist/mailbox.js` contains
`getInbox` (×4), `recordHookInjections`, and `first_injected_at`. **The poll-path mechanism
is in the code that actually runs.**

**Boundary that is *not* closed:** this proves the *current* binary matches the *current*
source. The delivery rows in question were written over preceding days by whatever `dist`
existed then, and an overwritten build cannot be inspected. *"The mechanism describes the
code running now"* is proven; *"…the code that wrote those rows"* is inferred from the
source being untouched since 07-21. A decent inference, still an inference.

**Noticed in passing, not chased:** `src/transport.ts` **is** newer than `dist`, so it has
been edited since the last build and the running binary does not contain it. Given
`transport.ts:20` is the unbounded `execFileSync` named in the charter and a transport fix
is queued, whoever lands it should know the current `dist` predates their edit.

**Tightest form of the freshness argument:** HEAD `ef91f8f` committed `2026-07-25T16:38:22`,
`dist` built `16:41`, working tree clean (`git status --porcelain -uno` empty). The bundle
was built from that exact commit three minutes after it landed.

### A8a. My own method was truncated — conclusion survived, confidence didn't

I told Ferry *"no origin ref contains newer changes to `src/mailbox.ts`"*. That loop ran
over `git for-each-ref refs/remotes/origin | head -8`. **Origin has 16 refs.** I checked
eight and published a universal.

Re-run across all 16 with no pipe: **same single hit** — `origin/feat/inbox-recent-replay`,
the July-14 divergent branch that lacks the mechanism. Conclusion unchanged, sample was half.

I also ran `git remote -v | head -2` in the same investigation, which hid `origin` entirely
(`fork` occupies exactly two lines). I escaped that one only because the next command
enumerated refs directly.

**Two truncating pipes in one investigation, both added for tidiness** — by the agent who
had just told Pitch that a caught-error count is a *floor* because nobody counts the ones
that didn't bite, and then didn't apply it to itself for another hour. I found both only
because Atlas confessed the same `head -2` publicly.

**One trap worth leaving for the next person:** `git rev-list --count A..B -- <file>`
returns nonzero for **old** work on a divergent branch, and reads exactly like "there are
newer changes." A false positive from a correct command — the counterpart to the day's
false negatives, and arguably worse, since a nonzero count invites action while an empty
result at least invites suspicion. The tell was that the mechanism symbols appeared as
deletions.

### A3. A claim of mine, withdrawn

I told Lead6 and Ferry: *"cloud-swarm has 1,006 messages and zero undelivered, so if a real
drop exists, its evidence is uxtest-side."* Built on `messages.delivered` — the wrong
object, inside a message correcting someone else's use of the wrong object. **Withdrawn.**
The rest of A1 came from the schema and live `curl` and stands.

---

## Writes made this round — full exclusion list

| what | detail |
|---|---|
| 6 signals | Dogfood Workspace, `infra latency probe N (Ledger, ignore)`, 1m TTL, immutable |
| 26 `audit_log` rows | 19 → 45 (20 malformed unauth probes + 6 signal posts) |
| 1 agent principal | `ledger-perf-probe` = `6f2b243c-fa5c-4690-b84a-e4a492b6fee7` |
| 1 agent token | `573eac4f-4fcb-452e-b21c-3d477025175f` |
| ~45 authenticated reads | no writes, no audit rows |

**Stark version for anyone measuring:** Dogfood Workspace holds **9 signals, of which 6
are mine.** My probes are 67% of that workspace's entire signal history. The three genuine
ones are the G5 canary, the spawn-hang `working-on`, and the bounded-timeout `ask`.

---

## 8a-v. A threshold placed inside the instrument's quantisation is a coin

**Found after this document was first landed; recorded here because the doc and the shipped
script had already drifted apart without it.**

Lead6 observed the `system free` condition flapping GREEN→RED→GREEN within seconds and asked
whether it was noise the gate should smooth, or the instrument correctly catching a momentary
dip. **It was neither.** 25 rapid samples of `memory_pressure` free percentage:

```
35 35 35 35 35 35 35 35 35 35 35 35 35 35 35 34 34 34 34 34 34 34 34 34 34
min 34   max 35   spread = ONE point
```

Against a 35% trip: **10 RED / 15 GREEN on a machine whose state never changed.** The signal is
a quantised integer with a one-point range and the threshold was sitting inside it. **It was a
coin by construction, not by noise** — and no amount of smoothing fixes a threshold placed on
the operating value; it only changes which way the coin lands more often.

**Two fixes, both shipped in `scripts/envelope-check.sh`:**

1. **Worst of 3 samples** — takes the minimum, so it fails safe toward *do not spawn*, and a
   genuine dip inside the sampling window still trips it.
2. **Threshold 35 → 30** — so it *separates* the states observed on 2026-07-25 (28–29% during
   the real excursion, 34–37% marginal-but-working for hours, 64% recovered) rather than
   bisecting the idle range.

Verified: **ten consecutive runs, identical verdict, no flap.** Before the fix the same machine
produced both answers within seconds.

**The trade-off, stated because it is a real loss:** 30% is less sensitive. A sustained 32% is
now GREEN and would previously have been RED. Accepted because the machine demonstrably
functioned at 34–37% for hours while the gate would have been telling everyone not to spawn —
and **a gate that is RED during normal operation gets ignored**, which is the failure mode that
ends with nobody reading it at all. The RED remains producible: 28–29% occurred twice that day.

> **★ THE GENERAL FORM — a threshold placed within the instrument's quantisation is a coin, and
> it looks exactly like a noisy signal. The tell is a spread of one unit: if min and max differ
> by a single quantisation step, the defect is the threshold's placement, not the instrument.**

**Also note:** this section exists because the *document* said 35% while the *script* said 30%
— a doc/artifact disagreement of exactly the class catalogued elsewhere in this file, created
by landing the two at different moments. Whoever edits either should check the other.

---

## 8a-vi. The replacement gate inherited the defect it replaced — found by Atlas

**`swap used (absolute) > 8192 MB` was the same defect as the ~12 GB charter gate, one
threshold lower.** Atlas caught it; confirmed here, and it was **live at the moment of the
fix**:

```
sysctl -n vm.swapusage  ->  total = 6144.00M   used = 5244.81M
```

**`used` cannot exceed `total`, and the trip sat at 8192 MB — above the entire swapfile.**
The arm could not fire. Of eight distinct swap totals observed across the session
(6144 … 13312 MB), **three put the gate in the unreachable state**, and the machine was in
one of them.

**And when it *was* reachable it was still wrong**: `total` is `count(swapfile) × 1 GB`, which
macOS **grows in response to the pressure being measured**. So the arm fired only after the
mitigation had already happened — *"on the mitigation rather than the pressure"*, which is the
exact wording of my own charter correction, applied to my own replacement. **I removed an
absolute threshold against a moving bound and then shipped another one.**

**Replacement — `memory under duress > 100% of physical RAM`:**

```
DURESS = (vm.compressor_bytes_used + swap_used) / hw.memsize
```

**Compressor is bounded by RAM, not by the swapfile count**, so **the numerator is no longer bounded
below the trip** — which is precisely attempt 3's defect, fixed.

★ **CORRECTED PER ATLAS — the original sentence here read *"reachable at any `swap_total`"*, which is
true in principle and OVERSTATES THE MARGIN.** The numerator's cap is `compressor_max + swap_total` and
**still contains `swap_total`**: the dependency on the moving bound is **reduced, not removed.** At
`total` 6144 MB the practical ceiling is **~75% against a 100% trip**, holding compressor constant —
a compressor excursion ~1.4x the largest observed this session. **A successor who checks the strong
claim on a quiet machine finds ~71-78% and reasonably distrusts the arm**, which is the same
falsifiability trap as the charter's *"unreachable by construction"*. The script asserts the **hard**
ceiling (`100*(RAM + swap_total)/RAM`, measured 156%) on every run and prints `UNREACHABLE` if a trip
ever sits outside it.

★★ **AND THE PROCESS DEFECT WORTH MORE THAN THE SENTENCE: THIS CLAIM EXISTED IN THREE PLACES AND THE
FIX REACHED TWO OF THEM, TWICE IN ONE HOUR.** Script + charter + this file all describe one gate in
prose. The first correction landed in the script and missed the charter; the second landed in the
charter and missed this file — **both by the same hand, minutes apart, while explicitly hunting this
exact class.** The rule *"update all three"* has now failed twice with the author watching for it.
**The mechanism that would retire it: ONE of these should be generated from, or point at, the script
rather than restating it.** Three prose copies of one fact is three chances to be two-thirds right.
See §3 face 13 — *a rule where a mechanism would do*.

Session evidence:

| moment | compressor | swap used | duress |
|---|---|---|---|
| baseline | 2.0 GB | 4558 MB | 40% |
| **pressure** | 7.2 GB | 12125 MB | **119%** |
| **peak** | 7.0 GB | 11167 MB | **112%** |
| mid | 6.0 GB | 8552 MB | 90% |
| easing | 3.2 GB | 7089 MB | 63% |
| recovered | 2.2 GB | 5443 MB | 47% |

A trip at **>100%** fires on exactly the two genuine excursions and stays quiet on everything
else. **Reachability verified at the state that killed the old arm**: at `swap_total` 6144 MB,
lowering the threshold makes the new arm go RED — the old one could not have, at any threshold
at or above the total.

`swap used` is retained as a printed **diagnostic**, since Vane's monotonicity argument for it
is still correct — it is a good *reading* and was a bad *trip*.

> **★ THE GENERAL FORM — an absolute threshold is only as good as its bound. If the quantity
> is capped by something that grows in response to the pressure, the threshold measures the
> mitigation, not the pressure. Check what caps the numerator, not just what divides it.**
