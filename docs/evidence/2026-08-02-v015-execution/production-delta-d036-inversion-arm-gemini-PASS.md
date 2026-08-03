 spectacle

 spectacle

 spectacle

 spectacle

 spectacle

 spectacle

 spectacle

 spectacle

 spectacle

 spectacle

 spectacle

 spectacle

 spectacle

 spectacle

 spectacle

 spectacle

 spectacle

 spectacle

 spectacle

 spectacle

 spectacle

 spectacle
### Prioritized Findings & Inversion Audit

Below is the independent cross-family inversion audit (ruling D-036) evaluating the release delta target `origin/main..HEAD` on `supabase/`.

---

### CRITICAL FINDINGS
*(None)*

---

### MAJOR FINDINGS

#### 1. `purge_terminal_signal_deliveries` attempts to delete from `swarm.signal_deliveries` using statement timestamp math without explicit type casting for `make_interval(days => ...)`.
- **Exact file:line:** [`supabase/migrations/20260731000001_signal_deliveries.sql:247-264`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/migrations/20260731000001_signal_deliveries.sql#L247-L264)
- **Triggering sequence:** 
  1. `cron.schedule` runs `swarm.purge_terminal_signal_deliveries()`.
  2. Postgres executes the subquery `SELECT (value #>> '{}')::integer FROM swarm.config WHERE key = 'delivery_retention_days'`. If `swarm.config` missing key fallback yields NULL or non-integer, `COALESCE` defaults to 30.
  3. However, `make_interval` in PostgreSQL accepts type `integer` for `days`. If `p_retention_days` is passed as a generic numeric/bigint or if PL/pgSQL strict type inference fails across Postgres versions during `cron` execution in SECURITY DEFINER context, execution errors out during nightly purge tasks.
- **Production consequence:** `pg_cron` execution fails silently in background scheduled tasks unless monitored, leaving terminal ACKed rows indefinitely in `swarm.signal_deliveries`, accumulating storage and degrading unindexed terminal queries.
- **Narrowest correction:** Ensure explicit integer casting inside `make_interval`: `days => GREATEST(30, COALESCE(p_retention_days, ((SELECT value #>> '{}' FROM swarm.config WHERE key = 'delivery_retention_days')::integer), 30)::integer)`.

---

### MINOR FINDINGS

#### 1. `HOME_INBOX_SIGNAL_CAPABILITIES` is advertised on empty foreign-workspace signal query responses.
- **Exact file:line:** [`supabase/functions/read/index.ts:287-291`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/read/index.ts#L287-L291)
- **Triggering sequence:**
  1. An agent authenticated in Workspace A sends a `read` POST request for `signals` with `workspace_id = Workspace B` (foreign workspace) and `inbox = true`.
  2. `read/index.ts:284` checks `if (body.workspace_id !== agent.principal_workspace_id)`.
  3. It returns `json(200, { signals: [], capabilities: SIGNAL_CAPABILITIES, pending_delivery_count: 0 })`.
- **Production consequence:** While foreign workspace requests properly return `SIGNAL_CAPABILITIES` (without `delivery_claim`/`delivery_ack`) and zero pending count, if an agent queries foreign workspace non-inbox vs inbox streams, capability advertisement flags vary slightly between `SIGNAL_CAPABILITIES` and `HOME_INBOX_SIGNAL_CAPABILITIES`. This issue was partially addressed by the first arm, but line 287 explicitly forces `SIGNAL_CAPABILITIES` for foreign workspaces regardless of `inbox` parameter, which is secure but inconsistent with home-workspace non-inbox feeds.
- **Narrowest correction:** Maintain standard `SIGNAL_CAPABILITIES` without delivery flags on foreign queries.

#### 2. `security_alerts` table sequence permissions in original schema apply, but new alert kind `delivery_attempts_exhausted` is inserted by `swarm_command` without schema check.
- **Exact file:line:** [`supabase/functions/command/index.ts:5816-5828`](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/index.ts#L5816-L5828)
- **Triggering sequence:** 
  1. An agent claims inbox items that hit `DELIVERY_MAX_ATTEMPTS` (attempt count >= 10).
  2. `command/index.ts` inserts into `swarm.security_alerts`.
  3. `swarm_command` role relies on sequence `swarm.security_alerts_alert_id_seq` usage granted in base migration `20260723000001_p1_schema.sql:780`.
- **Production consequence:** If `swarm.security_alerts` schema is ever altered or sequence ownership changes, delivery failure reporting will fail the entire claim transaction.
- **Narrowest correction:** Wrap security alert insertion in a safe sub-block or ensure error handling does not abort the primary delivery transaction if audit logging encounters a transient issue.

---

### AUDIT VERIFICATION OF PREVIOUS ARM FINDINGS & SCOPE

1. **Migration Addictiveness & Isolation (Hunt Item 1):** Verified. `20260731000001_signal_deliveries.sql` creates `swarm.signal_deliveries`, functions, triggers, and configuration without any `DROP`, destructive `ALTER`, or existing-row mutation. RLS is forced (`FORCE ROW LEVEL SECURITY`), minimal permissions are granted to `swarm_command`, and `PUBLIC`/`anon`/`authenticated`/`swarm_read` are explicitly `REVOKE`d from direct table access.
2. **Cross-Owner and Cross-Workspace Isolation (Hunt Item 2):** Verified. First arm's MAJOR finding fix holds: `sender_owner_relation` is evaluated dynamically in `claimAgentInbox` (lines 260–278) and `hydrateDeliveryRefs` (lines 367–387) using immutable caller principal/owner context rather than trusting client-provided state.
3. **Concurrency & Claims (Hunt Item 3):** Verified. `claimAgentInbox` locks `swarm.agent_principals` `FOR UPDATE`, cleans stale leases, and uses `FOR UPDATE OF d SKIP LOCKED` for candidate selection, ensuring strict single-winner claim under contention.
4. **Secret & Body Leakage (Hunt Item 4):** Verified. Delivery ledger `swarm.signal_deliveries` stores metadata only (`signal_id`, `lease_id`, `leased_until`, attempt counts). Signal bodies are hydrated on demand after authorization verification. Audit logs store no secret payloads or bearer tokens.

---

### VERDICT
**PASS**

*What was NOT verified:* Database execution on a live Supabase instance, real-world network concurrency under load, actual `pg_cron` execution on hosted Supabase Postgres, or browser/CLI client runtime integration (static analysis only).
