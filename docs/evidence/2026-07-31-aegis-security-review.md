# Adversarial security review — OpenCode ACP adapter + durable signal delivery

Reviewer: AegisClaude (claude family). Date: 2026-07-31. Read-only; no edits, commits, pushes,
deploys, or database mutations were made.

## Targets, resolved before trusting them

- Adapter: commit `030303125bb8deab5269096199c3617152e79fbb` in
  `/Users/yulanbot/.swarm/wt/cloud-swarm-source/Slate--opencode-acp-adapter`
  (branch `swarm/Slate/opencode-acp-adapter`, HEAD == target commit, parent `d8bd531`,
  gitdir `/Users/yulanbot/Developer/Ridge.io/cloud-swarm-source/.git`, remote `Ridge-io/cloud-swarm`).
  14 files, +1466/-29.
- Spec: `docs/design/2026-07-31-DURABLE-SIGNAL-DELIVERY.md` (335 lines, **untracked `??`**) in
  `/Users/yulanbot/Developer/Ridge.io/swarm-worktrees/lead7-durable-delivery`
  (branch `lead7/durable-delivery-ack`).

Treated as one combined decision set, per AGENTS.md "review the decision set, not the items".

---

## BLOCKERS

### B1 — The product prints a security assurance that measurement disproves

`src/cli.ts` `hostNote` tells the user, on every `listen start`:

> "The same-owner OpenCode worker uses a private 0700 home with auth-only copy and forced-ask tool
> config; **ambient project allow lists do not apply.**"

The measured fact says the opposite: a project `opencode.json` in cwd that sets wildcard/bash/read/
write/edit `allow` **does** override the generated config. The same false claim appears three more
times in code:

- `src/host/opencode.ts` — "Generated opencode.json that ambient project allow cannot soften"
- `src/host/bounds.ts` — "The wildcard covers future tools so ambient project allow cannot bypass ACP"
- `src/cli.ts` `listenerStatusJson.host_limits` — was a concrete Grok-specific warning, now reads
  "...outside CommonSwarm's ACP permission boundary **unless the adapter uses a private home**",
  which implies private home ⇒ no ambient escape. That is the same false implication, and it
  *weakened* an existing honest warning.

This is the exact failure class AGENTS.md documents in D-023: copy that asserts a security/deployment
state, lives in git, and is read by someone downstream as fact.

Required: correct all four strings to state that a project-level `opencode.json` in cwd can override
the generated permission config, keeping the superseded lines marked dead per doctrine. This must
land regardless of what happens to the canary.

### B2 — The canary validates a permission posture that is not the one used afterwards

`src/listener/opencode-model.ts:129-132`:

```ts
const permissionCallback = (request) =>
  this.workerCanary || this.permissionMode === "deny"
    ? defaultPermissionCallback(request)   // hard deny
    : allowOnceOrDeny(request);            // auto-allow_once
```

`workerCanary` is `true` for the whole canary and set `false` immediately after it passes
(`:144-145`). So the canary proves "deny works while deny is hardcoded", then the session flips to
auto-allow for `--permissions allow`. The steady-state boundary is never exercised by the gate that
authorises it.

Required: run the canary under the *steady-state* callback, or add a second arm that does, or assert
at ready-time that the callback in force is the one the canary measured.

### B3 — The canary is forgeable and has a false-pass channel

`src/host/session.ts:449-462` sets `sawDeniedToolResult` from two regexes:

```ts
/den(y|ied)|reject|blocked|cancelled|error/i.test(status)         // (a)
/permission denied|rejected|not allowed|deny/i.test(JSON.stringify(update.content))  // (b)
```

- (a) matches `error` and `cancelled` — **ordinary tool failure is indistinguishable from denial.**
  Any tool that runs and fails satisfies this half.
- (b) matches over provider- and content-derived text. In a hostile repo, a file the agent reads and
  echoes back can contain "not allowed" and satisfy this half directly.
