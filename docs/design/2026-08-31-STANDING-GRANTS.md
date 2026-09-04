# Standing grants: permanent agents without a permanent secret

Status: IMPLEMENTED AND NOW THE DEFAULT. Design by Quill (Grok 4.6, principal ed2c60f4),
2026-08-31, in reply to ask 6bb838de; recorded by CSwarmDevLead. Operator direction that
motivated it (2026-08-28): "if the user wants a permanent agent, why not allow them to have
one... there's got to be a reasonably secure way to do that."

> **The line above read "Status: PROPOSAL … Not yet implemented; nothing here is applied."**
> It is kept here because readers arriving from older links will have met it. What changed:
>
> - **2026-09-01**, commit 93a2a64 and `supabase/migrations/20260901000001_standing_grants.sql`
>   applied the grant row, the fences, and `cswarm token mint --standing --confirm-standing`.
> - **2026-09-04** made standing the default for agents added through the web flow
>   (`site/src/lib/agent-connect.ts` sends `renewal_kind: "standing"`), and fixed the idle
>   suspension this document specified but the first migration under-implemented. See the
>   correction under "Loud lapse" below.
>
> **`cswarm token mint` is NOT affected.** Standing there still costs `--standing
> --confirm-standing`; only the web add-agent flow defaults to it.

## Principle

Never mint a permanent bearer. "Permanent" is a **standing grant**: an unexpiring row with no
secret in it. Tokens stay short (today's 1h/8h band) and rotate against the grant. Revoking the
grant kills every descendant token. Standing grants are host-bound by default.

## Mechanism (additive fields on the grant row)

- `kind`: `timeboxed` | `standing`
- `horizon_expires_at`: NULL only when standing
- `successors_remaining`: NULL = unlimited (standing only)
- `bound_device_id`: default REQUIRED for standing; never for timeboxed 30d grants
  (CI runners and laptop handoffs need portability — do not bind those)
- `last_used_at`, `last_used_device_id`, `last_used_from` (host fingerprint, not IP)
- `new_host_at`: stamped on first use from a foreign device
- `suspended_at`: idle kill switch — LOUD suspension, not silent expiry
- `revoked_at`: the only hard kill

Renewal issues a successor token iff: grant not revoked/suspended; predecessor matches lineage
and is unsuperseded; standing OR inside horizon; device matches binding when bound; TTL stays in
the 1h/8h band — never lift a bearer's expires_at to infinity.

Why this is the reasonably-secure shape: a harvested token (the MrSentry incident) still works
only until TTL. It cannot KEEP working — renewal needs the live predecessor plus local 0600
state, and a standing+bound grant refuses a foreign device.

## Loud lapse for standing = suspension

Idle > 14d: set `suspended_at`, send a directed note to the owner ("standing grant idle 14d —
resume or revoke"). Resume is one explicit owner action; never automatic.

> **CORRECTION (2026-09-04): the resume in that last sentence did not exist until now.**
> `20260901000001_standing_grants.sql` implemented the pause and not its exit: the row trigger
> raised `SWARM_RENEWAL_GRANT_UNSUSPEND` on ANY un-suspend, so 14 idle days killed a standing
> grant permanently and the only recovery was a new grant on a new lineage. `cswarm whoami`
> said so out loud — "Next step: ask a workspace owner to revoke this grant and mint a new
> credential" — which offered the permanent kill as the cure for the recoverable pause.
>
> `20260904000001_standing_grant_resume.sql` installs the missing half:
>
> - `suspended_at` is still **never cleared**; a resume is recorded forward in `resumed_at`,
>   `resumed_by`, `resume_count`, so the lapse stays readable.
> - `suspension_active` is a generated column and is the ONE definition of "paused right now".
>   Every reader — preflight, successor fence, use recorder, both read functions, and the
>   command edge — asks it rather than testing `suspended_at`.
> - `swarm.resume_renewal_grant(workspace, grant, user)` is the only exit, gated exactly like
>   `revoke_agent_principal` (owner/admin, or the member who owns the principal), reachable as
>   the `resume_renewal_grant` command and `cswarm grant resume`, and audited in
>   `swarm.audit_log`. Agent credentials are refused: an agent may not lift a pause imposed on
>   itself.
> - **The idle clock restarts at the resume.** Measured from `last_used_at` alone the next
>   preflight would re-pause immediately, because a grant is paused precisely for being idle.
> - **Revocation is unchanged and still permanent.** A revoked grant can never be resumed, at
>   three independent fences: the function refuses it, the row trigger raises
>   `SWARM_RENEWAL_GRANT_RESUME_AFTER_REVOKE`, and a table CHECK refuses the row shape.
>
> The directed note to the owner is still **NOT built**. The pause surfaces on the dashboard
> badge and in `cswarm whoami`; nobody is messaged when it happens.

## Dashboard (owner-visible, per principal)

Grant kind (30d / standing), listener live/down, last-used + host, and one risk badge, first
match wins: REVOKED / SUSPENDED / NEW HOST / UNBOUND / STALE (>7d) / HORIZON 3d. One button:
**Revoke grant** (not revoke-this-token). Standing row copy: "This does not expire. Revoke is
the only kill switch." First use from a new host = directed note + badge — that observability
is what expiry was substituting for. Show token_id last-4 + issued_at (to match ps incidents);
never the secret.

> **CORRECTION (2026-09-04): that row copy was false and is retired.** It claimed revocation
> was the only thing that stopped a standing grant while 14 idle days also stopped it — and a
> test pinned the sentence literally, which made it stable rather than true.
> `site/src/lib/standing-grants.ts` now ASSEMBLES the paragraph from
> `STANDING_GRANT_RULES`, which is built from `STANDING_IDLE_PAUSE_DAYS` and
> `STANDING_RESUME_ACTORS`. The rendered text is:
>
> > Access does not expire. 14 days with no use pauses it; a workspace owner, an admin, or the
> > member who added the agent can resume it. Revoking it is the only permanent stop.
>
> The SUSPENDED badge is now correct across a resume without any dashboard change, because
> `swarm_read.renewal_grant_roster` reports EFFECTIVE suspension: a resumed grant returns NULL
> in `suspended_at`. **Still missing from the dashboard: a Resume button.** A paused grant
> shows the badge and offers only Revoke, so the recovery path is CLI-only
> (`cswarm grant resume --renewal-grant-id <uuid>`) until that button is added beside the
> existing revoke control in `site/src/components/app/LiveDashboard.astro`.

## Leak-day runbook

1. Revoke the grant — every live token 401s, the listener cannot rotate.
2. Kill long-lived local processes started with the old credential (a process still holding the
   predecessor in memory outlives the file).
3. Read last_used_at / last_used_device_id: did the thief renew, or only ride the TTL window?
4. Remint a NEW grant (new lineage). The principal (name/history) survives.

## CLI

`cswarm token mint --standing` behind an extra confirm flag; default stays
`--renewal-horizon-days 30`. No flag may make a BEARER permanent.

## Blockers / notes against current schema

The grant is implied today by horizon/renewal fields rather than being a first-class row;
making it one is the main migration. `--renewal-horizon-days` is currently display-only (known
open defect) — the grant row is where it becomes real.

## Sequencing

Implementation is deliberately DEFERRED until the hook principal-scope fix (L13) ships —
both touch src/cli.ts and lanes must not overlap. Next concrete action: spec the migration for
the grant row, then server enforcement, then CLI, then dashboard badges.
