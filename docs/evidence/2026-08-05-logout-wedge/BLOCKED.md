# `lead/logout-wedge` was BLOCKED — RESOLVED 2026-08-07 on `lead/logout-honest`

> **STATUS 2026-08-07: fix PREPARED and pending the D-036 gate. NOT landed, NOT released.**
> Marking it shipped here would violate the repo's own *pushed ≠ landed ≠ applied* rule
> (Plumb). This line gets updated to "shipped" only against the landed and released artifact. The original branch was
> never merged; it also predated 0.1.7 and would have reverted that release's refusal-tolerance
> work, so the logout material was rebuilt on a fresh branch off `main`. The record below is
> kept intact because the *shape* of the failure is the useful part.
>
> **BLOCKER 1 — the swallowed server outcome — fixed properly, not by weakening copy.**
> `client.auth.signOut()` swallows 401/403/404 and returns `error: null`. But it is a thin
> wrapper over `admin.signOut(jwt, scope)`, which is public and **returns the error with its
> status intact**. Measured on a fake GoTrue: high-level `signOut` reports `null` on a 403
> while `admin.signOut` reports `AuthApiError/403`, and both report `null` on a real 200 — so
> it discriminates. The CLI now says "the server confirmed it" only on the path where the
> server actually answered and accepted.
>
> **BLOCKER 2 — legal-surface copy — corrected at all three sites, in two passes.** The first
> pass fixed only the `--all-devices` claim and left ordinary `logout` asserting unconditional
> local success, which is false on every retained path. Plumb caught the survivor. `README`,
> `privacy.astro`, and `terms.astro` said sign-out "ends every session everywhere". They now
> say it **asks the server to**, and privacy — the page where a user decides whether they are
> protected — adds that the command reports whether the server confirmed it.
>
> **A third bug was found while fixing those two** and is the one most likely to have bitten a
> real user: every failure path told the operator to "run cswarm logout again", but the
> refresh had already **consumed** the stored token and nothing wrote the rotated one back. The
> retry therefore depended on GoTrue's parent-token grace rather than on a credential we hold.
> The rotated token is now persisted before the revoke is attempted — a write, not a delete.
>
> **What was deliberately NOT built**, and stays not built: a classifier on the `/logout`
> response. The logout leg is binary — confirmed, or retain-and-report. Classifying it (e.g.
> "404 means already gone, so delete") is precisely how versions 1–3 of this fix each
> introduced a new defect, and the refresh leg already owns dead-session classification and
> resolves it on retry.

---

Two blockers survive the corrected fix. Both were raised by Plumb (cross-family inversion arm)
and both were then **reproduced independently by CswarmLead** rather than accepted on report.

## The story so far, because the shape matters

1. Dogfooding found a real wedge: `logout` threw when `refreshSession` failed, so it never
   reached `store.delete()`. `status` said "log in"; `logout` refused to reset. No way out.
2. First fix deleted the credential on **any** refresh failure. Verity blocked it: a transport
   failure (offline/DNS/5xx) never got an answer, so the token may be live. Confirmed by
   measurement — a client pointed at a closed port returns `AuthRetryableFetchError`, status 0.
3. Second fix gated the delete on `isAuthRetryableFetchError`. **Still wrong.** See below.

**Three versions, each fixing a real defect and each introducing another, all in the same
direction: destroying state on input whose cause was not established.**

## BLOCKER 1 — `AuthApiError` is not uniformly terminal

`isAuthRetryableFetchError` does not cover transient conditions the *server answers*.
Measured on this tree against a fake `/auth/v1/token`:

```
429 over_request_rate_limit
  name                      = AuthApiError
  status                    = 429
  isAuthRetryableFetchError = false     <-- so the current code DELETES
```

A rate-limited user running `cswarm logout` still has a live credential destroyed and is told
their session had expired. Supabase documents `over_request_rate_limit` as "try again in a few
minutes"; `request_timeout` and `conflict` are likewise retry conditions.

**Also unhandled — ambiguous success:** the refresh can rotate server-side and the *response*
can be lost. Supabase's parent-of-current-active rule exists so the retained parent token can
recover that child on retry. Deleting destroys that recoverable handle, and on `--all-devices`
can make revocation impossible from this CLI while a live server session remains.

**The regression test passes falsely.** It exercises one `400 invalid_grant` shape and never
contrasts a transient error, so it cannot distinguish the fix from the bug.

## BLOCKER 2 — the containment claim is still reachable when nothing was revoked

`auth-js`'s high-level `signOut` deliberately **swallows 401/403/404** from `/logout` and
returns `error: null`, so it can still clear local browser state. Measured on this tree:

```
refresh -> 200, then /auth/v1/logout -> 403
  signOut error = null        <-- SWALLOWED
  outcome       = "revoked"
```

The CLI then prints *"Every refresh session for this identity was revoked for account-wide
containment"* although the server returned **forbidden**. The `LogoutOutcome` type fixed the
refresh-failure path but **cannot recover information the library discarded**.

## Required shape (Plumb's, adopted)

- **Closed terminal allowlist.** Delete only on a positively-recognised terminal condition
  (e.g. `refresh_token_not_found`, `refresh_token_already_used`, `session_not_found` /
  `session_expired`, each verified). Unknown / retryable / rate-limit / timeout / conflict
  **retain** the credential. Safe default is retain, not delete.
- Classify via `isAuthRetryableFetchError` / `isAuthApiError` and stable codes. **Never on
  message text** (D-053).
- **An explicit local-clear escape hatch** for legacy unclassified invalid-token responses,
  so the original wedge stays fixed without classifying every error as terminal. This is the
  key move: it decouples "let the user escape" from "guess that the token is dead."
- For the account-wide claim: either use a call that preserves the logout HTTP outcome, or
  **weaken the copy to what was observed.**

## Standing lesson

> Declining to classify is not neutral when the default action destroys state. — Verity

Both blockers are the same error: an irreversible action applied to an input whose cause was
assumed rather than established. D-053 forbids branching on message **text**; it does not
excuse skipping the distinction. Type- and code-based classification is what it asks for.

Gates are green and prove nothing here: `test:p1-cli` 156/156, `npm test` 495/495, build and
`check:tests` clean. **Neither causal failure is covered by any of them.**
