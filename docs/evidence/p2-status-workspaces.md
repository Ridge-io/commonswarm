# Evidence — P2-2 `coswarm status` + workspace visibility/selection (2026-07-24)

**Landed:** `053e972` on `main`. **Hosted:** migration `20260724000002_status_workspaces.sql`
applied; PostgREST exposed schemas widened to include `swarm_read`. **Design:**
`docs/design/P2-STATUS-WORKSPACES-BRIEF.md` v1.1 + §6 rulings; seam handoff
`docs/design/P2-2-SEAM-NOTES.md`. **Built by:** Quill [codex]. **Reviewed by:** Sable [grok].
**Verified + landed by:** Lead4.

## What shipped

- **`coswarm status`** — one screen in plain words: you, project (name **and** id), members,
  agents, tasks, leases rendered as *"held by X, expires in 12m"* rather than raw epochs. Zero
  memberships renders identity + guidance and **never errors** (ruling §6.1).
- **`coswarm workspaces`** — every row shows **name AND full id**, so there is always an
  unambiguous copy-paste target. Archived projects listed with a marker.
- **`coswarm use <full-id|exact-name>`** — exact selection only. No slug aliases, prefix
  matching, or closest-name resolution; the failure mode avoided is **silent wrong-tenant
  selection**. Ambiguous name fails, lists collisions, leaves the default **unchanged**; id
  always works under collision; confusable names that sanitize identically are ambiguous;
  foreign/unknown id fails with **no profile write**.
- **Five-step resolution** across scoped commands: flag → `SWARM_CLOUD_WORKSPACE_ID` → live
  profile default → sole live membership → fail closed with the list. A revoked default warns
  once and **clears** (no zombie project selected), then continues resolving.
- **No interactive picker**, TTY or otherwise — and this is **structural**: the module has no
  `readline`/`createInterface`/`stdin` dependency, so it cannot prompt by mistake.
- **Agent tokens** require flag/env; with neither and no human credential the command fails
  **not-logged-in** rather than deriving tenant state from a run-scoped capability (§6.3).

## The bug this fixes

