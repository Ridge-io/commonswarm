### Findings

- **CRITICAL**: None.
- **MAJOR**: None.
- **MINOR**: None.

---

### Specific Attack Vector Verification

#### Correction 1: Claim replays preserve `sender_owner_relation`
- **Is `ref.sender_owner_relation` ALWAYS populated and server-generated?**
  Yes. In `claimAgentInbox` ([durable-delivery.ts:260-278](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/durable-delivery.ts#L260-L278)), SQL `CASE ... ELSE 'unknown' END::text` computes the server relation at initial claim time and stores it in the ledger ref. When replayed via `parseClaimLedger` ([durable-delivery.ts:589-598](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/durable-delivery.ts#L589-L598)), `ref.sender_owner_relation` is validated against the strict enum set `("same_owner" | "cross_owner" | "unknown")`. Malformed or missing relation values return `null` and map to `delivery_unavailable`.
- **Could it be null/undefined or recomputed on replay?**
  No. In `hydrateDeliveryRefs` ([durable-delivery.ts:424](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/durable-delivery.ts#L424)), line 424 now returns `ref.sender_owner_relation` directly from the ledger ref rather than `signal.sender_owner_relation`. The claim-time value persists regardless of subsequent author membership changes or revocations. No other code path recomputes the relation for claim replay.

#### Correction 2: Terminal ACK identity check refactoring & truth table
Both initial read ([durable-delivery.ts:471-477](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/durable-delivery.ts#L471-L477)) and post-update re-read ([durable-delivery.ts:546-552](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/durable-delivery.ts#L546-L552)) were verified.

**ACK Truth Table: (Identity Matches? Outcome Matches?) $\rightarrow$ Status / HTTP Code**

| Terminal Row Exists? | Identity Matches (`last_lease_id` & `last_leased_by`)? | Outcome Matches Stored `ack_outcome`? | Resulting Status | HTTP Status Code |
| :--- | :--- | :--- | :--- | :--- |
| No (or wrong recipient) | N/A | N/A | `unavailable` | **403** (`delivery_unavailable`) |
| Yes (unacked / live) | No | N/A | `unavailable` | **403** (`delivery_unavailable`) |
| Yes (acked) | **No** | Yes or No | `unavailable` | **403** (`delivery_unavailable`) |
| Yes (acked) | **Yes** | **Yes** | `idempotent` | **200** (OK) |
| Yes (acked) | **Yes** | **No** | `conflict` | **409** (`delivery_ack_conflict`) |

- **Consequence:** Stale/wrong lease attempts or guessed signal UUIDs on terminal rows now return 403 `delivery_unavailable`, identical to non-existent rows. HTTP 409 `delivery_ack_conflict` is returned *only* when the exact lease holder re-acks with a conflicting outcome. No legitimate client is broken.

#### Correction 3: Delivery commands restricted to workspace streams
- **Effect of adding `CLAIM_AGENT_INBOX_KIND` & `ACK_AGENT_DELIVERY_KIND` to `WORKSPACE_COMMAND_KINDS`:**
  - Route validation ([command/index.ts:5287-5290](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/index.ts#L5287-L5290)) enforces `record(body.stream)?.kind === "workspace"`. Passing `{ kind: "repo", repo_mapping_id: ... }` fails `workspaceCommandRouteOk` and returns 403 `delivery_unavailable`.
  - In execution routing ([command/index.ts:5960](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/index.ts#L5960)), delivery commands exit early via their dedicated handlers ([command/index.ts:5753-5937](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/index.ts#L5753-L5937)) and never fall through to `prepareWorkspaceCommand`.
  - Scopes, rate limits, and recipient isolation remain completely intact.

#### Correction 4: Capability marker scoping
- **Capability advertisement:**
  - `read/index.ts` ([read/index.ts:417-419](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/read/index.ts#L417-L419)) emits `HOME_INBOX_SIGNAL_CAPABILITIES` (including `delivery_claim: 1` and `delivery_ack: 1`) *only* when `body.inbox` is true on the principal's home workspace.
  - Foreign workspace reads ([read/index.ts:289](file:///Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/read/index.ts#L289)) and non-inbox home workspace reads emit `SIGNAL_CAPABILITIES` without delivery markers.
  - Legacy v0.1.4 clients reading cursors continue to receive `cursor_after: 1` and `sender_owner_relation: 1` without breakage.

#### Scope Creep & Migration Integrity
- **Scope creep:** None. All changes in `durable-delivery.ts`, `command/index.ts`, `read/index.ts`, and `command.test.ts` correspond strictly to the 4 requested corrections.
- **Migration directory:** `git diff 1f7c9ac..df2f4c9 -- supabase/migrations/` is completely empty.

---

### Verdict

**VERDICT: PASS**

**What was NOT verified:** Runtime database execution, live network HTTP requests, or `pg_cron` background execution (per static analysis requirement).
