# The 889ms is a region split, not a transaction shape

**Found by the infra/cost lane on its first day. Verified independently by the Lead.**

## The finding

```
edge functions   x-sb-edge-region: us-east-2      (response header, measured)
database pooler  aws-0-us-east-1...pooler.supabase.com   (connection host, measured)
```

**The edge functions run in a different AWS region from the database they talk to.** The whole
`command` handler runs inside **one interactive `db.begin`** (`index.ts:2279-2886`), and a successful
`post_signal` executes at minimum **~13 sequential awaited statements** — `setTransaction`, config
read, idempotency select, idempotency claim, rate bucket insert, stream head select, `now_ms`, stream
update, idempotency response write, `insertAudit`, display-name select, plus BEGIN and COMMIT. A
directed signal adds one more.

**889ms / 13 ≈ 68ms per round trip.** An edge isolate talking to Postgres *inside its own region*
should see single-digit milliseconds, which would put the whole transaction near 65ms.

## ★ Why this matters more than the number

**The obvious fix was the wrong one.** Facing an 889ms transaction with 13 statements, the natural
move is to rewrite it into fewer statements. That would have taken 13×68ms to perhaps 8×68ms — real
work, modest gain, and the actual cause untouched. **Placement is the cause; statement count is only
the multiplier.**

★ The lane called this before it was settled, and called it correctly:

> *"Do not touch the transaction until one timed statement tells us whether a round trip costs 3ms or
> 68ms. Those two worlds have opposite fixes and the measurement is one line."*

★ **And it labelled its own reasoning honestly at the time — "division, not measurement"** — a
statement count read from source divided into one end-to-end number, with no single statement timed.
It was offered as *a hypothesis with an arithmetic motive*, not a result. **That framing is why it was
worth acting on:** a claim that states its own evidential grade can be checked cheaply, and this one
was then settled by reading a response header rather than by the instrumented deploy the Lead had
already cleared. **The clearance was granted and turned out not to be needed.**

## The fix shape (not taken)

Provision the edge functions in the database's region, or move the database to the functions' region.
**Config, not code.** Neither is in this repo — it is a hosted placement decision and it belongs to
the Lead's deploy authority.

**Do not rewrite the transaction until placement is fixed and re-measured.** If the per-statement cost
drops to single digits, the current shape is fine and the rewrite is unnecessary work with a
regression surface.

## Independent, smaller, and still worth doing

Both functions construct their pool with `prepare: false`. `docs/evidence/p1-first-dogfood.md:51`
records this repo's own finding: *"Transaction pooler (6543) needs prepare:false with the postgres
pkg; session pooler (5432) doesn't — SWARM_DATABASE_URL uses session mode."* So by our own written
evidence it is not required on the connection actually in use, and it is set anyway — every statement
re-parses and re-plans instead of reusing a prepared plan.

**Not claimed as the 889ms** — at 68ms a statement it is almost certainly not. Flagged because **a
config contradicting our own recorded evidence is drift that outlives whoever introduced it.**