`src/cloud/auth.ts:410` — `discoverSoleWorkspace` persists a default workspace **only when the
identity has exactly one live membership**. Any human in two or more workspaces therefore could
not invite anyone after a logout: `invite` needed `--workspace-id`, the flag §1c called
undiscoverable (**bug #3**). A second *real* collaboration triggers it identically.

Found by the **uxtest harness before it ever ran a round** — from read-only observation while a
worker was stood down. Operator ruled (**decision #84**) to fix the product rather than authorize
a destructive test-data workaround.

## ★ Second root cause of bug #3, found at deploy time

**Hosted PostgREST was never exposing the `swarm_read` schema.** Before this deploy:

```
GET /rest/v1/workspaces  (accept-profile: swarm_read)
→ 406 PGRST106 "Only the following schemas are exposed: public, graphql_public"
```

`discoverSoleWorkspace` treats any non-ok response as "no default" (`auth.ts`: `if
(!response.ok) return null`), so **every `swarm_read` read from the CLI had been failing silently
on hosted** — including the workspace-default discovery. That means bug #3 had **two** causes: the
sole-membership heuristic *and* an unexposed schema. Fixing only the heuristic would have shipped
a still-broken hosted experience, and the failure would have looked like the heuristic again.

**Fix applied surgically** via the Management API (`PATCH /v1/projects/{ref}/postgrest`,
`db_schema: public,graphql_public,swarm_read`).

Post-fix canary — the schema is reachable and **anon is still denied**, which is the correct
shape:

```
workspaces      → 401 42501 "permission denied for schema swarm_read"
member_profiles → 401 42501 "permission denied for schema swarm_read"
memberships     → 401 42501   (pre-existing view, same behavior — consistent)
```

Anon denial comes from `REVOKE ALL ON ALL TABLES IN SCHEMA swarm_read FROM anon`
(`p1_schema.sql:789`); `authenticated` holds USAGE + SELECT (`:785-786`), so a logged-in user
works while anon cannot read. Exposure widens the API surface **only** to views that are
`security_barrier`, owner-pinned, and `is_member`-gated.

## ★ LANDMINE: never run `supabase config push` against hosted

`supabase/config.toml` carries **scaffold defaults** for auth:

```
site_url = "http://127.0.0.1:3000"
additional_redirect_urls = ["https://127.0.0.1:3000"]
```

Hosted holds the real, hard-won values — `uri_allow_list = http://127.0.0.1:*/callback` (gap #6,
proven at port 53493 in the first dogfood) and an enabled GitHub provider. A blanket `config
push` would **overwrite the allowlist with the scaffold default and break PKCE login entirely**.

Config was therefore **not** pushed; only the single PostgREST setting was PATCHed. Verified
after the change:

```
uri_allow_list: http://127.0.0.1:*/callback     ← intact
external_github_enabled: True                    ← intact
```

If hosted config ever needs to change, change **only the specific setting**, then re-verify
`uri_allow_list` and the GitHub provider.

## Authority

Two **additive** membership-gated views only — no table or policy changes:

| View | Predicate |
|---|---|
| `swarm_read.workspaces` | `swarm.is_member(workspace_id, auth.uid())` |
| `swarm_read.member_profiles` | `revoked_at IS NULL AND swarm.is_member(workspace_id, auth.uid())` |

Both `security_barrier`, both owner-pinned to `swarm_admin`, anon revoked, grants matching the P1
convention (necessary rather than redundant — `GRANT ON ALL TABLES` covers only objects existing
at grant time).

The rule this slice settled: **NO NEW AUTHORIZATION PREDICATE**, not "no new views." The stricter
wording — which the brief carried in v1 — would have banned project and member *names* and shipped
id-only lists, reopening the exact friction the slice removes. An over-strict rule produces a
crippled screen or someone smuggling names through `service_role`, not safety.

Foreign and unknown workspace ids produce **byte-identical** errors, so `use` is not an existence
oracle for other tenants (`tests/p1-cli/workspaces.test.ts:319` asserts serialized equality).
Attacker-influencable project, member, agent and task labels are sanitized (control/bidi/ANSI)
before render.

## Verification (Lead4, independent execution)

- `npx tsc --noEmit` clean
- core `npm test` — **66/66**
- `npm run test:p1-cli` — **49/49** (was 37)
- `npm run test:p1-server` — **12/12**, including *"P2-2 read views retain the membership gate and
  hide foreign projects"*
- `src/protocol` untouched; generated bundle **zero drift**
- `git diff --check` clean
- migration applied to **local first**, then hosted (`migration list --linked` shows
  `20260724000002` on both sides)
- CLI rebuilt and relinked; `--help` exposes `status`, `workspaces`, `use <full-id|exact-name>`

Review: Sable returned **GO** with all five focus areas PASS — the `member_profiles` join, the
five-step resolution, `use` collision safety, agent-token no-inference, and label sanitization.
Four MINOR/NIT items, none blocking.

## Residual

- Name matching is **case-sensitive** after control-stripping. Safer against wrong-tenant
  selection than case-folding; the usage string reads `use <full-id|exact-name>` to make that
  plain.
- Sole-membership resolution re-persists the default even if a sole member cleared it
  deliberately. Acceptable for this fix; optionally persist only when the default was null.
- Workspace `archived_at` has **no server-side enforcement** (`command/index.ts:1105` gates only
  *repositories*). Archived projects are listed with a marker and remain selectable; "live" keeps
  meaning `membership.revoked_at IS NULL`. **Known gap**, deliberately not papered over
  client-side (ruling §6.4).
- `--json` deliberately not added to pre-existing commands; the resolution failure is
  machine-readable without it. Unifying `--json` is a future slice (§6.2).
