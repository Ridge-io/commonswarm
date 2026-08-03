# /goal — QA-010: the app cannot detect or recover from a dead session

Worker: **Lantern** (Codex). Lane: site auth-state correctness.
Clone: `/Users/yulanbot/Developer/Ridge.io/cloud-swarm` · Branch: `lead7/mvp-release-0.1.5`
**Frozen base: supplied by the launcher as `$FROZEN_BASE`, asserted in preflight.**
Owned: `site/src/lib/commonswarm.ts` and `site/src/components/app/LiveDashboard.astro` only.

## The defect, diagnosed by measurement against production — verify, do not re-derive

A signed-in owner cannot create a teammate invite. The UI reports
*"CommonSwarm did not create the invitation (unauthenticated)"* while appearing fully signed in.

The decisive probe was Supabase's own endpoint with the correct anon key:

```
GET /auth/v1/user
403 {"code":403,"error_code":"session_not_found",
     "msg":"Session from session_id claim in JWT does not exist"}
```

The access token is cryptographically sound — `alg: ES256`, `kid` matching the project JWKS exactly,
**not expired**. The *session it references* is gone. Signature checks pass; existence checks fail.

That explains every symptom:

| Path | Verifies | Observed |
|---|---|---|
| Reads via PostgREST | JWT **signature** only | **200** — feed, members, agents all load |
| Writes via `/functions/v1/command` | `auth.getUser()`, which checks the **session exists** | **401 `unauthenticated`** |

**The client never notices.** `site/src/lib/commonswarm.ts:91-96` uses `auth.getSession()`, which is
a localStorage read by design and never contacts the server. Nothing validates. And the command path
(`commonswarm.ts:360-372`) surfaces a 401 as a raw string with no special handling.

**Measured: the state is permanent.** After a full page reload — still shows signed in, still hides
the sign-in form, still stores the dead token, `/auth/v1/user` still 403.

A user whose session is invalidated anywhere — signed out on another device, session rotated, access
revoked — is trapped: the UI insists they are signed in, their feed keeps loading, every action fails
telling them they are not, and reloading does not help. The only escape is guessing that "Sign out"
is the remedy.

## The fix

Two changes, both narrow:

1. **Validate on load.** Where the app currently trusts `getSession()`, confirm the session is real
   with a server round-trip (`auth.getUser()`). If it fails, clear the local session and show the
   signed-out state rather than a signed-in shell that cannot act.
2. **Treat a command 401 as a dead session.** When `/functions/v1/command` returns 401
   `unauthenticated`, do not surface it as a bare error string. Clear the session and route the user
   to sign in again.

Keep the added round-trip off the hot path where you reasonably can — validating once on load and on
a 401 is sufficient; do not validate before every read.

**Do not change the error copy to be vaguer to hide this.** The product voice says output tells the
user what just happened, what is now true, and what happens next. "Your session expired — sign in
again" is the honest version of this state.

Note also: an **empty-email** submission currently produces the *identical* "unauthenticated"
message, so a validation failure is indistinguishable from an auth failure. Fix that too — an empty
or malformed email should say so.

## Tests — must discriminate

Add tests that fail before your change and pass after:

- a session whose `getUser()` returns 403 `session_not_found` must result in the signed-out state,
  **not** a signed-in shell;
- a command response of 401 `unauthenticated` must clear the session and prompt re-auth;
- an empty/malformed email must produce a validation message distinct from the auth message.

Prove **RED before, GREEN after** for each. If a test cannot be made to fail first, say so plainly —
it does not discriminate and the fix is unproven.

## Gates

`npm --prefix site test`; clean site build (`cd site && rm -r -- dist && npm run build`);
`npm --prefix site test` again on fresh output; root `npm test`. **Do not deploy.**

## Deliverable

Commit once, push, record the new SHA. Write
`/Users/yulanbot/Developer/Ridge.io/cloud-swarm/scratchpad/2026-07-31-common-swarm-handoff/QA-010-FIX-RESULT.md`
with the diff, each red-then-green proof, gate counts, and the new SHA.

## Non-goals

Nothing outside the two owned files. No `src/`, `supabase/`, migration, edge function, version bump,
deploy, tag, or release. **Do not attempt to fix the server** — the server behaviour (rejecting a
token whose session is gone) is correct; the client's failure to detect it is the defect. Do not join
the swarm or set swarm status. No broadcast, no `AdvisorClaude2`.

## Stop conditions

Preflight fails · a test cannot be made red first · the fix appears to require server changes (stop
and report — that is a scope finding) · any site test regresses.

State what you did **not** establish: the deployed site is unchanged until deployment, which is not
yours to do, and this fix does not address why the session was invalidated in the first place.
