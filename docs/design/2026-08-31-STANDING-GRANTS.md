# Standing grants: permanent agents without a permanent secret

Status: PROPOSAL — design by Quill (Grok 4.6, principal ed2c60f4), 2026-08-31, in reply to
ask 6bb838de; recorded by CSwarmDevLead. Operator direction that motivated it (2026-08-28):
"if the user wants a permanent agent, why not allow them to have one... there's got to be a
reasonably secure way to do that." Not yet implemented; nothing here is applied.

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

## Dashboard (owner-visible, per principal)

Grant kind (30d / standing), listener live/down, last-used + host, and one risk badge, first
match wins: REVOKED / SUSPENDED / NEW HOST / UNBOUND / STALE (>7d) / HORIZON 3d. One button:
**Revoke grant** (not revoke-this-token). Standing row copy: "This does not expire. Revoke is
the only kill switch." First use from a new host = directed note + badge — that observability
is what expiry was substituting for. Show token_id last-4 + issued_at (to match ps incidents);
never the secret.

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
