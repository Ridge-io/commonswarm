# Evidence

Durable artifacts backing evidence-gated phase completions. These live in the repo
**on purpose**: an earlier `SUCCESSION-PLAN.md` cited P0 review logs under
`scratchpad/`, which is gitignored — by the time the next Lead read it, the cited
evidence no longer existed. A completion claim whose evidence cannot be re-read is
not evidence-gated.

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
