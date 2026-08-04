# /goal — D-040: stop the listener bricking, and fix the four confirmed companions

> **Superseded in part by D-044, 2026-08-04:** do not execute this contract's cross-owner sandbox or
> tool-kill-switch requirements. Every sender relation now uses the operator's worker and cwd with
> provenance in the prompt. The other historical D-040 requirements remain recorded as shipped work.

Branch: **`fix/v015-d040`**, cut from the frozen release SHA `175f894`.

This is a **release-blocking fix set**. v0.1.5 cannot ship without it. Every defect below was found by
an independent Claude Opus 5 review arm and then **independently re-verified by the Lead against the
frozen tree** — the line references in this document resolve, and you should expect them to.

Full write-up: `docs/org/DEFECT-REGISTER.md` D-040. Read it before you start.

## The situation in one paragraph

A listener can reach a state where its journal holds an `active` claim whose lease has expired, and
**every subsequent start dies fatally** — `listen start` prints success, then the runtime stops. It is
permanent: nothing clears the state. There are **two independent routes in**, and the repair code for
the state already exists but is unreachable.

---

## Fix 1 — C-1 · CRITICAL · the stale-lease repair is unreachable in the only mode we ship

**Verified chain:** the cancel path never calls `clearActive` (last call in the file is `runtime.ts:997`;
cancel handlers begin at `:1028`, and the `finally` at `:1145` only cancels/closes the model) → the
journal restores `active` verbatim including the instance id → the runtime replays the stored
`claimCommandId` → idempotency returns the **stored ledger row** with its original, now-past
`leased_until` → `checkedLiveLease` (`delivery.ts:400`) rejects it → `DeliveryProtocolError` is neither
retryable (`runtime.ts:204-208`) nor credential loss (`:198-201`) → `reason: "fatal"`.

**The repair exists.** `runtime.ts:766` gates it `if (deliveryMode === "cursor_fallback" && recovery
!== null)`. And `runtime.ts:367` returns `durable_claim` whenever the server advertises both
capabilities — which every v0.1.5 server does — so the block **can never run in production**.

**What to build:** make recovery from a stale `leased` claim reachable in `durable_claim` mode. Handle
both shapes: a terminal effect exists for the claim (ACK it, then clear), and no terminal effect
exists (clear and re-claim cleanly). Do not simply delete the mode check without thinking about what
the durable path needs — the cursor-fallback body may not be correct as-is for durable mode.

**Causal control required:** a test that drives a listener to a persisted `leased` claim with an
expired lease, restarts it, and asserts it **recovers and continues**. It must fail with a named
assertion against the current code. State the red output in your report.

---

## Fix 2 — MAJOR-3 · effectively CRITICAL · an ordinary error is a second route into the same brick

**This is likely the more common trigger, and it needs no stop and no 15-minute wait.**

`runtime.ts:283` throws `"listener terminal effect has an unknown failure classification"` when the
code matches neither `/prompt|acp|child|host|session/i`, nor `/post|http_|transport|reply_body/i`, nor
the three literals `model_refusal` / `model_cancelled` / `blank_reply`.

`engine.ts:179-183` derives that code as **`error.name.toLowerCase()`**. So a plain `Error` produces
`"error"` and a `TypeError` produces `"typeerror"` — **neither matches anything.** The resulting throw
is itself a plain `Error`, so it is not retryable and not credential loss: `reason: "fatal"`, journal
left at `leased`, and the listener is now bricked exactly as in Fix 1.

**What to build:** classification failure must never be fatal. An unrecognised `failureCode` should
map to a safe terminal outcome the server accepts (`local_effect_failed` is the natural fit) so the
runtime can ACK, clear the journal, and carry on. **A listener must not die because it could not name
an error.**

**Causal control required:** drive a terminal effect whose `failureCode` is `"error"`, assert the
runtime ACKs and survives. Must fail red first.

---

## Fix 3 — MAJOR-4 · a valid credential is reported as revoked