- `sawPermissionRequest` (`:485`) is set by **any one** permission request from **any** tool. It is
  not tied to the dangerous set.

Composite bypass: a hostile project `opencode.json` allows `bash` while leaving one harmless tool at
`ask`. The harmless tool asks (half one), any tool output containing "not allowed" or any tool
erroring (half two) → **canary PASSES with `bash` unrestricted.**

The committed positive test is itself the weak path: `tests/host-acp-opencode.test.ts:293-300` uses
`status: "failed"` (which matches neither `den(y|ied)` nor the others) and passes via content text
"permission denied by host" — i.e. the only demonstrated positive path is channel (b).

The canary is the sole compensating control for B1, and it does not measure what B1 breaks.

Required: derive denial from **our own** recorded decision — we know when `defaultPermissionCallback`
returned reject/cancel and for which `toolCallId`; correlate by `toolCallId` instead of regexing
provider text. Assert per-tool over the dangerous set (`bash`, `write`, `edit`, `execute`), not "any
one tool asked once".

### B4 — The canary is not side-effect-free and runs in the user's real repo

`OpenCodeListenerModel.start()` → `ensureWorker()` opens with `cwd: this.options.cwd` — the real
repository — and the probe text instructs the agent to *attempt a tool call*. Under exactly the
compromised configuration the canary exists to detect, that tool is **allowed and executes** before
the canary concludes.

The measured result (`sawPermissionRequest=false, sawDeniedToolResult=false`) is consistent with two
different worlds: "no tool was attempted" and "a tool ran unrestricted and produced no permission
request". **The instrumentation cannot distinguish them**, so that measurement does not establish
that nothing executed in the hostile-config run.

Required: run the worker canary in a fresh empty temp cwd first (`promptIsolated` already builds
exactly this), and only then bind the repo cwd; and record enough observation (tool_call starts,
statuses, ids) to distinguish "nothing attempted" from "ran unrestricted".

---

## HIGH

### H1 — The version pin is on the name, not the resolved artifact

`resolveOpenCodeExecutable` returns bare names **unresolved**; PATH resolution then happens twice,
independently:

- `assertOpenCodeMeasuredVersion` → `execFile(..., { env: sanitizeChildEnv(process.env) })` — always
  `process.env`.
- `spawn(executable, args, { env })` where `env = buildOpenCodeChildEnv(options.env ?? process.env, home)`.

`PATH` is allowlisted by `sanitizeChildEnv`. `OpenCodeListenerModelOptions.env` is plumbed from the
CLI/detach path. When `options.env` differs from `process.env`, **the version gate checks one binary
and the session spawns another** — plus a plain TOCTOU window even when they match. This is a
"measure the artifact, not its name" violation in the one place the pin is supposed to be load-bearing.

Required: resolve to an absolute `realpath` once, version-check that exact path, spawn that exact
path, and use the same env for both calls.

### H2 — `close()` has no failure path and no escalation

`src/host/opencode.ts` close:

```ts
const close = async () => {
  await session.close();                 // unguarded — a throw here skips everything below
  if (!child.killed) child.kill("SIGTERM");
  if (createdHome || disposeHomeOnClose) await rm(home, {recursive:true, force:true}).catch(()=>undefined);
};
```

If `session.close()` throws, the child is never signalled and the credential-bearing home is never
removed. There is no SIGKILL escalation after SIGTERM and no wait for exit, so a child that ignores
SIGTERM outlives the listener holding an open descriptor on the copied `auth.json`.

Required: `try/finally`, timed SIGKILL escalation, await child exit before `rm`.

### H3 — Plaintext credential copies survive abnormal exit with no reaper

`prepareOpenCodeIsolatedHome` copies the real `auth.json` verbatim to
`$TMPDIR/cswarm-opencode-home-*/xdg-data/opencode/auth.json`. Removal happens only on an explicit
`close()`, and **every** `rm` is `.catch(() => undefined)`. On SIGKILL, panic, or detached-parent
death nothing cleans up. Note the measured path hits this: when `ensureWorker`'s canary throws, the
worker home was created with `disposeHomeOnClose: false`, so the copy stays on disk.

