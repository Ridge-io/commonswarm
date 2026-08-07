# Resume here — CswarmLead, 2026-08-06

**Verify every SHA by hash, not by branch name.** Braced revisions only: `"${R}:src/..."`,
never `"$R:src/..."`.

## Refs as they actually are

```
main                     <see git>  v0.1.8 SHIPPED and verified on the public artifact
lead/d056-bounded-recovery 72f5f70 MERGED into main, both D-036 arms cleared
lead/logout-honest       3e44367   MERGED. Shipped as v0.1.8.
lead/logout-wedge        e16e1c8   SUPERSEDED -- predated 0.1.7, never merged. Do not use.
lead/hide-scrollbars     d271109   LANDED TO PRODUCTION (site)
lead/d059-pooler-raise   e67e73f   docs only, unreviewed
```

---

## SHIPPED SINCE THIS DOC WAS WRITTEN

**v0.1.7** — bounded refusal tolerance + codex provider + 13 correctness commits.
**v0.1.8** — the logout lane: the CLI no longer strands a user with an expired session, no
longer claims a sign-out the server refused, and a failed sign-out can now actually be retried
(the attempt had been consuming the stored token without persisting the replacement).

Both verified on the installed public artifact by sha256, and on the deployed pages with paired
present/absent controls — not on the deploy log. See `docs/release/0.1.7.md`,
`docs/release/0.1.8.md`, and `docs/evidence/2026-08-05-logout-wedge/BLOCKED.md`.

**What the second lane cost, because it is the useful part:** Plumb held five times and every
hold was correct. Three found claims that contradicted evidence already in this repo — a copy
test that *required* an overclaimed string, a cause split I could not establish committed inside
the fix for asserting causes I could not establish, and a "self-clears" justification whose
counterexample was in the test file I had written. AGENTS.md gained three rules from it.

## THE HEADLINE: the wake round trip is GREEN, measured

`docs/evidence/2026-08-06-agent-wake-round-trip.md`

Agent → cswarm → **production cloud** → recipient agent → **woken** → replies. Same user, same
machine, two agent principals.

| provider | result | artifact |
|---|---|---|
| **claude** | ✅ 9s | **shipped 0.1.6** (`sha256 dee33d32`) |
| **codex** | ✅ 11s | repo `main` — **absent from 0.1.6** |
| grok | canary fails | out of credits (operator) — out of scope |
| opencode | never ready | not scoped |

