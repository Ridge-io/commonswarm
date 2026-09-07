# Live control for the agent-identity candidate (local Supabase stack)

`run-control.sh <worktree> <host-session-id>` drives enable, `session start --mode interactive`,
`listen start --route main` with the hook installed, a directed ask, a bare queued-to-observed
without `surfaced` (expected refusal `delivery_not_surfaced`), the hook with and without the host
session id on stdin, recover, and a stale stop. `env.py` parses `supabase status -o json`;
`enable.ts` posts `enable_agent_management` / `recover_agent_session` with the same client class the
CLI uses (the CLI's own `session enable` needs a browser login the local stack does not have).
Expected outcome per step is the comment block at the top of the script.

Preconditions on a colima host: the worktree under `/Users`, `npm run build` done,
`supabase start -x vector,logflare` up from that worktree, and the VM clock not ahead of the host
(`colima ssh -- sudo date -s @<epoch>` if `docker exec <db> date` leads `date`).

Measured runs: `control.log` and `listener-events.ndjson` here are from b0902f68 against an
a556ab1b server (no `surfaced` field yet); the mini's run against the final head is recorded under
`docs/evidence/2026-09-06-agent-identity/mini-live-control-<sha>/` by CSwarmStrategist.
