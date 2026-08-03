# Production delta exact review — Ashlar (Codex), D-036 exact arm

Target: `origin/main..8852ce8` restricted to `supabase/` + `src/cloud/command-client.ts` (~1,932 insertions).
Method: static analysis only; no test, database, Supabase, Docker, or network command was run.
Note: the worker ran in a read-only sandbox and therefore could not write this file itself;
the Lead transcribed its final report verbatim from the run log.

# PASS

No CRITICAL findings. The migration is statically additive, forced-RLS protected, and minimally granted. I found one MAJOR and three MINOR issues.

## Findings

- **MAJOR (confidence 9/10): claim replays can change `sender_owner_relation`.** The claim ledger persists the claim-time relation ([durable-delivery.ts:312](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/durable-delivery.ts:312)), but hydration discards it and returns a freshly computed relation ([durable-delivery.ts:367](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/durable-delivery.ts:367), [durable-delivery.ts:424](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/durable-delivery.ts:424)). Replays invoke that hydration again ([index.ts:5543](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/index.ts:5543)).  
  **Trigger:** claim records `unknown`; the sender’s membership is restored—permitted by `revoked_at = NULL` ([index.ts:3087](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/index.ts:3087))—then a lost-response retry replays the command ID.  
  **Consequence:** the replay can upgrade `unknown` to `same_owner`, changing host wake/tool policy for one idempotent claim; revocation can cause the inverse availability failure.  
  **Narrow correction:** hydrate the signal body under exact-recipient authorization but return `ref.sender_owner_relation`, the server-generated value already stored in the ledger.

- **MINOR (confidence 9/10): ACK responses expose terminal-row existence.** No exact row returns `unavailable`, while an already-ACKed row with a different lease/listener/outcome returns `conflict` ([durable-delivery.ts:460](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/durable-delivery.ts:460), [durable-delivery.ts:470](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/durable-delivery.ts:470), [durable-delivery.ts:488](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/durable-delivery.ts:488)). Those become distinguishable HTTP 403 and 409 responses ([index.ts:5866](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/index.ts:5866)).  
  **Trigger:** an authenticated recipient submits the same guessed signal UUID with a random lease against an ACKed row and an absent/unacked row.  
  **Consequence:** it can distinguish terminal delivery existence/status, contrary to the stated stale/unknown indistinguishability rule. This does not expose another recipient’s row because recipient predicates remain enforced.  
  **Narrow correction:** return conflict only when the stored last lease/listener matches but the outcome differs; wrong identity should return `delivery_unavailable`.

- **MINOR (confidence 9/10): workspace-wide delivery operations accept caller-selected repo streams.** Route resolution accepts either workspace or repo streams ([index.ts:1825](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/index.ts:1825)), while the workspace-stream restriction excludes delivery commands ([index.ts:5285](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/index.ts:5285)). Accepted claim/ACK audits persist that selected stream ([index.ts:5827](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/index.ts:5827), [index.ts:5919](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/index.ts:5919)).  
  **Trigger:** a valid agent sends claim/ACK using any active repo mapping in its workspace.  
  **Consequence:** workspace-wide delivery activity is falsely attributed to that repository in audit and idempotency rows. Authorization and recipient isolation remain intact.  
  **Narrow correction:** require the workspace stream for both delivery commands or derive it server-side.

- **MINOR (confidence 9/10): read advertises delivery capability outside eligible inbox pages.** A foreign-workspace request returns empty data but still advertises claim/ACK ([read/index.ts:280](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/read/index.ts:280)); every signals query also advertises them regardless of `inbox` ([read/index.ts:376](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/read/index.ts:376), [read/index.ts:411](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/read/index.ts:411)).  
  **Trigger:** an authenticated agent probes a foreign workspace or requests a non-inbox feed.  
  **Consequence:** the client can select claim mode where claim necessarily returns `delivery_unavailable`, creating a misleading capability contract.  
  **Narrow correction:** emit delivery markers only for the authenticated principal’s home-workspace inbox response.

## Migration and isolation proof

- The only existing-object mutation is a comment on the dormant table; the migration otherwise creates a new table, functions, trigger, configuration row, extension, and schedule. The only `DELETE` is inside the new terminal-row purge and is limited to old ACKed rows ([migration:7](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/migrations/20260731000001_signal_deliveries.sql:7), [migration:15](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/migrations/20260731000001_signal_deliveries.sql:15), [migration:238](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/migrations/20260731000001_signal_deliveries.sql:238)). No `DROP`, destructive `ALTER`, type narrowing, or existing-row rewrite appears.
- Ownership, claim-supporting indexes, constraints, and forced RLS are explicit ([migration:33](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/migrations/20260731000001_signal_deliveries.sql:33), [migration:77](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/migrations/20260731000001_signal_deliveries.sql:77), [migration:79](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/migrations/20260731000001_signal_deliveries.sql:79), [migration:92](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/migrations/20260731000001_signal_deliveries.sql:92)).
- `PUBLIC`, `anon`, `authenticated`, `swarm_read` receive no table authority. `swarm_command` receives only `SELECT, INSERT, UPDATE`, with no `DELETE`; `swarm_read` gets only schema usage and execution of the narrow definer function ([migration:103](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/migrations/20260731000001_signal_deliveries.sql:103), [migration:482](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/migrations/20260731000001_signal_deliveries.sql:482)).
- Workspace and recipient are derived from authenticated state and repeated in claim, hydration, and ACK predicates ([index.ts:1802](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/index.ts:1802), [durable-delivery.ts:124](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/durable-delivery.ts:124), [durable-delivery.ts:398](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/durable-delivery.ts:398), [durable-delivery.ts:460](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/durable-delivery.ts:460)).
- Fresh claims serialize on the recipient-principal row, reset expired leases, then use `FOR UPDATE SKIP LOCKED`; concurrent ACKs serialize on the delivery row ([durable-delivery.ts:124](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/durable-delivery.ts:124), [durable-delivery.ts:137](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/durable-delivery.ts:137), [durable-delivery.ts:221](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/durable-delivery.ts:221), [durable-delivery.ts:452](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/durable-delivery.ts:452)).
- The claim idempotency payload contains only signal/lease references, not bodies; bodies are hydrated afterward under exact-recipient predicates. New alerts contain only workspace, recipient, operation/count/window metadata ([durable-delivery.ts:312](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/durable-delivery.ts:312), [index.ts:5768](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/index.ts:5768), [index.ts:3932](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/index.ts:3932), [index.ts:5819](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/command/index.ts:5819)). I found no credential, lease capability, or message-body write into the new log, audit, alert, or error paths.
- The signal-post deadline clears its timer and caller listener on every exit; all raced work rejections have handlers ([command-client.ts:545](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/cloud/command-client.ts:545), [command-client.ts:875](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/cloud/command-client.ts:875), [command-client.ts:997](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/cloud/command-client.ts:997)).

## Not verified

Static analysis did not establish migration execution on a fresh reset, runtime database behavior, real-load capacity, deployed edge behavior, production application/correctness, or actual `pg_cron` execution. I ran no tests, builds, database, Supabase, Docker, or network commands.

The exact delta does not contain the listener effect store, so I did not establish effect-persist-before-ACK ordering or cross-machine duplicate-model behavior. An injected fetch implementation that ignores `AbortSignal` can continue underneath after the caller’s deadline, although its later rejection is handled and the timer/listener are released.

Per the read-only sandbox and your “change nothing” instruction, I did not create `PRODUCTION-DELTA-REVIEW-RESULT.md`; the checkout remains clean at the exact SHA.
hook: Stop
hook: Stop Completed
tokens used
301,586












