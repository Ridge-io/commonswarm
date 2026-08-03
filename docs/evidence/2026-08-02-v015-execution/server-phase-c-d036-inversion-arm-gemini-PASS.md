### Executive Summary & Scope

- **Target SHA**: `e3dc295321abcbeac28b6418b396e85d69b99f6f` on branch `cobalt/durable-delivery-server`
- **Worktree**: `/Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery`
- **Reviewed Delta**: `5f5018a..e3dc295` (`tests/p1-server/command.test.ts`, +845 lines)
- **Binding Specification**: `SERVER-PHASE-C-PREFLIGHT-CORRECTIONS.md`
- **Execution Constraints**: Static code analysis only. No database or test commands executed.

---

### Findings by Severity

#### CRITICAL
None.

#### MAJOR
None.

#### MINOR
None.

---

### Audit Against Attack Vectors & Spec Requirements

#### 1. Assertion Laundering & Spec Compliance
- **Allowed Test Set** ([`command.test.ts:L11223-L11272`](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L11223-L11272)):
  - Asserted `resolverObserved: true` ([L11239](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L11239)).
  - Exact `409 {"error":"command_id_conflict"}` body and 409 status ([L11241-L11242](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L11241-L11242), [L11249](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L11249)).
  - ACK bucket count exactly 1 and claim bucket count exactly 1 ([L11245-L11246](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L11245-L11246)).
  - Unchanged signal B ([L11188](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L11188)).
  - Exactly one shared ledger row matching workspace/stream/principal/command/hash ([L11189-L11205](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L11189-L11205)).
  - Shared ledger stores exact body-free ACK response ([L11206-L11211](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L11206-L11211)) and forbids losing-claim sentinels ([L11212-L11220](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L11212-L11220)).
  - Exactly two post-watermark audits: ACK accepted (null detail/reason) and claim conflict with detail `resolved concurrent idempotency race` ([L11251-L11270](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L11251-L11270)).
  - Zero post-watermark alerts ([L11247](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L11247)).
- **Denied Test Set** ([`command.test.ts:L11274-L11354`](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L11274-L11354)):
  - Seeded claim bucket at 119 ([L10869-L10874](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L10869-L10874)).
  - Exact `429` status with rate-limit body including `limit: 120`, `message`, and calculated `resets_at` matching `window_start + 1m` ([L11301-L11306](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L11301-L11306)).
  - Integer `Retry-After` header within 1..60 ([L11307-L11308](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L11307-L11308)).
  - ACK bucket count 1, final claim bucket count 121 ([L11295-L11296](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L11295-L11296)).
  - Exactly two audits (ACK accepted; claim `rate_limit` / `delivery_claim_rate_limited` with null detail/hash/stream) ([L11310-L11329](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L11310-L11329)).
  - Exactly one `delivery_claim_rate_limit` alert with subject `agent` and ONLY keys `workspace_id`, `recipient_principal_id`, `operation`, `limit`, `resets_at` ([L11330-L11344](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L11330-L11344)).
  - Full privacy sentinel checks on response and alert details ([L11345-L11350](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L11345-L11350)).

#### 2. Causal Topology & pg_stat_activity Observation
- Every barrier is explicitly observed via `pg_stat_activity` queries checking exact PIDs and blocker PIDs:
  1. Both HTTP request backends blocked on initial `swarm.idempotency_keys` SELECT query by holder `L` (`ledgerHolder.pid`) ([L10891-L10903](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L10891-L10903)).
  2. ACK rate probe blocked by exact ACK request PID ([L10915-L10926](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L10915-L10926)).
  3. Claim rate probe blocked by exact claim request PID ([L10930-L10947](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L10930-L10947)).
  4. Release `L` ([L10950](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L10950)).
  5. Mapped ACK blocked on ACK row holder `A` (`ackRowHolder.pid`), mapped claim blocked on principal holder `P` (`principalHolder.pid`) ([L10952-L10969](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L10952-L10969)).
  6. Shared ledger proven absent while both remain blocked at `A` and `P` ([L10970-L10977](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L10970-L10977)).
  7. Release `A` only ([L10979](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L10979)). Await ACK HTTP 200, ACK probe acquisition, and committed ledger ([L10981-L10993](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L10981-L10993)).
  8. Re-prove claim remains blocked behind `P` ([L10994-L11001](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L10994-L11001)).
  9. Release `P` ([L11003](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L11003)). Claim rolls back original charge and releases probe ([L11005-L11010](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L11005-L11010)).
  10. Resolver recharge query (`INSERT INTO swarm.rate_buckets`) observed blocked behind retained `claimProbe.pid` ([L11012-L11040](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L11012-L11040)).
- No unobserved sleeps or assumed orderings.

#### 3. Recharging Proof (`resolveLedgerRace`)
- The test cannot pass if `resolveLedgerRace` fails to execute. The observation gate `waitForBlockedBackends` explicitly matches `/INSERT INTO swarm\.rate_buckets/` blocked on `claimProbe.pid`. If `resolveLedgerRace` does not run, `resolverObserved` evaluates to `false`, causing test failure.

#### 4. Minute-Boundary Flakiness
- `awaitPhaseCMinuteWindow()` ([L10706-L10727](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L10706-L10727)) polls until `remaining_seconds >= 15` in the DB minute.
- `assertPhaseCRequestWindow()` ([L10741-L10763](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L10741-L10763)) asserts `date_trunc('minute', xact_start)` and `date_trunc('minute', query_start)` for both request PIDs match `windowStart`.
- Denied `resets_at` is strictly asserted against `windowStart + 60s`.

#### 5. Production Contamination & Scope Creep
- Delta `5f5018a..e3dc295` modifies only `tests/p1-server/command.test.ts`. `supabase/` is completely untouched.
- No modifications were made to pre-existing Phase-B helpers or earlier test cases.

#### 6. Leaks and Hangs
- `finally` block ([L11162-L11177](file:///Users/yulanbot/Developer/Ridge.io/swarm-worktrees/cobalt-durable-delivery/tests/p1-server/command.test.ts#L11162-L11177)) idempotently releases `ledgerHolder`, `ackRowHolder`, `principalHolder`, `ackProbe`, and `claimProbe`.
- All started background promises are gathered and passed to `settleCleanupTruthfully`.

---

VERDICT: PASS

What was NOT verified: Runtime execution against a live PostgreSQL / Supabase edge function environment, actual execution times, or performance under real multi-tenant system load.
