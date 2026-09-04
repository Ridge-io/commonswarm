# An agent added in /app gets a standing grant — what was measured

Lane `lane/standing-default-app`, from `origin/main` @ `e3df06b`. Operator decision 2026-09-04:
"when I add an agent, I want the default to be that it never expires."

Scope: `site/` only. No server, migration, CLI, or reducer file changed.

## What the change is

`site/src/lib/agent-connect.ts` now sends `renewal_kind: "standing"` in the `mint_agent_token`
body and reads `grant_kind` / `horizon_expires_at` back off the accepted response instead of
computing a 30-day horizon of its own. Copy on the connect form and in the roster says what is
true. Nothing on the server moved.

## What was established, with the citation that decides it

**No server change is needed.** The wire type already accepts `renewal_kind`
(`supabase/functions/command/index.ts:155-156`); the validator accepts standing at `:1952-1953`;
the prepared command nulls the horizon at `:2871-2874`; the grant INSERT writes
`kind=standing, max_successors NULL, horizon NULL` at `:4037-4061`, which the CHECK
`renewal_grants_kind_shape` accepts (`supabase/migrations/20260901000001_standing_grants.sql:59-64`);
the accepted response returns `grant_kind` unconditionally at `:7500-7509` and the idempotent
replay path carries it at `:2171-2177`. Verified line by line against this SHA.

**`renewal_horizon_ms: null` is a 400, absence is not.** `validRenewal` accepts standing only
when `cmd.renewal_horizon_ms === undefined` (`index.ts:1952-1953`). A present `null` is neither
that nor a valid timeboxed integer, so the arm returns 400 "mint_agent_token fields are
malformed or out of bounds" (`:2004-2008`). The wire TYPE says `number | null` (`:156`), which
is a trap. `JSON.stringify` serialises an explicit null, so the key is not written at all, and
`agent-connect-mint.observer.test.ts` asserts on the serialised string, not the object.

**RENEWAL FROM THE AGENT'S OWN MACHINE PASSES.** This was the claim most likely to be wrong and
one review arm got it backwards, so it is written out in full. The grant's `bound_device_id` is
the BROWSER's `cswarm-web` device row (`index.ts:4057`). The agent renews from a different
machine. It still passes, because renewal never accepts a device from its caller:

1. `renew_agent_token` accepts exactly one key, `kind` — `exactKeys(cmd, ["kind"])`,
   `index.ts:1647-1654`. A CLI cannot present a device id even if it wanted to.
2. The device handed to the preflight is `auth.agent?.device_id` (`index.ts:2839-2843`), which
   `agent-auth.ts:107-123` selects as `r.device_id` from `swarm.agent_runs` joined on the
   token's `run_id`.
3. That `agent_runs` row was created at mint from `prepared.wire.device_id` — the same browser
   device (`index.ts:3981-3986`).
4. The successor fence reads `run_device` the same way (`migration:337-341`) and compares it to
   `bound_device_id` at `migration:399-402`; the preflight does the same at `migration:216-226`.

So bound == presented by construction. Two consequences, both stated in the code comment and
neither dressed up as machine-locking: an app-minted standing grant can never read `UNBOUND` or
`NEW HOST`, so a copied credential renews from anywhere until it is revoked; and revoking this
browser's device row ends authentication for every credential minted from it
(`agent-auth.ts:139`, `device_revoked_at`).

**Revoke grant really does stop it, at once.** `AgentTokenRevoked` revokes the token, stamps
`renewal_grants.revoked_at`, and writes token and lineage tombstones
(`index.ts:3883-3944`). The copy may name it as the stop.

**Idle suspension is lazy, not scheduled.** `swarm.prepare_renewal_grant` suspends a standing
grant whose last use is older than `interval '14 days'` (`migration:199-207`), and that function
runs only on renewal. Every ordinary authenticated agent call restamps `last_used_at` through
`swarm.record_renewal_grant_use` (`migration:245-274`, called at `command/index.ts:7600` and
`read/index.ts:412`). So the honest sentence is "suspended at its next renewal", not "suspended
after 14 days" — an agent that comes back and calls before its renewal is due is not suspended.
The copy was corrected to say this after a review arm caught it. Suspension is one-way
(`migration:156-158`), and nothing un-suspends.

## Controls, and what each one would catch

Ten mutations were applied one at a time to a committed tree and reverted; each turned a named
test red. See `mutations.txt` beside this file for the run.

The drift control that matters most: `the idle rule the copy states is the idle rule the
database enforces` (`site/src/components/app/standing-grants.observer.test.ts`) parses
`interval '<n> days'` out of the migration and compares it to `STANDING_IDLE_SUSPEND_DAYS`.
`site/` cannot import a migration and has no shared module with `src/`, so the constant is a
mirror; this test is what makes the mirror safe. It is anchored on `RETURN
'renewal_idle_suspended'` rather than on `kind = 'standing'`, because that phrase appears first
in the CHECK constraints at the top of the migration and slicing from there measures the wrong
interval — the first version of this test did exactly that and failed.

## What was NOT established

- **The deployed edge function version.** The migration is applied (evidence:
  `docs/evidence/2026-09-01-v044/real-postgres-fold-apply.md`), and the committed function has
  the field. Whether the function currently serving `api.commonswarm.com` predates
  `renewal_kind` was not measured. If it does, `exactKeys` (`index.ts:1959-1967`) rejects the
  whole request and every add-agent fails with a 400 — loud and total, nothing minted. **Confirm
  the edge deploy before shipping the site.**
- **No live mint was run.** No local Supabase, no production mint, no dogfood. Every claim above
  is read from committed code or from a stubbed-transport test.
- `npm run test:p1-local` and `npm run test:p1-server` were not run (they need local Supabase and
  an exclusive DB slot on a shared host).

## Left undone, deliberately, and who owns it

- `site/src/components/connect/agent-prompt.ts` is outside this lane. Its `renewal()` falls into
  the `horizonExpiresAt === null` branch, which is TRUE but silent: the agent is never told its
  grant has no horizon, that idle days can suspend it, or that Revoke grant is the stop.
- `src/protocol/workspace-commands.ts:1133` tells an owner to "resume or revoke" a suspended
  standing grant. There is no resume anywhere in the code. That is a remedy naming a verb that
  does not exist — the pattern AGENTS.md records four instances of.
- `site/src/components/app/LiveDashboard.astro:2972` confirms revocation with "The agent will
  stop when its current bearer expires." Measured above: it stops at once. Pre-existing
  understatement, now fronting the primary off switch. Another lane owns that file.
- `site/public/api.md`, `site/public/llms.txt`, `site/src/pages/acceptable-use.astro` and
  `privacy.astro` still describe the old lifetime story. Outside this lane's file list.
- The `STALE` badge fires at 7 idle days for every grant kind. With standing as the default that
  is now the ordinary state of any agent idle over a weekend-plus. Product call, unchanged here.
