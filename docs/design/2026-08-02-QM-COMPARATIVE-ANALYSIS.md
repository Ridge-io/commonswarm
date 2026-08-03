# QM comparative analysis — what to learn, what to adopt, what to reject

Author: ClaudeCswarm (relief lead)
Date: 2026-08-02
Subject: `github.com/yc-software/qm` vs CommonSwarm, applied to the v0.1.5 roadmap
Method: shallow clone + source read of ~10 of 52 `src/` modules, cross-checked against our tree

---

## 1. What QM actually is (measured, not summarized from marketing)

| Fact | Value |
|---|---|
| Repo | `yc-software/qm`, MIT, TypeScript |
| Created | 2026-07-29 (4 days before this analysis) |
| Traction | 6,868 stars, 719 forks, 83 open issues, 29 subscribers |
| Homepage | `qm.ycombinator.com` |
| Tagline | "Multiplayer agent harness for work. In Slack and on the web." |
| Shape | Headless Fastify core + Postgres + per-scope sandboxes + plugins (Slack/web-ui/admin/portal) |
| Tests | 372 test files, glob-run, sharded 5 ways in CI |

`src/` carries 52 modules. Six of them sit directly on top of our open lanes:
`delivery/`, `idempotency/`, `wake/`, `harness/`, `credentials/`, `acl/`.

Harness adapters shipped: `claude-harness`, `codex-harness` (+ `codex-app-server`),
`opencode-harness`, `pi-harness`, `mock-harness`, behind a `harness-router`.

## 2. Strategic read: adjacent, overlapping on exactly one axis

QM **runs** agents — it owns the harness, the sandbox, model routing, and the surface (Slack/web).
CommonSwarm **coordinates** agents that the operator already runs somewhere else.

That difference is the whole product. A QM user adopts a new runtime. A CommonSwarm user keeps
their existing Claude Code / Codex / OpenCode setup and gains coordination on top. Our value
proposition — *agents posting short immutable signals of intent so collaborators are unblocked* —
is not something QM offers; QM's collaboration model is chat rooms with scoped memory.

**The one axis where we genuinely overlap is host adapters.** QM ships four plus a mock. We ship
two (`grok-model.ts`, `opencode-model.ts`). If a team adopts QM, our second-adapter work becomes
less differentiating for them specifically. This is worth the operator knowing; it is **not** a
reason to change the v0.1.5 plan, and I am not recommending any action on it.

## 3. The headline finding: architectural convergence is validation, not redirection

I checked QM's durable-delivery design against ours line by line. We independently arrived at the
same primitives, and in two places ours is stronger:

| Concern | QM | CommonSwarm | Verdict |
|---|---|---|---|
| Queue claim | `FOR UPDATE SKIP LOCKED` (`postgres-delivery-store.ts:98`) | `FOR UPDATE OF d SKIP LOCKED` (`command/durable-delivery.ts:235`) | **Same. Both canonical.** |
| Lease | `claim_expires_at`, TTL param | `lease_id`/`leased_by`/`leased_until`/`last_lease_id` (`20260731000001`) | **Ours richer** — tracks lease identity, not just expiry |
| Idempotency retention | 14 d, hard-coded default | 30 d, `idempotency_retention_days` in DB config (`p1_schema.sql:442`) | **Ours better** — operator-tunable without deploy |
| Unknown-ACK handling | tombstone row in `ackByKey` | `swarm.revocation_tombstones` | **Same idea** |
| Enqueue wake | `onEnqueue(listener)` in-process | not built (our post-MVP "realtime wake hints") | QM has it; ours is a deliberate deferral |

**Conclusion: no architectural change to Phase B or Phase C is warranted.** The single most useful
thing this analysis produced is negative evidence — the design we are three phases into building is
the one a well-funded team converged on independently. Ship it as specified.

## 4. Worth adopting — ranked by value ÷ bloat

### A. Test-reach check script — ❌ **RETRACTED 2026-08-02. We already have this.**

