# Slice 2 build brief — the `command` Edge Function (handle_command)

**From:** Lead (cloud-swarm) → **Mason [codex]**
**Task:** swarm task `p1-command-api` (Lead owns lease @ epoch 2). Checkpoint against it.
**Authoritative spec:** `docs/design/P1-COMMAND-API.md` §3 (esp. §3.2 exact check order), §4 (auth/tenancy), §5 (fencing), §9 (tests). This brief SCOPES that spec to the minimum-that-unblocks-coordination — where they differ, this brief's scope wins; where this brief is silent, the spec governs.

---

## The one rule: wrap `decide()`, never reimplement it

The pure authority core is DONE and frozen in `src/protocol/` (P0, 38/38 tests). You import it **unmodified** and call it in-process from the Edge Function. **Do not edit anything under `src/protocol/`.** If you think the core needs a change, STOP and message Lead — a core change is an authority-boundary change and goes through review, not a worker edit.

Public surface you consume (from `src/protocol/index.ts`):
- `applyCommand(ledger: IdemLedger, state: TaskState|null, cmd: Command, ctx: DecideCtx): ApplyOutcome` — the entry point. `ApplyOutcome` = `{status:'fresh', decision, response, events}` | `{status:'replayed', response}` | `{status:'conflict', detail}`.
- `decide(state, cmd, ctx): Decision` — called internally by `applyCommand`; you generally call `applyCommand`, not `decide` directly.
- `reduceTask(prev, env): TaskState` and `reduceStream(events): TaskState|null` — fold events → projection. Use to build the `swarm.tasks` projection by folding (§3.2 step 12), **never** hand-patch columns.
- `requestHash(actor, cmd)`, `canonicalJson(...)`, `StoredResponse`, `IdemLedger` (a `Map`), `idemKey(actor, command_id)`.
- Types: `Command` (8 P0 kinds below), `DecideCtx`, `Decision`, `Actor`, `EventEnvelope`, `TaskState`, `Disposition`/`DISPOSITIONS`.

The **P0 `Command` union** (the only commands slice 2 handles):
`create | acquire | renew | handoff | takeover | submit | close | reopen`. (Field shapes are in `src/protocol/commands.ts` lines 20-28 — read them; do not guess.)

