# Lane A: Server Execution Sessions Implementation

## 1. Migration
`supabase/migrations/20260906000020_agent_execution_sessions.sql` creates the `swarm.agent_execution_sessions` and `swarm.retired_agent_sessions` tables, and drops the legacy unique name constraint on agent principals.

## 2. Command Processing
Added 6 new self-contained endpoints in `supabase/functions/command/index.ts`:
- `enable_agent_management`
- `disable_agent_management`
- `recover_agent_session`
- `acquire_agent_session`
- `renew_agent_session`
- `release_agent_session`

These operations implement their own exact row locks and checks as requested.

## 3. Session Wire Headers
Session proofs use `x-cswarm-session-id`, `x-cswarm-session-generation`, and `x-cswarm-session-key` which are exported in `src/cloud/session-wire.ts`.

## 4. Mutation Fencing
Fencing logic is inserted right after `authenticateAgent` in `supabase/functions/command/index.ts`. All agent commands are verified against `swarm.agent_execution_sessions` if managed enforcement is enabled, failing closed with a 401 unauthenticated if the proof is missing or invalid. The `acquire_agent_session` command is properly exempted.

## 5. Duplicate Agent Names
`allow_duplicate_name` parameter was added to `create_agent_principal` in `src/protocol/workspace-commands.ts`, updating the pure decider logic.

## 6. Tests
Implemented comprehensive tests in `tests/p1-server/agent-execution-sessions.test.ts`.

## Gaps
None. Blocked designs? No.