`runtime.ts:608-613`'s `staleUnavailable` escape requires `startupAckPending && active.ack.commandId
=== startupAckCommandId` — the ACK must have been pending **at process start**. The identical
condition arising **mid-run** misses the escape and falls through to `isDeliveryCredentialLoss`
(`:198-201`), which is true for **any** 403. The runtime stops with `reason: "credential"` and the
supervisor records `credential_stopped`, telling the operator to re-authenticate a credential that is
fine.

**What to build:** recognise the stale-lease 403 (`delivery_unavailable` with an expired
`leasedUntil`) wherever it occurs, not only when it was pending at startup. Keep the credential path
intact for genuine 401/403 — do not widen this into swallowing real auth failures.

**Causal control required:** a mid-run stale 403 must not produce `reason: "credential"`.

---

## Fix 4 — MAJOR-1 · the OpenCode worker runs its whole life with a deleted working directory

`opencode-model.ts:450` mkdtemps `canaryCwd`; `:465` opens the session with `cwd: canaryCwd`, which
`host/opencode.ts` passes to `spawn` as the **OS process cwd**; `:511` calls `openWorkCwd`, but
`host/session.ts:296-303` only assigns `this.cwd` and re-issues `newSession()` — **it does not respawn
and does not chdir**; then the `finally` at `:536-538` deletes the directory **on the success path**.

**What to build:** the canary directory must outlive the worker that is running inside it — delete it
when the worker handle closes, not when `ensureWorker` returns. Do not leak it on the failure paths.

**Causal control required:** assert the worker's cwd still exists after `ensureWorker` returns, and
that it is removed once the handle closes.

---

## Fix 5 — MAJOR-2 · OpenCode cross-owner isolation has one mechanism where Grok has three

`host/grok.ts:187-200` builds cross-owner env with `GROK_MEMORY=0`, `GROK_SUBAGENTS=0`,
`GROK_LSP_TOOLS=0`, `GROK_WRITE_FILE=0`, `GROK_WEB_FETCH=0`, plus `GROK_SANDBOX`.
`buildOpenCodeChildEnv` (`host/opencode.ts:479`) sets **no equivalent**, leaving the ACP forced-ask
path as the only thing standing between a cross-owner agent and the operator's filesystem.

This is defence-in-depth, **not a demonstrated leak** — the forced-ask map does enumerate every tool
plus `*` and fails closed on anything that is not literally `"ask"`. Fix it anyway: one mechanism is
not isolation, it is a single point of failure.

**What to build:** cross-owner OpenCode children get the equivalent tool restrictions, using whatever
env or config surface OpenCode 1.18.10 actually honours. **If OpenCode exposes no such surface, say
so and stop** — do not invent variables that do nothing, which would be worse than the current state
because it would *look* defended.

**Causal control required:** assert the cross-owner child env carries the restrictions and the
same-owner one does not. If Fix 5 proves impossible, the control is a documented finding instead.

---

## Fix 6 — m-2 · a comment that contradicts the code four lines below it

`read/index.ts:341-344` says *"Do NOT filter author.revoked_at…"*; `:371` is
`AND author.revoked_at IS NULL`. The **code is right** and matches the command path
(`durable-delivery.ts:287`); the comment is wrong. Fix the comment. Zero risk, and in this repo a
comment asserting the opposite of its code is exactly how a later reader "fixes" working behaviour.

---

## Explicitly deferred to 0.1.6 — do NOT fix these here

- **m-1** — `durable-delivery.ts:424` returns the caller's `sender_owner_relation` and discards the
  computed one. **Latent, not live**: `owner_user_id` is never updated anywhere, so no ownership
  transfer exists to exploit it. Touching the authority path during a release fix is worse than the
  latent risk.
- **m-3** — `delivery_retention_days` is floored at `GREATEST(30, …)` so lower values are silently
  inert. Fixing it needs a **new migration**, and a migration in a release hotfix multiplies the
  re-gate surface.

Both stay open in the register. Do not close them.

---

## Scope

**Expected files:** `src/listener/runtime.ts`, `src/listener/engine.ts`,
`src/listener/opencode-model.ts`, `src/host/opencode.ts`, `supabase/functions/read/index.ts`
(comment only), plus tests.

**Do not touch:** any migration, `supabase/functions/command/durable-delivery.ts`, the generated
`_shared/protocol.js`, `package.json` version, or anything under `site/`.

## The gate

Baseline at `175f894`, measured: **`npm test` → 376/376**, `test:p1-cli` → 143/143,
`test:p1-local` → 4/4, `test:p1-server` → 69/69, site → 113/113, `npm run build`,
`npm run check:tests`, `npm run check:edge` all exit 0.

**Acceptance: 376 → N where N > 376**, with every new control demonstrated red first. Report the red
output for each. A control that has never failed proves nothing — and note that this entire defect set
sat under 376 green tests and 22 causal controls without being noticed, which is precisely why
"I added a test and it passes" is not acceptance here.

**Known flake:** `test:p1-server` fails roughly 1 run in 5 with `SocketError: other side closed`. It is
recorded in `docs/evidence/2026-08-02-v015-execution/stage7-full-gate.md` and is **not yours**. If you
hit it, re-run; if you see it more than twice in five runs, say so — that would be new information.

## Reporting

Per fix: what you changed, the causal control, its red output, and its green output. Then, plainly,
**what you did not establish** — especially for Fix 5, where "OpenCode has no such surface" is a
legitimate and valuable outcome.

You own this branch. Do not push. Do not touch `175f894` or `main`.