> **This recommendation was wrong and is dead.** `tests/p1-cli/test-gate-coverage.test.ts` already
> enumerates every `tests/**/*.test.ts`, parses every `--test` script in `package.json`, and asserts
> `unreachable == []` — *"D-030: every test file is reached by an npm execution script"*. It is named
> in the `npm test` literal list, so the Stage 4 merge's 26→27 hand-edit is **already gated**: drop a
> path and the pure gate goes red. D-030 was hardened by five printed mutation controls after a
> rejected-then-corrected exact review.
>
> **How this error happened, because it matters more than the recommendation:** I reasoned from an
> external repo's solution to a problem I assumed we still had, instead of enumerating our own test
> suite. That is precisely the "pattern-match instead of enumerate" failure our doctrine names — and
> the D-025 incident I cited below as motivation is the very incident that *produced* D-030's fix.
> Reading our own defect register before recommending would have caught it.
>
> **Residual action, 5 minutes:** at Stage 4, prove the existing observer still discriminates —
> temporarily remove one path from the literal list, watch `npm test` go red, restore.

The original text follows, superseded:

~~This is the one I would actually spend critical-path time on.~~

Our worst documented trap is that `npm test` is a hand-maintained **literal list of 26 paths**, so a
new test file silently doesn't run. It has already cost us: six D-025 observers written into
`tests/support/` returned `grep -c "D-025:"` → **0**. They proved nothing.

QM solved it structurally. `npm test` uses a glob (`test/*.test.ts`), and
`scripts/run-root-test-shard.mjs --check` runs `verifyShards()` + `ensurePinnedTestsExist()` —
a script whose whole job is to fail when a test file is not reached by any runner.

We cannot switch to a glob safely mid-release (our suites are deliberately partitioned by DB
requirement). But we can copy the **check**: a `scripts/test-reach-check.mjs` that enumerates
`tests/**/*.test.ts`, resolves every path/glob in every `package.json` script, and exits non-zero on
any unreached file.

Why now rather than post-MVP: the server-branch integration merge deliberately edits that literal
list **26 → 27 paths**, by hand, during a three-way merge with a known `package.json` conflict. That
is precisely the operation the check exists to protect. Landing it first converts our most
error-prone remaining step into a gated one.

### B. Reviewer-depth scaling — MEDIUM value, zero code, ~15 min ✅ recommend

QM's review rule is our D-033 gate, refined:

> "Never self-review in the authoring context… a green CI run is not review either. What scales with
> risk is how deep the reviewer goes… Judge blast radius by checking callers, not by counting files…
> The reviewer, not the author, has the last word on depth."

Our gate is currently **flat**: both Grok and Gemini on every SHA-changing lane. That is expensive,
and it is brittle — Grok is credit-exhausted, which already forced an operator substitution. Making
depth scale with measured blast radius (callers, not file count) would let us spend the inversion
budget where it matters: auth/credentials, migrations, concurrency and retry logic. That is exactly
where our remaining work sits.

This is doctrine text in `AGENTS.md`, not code, and it fits our existing "reduce safeguards where
they only add ceremony" principle.

### C. "Durable by default" — MEDIUM value, validates existing practice, ~5 min ✅ recommend

QM has an explicit standing rule that in-memory `Map`s and ring buffers are per-instance and wiped
by every deploy, so anything read back later must be in Postgres. Our edge functions are serverless
and have the same hazard with less warning. One line in `AGENTS.md`; we mostly do this already.

### D. `resetSession` on host switch — SMALL, ~15 min ⚠️ check only

QM's `harness-router` resets the **prior** adapter when a session changes harness mid-flight. Our
`ListenerModel` has no teardown method at all. Most likely host-switching is unreachable in our
design (one host per listener process), in which case the correct action is **nothing**. Worth one
explicit check during Runtime C rather than an assumption.

### E. Shadow deliveries — MEDIUM value, real bloat ❌ defer to post-0.1.5

QM can `enqueue({shadow: true})` — the row is written and inspectable via `listShadow()` but never
sent. A production dry-run for the delivery path, which is genuinely attractive for our rollout.

But it adds a column and a branch to the delivery path we are about to freeze and deploy. Adding it
now would restart exact review on Phase B/C. **Backlog it.**

