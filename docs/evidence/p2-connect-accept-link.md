# Evidence — P2-1 `coswarm accept <invite-link>` (2026-07-24)

**Landed:** `a823ab3` on `main`. **Hosted:** `command` Edge Function **v5**, ACTIVE
2026-07-24 18:17:10 UTC. **Design:** `docs/design/P2-CONNECT-UX-BRIEF.md` v2.1 + §2.10 + #83.
**Implemented by:** Mason [codex]. **Reviewed by:** Sable [grok]. **Verified + landed by:** Lead4.

## What shipped

The invitee's four-command path collapses to one command, each internal step narrating one
plain-language line — the direct answer to the §1c felt-dogfood feedback ("a lot of steps";
"I didn't really know what I was doing or why").

```
# before (4 commands, 5 concepts: PKCE/anon-key/capability/principal/run+epoch)
coswarm login --url … --anon-key … ; coswarm accept --invitation-token-stdin ;
coswarm principal create --name … ; coswarm token mint --principal-id … --run-id … --epoch …

# after
coswarm accept --link-stdin            # or: coswarm accept <coswarm://accept/...>
```

Machine order (§2.10): parse → origin pin → sanitized preview → login/skip → same-identity
guard → step-0 checkpoint → accept/recovery → principal → default/ready.

## Review chain (the process that produced this)

| Round | Verdict | Substance |
|---|---|---|
| brief v1 | **NO-GO** | 3 BLOCKING / 5 MAJOR — incl. an OAuth-phishing vector and a step that required breaking uniform-403 no-enumeration to work |
| brief v2 | **CONDITIONAL GO** | 4 residual MAJOR — incl. a *false-success* path introduced while fixing round 1 (R1) |
| brief v2.1 | **GO** | 5 implementation watch-outs folded (§2.10 canonical order, O2 hard exclusion) |
| decision #83 | **ACCEPT + 1 MINOR** | missing third collision case: `UNIQUE` is per-workspace, not per-owner |
| implementation | **GO** | all locked criteria PASS under Sable's independent run + code read |
| fix pass | **GO** | M1 checkpoint-convergence gap (a violation of our own brief §2.4) |

## Decisions recorded

- **#82 — the verb is `accept`, not `join`.** `SWARM-CLOUD.md:696` locks *"members accept
  invites; agents join swarms — the verbs are never interchanged"*, and §7 hardened that exact
  split through multi-model review. The baton's colloquial "`coswarm join`" was therefore
  unavailable; this **widens the existing `coswarm accept`** rather than adding vocabulary.
  Legacy bare `swm_inv_` positional and `--invitation-token-stdin` are unchanged and
  principal-free.
- **#83 — optional `--name`, link mode only.** Own live principal → reuse (idempotent). Held
  by **another member's live** principal or **any revoked** row → ONE uniform "already taken"
  error, **never silently renamed** (`UNIQUE (workspace_id, name)` is per-workspace, not
  per-owner — `migration:181`). Auto-generated names may be suffixed (cap 5); user-chosen
  names never are. Rejected: redirecting to `coswarm principal create` — it reintroduces
  multi-command friction *after* membership is committed, stranding the user mid-state.

## Security properties, each tested

- **Origin pin** — build-time allowlist (hosted + loopback); an unknown origin refuses and
  requires **re-typing the exact origin** via padded `timingSafeEqual`; non-interactive
  (`--json` / `--link-stdin` / no TTY) **hard-fails before login** and ignores the dev-only
  `COSWARM_DEV_ALLOWED_ORIGINS`. This closes a real OAuth-phishing vector: the link binds the
  endpoint, and `cloudTarget()` constrains URL *shape* but not *host*. The old four-command
  path made the human type `--url` — accidental protection the one-command collapse removed.
- **Never decodes an accept 403 body** — recovery branches on status only; `CommandHttpError`
  is thrown before JSON parsing. Uniform-403 no-enumeration (#80f) intact.
- **Membership-at-hint is not proof of consumption** — a forged/stale `workspace_id` hint
  naming a workspace the user already belongs to must **not** report success. Required test:
  `accept-link.test.ts:362`, asserting `doesNotMatch(message, /now a member|accepted/i)`.
- **On 200 the server's `workspace_id` always beats the hint.**
- **No roster oracle** — every `agent_principals` read is owner-scoped (`workspace_id` +
  `owner_user_id` + `name=eq` + `revoked_at=is.null`); `create_agent_principal` is
  authoritative for "taken". An unfiltered `name=eq` read used only to branch error copy is
  explicitly forbidden.
- **Labels** — server-derived, fresh-response-only (absent on replay; a SQL leak-check proves
  they never reach event payloads), control/bidi/ANSI-stripped **server and client**, and
  authoritative for nothing.
- **Secrets** — raw link/token never logged, never in progress JSON, never in errors.
- **Convergence** — step-0 short-circuit makes zero accept/create calls; recovery from a null
  default writes the full checkpoint so re-runs converge without a live invitation (M1 fix +
  regression); a deliberately switched default is never stolen; a workspace-B principal never
  attaches under a workspace-A default (documented single-slot limit).

## Verification (Lead4, independent execution — both checkpoints)

- `npx tsc --noEmit` clean
- core `npm test` — **66/66**
- `npm run test:p1-cli` — **37/37** (was 16 pre-slice; +21)
- `npm run test:p1-server` — **11/11** on the live local stack
- core bundle regen — **zero drift** (`src/protocol` untouched)
- `git diff --check` clean

## Hosted proof

- `command` Edge Function deployed **before** relinking the CLI (Mason's landmine: fresh
  invite responses from the old function lack the labels/workspace adjunct the new CLI needs).
- `functions list`: **v5** ACTIVE, 18:17:10 UTC (was v4).
- Endpoint canary → HTTP 400 `{"error":"invalid_request"}` — the function's own vocabulary.
- **Live phishing-gate proof against the shipped binary:**
  ```
  printf '%s' "<link with url=https://evil.example.com>" | coswarm accept --link-stdin --json
  → coswarm: invite link targets unrecognized Cloud host evil.example.com;
    non-interactive mode refuses before login
  ```
  The security property holds in the installed CLI, not only in tests.
- CLI relinked; `--help` shows all four accept forms (two link, two legacy).

## Residual / next

- **Operator second-human drive** of the one-command flow (distinct verified email, lesson #5)
  is the real test of whether it *feels* simpler. Not yet done.
- Profile holds one workspace/principal slot — multi-membership users are R4-safe but not
  multi-principal-aware.
- Deferred, unchanged: `coswarm status` (P2-2), agent-skill layer (P2-3), hosted invite page +
  `https://` link form (P2-4), rate limiting, revoke wiring, T-sweep.
