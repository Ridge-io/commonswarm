# Lead verification arm — UI addressing slice (`34d75ee`)

Reviewer: ClaudeCswarm. Non-authoring — the code was written by a Codex worker against
`docs/design/contracts/UI-ADDRESSING-VISIBLE-GOAL.md`. Branch `next/0.1.6-ui-shape`, post-0.1.5.

**This is not a D-036 release gate.** D-036 governs SHA-changing lanes on the release; this is
post-freeze 0.1.6 work that ships nothing. Recorded to the same standard anyway, because the habit —
not the rule — is what has actually caught things this cycle.

## What I re-ran myself rather than reading from the report

| Check | Result |
|---|---|
| Clean build + full site gate | **118/118** (own `rm -rf site/dist` + rebuild) |
| Scope — anything outside `site/` | Only `REPORT.md` at root, since I asked for it. No `supabase/`, no root `src/`, no migration, no manifest or lockfile. |
| Frozen release | `175f894` is an ancestor of HEAD and unmodified. Nothing deployed. |

Baseline was **113/113**, so the count moved **113 → 118** and the acceptance is met on the number I
measured, not the one I was told.

## The causal control — the part that decides whether this is real

A passing observer proves nothing unless it would fail when the defect returns. So I restored the
original defect: removed `to_agent` from the dashboard's PostgREST select, the single omission this
whole slice exists to fix.

```
mutant  (to_agent dropped from the select)  -> 118 tests / 117 pass   RED
restore                                     -> 118 tests / 118 pass   GREEN
```

**The observer catches it.** The control is causal, not decorative, and the worker's claimed red
evidence (5 failures against the pre-change build) is consistent with a control that discriminates.

## A false defect I nearly filed against my own instrument

Grepping the built bundle for privacy language returned `Private` and `private` inside
`LiveDashboard.astro`'s script, which — against a packet whose central prohibition is *do not render a
privacy claim* — reads as a violation.

It is not. Both strings predate this work and belong to the **invite link** (`Private one-use link ·
expires in 7 days`), which has nothing to do with signal visibility. Checked against the packet SHA
`f4e0008`, where they already exist at `:376` and `:2178`.

The diff adds **no** privacy language at all. The only `+` line matching my pattern is an assertion
that *forbids* it:

```js
assert.doesNotMatch(renderFeed, /only .* sees|private|lock icon/i);
```

So the worker gated the prohibition rather than merely complying with it — the constraint now survives
the next person who does not read the packet. Two things worth keeping from this: my grep was the
imprecise instrument and the code was fine, and **a "must be absent" grep without a
did-this-predate-me check manufactures violations** the same way a mis-scoped grep manufactures zeroes.

## What this does NOT establish

- **Nothing about who can *read* a directed signal in the dashboard.** The agent read path is enforced
  (`read/index.ts:376-383`); the dashboard's `swarm_read.signals` PostgREST/RLS path is a different
  query and **remains unmeasured**. The UI states the addressee and makes no visibility claim, which is
  exactly the intended outcome — but the open question in `2026-08-03-SLACK-SHAPE-UI.md` is still open,
  and the worker said so unprompted rather than quietly resolving it in copy.
- No live authenticated browser check against production, no database measurement, no deployment.
- Static and built-artifact review plus the one mutant above. I did not mutate the other four checks,
  so their individual discrimination is asserted by the worker and not independently confirmed.