Both greens carry the same two controls: the reply reads back under the **human's** credential
(so it exists server-side, not just in the asker's process), and `listen status` reports
`lastSignalId` equal to that exact ask — which is what makes it a **wake** and not a delivery.

**`deliveryMode: cursor_fallback` observed at runtime in production.** That converts the
previous inference to fact: D-040/041/041a/042 are unreachable, because they need
`durable_claim` and deployed `read` v6 cannot advertise it. **A `read` deploy invalidates this
measurement.**

### What this means for the release

**A user on 0.1.6 today has exactly ONE working provider: claude.** grok is out of credits and
codex does not exist in the shipped binary (`codex-model.ts` is absent at the `v0.1.6` tag;
landed after, `0179c1c`). That materially raises the value of shipping 0.1.7.

### Both readings of "idle" hold — including the cold one

- **Resident listener, model asleep** → woken, replies in 9-11s.
- **Nothing running at all** → the ask times out with no reply (nobody home), the message
  persists in the cloud, and **starting the listener wakes the agent with it**: measured
  `lastSignalId` = the cold ask, reply bound by `in_reply_to` and carrying the nonce.

The intermediate timeout is the control that makes the cold result meaningful — it proves
nothing was listening when the ask was sent.

~~Superseded: "a recipient with no listener process is not woken; the message waits in the
inbox."~~ It waits AND wakes the agent on start. What is not established is any push to a
machine with nothing running — a process must start for the wake to land.

---

## ~~NEXT ACTION — unblock the red branch~~ DONE. v0.1.7 SHIPPED 2026-08-07.

`curl -fsSL https://commonswarm.com/install.sh | sh` now yields **cswarm 0.1.7**, sha256
`73ee5b11…`, matching the published asset byte-for-byte. Live `/download` carries 0.1.7 on
every surface with zero stale 0.1.6 strings. The wake round trip was re-measured **on the
downloaded binary** via **codex** — the provider that did not exist in 0.1.6.

See `docs/release/0.1.7.md` for what shipped and its stated limits.

### THE NEXT ACTION IS NOW THE LOGOUT LANE (see "Open" below)

~~Superseded, kept for history:~~

## ~~Unblock the red branch (~30 min)~~

`lead/logout-wedge` is `test:p1-cli` **156/2**. Not a logic defect: both failures spawn the real
CLI, which sleeps real backoff, so the 60s refusal budget exceeds their timeouts.

Fix: make the budget injectable from outside the process (env, e.g.
`CSWARM_REFUSAL_TOLERANCE_MS`), **read once at startup, never per-arm** (Verity). Wire it at the
`runInboxFollow` call site, `src/cli.ts:2460`. `src/cli.ts` never passes the option today —
that is the exact seam. Also raise the 30s `timeoutMs` in
`tests/p1-cli/follow-backoff-e2e.test.ts`, which now sits *below* the budget it exercises.

**A supervised host wants tolerance `0` in production** — that is the stronger justification and
keeps this from being test-only scaffolding.

Then: **split the lanes** (Plumb). `lead/logout-wedge` bundles the logout fix and bounded
recovery; the auth lane still has open blockers, so every D-056 correction drags unrelated auth
code through both review arms.

Also cherry-pick and **confirm** Plumb's non-author control —
`plumb/d056-adversarial-31829df @ 41c9be9` — which was RED against `31829df` and should now PASS
against the per-burst reset. Confirm it; do not trust this sentence.

---

## Open defects found by using the product

1. **D-050 reproduced TWICE today**, both providers. A clean `listen stop` reporting no error
   left orphaned adapter children (`claude-agent-sdk`, `codex-acp`). On a fleet doing this
   repeatedly, workers accumulate silently.
2. **3-project limit has no CLI escape** — `cswarm new` refuses a fourth: *"the CLI cannot
   archive one yet, so ask whoever operates this deployment."* A user who hits it is stuck. It
   also denied today's test its intended fresh-workspace isolation control.
3. **Revoking an already-revoked token reads as failure** — *"Token revocation was refused:
   token_revoked. The credential is unchanged."* Security outcome is right; the sentence tells
   an operator their revoke did not happen when the credential is exactly as they wanted.
4. **Agent credentials can strand mid-renewal.** Two on this machine are dead — one expired, one
   with `token: null` and an unfinished `pendingRenewal` from 31 July. An agent in that state
   cannot authenticate, so it is silently unreachable — no wake, ever. Not diagnosed; this
   machine's state is stale and it may be an artifact of old testing.

---

## Corrections to claims published in commit messages (which cannot be edited)

- **"The veto is not relaxed / it only blocks an IMMEDIATE retry"** — wrong. Ordinary retries
  were already delayed, so that distinguishes nothing. It is a **bounded override** of the veto.
- **"Delayed retry is the opposite of amplification"** — false. It is bounded, rate-limited
  amplification.
- **"Bounded recovery is load-bearing for the wake goal"** — I rationalised that.
  `runInboxFollow` is called only from `inbox --follow`; `listen` never touches it, 0.1.6 has no
  tolerance at all, and the listener has its own retry classifier. It is real 0.1.7 work for a
  **different** surface.
- **grok's canary failure called "a regression"** — overstated; never diagnosed, and
  out-of-credits explains it.

---

## Deferred deliberately (operator: "the bar is that it works")

`--local` habituation control; flag-registration coverage (a missing `BOOLEAN_FLAGS` entry
shipped `--local` unusable while green); emission of 3 of 4 terminal auth codes unverified
(safe direction — an entry that never appears never matches); Plumb's parent-token retry route;
site/README copy asserting session termination (`README:268-270`, `privacy.astro:234`,
`terms.astro:265`) — real, legal-surface, but a copy pass not an auth fix; transaction-mode
pooling; the CLI surface cut.

---

## Still owed to the operator

- **The `read` deploy vehicle is unnamed.** The freeze lift for the `EMAXCONNSESSION` classifier
  is not recorded in the register — no scope, no rollback, no statement of how the coupled
  D-040/41/42 changes stay disabled. Today's green depends on `read` staying at v6.
- **The dogfood fleet shares the production pool** — 8 seats on `ukezjcnxjvkpkeezxaew`.
- **No rollback/yank procedure** while `install.sh` serves `latest`.
- **`main` is not protected**; ruleset `swarm-1human-main` is disabled.

---

## Session hygiene note

Today I cleared orphaned adapter processes with a broad `pgrep | xargs kill` on a machine
running 8 agent seats. Verified afterwards that all 8 survived and nothing else died — but that
was luck, not care. On this box, kill by explicit PID list.
