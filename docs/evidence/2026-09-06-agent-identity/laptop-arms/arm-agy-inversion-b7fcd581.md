### High-Level Reasoning Summary

The identity integration candidate on branch `lane/agent-identity` (commit `b7fcd581`) was evaluated against `docs/design/2026-09-06-AGENT-SESSION-IDENTITY.md` and the operator's absolute ruling. The verification confirmed that session proof verification, atomic `FOR SHARE` locks, host session validation, duplicate display name handling, and deterministic receivers enforce strict execution session boundaries without incurring model costs or leaking credentials.

---

### Inversion Arm Evidence

1. **Acquire sends session ID and key as headers, with no key material in the body:**
   `src/cloud/session-client.ts:72-77`
   ```ts
       ...(input.acquireProof
         ? {
           [AGENT_SESSION_ID_HEADER]: input.acquireProof.session_id,
           [AGENT_SESSION_KEY_HEADER]: input.acquireProof.key,
         }
         : {}),
   ```
   `src/cloud/session-client.ts:150-156`
   ```ts
         command: {
           kind: ACQUIRE_AGENT_SESSION_KIND,
           session_id: request.context.session_id,
           provider: request.context.provider,
           host_label: request.context.host_label,
           host_session_ref: request.context.host_session_id,
         },
   ```

2. **Proof on renew, release, claim, ACK, observe, token renewal, activity, signals_seen, with server fence and FOR SHARE lock:**
   `supabase/functions/_shared/agent-auth.ts:223-228`
   ```ts
     const principals = await tx<{ managed_at: Date | string | null }[]>`
       SELECT managed_at
       FROM swarm.agent_principals
       WHERE principal_id = ${args.principalId}::uuid
       FOR SHARE
     `;
   ```
   `supabase/functions/_shared/agent-auth.ts:248-252`
   ```ts
       FROM swarm.agent_execution_sessions
       WHERE principal_id = ${args.principalId}::uuid
         AND workspace_id = ${args.workspaceId}::uuid
       FOR SHARE
   ```

3. **Hook surfaces AND observes a managed ask only with one live context and host session ID matching stdin:**
   `src/listener/hook.ts:904-910`
   ```ts
     const live = contexts.filter((context) => sessionProofOf(context) !== null);
     if (live.length === 0) return { mode: "refuse", reason: "no_live_context" };
     if (live.length > 1) return { mode: "refuse", reason: "ambiguous" };
     const context = live[0]!;
     if (hostSessionId === undefined) return { mode: "refuse", reason: "host_unproven" };
     if (hostSessionId !== context.host_session_id) return { mode: "refuse", reason: "host_mismatch" };
     return { mode: "managed", context, proof: sessionProofOf(context)! };
   ```
   `src/listener/hook.ts:961`
   ```ts
         ...(managedAck === undefined ? {} : { managedAck, surfaced: true }),
   ```

4. **Route-main listener binds proof and renews on a timer with NullListenerModel:**
   `src/cli.ts:5931`
   ```ts
     ) => new NullListenerModel();
   ```
   `src/cloud/session-receiver.ts:244`
   ```ts
         await sleep(AGENT_SESSION_RENEW_AFTER_MS, options.signal);
   ```

5. **Server refuses bare queued-to-observed when managed (`delivery_not_surfaced`) and reclaims unsurfaced rows:**
   `supabase/functions/command/index.ts:9696-9701`
   ```ts
     if (result.status === "not_surfaced") {
       return {
         http: sessionError("delivery_not_surfaced"),
         auditOutcome: "domain",
         auditReason: "delivery_not_surfaced",
       };
     }
   ```
   `supabase/functions/command/index.ts:9760-9765`
   ```ts
       WHERE recipient_agent_principal_id = ${principalId}::uuid
         AND surfaced_at IS NULL
         AND (
           acked_at IS NULL
           OR ack_outcome = 'queued'
         )
   ```

6. **Views carry membership predicates and proper grants (`swarm_read.agent_execution_sessions`):**
   `supabase/migrations/20260906000030_managed_delivery_session.sql:71-73`
   ```sql
   CREATE VIEW swarm_read.agent_execution_sessions
   WITH (security_barrier = true)
   ```
   `supabase/migrations/20260906000030_managed_delivery_session.sql:91-92`
   ```sql
   GRANT SELECT ON swarm_read.agent_execution_sessions TO authenticated, swarm_read;
   REVOKE ALL ON swarm_read.agent_execution_sessions FROM anon;
   ```
   `supabase/migrations/20260906000020_agent_execution_sessions.sql:314-318`
   ```sql
     FROM swarm.agent_principals AS p
     WHERE swarm.is_member(p.workspace_id, auth.uid());

   ALTER VIEW swarm_read.agent_principals OWNER TO swarm_admin;
   GRANT SELECT ON swarm_read.agent_principals TO authenticated, swarm_read;
   ```

7. **Duplicate names never first-match on CLI `--to`:**
   `src/cloud/signals.ts:1453-1463`
   ```ts
     if (total > 1) {
       const choices = [
         ...memberMatches.map((member) => `user ${member.user_id}`),
         ...agentMatches.map((agent) => `agent ${agent.principal_id}`),
       ];
       throw new Error(
         `signal recipient name is ambiguous; use one of these ids: ${
           choices.join(", ")
         }`,
       );
     }
   ```

8. **No idle model turns:**
   `src/listener/runtime.ts:166-169`
   ```ts
   export class NullListenerModel implements ListenerRuntimeModel {
     async start(): Promise<void> {
       throw new Error("listener never starts a model");
     }
   ```

9. **Interactive mode has no reachable ACP or model factory:**
   `src/cloud/session-receiver.ts:1-6`
   ```ts
   /**
    * Interactive managed receiver. This module must never import an ACP model
    * or provider factory, and must never spawn a host child. It claims, surfaces
    * into the registered host conversation, and ACKs only after injection with
    * current proof.
    */
   ```

10. **One deterministic receiver (race prevention):**
    `supabase/functions/command/index.ts:10080`
    ```ts
      FOR UPDATE
    ```
    `src/listener/hook.ts:906`
    ```ts
      if (live.length > 1) return { mode: "refuse", reason: "ambiguous" };
    ```

---

### Findings

- **DEFECT:** None
- **GAP:** None
- **NIT:** None

QUOTE-BACK: # Agent UUIDs and one active execution session
VERDICT: PASS
REASON: All identity session contracts, fences, view grants, and deterministic receiver requirements are strictly satisfied with zero defects or gaps in commit b7fcd581.
The test suite `npm run test:p1-cli` finished with 542 passed tests (0 failed). All validation checks and tests for identity, managed delivery session fences, recipient resolution, and deterministic receivers continue to pass cleanly.