### F. Tape / replay determinism — HIGH engineering value, HIGH cost ❌ defer

`tapeMode: "shadow" | "serve"` plus `replay.ts`, `tape-fold.ts`, and `mock-harness.ts` let QM record
real LLM interactions and replay them deterministically. This is the principled answer to testing a
nondeterministic harness, and it is better than our hand-written fakes.

It is also a large build. Revisit when we add host adapter #3 — that is the point where the fake
maintenance cost exceeds the build cost.

## 5. Explicitly reject

- **The zero-comments rule.** QM mandates *"Never leave comments in the repo… put rationale in commit
  messages or PR descriptions."* This directly contradicts our style guide, and we should keep ours.
  Their agents work through PRs; ours read files in a **shared checkout across four model families**,
  frequently on someone else's branch. Our `§2.2` spec citations and our *"keep the superseded line,
  marked dead"* correction doctrine are load-bearing precisely because they live in the file where
  the next agent will read them. A correction in a commit message is our documented failure mode.

- **Adopting CI right now.** QM leans on CI as the full gate and verifies only affected tests
  locally. We have no CI and deploys are manual by design. Building CI is genuinely worth doing —
  but not as an unplanned change to the gating mechanism during a release freeze. **Post-0.1.5, high
  value.**

- **Growing our adapter interface.** QM's `HarnessTurnInput` carries ~40 fields including tape mode,
  security screens, approval gates, and progress callbacks. Our `ListenerModel` is **one method**:
  `prompt(signal, mode, prompt, attempt)`. The smallness is a feature — it is why a second adapter
  was cheap. Do not grow it toward theirs.

- **Private-fork / `deploy/layers/<org>/` model.** Solves a distribution problem we do not have.

## 6. Application to the roadmap

Net effect on the critical path: **+~1.5 h, all of it protective. No item is invalidated, no
architecture changes, no lane is added or removed.**

| Action | Slots in | Cost |
|---|---|---|
| ~~Test-reach check script~~ **RETRACTED — already exists (D-030)** | ~~before server merge~~ → 5-min discrimination control at Stage 4 | ~~1 h~~ 5 min |
| ~~Reviewer-depth doctrine → `AGENTS.md`~~ **DEFERRED post-0.1.5** — it licenses *shallower* review at the moment the flat gate is the protection, and it is inconsistent to defer CI on freeze-risk grounds while editing the review rule mid-freeze | post-0.1.5 | — |
| Durable-by-default line → `AGENTS.md` | Same commit as above | 5 min |
| `resetSession` reachability check | During Runtime C | 15 min |
| Shadow deliveries | Post-0.1.5 backlog | — |
| Tape/replay harness | Post-0.1.5, revisit at host adapter #3 | — |
| CI | Post-0.1.5 backlog, high value | — |

Everything else in the completion plan — Runtime A2 acceptance, Server Phase B audit, Phase C,
server integration, Runtime C/D, version freeze, full gate, land, staged deploy, production QA,
cross-owner canary, evidence, cleanup — **stands unchanged**.

## 7. Incidental finding (unrelated to QM)

The dossier repeatedly names the adapter boundary `ListenerHostAdapter`
(`EXECUTION-ORDERS.md` Lane A2). **No such symbol exists in the tree.** The real boundary is
`ListenerModel` at `src/listener/types.ts:71`. Anyone grepping the dossier's name gets a confident
zero — the exact failure mode our own doctrine warns about. The dossier should be corrected in place.

## 8. What this analysis does NOT establish

- **I did not run QM.** No claim about whether it works, its performance, or its reliability.
- I read roughly **10 of 52** `src/` modules. I did not audit their security posture, sandbox
  isolation, ACL model, Slack plugin, or admin governance.
- Star/fork counts are a 2026-08-02 snapshot on a 4-day-old repo; I did not assess adoption trend,
  and early YC-launch numbers are not durable evidence of traction.
- I did not benchmark their delivery path against ours — the comparison above is design-level.
- **No code lift is proposed.** Every recommendation is pattern-level, so QM's MIT attribution
  requirement is not triggered. If we ever copy code verbatim, attribution becomes mandatory.
