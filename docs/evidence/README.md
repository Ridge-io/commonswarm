# Evidence

Durable artifacts backing evidence-gated phase completions. These live in the repo
**on purpose**: an earlier `SUCCESSION-PLAN.md` cited P0 review logs under
`scratchpad/`, which is gitignored — by the time the next Lead read it, the cited
evidence no longer existed. A completion claim whose evidence cannot be re-read is
not evidence-gated.

**Naming, and why these files were not rewritten.** The product was renamed to
**CommonSwarm** with binary **`cswarm`** on 2026-07-27. Evidence written before that date
still says `coswarm`, and it stays that way: these files record what was run and what it
printed on a given day, and editing a past measurement to match a present name destroys
the only thing they are for. Read any `coswarm` here as the old name of the same product.
The one exception is `zero-install-agent-onramp.md`, whose *forward-looking* install and
post-deploy-verification commands were updated — a stale command there is not a record,
it is a trap that produces a copied 404 and a grep that manufactures a confident zero.
That file carries its own amendment note saying which parts moved and which did not.

| File | What it is |
|---|---|
| `kimi-p1-spec.log` | Kimi K3 dispatch 1 — P1 spec §0–§4 (truncated mid-§4) |
| `kimi-p2a.log` | Kimi K3 dispatch 2 — §4 completion, §5 fencing, §6 revocation, §7 idempotency |
| `kimi-p2b.log` | Kimi K3 dispatch 3 — §8 local-first, §9 test plan |
| `kimi-p2c.log` | Kimi K3 dispatch 4 — §10 risk register, SPEC GAPS |

Assembled into `docs/design/P1-COMMAND-API.md`. The logs include each run's tool
calls (what the model actually read), which is the part worth auditing: it shows the
spec was written against the real source, not from assumption.

Dispatch note: the first attempt at §5–§10 as ONE request wedged for 3h38m at zero
CPU and produced nothing. Splitting it into three parallel slices completed the same
material in ~17 minutes. If a long generation stalls, check accumulated CPU time
(`ps -o time`) rather than instantaneous %CPU — on a shared machine %CPU lies.

## `2026-07-31-handoff/` — the current zero-context handoff

**Start here if you are picking up CommonSwarm with no context.** Five documents covering
product state, repository/worktree inventory, the phased continuation plan, production QA, and
an independent adversarial review of the other four.

| File | What it is |
|---|---|
| `README.md` | Entry point: executive status, stop-the-line warnings, corrections log |
| `STATE-AND-PRODUCTION.md` | Architecture, exact release/repo state, production verification, customer-facing issues |
| `SWARM-AND-WORKTREES.md` | Agent lanes, task ledger, all 28 registered worktrees with dispositions |
| `NEXT-EXECUTION-PLAN.md` | Phased plan, specifications, acceptance gates, rollback, operator decisions |
| `PRODUCTION-QA.md` | Route-by-route public QA with reproducible issues |
| `ADVISOR-REVIEW.md` | Independent read-only re-measurement; nine findings; best first slice |

**Why it is here and not in `scratchpad/`.** It was written to `scratchpad/` and would have
been lost to any `git clean` — the identical failure described in this file's first paragraph,
recurring. The four original documents carry in-place corrections with **superseded lines kept
and marked dead**; `ADVISOR-REVIEW.md` records the measurements behind each correction and
bounds itself with an explicit "what I did not establish" section.

The `scratchpad/2026-07-31-common-swarm-handoff/` copy is a working convenience. **This copy is
authoritative.**