macOS per-user `$TMPDIR` limits cross-user exposure but not backup capture, forensic recovery, or a
later local compromise.

Required: process-exit/signal cleanup, a startup sweep of stale `cswarm-opencode-home-*`, and
consider not copying at all (read-only bind of the real auth, or a short-lived credential).

### H4 — Concurrent isolated turns orphan a live child

`OpenCodeListenerModel.promptIsolated` writes `this.isolated = handle` (a single slot) **before** the
canary. Two concurrent cross-owner turns: the second overwrites the slot; `cancel()` and `close()`
then reach only the newest, and `if (this.isolated === handle)` in the loser's `finally` leaves it
unreachable from the model until its own cleanup runs. `close()` does not await in-flight isolated
turns at all.

Required: track live handles in a `Set`; have `close()` await them.

### H5 — (spec) Lease expiry terminally acks in-flight work, breaking at-least-once

Line 152: claim first marks this recipient's "expired, unacked rows" as
`acked_at=now, ack_outcome='expired'`. Line 203: a later ack with a different outcome is "a conflict,
not a rewrite". So a turn that overruns the 15-minute lease — which line 331 admits is **not
load-tested** against provider tail latency, against a budget of "three 120-second prompt attempts
plus five bounded post attempts and backoff" — has its row terminally expired by the next claim, its
own `replied` ack rejected, and **the row never redelivers**. The audit then records `expired` for a
delivery that in fact replied. This contradicts Acceptance line 319 ("eventually receives every live
unacked direct signal").

Compounding: `ack_outcome='expired'` is used for **both** signal-TTL expiry (line 234) and lease
expiry (line 152). After the fact the two are indistinguishable, so this failure is invisible in the
data.

Required: lease expiry must **reset** the row (clear lease fields, leave `acked_at` NULL) rather than
ack it; reserve `expired` for signal TTL; add separate accounting for lease expiry. Note this changes
the CHECK at lines 84-88, which currently exists specifically to permit acking a never-delivered row.

### H6 — (spec) Claim replay puts signal bodies in the idempotency ledger

Line 161: "A retry with the same command ID replays the exact stored batch." The batch (lines 170-179)
contains full signal bodies. Invariant 9 (line 55) enumerates "delivery metadata logs, audit detail,
status, or error fields" — the idempotency ledger is not among them. Line 289 asks for
"audit/idempotency responses contain no bearer **and** audit detail contains no body" — it covers
bearer for idempotency and body for audit, and never body for idempotency. That asymmetry is the gap.

Required: either store only delivery identifiers and re-read bodies at replay under the same auth, or
explicitly bring the ledger under invariant 9 with stated grants, RLS, and retention.

### H7 — (spec) The public read edge transiently holds `swarm_command`

Lines 249-251: the count is computed "immediately after agent authentication while the transaction
still holds `swarm_command`, before switching to the restricted `swarm_read` role". That places the
full-authority role inside the public read path, directly weakening invariant 4 ("claim and
acknowledgement ... never through the public read edge"). Any early-return, error path, or reachable
`RESET ROLE` before the switch executes with command authority.

Required: expose the count through a `SECURITY DEFINER` function with a pinned `search_path`,
executable by `swarm_read`, so the read edge never assumes `swarm_command` at all.

### H8 — (spec) Rollback is not the mirror of the deploy ordering

Line 270: "Rollback disables claim mode/read capability first." A client holding a live lease can then
no longer ack; the row expires and (per H5) terminates; and the cursor fallback will not re-deliver a
signal whose timestamp the listener's cursor has already passed. The forward deploy race was closed
deliberately and well (lines 118-126); the reverse race was not analysed.

Required: rollback disables **claim** first while **ack stays live** until leases drain, then disables
ack; and define cursor-rewind behaviour for rows that terminated unacked.

---

## MEDIUM

- **M1 — RLS on `signal_deliveries` is decorative as specified.** An all-rows policy for
  `swarm_command` plus grants only to `swarm_command` means the grant matrix is the real control. If
  the table is owned by `swarm_admin` (repo precedent), the owner bypasses RLS absent
  `FORCE ROW LEVEL SECURITY` — a hazard this repo already documents at
  `supabase/migrations/20260727000001_capability_urls.sql:213`. State the owner, add FORCE, or say
  plainly that RLS is not the control here.
- **M2 — Security-invoker trigger couples signal inserts to delivery-table grants.** Verified today
  only `swarm_command` holds INSERT on `swarm.signals` (`20260724000003_signals.sql:41`), so the
  design works as written. But any future role granted signal INSERT without delivery INSERT turns a
  delivery permission gap into an **outage of the append-only signal path**. Add a migration-time
  assertion enumerating roles with INSERT on `swarm.signals` and requiring matching grants.
- **M3 — `lease_id` is a capability, not "metadata".** Line 157 calls it "opaque lease metadata" and
  line 107 says `leased_by` is "not a bearer or authorization credential", yet line 198 makes both
  part of the ack authorization tuple. Classify `lease_id` as a capability token with explicit
  handling rules. (Blast radius is intra-principal, hence MEDIUM not HIGH; line 244 does already keep
  it out of status/logs.)
- **M4 — No `attempt_count` ceiling, no dead-letter, no retention, no DELETE grant (line 105).** A
  signal that reliably crashes the consumer redelivers forever after each lease expiry, each attempt
  costing a model turn, and the table only grows. That is a cheap intra-workspace abuse vector. Add a
  max-attempts → `failed_terminal` transition and a reviewed retention plan.
- **M5 — `allowMissingAuth: this.options.open !== undefined`** (`opencode-model.ts:118,167`) uses a
  dependency-injection seam as a proxy for "this is a test", silently disabling the not-signed-in
  guard for any non-test caller that injects `open`. Make it an explicit option.
- **M6 — detach and CLI disagree on executable policy.** `buildListenerChildArgs` coerces
  `spec.executable` into `--opencode-executable` when provider is opencode, while `runListenStart`
  *rejects* `--grok-executable` with `--provider opencode`. Two layers, opposite policies; only the
  version pin catches the resulting mismatch. Make detach reject it too.
- **M7 — `session.load()` falls back to `session/new` while `promptsEnabled` stays true**, so a
  brand-new session that never passed a canary accepts real prompts. Reset and re-canary on fallback.
- **M8 — Unbounded `JSON.stringify(update.content)`** per `tool_call_update` over provider-controlled
  content (memory/CPU on hostile output). Bound it — and B3's fix removes the need for it entirely.

## LOW

- **L1 — Dead error-code branches.** `cli.ts:2589` and `cli.ts:2613` handle `acp_version_error` and
  `acp_permission_canary_error`. Enumerated across `src/` and `tests/`: exactly 2 occurrences, both
  consumers, **zero producers**. The real codes are `version_refused` and `permission_canary_failed`
  (`src/host/types.ts:138,146`). Functionally harmless — the real codes are handled on the same lines
  — but it is a guessed mapping presented as coverage.
- **L2 — Trailing whitespace** at `docs/evidence/2026-07-31-opencode-acp-adapter.md:3,4,5`;
  `git diff --check` exits 2. These are Markdown hard-line-breaks — keep deliberately and note, or
  convert.
- **L3 — `sanitizeChildEnv`'s "Ensure PATH exists" block** (`src/host/env.ts`) is an empty `if` whose
  body is only a comment. It advertises behaviour it does not implement.
- **L4 — stderr is drained and never surfaced** (`child.stderr.on("data", () => undefined)`). Correct
  for credential hygiene, but it is why the measured canary failure has no provider-side explanation.
  Consider a bounded, redacted, opt-in ring buffer.
- **L5 — `src/host/permission.ts` boundary docstring** still names only "ambient Grok hooks" as
  outside the boundary. For OpenCode the equivalent escape is project config. Add it.

---

## Credit — do not "simplify" these away

- **Gate reachability was handled correctly.** Both new test files are NAMED in the `package.json`
  `test` literal list — the AGENTS.md trap that has bitten this repo before was avoided. Verified by
  running them on the commit: **9/9 pass**.
- **The spec's composite FKs are already satisfiable** — unique indexes on
  `swarm.signals (id, workspace_id)` and `swarm.agent_principals (principal_id, workspace_id)` exist
  (`20260730000002_agent_signal_receive.sql:8,15`). Checked rather than assumed; **not** a migration
  blocker.
- **The cross-owner/isolated path uses a fresh empty temp cwd**, which structurally immunizes it from
  the project-config override. The override risk is concentrated **entirely on the same-owner worker
  path**, where cwd is the real repository. That asymmetry is real and worth preserving explicitly.
- `CHECK (last_error_code ~ '^[a-z][a-z0-9_]{0,63}$')` prevents body leakage into the error column.
- Effect-persist-before-ack ordering **with a reversed-order mutation control** (spec line 296).
- `unknown` sender relation takes the cross-owner isolated/tool-denied path — fail-closed, and given
  the point above, genuinely the safer path.
- Credential never on argv; env allowlist plus deny-regex with a causal control test.
- Creating the trigger before backfill to close the forward deploy race (lines 118-126).

---

## What I did NOT establish

- **I did not run OpenCode 1.18.10.** Every test in this commit is fake-child, so **no test here can
  observe real config precedence, real ACP framing, or real permission behaviour.** The adapter's
  central security property is untested by construction, and 9/9 green says nothing about it.
- I did not reproduce the project-config override myself. I take the measured fact as given from
  Lead7 and did not re-verify it against a live provider.
- I did not determine **why** the canary failed in the measured run. Per B4 the code cannot
  distinguish "no tool attempted" from "tool ran unrestricted", so neither can I from the artifact.
- No database was touched: no migration applied, no `p1-server`/`p1-local` run, no production query.
  The spec's zero-row claims about `swarm.inbox_deliveries` were re-read, not re-run.
- Claim/ack are unimplemented, so H5-H8 and M1-M4 are spec review only; there is no code to review.
- I did not review Grok-adapter parity beyond the shared `session.ts` / `permission.ts` / `env.ts`
  paths — note B3, H2, M7 and M8 live in **shared** code and therefore likely affect Grok too, which
  I did not confirm.
- I did not review `src/listener/runtime.ts`, `engine.ts`, `file-store.ts`, or the edge functions in
  depth. `check:edge` was not run; no edge function changed in this commit.
- I did not audit `site/` or `install.sh`.
- Per AGENTS.md D-033 this is a Claude-family read; it does **not** substitute for the required
  Grok + Gemini pair on this SHA.

---

## GO / NO-GO

**Adapter integration: NO-GO as it stands.** Conditional GO after B1-B4 and H1-H4.

B3 and B4 are the crux: the canary is the only control standing between a hostile repository and an
unrestricted `bash`, and it is simultaneously forgeable (B3) and self-triggering in the exact
configuration it is meant to detect (B4). B1 must land regardless of the canary outcome — shipping a
false security assurance in user-facing output is the precise failure documented as D-023.

**Durable delivery: GO to begin implementation, after H5-H8 and M1-M4 are fixed IN THE SPEC first.**

The spec is unusually strong — invariants, causal negative controls, and test-gate reachability are
already stated, which is more than most designs here start with. The defects are concentrated in four
places: lease-expiry semantics (H5), the idempotency body surface (H6), the read-edge role (H7), and
rollback symmetry (H8). All four are contract-level decisions, not implementation details — H5 alone
changes `ack_outcome`'s value set and the schema CHECK — so fixing them after code exists costs
strictly more. Do not apply the migration until H5 and H8 are settled.

Adapter fixes and spec fixes are independent and can proceed in parallel.
