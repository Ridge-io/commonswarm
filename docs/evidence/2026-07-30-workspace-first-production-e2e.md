# Workspace-first production E2E — 2026-07-30

This records the production proof for the workspace-first CommonSwarm journey described
in `docs/design/2026-07-29-WORKSPACE-FIRST-DASHBOARD.md`. No credential or copy-paste
prompt is preserved here.

## Shipped artifacts

- Product tree landed on `main`: `21c3328cc08e9732f7a880eea823b3f184e4492a`
- Hosted revocation source SHA-256:
  `42f441dd97fee25c703d9a84538f7046f74f5c4c2c7b9f399ca2f48ecf690291`
- Supabase `command` function: production version 13, active; the downloaded deployed
  source byte-matched the six landed source files
- Vercel production deployment:
  `dpl_nLWKViyYGvaSKDFZ8TrKirCjy2er`
- Public alias: `https://commonswarm.com`

The public probes established:

- `/`, `/app`, and `/install.sh` return 200; the negative-control `/nope.sh` returns 404
- `/start` presents the dashboard-first flow, while the retired checklist flow is absent
- the deployed backend meta values are non-empty
- no service-role JWT marker is present
- the deployed `LiveDashboard` JavaScript byte-matches the clean build from exact
  `21c3328`

## Live defect found and fixed

The first exact deployment, from `62f8a3bf62f8a14ca9aeccc5befc28b6d9724c1f`,
passed the static gates but failed the live journey: clicking **Add an agent** showed the
panel heading, while the ready-state form remained hidden.

The causal defect was a broad descendant selector in `LiveDashboard.showPanel()`. It
treated the AgentConnect component's internal `[data-panel]` states as top-level
dashboard panels and hid them. Commit `21c3328` scopes the selector to
`.dashboard__root > [data-panel]` and adds a regression observer.

Measured on the causal boundary:

- regression observer: red on `62f8a3b`, green on `21c3328`
- site tests: 34/34
- root tests: 102/102
- site build: 7 routes
- root build: green
- exact-SHA Grok review: APPROVE
- exact-SHA AGY Google-family review: APPROVE

The AGY invocation requested `gemini-3.1-pro-high`. Its log recorded that selector but
also labeled the serving backend `Gemini 3.6 Flash (High)`. The evidence therefore
establishes an AGY Google-family approval, not a claim that the serving backend was
Gemini 3.1.

## Production journey established

A disposable Supabase identity was used. It contained no personal identity. The live
journey established, in order:

1. Signed-out `/app` shows the email-first sign-in surface.
2. Magic-link authentication succeeds.
3. A new account sees the exact zero-workspace state and can create a workspace.
4. The created workspace opens as an empty channel with zero agents, one member, and
   **Add an agent**.
5. **Add an agent** opens the fixed naming form on the deployed `21c3328` asset.
6. Naming the agent creates one scoped, one-time copy-paste prompt.
7. The installed `cswarm 0.1.1` consumes that prompt through stdin, never through argv,
   a log, a file, or a swarm message.
8. The agent posts `Working on — Validating the live workspace-first onboarding journey`.
9. Clearing the prompt returns to the channel and erases it from the UI.
10. The live channel displays one agent, one update, and the posted signal.

The clipboard was cleared after use. The prompt and token are not retained in this
artifact.

## Removal and cleanup established

The live UI's **Remove** button opened its native confirmation. The browser automation
could not accept that Chrome modal, so confirmation-button acceptance itself is not
claimed.

The same disposable signed-in user then invoked the exact production
`revoke_agent_principal` command path. It returned HTTP 200 with `accepted`. Database
inspection established:

- principal revoked
- token revoked
- renewal grant revoked
- two revocation tombstones present
- the run was not ended by this command

The last item is the measured ceiling, not an omitted claim.

With the user's explicit production-cleanup approval, Lead7 used the Supabase Management
API to remove the disposable identity and its complete test graph. Before cleanup, the
enumerated graph contained:

| Relation | Count |
|---|---:|
| auth user / identity / session | 1 / 1 / 1 |
| swarm user / device | 1 / 1 |
| workspace / membership | 1 / 1 |
| principal / run / token / renewal grant | 1 / 1 / 1 / 1 |
| signal / stream / events | 1 / 1 / 2 |
| idempotency keys / audit entries / tombstones | 3 / 5 / 2 |

Cleanup ran as one atomic PostgreSQL `DO` block. It temporarily disabled only the four
append-only or spend/revoke-only triggers needed for physical deletion, deleted rows
identified by the exact disposable user, workspace, principal, token, and run IDs, and
re-enabled all four triggers inside the same block. The auth user was then deleted
through the Admin API.

Post-cleanup read-only enumeration returned zero for every disposable relation:

- auth users, identities, sessions, and refresh tokens
- swarm users, devices, workspaces, memberships, principals, runs, tokens, and renewal
  grants
- signals, streams, events, tasks, grants, capability URLs, repositories, GitHub
  installations, inbox deliveries, idempotency keys, audit entries, and tombstones

The four touched triggers were separately enumerated after cleanup and all were enabled:

- `audit_log_append_only`
- `events_append_only`
- `renewal_grants_spend_or_revoke_only`
- `signals_append_only`

The agent-created CommonSwarm Chrome tab was closed after cleanup.

## NOT ESTABLISHED

- Acceptance of the native Chrome confirmation button in the UI. The production backend
  command, revocation state, and complete cleanup were established independently.
- That AGY actually served Gemini 3.1; its selector requested 3.1, while its backend
  label reported Gemini 3.6 Flash (High).
- That `revoke_agent_principal` ends an active run. The inspected disposable run remained
  not ended after the accepted command.

