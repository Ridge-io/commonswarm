# D-054 answered from the production logs — the premise is refuted

Read 2026-08-05 by the Lead, from the Supabase dashboard logs of project `ukezjcnxjvkpkeezxaew`
(`cloud-swarm-dev`, **which is production** — the branch selector in the dashboard reads
`main PRODUCTION`). Operator granted authenticated browser access; this had been the single
external blocker on D-054 and D-056 since they were opened.

Time range: **last 7 days** (2026-07-29 → 2026-08-05 19:53). Engine is ClickHouse SQL over a
unified `logs` table with a `source` column — `function_logs` is a *source*, not a table.

## The log line D-054 asked for

```json
{"event":"read_request_failure","request_id":"598fd40d-ee48-4c35-8628-5b1284568f7b",
 "phase":"parse","name":"PostgresError","code":"XX000",
 "severity":null,"routine":null,"constraint":null,"retryable":false}
```

## 1. The premise is refuted: production errors DO carry a code

D-054 asked whether the failing errors carry a top-level string `code` at all, reasoning that if
they do not, `retryable:false` is the blanket default applied to everything unclassified.

**They do.** Enumerated over 7 days, grouped by `name`/`code`:

| `name` | `code` | count | `retryable` |
|---|---|---|---|
| `PostgresError` | `XX000` | **8,990** | `false` |
| `Error` | `CONNECT_TIMEOUT` | 18 | **`true`** |

Two things follow, and the second matters more than the first:

- **`retryable:false` on these failures is a real classification, not the unclassified default.**
  The `XX000` rows carry a code and the classifier read it.
- **The classifier is demonstrably working.** `CONNECT_TIMEOUT` — the obviously transient case — is
  reported `retryable:true`. That is the positive control, and it discriminates: if the field were
  a blanket default we would see `false` on both rows.

**The D-054 mechanism is real and the fix is still correct. Production is not an instance of it.**
That distinction was not available before this read, and the register entry asserted the production
consequence without it.

## 2. What the read did establish, and it is worse

**These errors are not coming from Postgres.**

| source | measurement |
|---|---|
| `function_logs` — `PostgresError`/`XX000` reported by the edge function | **8,990** |
| `postgres_logs` — rows matching `XX000` | **0** |
| `postgres_logs` — rows matching `ERROR` at all, whole range | **2** |
| `postgres_logs` — total rows, whole range (positive control) | 10,530 |

The database logged **two** errors in seven days while the edge function reported **8,990**
`PostgresError`s. Every one carries `severity:null`, `routine:null`, `constraint:null` and
`phase:"parse"` — a genuine server-side Postgres error arrives with a severity and a routine.

So the `PostgresError` is being **synthesized below the function and above the database**, and
`XX000` (Postgres's generic `internal_error`) is the code it is being given. The server-side ruling
that `XX000` is non-retryable is then applied to a condition that is not a database error at all.

## 3. It is happening now, continuously

Hourly `XX000` counts, most recent first:

```
19:00  235     15:00  305     11:00  272
18:00  232     14:00  531     10:00  301
17:00  234     13:00  326     09:00  365
16:00  201     12:00  168
```

Steady 168–531/hour with no gaps, through the hour this was read. This is not a historical
incident; it is the current state of production.

## Not established

- **The cause of the synthesized `PostgresError`.** Pooler/driver interaction at the extended-query
  `Parse` step is consistent with `phase:"parse"` plus null severity plus no server log, but that is
  a hypothesis and it is **not** measured here. `supavisor_logs` around the failure timestamps show
  ordinary connect/authenticate/terminate traffic and one `ECLIENTSOCKETCLOSED … while state was
  idle (proxy)`; I did not quantify that — two attempts at a counting query over the 123,609-row
  source returned no result and I did not determine whether that was a timeout or a query error.
- **Which function** emits the failures. `read_request_failure` names the read path, but I did not
  join to a function id.
- **Whether this is the same condition as D-056's cold-start deaths**, or the ~50% per-request
  baseline. The rates are compatible; nothing here demonstrates they are one cause.
- **Whether the 2 postgres `ERROR` lines relate to these failures at all.** I did not read them.
- Nothing was changed. This is a read.

## Consequence for the register

D-054's "what answers it immediately" section is answered and its expected answer was wrong. The
entry should keep the mechanism — an unclassified error must not assert non-retryability — and mark
the production inference dead. Its own "Not established" line already anticipated this: *"Whether
the production failures actually lack a `code`."* They do not.

---

## Addendum — Wren's eight captured request ids, looked up individually

Wren captured the eight ids deliberately spread across **three workspaces** (including
`53158257…` created 2026-07-31 *pre-migration* and `6e380592…` created 2026-08-04
*post-migration*), **both views** (`inbox` and `feed`), **two capture methods** (raw `curl` with a
config-file header, and the CLI's own stdout once 0.1.6 began printing the id), over a **2.5-hour
span**. Its stated criterion: *"If name and code are identical across all eight, that is a strong
signal it is one condition rather than several. If they differ by view or by workspace age, that is
the discriminator I could not get from outside."*

All eight resolve in `function_logs`. **All eight are identical:**

```
name=PostgresError   code=XX000   phase=parse
```

| # | request_id | ~time (UTC) | view | workspace |
|---|---|---|---|---|
| 1 | `a94ec2e2-e8bd-44b6-a0a5-7ab7d8489823` | 13:02 | inbox | `ff36ef30…` (Test 1) |
| 2 | `9eb59cf3-70fb-4c2c-94aa-b443f25c5b7d` | 13:05 | inbox | `53158257…` pre-migration |
| 3 | `5868e561-c742-472c-a207-41a04cebb772` | 13:09 | feed | `53158257…` |
| 4 | `4a2e76b2-54aa-439e-8444-b5cf0bba7f74` | 13:09 | inbox | `53158257…` |
| 5 | `2e34faad-34df-481a-ad37-ccd4c66610a9` | 13:11 | feed | `6e380592…` post-migration |
| 6 | `084ecea1-cde8-492f-ad57-f191d930aa88` | 13:11 | inbox | `6e380592…` |
| 7 | `5bdd7856-7334-45bf-bfa1-ff45af5ac17d` | 14:46 | inbox | `6e380592…` (0.1.6, follow, fatal) |
| 8 | `60a897bd-1826-42a6-bbd8-38198fc0cb69` | 15:20 | inbox | `6e380592…` (0.1.6, follow, fatal) |

**By Wren's own criterion this is one condition, not several.** Workspace age does not discriminate
it; neither does view, nor capture method, nor the 0.1.5→0.1.6 binary change.

This also retires the lock-contention hypothesis for a stronger reason than the one Wren gave when
withdrawing it. Wren noted it predicted `40001`/`40P01`/`55P03`, which all classify *retryable
true*, so the observation could never have matched. The deeper reason is that **no Postgres error
code was ever going to appear**: per §2 above, these errors are not reaching us from Postgres at
all.

## What this addendum still does not establish

**The command path.** All eight ids are `/functions/v1/read`, and every measurement in this
document is of `read_request_failure` events. Wren has **zero** command-side ids, and the reason is
itself a finding: in 0.1.5 the write-path error text carried **no `request_id`**, so simultaneous
write failures — Wren reports `working-on` taking four attempts and token mint up to eight — left
no correlation id at all. **Nothing here is evidence about the command path.** Wren has been asked
to capture command-side ids directly; if they show the same `XX000`/`parse` signature this is one
infrastructural condition, and if they differ, every conclusion above is scoped to `read`.
