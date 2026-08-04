# Stage 7b — two-arm review at full delta scope (`origin/main..175f894`)

D-036 requires an exact-review arm plus a cross-family inversion arm **on the exact SHA**. Prior lanes
each carried their own pair, but the inversion at *delta* scope had only covered `supabase/` — the gap
named at the end of `lead-exact-arm-records.md`. This closes it.

Delta: **155 commits, 138 files, 33,948 insertions**; 68 of those files are code (25,809 insertions),
the rest documentation and evidence.

## Arm availability — the gate nearly could not run

D-036 permits the inversion arm to be **Gemini via `agy`** or **Kimi K3 via Pi**, and records Grok as
credit-exhausted. Measured on this machine today:

| Arm | State |
|---|---|
| Kimi K3 via `pi` | **Unusable** — `No API key found for the selected model` |
| Grok | **Unusable** — D-036 already rules it out; a liveness probe errored before reaching the model |
| Gemini via `agy` | **Alive but initially refusing** |

`agy` answered a neutral control prompt with `ARM ALIVE`, so the arm was working; it declined the
*task*. Two successive security-framed prompts were refused categorically ("I cannot fulfill your
request to perform a vulnerability analysis or security code review"). A third framing — an ordinary
correctness and robustness code review of our own repository, which is what D-036 actually needs —
was accepted. It then failed once more on tool permissions in headless mode, and succeeded with tools
enabled.

**Worth recording because it nearly manufactured a blocked release:** three consecutive empty results
from a live arm looked like a hard blocker on our own gate. The distinguishing probe was the neutral
liveness prompt — without it, "no output" was indistinguishable from a dead arm, and the honest
conclusion would have been the wrong one.

The tools-enabled run was audited afterwards: the worktree was still at `175f894` with **0 modified
files**, so the reviewer read and did not write.

## Arm 1 — exact review (ClaudeCswarm, non-authoring)

Focused on the largest *new* authority surface in the delta, which no prior lane arm had reviewed at
delta scope: the `signal_deliveries` migration and its security-definer read path.

- **RLS is enabled *and* forced** on `swarm.signal_deliveries`. `FORCE` matters — without it the table
  owner bypasses the policies.
- **Policies are scoped to internal roles** (`swarm_admin_all`, `swarm_command_all`). Table grants go
  to `swarm_command`; **no table privilege is granted to `anon` or `authenticated`.**
- **`swarm.agent_delivery_read_context(bytea, uuid)` is `SECURITY DEFINER` with
  `SET search_path = swarm, pg_catalog`** — the pinned search path closes the classic definer
  hijack — and is `REVOKE ALL ... FROM PUBLIC` before an explicit `GRANT EXECUTE` to `swarm_read`
  alone.
- It keys on `t.token_hash = p_token_hash`, so it **reports facts about a token the caller must
  already hold**; it does not mint authority.
- **The cross-workspace question, followed through to the caller.** The function returns the
  principal's *own* `principal_workspace_id` rather than trusting the `p_workspace_id` argument, which
  means the enforcement must live in the callers. Both do it: `read/index.ts:284`
  (`body.workspace_id !== agent.principal_workspace_id`) and `command/index.ts:1810`
  (`auth.agent.principal_workspace_id !== workspaceId`). A token for workspace A cannot read
  workspace B.

## Arm 2 — cross-family inversion (Gemini via `agy`, `--effort high`)

Returned a substantive ~40 KB review with mechanism-level reasoning across six categories. **No
CRITICAL survived verification.** Its three most serious findings were each traced to the source and
each is a false positive:

**1. "`deadSession` is sticky, so `currentSession()` throws `SessionExpired` forever after sign-out."**
Refuted. `signOut()` sets `deadSession = false` (`commonswarm.ts:212`), and the QA-010 observer
(`dead-session.observer.test.ts:146-149`) asserts the dashboard *deliberately* catches `SessionExpired`
to render `showPanel("signed-out")` with the reason. The stickiness **is** the QA-010 fix: it is what
stops a dead session from being invisible. Repeated throwing is caught idempotently by a handler that
shows the same panel — not a loop. The arm described the mechanism accurately and missed the handler.

**2. "Floating promise in `delivery.ts` `post()` produces an `unhandledRejection` on timeout."**
Refuted. Every `catch` inside the `read` IIFE checks `signal.aborted || timedOut` and **returns
`"timeout"` instead of throwing** — four separate guards. The deadline timer sets `timedOut = true`
*before* calling `abort()`, so by the time `aborted` can win the race the guard is already true. After
a timeout the floating promise resolves; it cannot reject. The guards are deliberate, and
`DeliveryClientOptions` injects `clearTimeout` and an `AbortController` factory specifically so
teardown is causally tested (`tests/delivery-client.test.ts:289`).

**3. "Restart resets `nextClaimOrdinal` to 0 and wipes idempotency."** Refuted. `delivery-journal.ts:691`
derives the command id as `claimCommandId(current.listenerInstanceId, ordinal)` — **instance id plus
ordinal**. A restart that mints a fresh `listenerInstanceId` therefore produces non-colliding command
ids from ordinal 0 by construction. That is the startup-locked instance identity behaviour landed
deliberately in `82473de`, not a regression.

**A reliability signal about this arm, recorded for whoever reads it next:** its line references do
not resolve. It cited `delivery.ts:125-188` for a method that is type declarations at that range, and
`delivery-journal.ts:790-835` for a function that is lease/ACK code there. The *prose* identified real
code shapes; the *coordinates* were fabricated. Treat its file:line as a hint to search, never as a
citation — and note that a reviewer who spot-checked only the line numbers would have concluded the
findings were nonsense, while one who trusted them would have "fixed" working code.

## Verdict

**PASS.** Both arms ran on the exact SHA, both returned substantive content, and no finding survived
verification as a defect.

## What this review did NOT establish

- The inversion arm's findings were triaged in **severity order and the top three were verified in
  full**; the remaining lower-severity items were read but not each independently traced to source.
- Neither arm executed the code. This is static and diff-level review plus the separately-recorded
  Stage 7 suite run.
- Nothing here establishes deployment, production behaviour, real-load capacity, or the cross-owner
  canary.
- The `claim one-winner` causal-control domain remains blind, unchanged by this review.
