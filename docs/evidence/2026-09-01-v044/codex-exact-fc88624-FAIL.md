# Codex exact review of fc88624 — VERDICT: FAIL (2026-09-01)

Final message of the Codex arm (gpt-5.6-sol, xhigh), verbatim from the lane log. Fixes: fold → 21334f7; body deadline → L25; hook scope + CLAUDE_CONFIG_DIR → L26.

tokens used
448,420
Three release blockers and one lower-severity defect.

- **P1 — The migration sequence breaks 0.1.43 clients.** Migration `000001` commits agent tracking rows inside `receipts` ([SQL](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/migrations/20260902000001_broadcast_recipient_roster.sql:125)). Migration `000002` fixes this, but the claim that one `db push` is continuously safe is false ([comment](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/migrations/20260902000002_broadcast_roster_compat.sql:37)). Supabase CLI 2.98.2 applies files one at a time, with a separate transaction for each file. Thus `000001` becomes visible before `000002`, and remains applied if `000002` fails. [Apply loop](https://github.com/supabase/cli/blob/v2.98.2/pkg/migration/apply.go#L53-L73), [per-file transaction](https://github.com/supabase/cli/blob/v2.98.2/pkg/migration/file.go#L69-L108). Fold the final shape into `000001`; do not depend on the next migration for compatibility.

- **P1 — File and brain deadlines stop at response headers.** `fetchWithDeadline` clears its timer as soon as `fetch()` returns ([files.ts](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/cloud/files.ts:410)). JSON and download bodies are read later, without a deadline. My controlled body-stall probe was still pending after 160 ms against a 40 ms deadline; its caller-abort control failed after 42 ms. Also, retries start a fresh 30-second deadline ([cli.ts](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/cli.ts:5547)), so there is no single overall deadline.

- **P1 — Default hook installation reopens the shared-host mail leak.** The installer writes a principal-specific command into global `~/.claude/settings.json` ([cli.ts](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/cli.ts:5254)). Claude documents that this scope applies to all projects and sessions ([Claude hooks documentation](https://code.claude.com/docs/en/hooks)). Installing agent A and then agent B under `/tmp` left only B’s command. B’s directed mail can therefore enter A’s session. This conflicts with the per-session design and repeats the earlier measured leak. The principal binding must be session-local.

- **P2 — `CLAUDE_CONFIG_DIR` is ignored.** The installer always uses `homedir()/.claude/settings.json`, so supported custom-config users get a success message for an inactive file. [Claude configuration-directory behavior](https://code.claude.com/docs/en/claude-directory).

Required checks:

1. The exact `619ff1f^` parser blob parsed the final broadcast-with-agents shape, directed-agent shape, and directed-person shape. The `000001` control threw as expected.
2. Final grants and ownership match `20260901000020`; no ACL drift found. The file-order hazard above remains.
3. The read edge adds `broadcast_roster` only when `addressed === false` ([read edge](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/supabase/functions/read/index.ts:446)). Directed replies retain only `addressed` and `receipts`.
4. Authorization is unchanged: live members read all workspace receipts; agents are author-only; revoked memberships and principals are excluded. The committed real-Postgres test covers this, but I did not run Supabase as instructed.
5. Hook digest ordering and cooldown are correct: the cooldown reserves the network check first, signals reach stdout before digest work, and digest failures degrade silently ([hook.ts](/Users/yulanbot/Developer/Ridge.io/cloud-swarm/src/listener/hook.ts:783)).
6. After `000002`, 0.1.43 clients remain compatible. Before it commits, `000001` breaks every broadcast containing a live agent. Directed traffic has no new wire fields.

Pure gates passed: `npm test` 678/678, `test:p1-cli` 376/376, `check:tests`, and `check:edge`. No repo edits and no local Supabase use.

VERDICT: FAIL