`DecideCtx` (commands.ts:36) is the contract you must satisfy. Every oracle is a **pure predicate over server-derived, in-transaction state** — never over anything from the request body. Your job in the Edge Function is to back each oracle with a parameterized SQL read inside the one open transaction:
- `now` → `statement_timestamp()` as epoch-ms (gap #9: ms-floor, never round).
- `actor` → stamped entirely from the credential row (step 4), never the body.
- `isMember/role/isEligibleRecipient` → `swarm.memberships` (+ `agent_principals` for agents).
- `slugTaken` → `swarm.tasks` (unique index is the backstop).
- `claimRequiresGrant` → **`() => false`** at P1 (claim kinds are P2, gap #3).
- `validCloseGrant` → **dormant** at P1 (schema-ready; return false).
- `validTakeoverGrant` → live `grants` row of type `takeover` bound `{task, epoch, recipient=caller}`, not revoked/expired/not in `grant_consumptions`.
- `evidenceComplete` → non-empty + structurally-valid string refs (full §2.4 verification is P2 / RISK R7).
- `nextSeq` → locked head arithmetic (step 8 `FOR UPDATE`); `nextEventId` → `crypto.randomUUID`.

---

## Scope of slice 2 (decision #62 — minimum that unblocks coordination)

**IN:**
1. `supabase/functions/command/index.ts` — Deno Edge Function, `POST /commands`, TS orchestrator holding **one** Postgres transaction as role `swarm_command` on the transaction-mode pooler, per §3.2 steps 1–15 in exact order.
2. Handle the **8 P0 task commands** end-to-end against the **LOCAL** Supabase stack (all 12 containers are up — verified). Edge runtime container `supabase_edge_runtime_cloud-swarm` is up.
3. **Auth = real but minimal:** JWT path → verify via Supabase Auth (`auth.getUser`); agent-token path → `swm_agt_` prefix → sha256 the full presented string (incl. prefix, gap #12) → look up `agent_tokens` by hash. Real verification, but **no PKCE login flow** (that's slice 3).
4. Idempotency at the **DB layer** authoritatively: `INSERT … ON CONFLICT DO NOTHING RETURNING` (gap #10) — zero rows → re-read, hash-compare, answer `replayed` (200, stored response) or `409` exactly as the sequential path. On the miss path, call `applyCommand` with an **empty** `IdemLedger` Map.
5. Projections by **folding** (`reduceTask`), append-only `events`, `grant_consumptions` on grant-bearing events, `audit_log` on **every** outcome.
6. Test-only hooks gated on `SWARM_ENV=test` (refuse otherwise): `SWARM_CMD_TEST_SLEEP_AFTER_STEP`, `SWARM_CMD_TEST_ROLLBACK_BEFORE_STEP` (§9.0).

**OUT (deferred — do NOT build):**
- §3.4 workspace-authority commands (`create_workspace`, `invite/accept`, `map_repository`, token minting/renewal, landing authority, …). For the first dogfood, the test/dogfood harness **seeds** workspace + membership + `agent_principal` + run + token via the **service_role key** (fixture setup only — never in the command path). Full §3.4 is slice 2b.
- Real PKCE login + CLI client → slice 3.
- Snapshot bootstrap (gap #18, replay-only at P1); claim kinds (gap #3).

---

## Check order — §3.2, non-negotiable ordering

1. Edge pre-checks (stateless): body ≤128 KB (else 413, **zero DB writes**); `command_id` matches `^[A-Za-z0-9_-]{8,72}$`; classify credential by format.
2. `BEGIN` (`READ COMMITTED` — §5.3); `SET LOCAL search_path = swarm, pg_catalog`.
3. Authenticate (uniform 401 `{error:"unauthenticated"}` on unknown/expired; no other table read on this path).
4. Derive principal server-side; ignore any `actor_*`/`device` in body, record their presence in audit `detail`.
5. Validate every client identifier vs derived tenancy, **reject-before-read**; mismatch → **uniform** 403 `{error:"forbidden"}`, audit-only, zero tenant rows read.
6. Revocation (fail-closed, every command) → 403 on any tombstone. Then validation & bounds (kind known, formats, `ttl_ms ∈ (0,4h]`, payload ≤64 KB) → 400/413.
7. Idempotency lookup (DB, per #4 above) → `replayed`/`409`/miss.
8. Lock stream head: `SELECT head_seq FROM streams WHERE stream_id=$1 FOR UPDATE` (single serialization point).
9. Load decide-state (task projection or null) + build `DecideCtx` with the in-tx oracle reads above.
10. `applyCommand(emptyLedger, state, cmd, ctx)`.
11. Append returned event envelopes with allocated seqs (PK violation under lock → ROLLBACK + 500).
12. Update projections by folding (`reduceTask`) → upsert `swarm.tasks`; `leases` per epoch-advancing event.
13. Side effects off emitted events: grant-bearing `TaskClosed`/`LeaseTakenOver` → `INSERT grant_consumptions` (unique violation → ROLLBACK = double-spend loser); `TaskReopened` → revoke open submissions/grants for that task.
14. Ledger idempotency row **iff** accepted or domain-rejected (never authz). Audit row on all outcomes (`detail` control-char-stripped).
15. `COMMIT`. Map: accepted → 200 `{status:"accepted", events, min_client_version}`; domain-rejected → 200 `{status:"rejected", class:"domain", reason, detail, event}`.

§3.3 failure→disposition table is the source of truth for which failures become committed `CommandRejected` events (domain) vs audit-only (authn/authz/revocation/validation/409/rate-limit). Get this right — it is the security boundary (§3.3 lists the 4 concrete attacks that ride on it).

---

## Definition of done for this slice (evidence-gated)

Green against the **local** stack:
- `tsc --noEmit` clean; existing `npm test` still 38/38 (core untouched).
- A `tests/p1-server/` integration suite (harness per §9.0: fresh workspaces A & B, users, seeded agent principal/run/token via service_role) with the **core task-path merge-gate subset GREEN**: **T-01, T-02, T-03, T-05, T-06, T-10, T-11** + invariants **I1–I5**. (T-04 grants and T-07 revoke-mid-flight land in 2b unless they come cheap.)
- Commands issued over HTTP exactly as a client would; concurrency via `Promise.all`.

Report the commit SHA + test output. A "done" claim without the passing-test artifact does not count (evidence-gated, §2 method). I will verify independently.

---

## Coordination
- You are swarm-native. Work in your own session; **do not** spawn `codex exec` background jobs (orphans/wedges — landmine).
- Checkpoint on `p1-command-api` as you hit milestones (`swarm task checkpoint p1-command-api --notes "..."`).
- Land small: Lead may merge/push `main` directly (no PR ceremony required). If you open a PR that's fine too.
- Blocked or think the scope is wrong? Message Lead immediately — don't guess on the authority boundary.
- Questions on the pure core's intent → ask; hard adversarial review of your output will go to Kimi K3 before merge.
