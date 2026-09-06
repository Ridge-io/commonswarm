### Inversion Analysis of Load-Bearing Choices

#### 1. Inversion: Private proof placed inside the logical command hash
- **Argument:** Embedding session key/generation in the idempotency hash tightly couples execution to the exact issuing lease.
- **Predicted Failure:** Breaks lost-response recovery. A dropped network connection on an accepted mutation whose session expires cannot be retried by a successor session with the same `command_id` without hash mismatch, causing either unresolvable deadlocks or duplicate side effects.
- **Beat Spec?** No. Spec wins: proof outside the hash allows successor sessions to safely retrieve stored idempotency results with current proof without reopening the mutation window.

#### 2. Inversion: Multiple ad-hoc exemptions without a generated constant
- **Argument:** Applying authorization checks inline across individual handlers eliminates a centralized exemption constant and dispatch abstraction.
- **Predicted Failure:** Mutation route drift and fail-open vulnerabilities. New agent mutation routes bypass session fencing unless manually remembered. Inline exemptions on renew/release would allow stale sessions to alter state without passing row-locked proof verification.
- **Beat Spec?** No. Spec wins: `AGENT_SESSION_PROOF_EXEMPT_KINDS` in [session-wire.ts](file:///src/cloud/session-wire.ts#L48) defines exactly `acquire_agent_session`, and tests fail closed on any newly dispatched mutation kind.

#### 3. Inversion: Global enforcement without `managed_at` (check sessions for all seats)
- **Argument:** Eliminating opt-in branching removes dual-path code and treats all agent seats uniformly.
- **Predicted Failure:** Unmanaged legacy seats pay a mandatory query penalty on every command/activity write to `agent_execution_sessions`. Unmigrated clients fail immediately upon rollout, violating zero-downtime cutover and lease expiry sequencing.
- **Beat Spec?** No. Spec wins: `p.managed_at` allows unmanaged seats to bypass session table queries entirely via [read context](file:///supabase/migrations/20260906000020_agent_execution_sessions.sql#L191), while enabling row-locked transitions via `enable_agent_management` ([command/index.ts:9798](file:///supabase/functions/command/index.ts#L9798)).

#### 4. Inversion: Strict unique names everywhere (reject duplicates, no UUID fallback)
- **Argument:** Disallowing duplicate display names avoids disambiguation UI and name resolution collisions.
- **Predicted Failure:** Multi-agent workflows cannot instantiate identical worker roles across teams. Cloned or invited agents collide unrecoverably.
- **Beat Spec?** No. Spec wins: Preserving uniqueness by default with `pg_advisory_xact_lock` ([command/index.ts:6330](file:///supabase/functions/command/index.ts#L6330)) while requiring explicit `allow_duplicate_name: true` and UUID-backed labels prevents accidental collision while supporting intentional duplicates safely.

---

### Unverified Evidence Claims (Not Verifiable from Pasted Text Alone)

1. **Client Execution Context (Lane C):** Local session key generation (32-byte secure random) and file permissions in `~/.config/cswarm/sessions/...`.
2. **Interactive Zero-Model Guarantee:** Absence of ACP/model factory imports in interactive CLI listener routines (`session start|status|stop`).
3. **UI Disambiguation Rendering (Lane B):** Verification that `LiveDashboard.astro`, `mention-address.ts`, chips, and drafts properly render and persist UUID suffixes.
4. **Client-Side Recipient Disambiguation:** CLI `--to` resolution in `src/cloud/signals.ts` rejecting ambiguous names with UUID lists.
5. **Test Suite Flake Resolution:** Whether `test:p1-server` passes reliably outside isolated test runs.

---

### Findings Classification

- **DEFECT:** None. Migration enumerates columns without `wake_id` ([migration:305-322](file:///supabase/migrations/20260906000020_agent_execution_sessions.sql#L305-L322)), all mutation paths ([command/index.ts:7338](file:///supabase/functions/command/index.ts#L7338), [activity/index.ts:129](file:///supabase/functions/activity/index.ts#L129)) enforce proof, and lease revocation reclaims unsurfaced leases without incrementing attempt ceilings.
- **GAP:** None. The server contract, database constraints, migration assertions, and protocol deciders define all required behaviors without operator improvisation.
- **NIT:** In [workspace-commands.ts:1432](file:///src/protocol/workspace-commands.ts#L1432), session commands throw `"Handled outside reducer"` because edge SQL handlers execute them prior to reducer dispatch.

QUOTE-BACK: ## 8. Concrete contract and review resolutions
VERDICT: PASS
REASON: The four inversions fail against the spec's recovery and cost requirements, all agent mutation paths are strictly fenced, and no DEFECT or GAP remains.
