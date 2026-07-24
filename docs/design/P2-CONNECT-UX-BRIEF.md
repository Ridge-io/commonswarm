# P2-connect-UX — sub-slice 1 design brief: `coswarm accept <invite-link>`

**Status:** v2 — REVISED after Sable[grok] model-inversion review (verdict NO-GO on v1;
BLOCKING 1–3, MAJOR 4–8, NIT 13 all folded). Ready for Sable re-review, then Mason.
**Author:** Lead4, 2026-07-24. **Governs:** the most direct answer to the §1c felt-dogfood
feedback.

> **v1→v2 changes:** verb renamed `join`→`accept` (spec-locked vocabulary, BLOCKING 3);
> `workspace_id` + server-derived labels added to the payload (BLOCKING 1, MAJOR 6);
> recovery state machine that never interprets a 403 (BLOCKING 1); principal reuse via
> `swarm_read.agent_principals` (BLOCKING 2); endpoint origin pin (MAJOR 4); one uniform
> recovery message replacing per-cause copy (MAJOR 5); agent-safe invocation specced
> (MAJOR 7); default-workspace overwrite narration (MAJOR 8); mint wording corrected (NIT 13).

## 0. Governing feedback (from SUCCESSION-PLAN §1c)

After personally driving the two-human connect, the operator said:
1. "**A lot of steps** — I'd like it much simpler. Driving this via an agent would help…
   I don't want the end user to need to do much via terminal."
2. "I **didn't really know what I was doing or why** — I don't understand why there were
   multiple steps; it all felt very technical."

**Design rule (both points collapse to one):** a user-facing step must either (a) explain
itself in one plain-language line — what just happened and why — or (b) not exist as a
user-facing step. This brief eliminates steps where possible and narrates the rest.

## 0b. Decision #82 — the verb is `accept`, not `join` (BLOCKING 3)

The baton (§1c NEXT PHASE item 1) wrote this as `coswarm join <invite-link>`. **That verb
is not available.** `SWARM-CLOUD.md:696` locks the vocabulary — *"a **member** is a human…
an **agent** is a registered AI process… Members **accept invites**; agents **join
swarms** — the verbs are never interchanged"* — and §7 (`:322`) hardened this exact
`join`-collision through multi-model review, because `swarm join` already means *an agent
registers on the roster*. Overloading `join` for human onboarding reopens the precise
confusion the spec closed.

**Ruling:** the human one-command verb is **`coswarm accept <invite-link>`**. It extends
the existing `coswarm accept` (which already consumes an invitation) rather than adding a
verb — so this is a *widening of an existing spec-correct verb*, not new vocabulary. The
operator's "join" in §1c was colloquial for "one command"; the intent (collapse the steps)
is fully preserved. Backward compatibility: `coswarm accept --invitation-token-stdin`
keeps working unchanged (§3.3).

## 1. The pain, concretely (today's invitee path)

Four commands + five concepts the invitee should never have to hold:

```
coswarm login --url … --anon-key …            # concept: PKCE, anon key, url
printf %s "$INVITATION_TOKEN" | coswarm accept --invitation-token-stdin   # concept: capability token, stdin safety
coswarm principal create --name laptop-agent   # concept: "principal"
coswarm token mint --principal-id … --run-id … --task-id … --epoch 1      # concept: run, task, epoch binding
```

## 2. The target: ONE command

```
coswarm accept <invite-link>          # or: coswarm accept --link-stdin
```

collapses **login → accept-invitation → principal (auto-named) → ready**, narrating each
internal step in one plain-language line. The human states intent; the CLI does the rest.

**Mint is explicitly OUT of this command** (correcting v1's wording — NIT 13): decision #80
says the `agent_runs` row is created *server-side at mint time*; **mint itself is still an
explicit client command** (`coswarm token mint`). There is no auto-mint today and this
sub-slice does not add one. Accept leaves a *mintable* state (persisted `workspace_id` +
`principal_id`), and the closing narration tells the user what comes next.

### 2.1 The invite link

`coswarm invite` emits a single opaque link carrying everything the invitee needs:

```
coswarm://accept/<base64url(payload)>
payload = {
  v: 1,
  url,                      # Supabase project base URL (origin-pinned at parse — §2.5)
  anon_key,                 # publishable JWT, not a secret
  workspace_id,             # UUID — CLIENT RECOVERY HINT ONLY, never authority (§2.4)
  invitation_token,         # swm_inv_… one-time capability, 24h TTL
  workspace_name,           # display-only, server-derived at emit (§2.6)
  inviter_display_name,     # display-only, server-derived at emit (§2.6)
  inviter_user_id           # optional; client-side identity-equality check only (§2.7)
}
```

**Why each field is safe to embed:**
- `url` + `anon_key` are public (the anon key is a publishable JWT, already printed in the
  README). Integrity is handled by origin pinning, not secrecy — §2.5.
- `invitation_token` is a one-time 24h bearer capability whose *entire purpose* is to be
  handed to the invitee. Embedding it in the link IS the delivery mechanism (same trust
  model as a Slack/GitHub invite URL). Spec-sanctioned: `SWARM-CLOUD.md:300` states a valid
  invite token is "a **narrowly-scoped disclosure capability** — it reveals only the
  workspace name, inviter, and coordinated repo names to whoever holds the link."
- `workspace_id` is a recovery hint. **It grants nothing:** every read using it is still
  `is_member(workspace_id, auth.uid())`-gated (`swarm_read.*`, migration `:633-667`), and
  all write authority still derives server-side from the invitation row (decisions #78/#80).
  A non-member holding it can read nothing.
- Labels are display-only and **never** authorize; see §2.6 for sourcing + sanitization.

### 2.2 Step sequence + narration

Each line is what the user SEES — plain language, no jargon, one per internal step:

0. **Preview, before any commitment** (no network): *"You're accepting an invitation to the
   "<workspace_name>" swarm from <inviter_display_name>. This will sign you in with GitHub
   and register this machine's agent identity."* Then proceed (or require confirm if the
   origin is unknown — §2.5).
1. **Login** — skipped if a live refreshable credential exists **for this link's
   CloudTarget** (not merely "any login" — MINOR 11): *"Signing you in with GitHub… opening
   your browser."* → *"Signed in as <email>."* / *"Already signed in as <email>."*
2. **Accept** (governed `accept_invitation`, capability-only, atomic): *"You're now a member
   of "<workspace_name>"."*
3. **Principal** (reuse-or-create, auto-named — §2.8): *"Registered this machine's agent
   identity: <name>."* / *"This machine already has an agent identity: <name>."*
4. **Ready**: *"You're connected to "<workspace_name>". Run `coswarm status` to see what's
   happening. Your agent gets its credential when it starts work (`coswarm token mint`)."*

If the default workspace changed, add one line (MAJOR 8): *"Your default workspace is now
"<new>" (was "<old>")."* Only auto-switch when the previous default is null or equals the
recovered id; otherwise narrate the switch explicitly.

### 2.3 Secret hygiene + backward compatibility

- **`--link-stdin` is the documented-safe form**; a positional link is supported as
  convenience with a **stderr warning** that it lands in shell history and `ps` (mirrors the
  FIX-3 precedent). Sable's refinement: immediate consumption does NOT close the
  pre-consumption window — the OAuth round-trip is up to `CALLBACK_TIMEOUT_MS` (5m) wide,
  and history/scrollback retain the payload forever.
- **Never log or echo the raw link or token** — not on success, not in errors, not in
  `--json`. Redact to `coswarm://accept/<redacted>` in any diagnostic.
- Existing `coswarm accept --invitation-token-stdin` (bare token, `--workspace-id`
  resolution) keeps working unchanged. Link mode and token mode are mutually exclusive
  inputs; supplying both is a validation error.

### 2.4 Recovery state machine — never interpret a 403 (BLOCKING 1)

**The constraint:** accept failures are outwardly UNIFORM by design (decision #80f;
`command/index.ts:2518-2519`, `962-963`). Unknown-hash, expired, consumed, revoked, and
already-member all return byte-identical `403 {"error":"forbidden"}`. v1's "already a member
→ narrate success" was therefore **unimplementable from the accept response** without
breaking no-enumeration. The fix is membership-side, not response-decoding.

Also: decision #81's pending-command_id covers **transport-ambiguous** retries only — any
*parsed* HTTP response (including 403) clears the pending id (`pending-command.ts:98`). It
does not cover the multi-step matrix.

**On accept 403 → probe, don't guess:**
1. `GET /rest/v1/memberships?select=…&workspace_id=eq.<hint>&user_id=eq.<uid>&revoked_at=is.null`
   with `accept-profile: swarm_read` — the exact pattern of `discoverSoleWorkspace`
   (`auth.ts:385-416`). Authority unchanged: the view is `is_member`-gated.
2. **Live membership found** → treat as success. Narrate *"You're already a member of
   "<workspace_name>" — nothing to do."* Persist the default, continue to the principal step.
3. **No membership** → plain failure with **ONE uniform message for every cause** (MAJOR 5,
   preserving server semantics client-side): *"This invitation can't be used — it may have
   expired, already been used, or been revoked. Ask <inviter_display_name> for a new link."*
   Never branch this copy on a guessed cause.

**Persist a checkpoint** after each committed step — `{workspaceId, principalId}` in the
0600 sidecar profile — so a re-run converges **without a live invitation** (the invite may
be consumed or TTL-expired by then). Re-running a fully-successful accept is a no-op that
narrates the already-connected state.

Failure matrix, resolved:

| Failure | Resolution |
|---|---|
| accept committed, response lost | #81 replay → accepted (+`workspace_id`) |
| accept committed, pending cleared, re-run | membership probe → success path |
| accept ok, default never written | probe with payload `workspace_id` hint → recover |
| principal committed, response lost | #81 replay → `principal_id` |
| principal committed, re-run (fresh id) | principal READ first (§2.8) → reuse, no conflict |
| re-run after invite TTL expiry | checkpoint + probe → converges if member; else uniform copy |
| re-run after login identity change | credential is per-CloudTarget + uid; probe is uid-scoped → no cross-identity bleed |

### 2.5 Endpoint integrity — origin pin (MAJOR 4)

`cloudTarget()` (`config.ts:11-29`) validates URL *shape* (no credentials, query, or path)
but does **not** constrain the host. An unauthenticated pasted link therefore binds the
endpoint: a tampered payload can point `url` at an attacker's Supabase while keeping a
friendly `workspace_name`, and harvest the invitee's GitHub OAuth through a lookalike login.
The four-command path forced the human to type `--url` as a separate act of attention; the
link collapses that away.

**Fix:** ship a **known-origins allowlist** in the CLI (the hosted project origin;
`localhost`/`127.0.0.1` permitted for development). Parse rules:
- Origin in the allowlist → proceed silently.
- Origin NOT in the allowlist → **refuse by default**, with a loud explanation naming the
  host, and require an explicit interactive confirmation that echoes the host (and is
  unavailable in non-interactive/agent mode, where it hard-fails). Never a silent proceed.
- `--url`/`--anon-key` flags still override for development.

### 2.6 Label sourcing + sanitization (MAJOR 6, Q4)

`runInvite` today returns only `{invitation_id, invitation_token}` (`cli.ts:353-379`) and
there is no workspace-name read view — so v1 had **no source** for the labels and would have
previewed "joining undefined."

**Fix:** extend the `invite_member` response with server-derived `workspace_id`,
`workspace_name`, and `inviter_display_name` as a **fresh-response-only adjunct** (same
class as the raw token per decision #80e — never ledgered, never in events/audit, omitted on
replay). The Edge function already holds the workspace row in-transaction, and this
disclosure is exactly what `SWARM-CLOUD.md:300` sanctions for an invite capability. No new
read view needed.

**Sanitization is mandatory on BOTH sides** (FIX-5 class, extended): labels are untrusted
data — inviter-authored and attacker-modifiable in a tampered link. Strip control, C1, bidi
(`‪-‮`, `⁦-⁩`), and ANSI escape sequences — the same classes as the
server's `CONTROL_RE`/`ANSI_ESCAPE_GLOBAL_RE` (`command/index.ts:269-273`) — **at invite
emit and again at accept preview**, before any terminal write. Bound to 120 chars. If
stripping empties a label, fall back to `"this swarm"` / `"the inviter"`. Never print raw
payload fields.

### 2.7 Same-identity guard (MAJOR 5, lesson #5)

GoTrue links provider identities by verified email, so two GitHub accounts sharing an email
resolve to ONE uid (evidence lesson #5). Accept then returns `member_exists` → uniform 403,
and the client cannot distinguish it.

- Optional `inviter_user_id` in the payload enables a **client-side equality check after
  login only** (never authority): if the logged-in uid equals it, say plainly *"You're signed
  in as the person who sent this invitation. To join as a second person, use a GitHub
  account with a different verified email."*
- Otherwise the §2.4 membership probe already resolves already-member into a success path.
- Distinct-email guidance belongs in the **invite emit output** and login help (partially
  present at `cli.ts:163-164`) — surfaced *before* the invitee burns a link, not after.

### 2.8 Principal reuse (BLOCKING 2, Q3)

Create-conflict tolerance alone is **unsafe**: `principal_name_taken` is a domain rejection
that does **not** return the existing `principal_id` (`workspace-commands.ts:464-469`;
prepare always mints a fresh id, `command/index.ts:1518-1523`), so accept would claim "ready"
with no mintable principal.

**Fix — read first, create only if absent:** after membership is known, `GET
/rest/v1/agent_principals?select=principal_id,name&workspace_id=eq.<ws>&owner_user_id=eq.<uid>`
via `accept-profile: swarm_read`. The view exists and is `is_member`-gated (migration
`:662-667`) — **no new read authority**. If a principal for this machine's stable name
exists, reuse its id; else create via #81. Persist `principal_id` to the profile either way.

**Auto-name** (MINOR 9): `user@hostname` is fragile — it can exceed `boundedText(…, 80)`,
collides across cloned images/shared usernames, and admits unusual hostname characters.
Use a **device-stable, sanitized, bounded** name — `<sanitized-user>@<sanitized-host>-<deviceId
first 8>` truncated to ≤80, `[a-z0-9._@-]` only — and persist the chosen name in the profile
so subsequent runs reuse it verbatim.

### 2.9 Agent-safe invocation (MAJOR 7 — the actual §1c goal)

The felt feedback's core want is *the user's own agent drives this*. Even though the skill
layer ships in P2-3, the affordances must exist now:
- **`--link-stdin`** (never argv, so the capability stays out of agent transcripts and tool
  logs — Part I §7's "never hand a bearer token to a model as a raw secret").
- **`--no-browser`** → print the OAuth URL for the human to open, and accept the pasted
  callback via stdin; no silent hang waiting on a browser that will never open.
- **`--json`** → machine-readable progress/result on stdout, human narration on stderr, so
  an agent can parse state while a human still reads plain lines. Redact link/token in both.
- **Non-interactive mode hard-fails** (never prompts) on the §2.5 unknown-origin gate.

## 3. Scope boundaries

**IN:** `coswarm accept <link>` orchestration + narration; link format + `coswarm invite`
emitting it; invite-response label/workspace_id adjunct (server); `--link-stdin` /
`--no-browser` / `--json`; origin allowlist + confirm gate; recovery state machine
(membership probe, principal read-reuse, profile checkpoint); label sanitization both sides;
same-identity guard; default-workspace narration; auto-name; tests; README rewrite of the
invitee flow to the one-command form.

**OUT:** `coswarm status` (P2-2); agent-skill layer (P2-3); hosted invite *page* and the
`https://` link form (P2-4); auto-mint (does not exist; stays out); rate limiting; revoke
wiring; T-sweep.

### 3.3 Parse grammar (Q5, MINOR 10) — strict, ordered, no sniffing

1. exact `coswarm://accept/<base64url>` → decode
2. else a bare base64url payload → decode
3. else **refuse** — no `https://` sniffing until P2-4

Reject: wrong/missing `v`, oversize payloads (cap bytes), non-strict base64url (padding
tricks), malformed UUIDs, and any `url` failing `cloudTarget()` or the §2.5 origin pin.
`coswarm://` is copy-paste only — no OS deep-link handler is registered or assumed (NIT 14).

## 4. Acceptance (evidence-gated)

- `npx tsc --noEmit` clean; core untouched (zero bundle drift); CLI + server suites green.
- **New CLI tests:** link encode/decode round-trip; strict-grammar rejections (bad v,
  oversize, bad base64url, non-allowlisted origin); happy path; `--link-stdin`; positional
  warning; `--json`/`--no-browser` shapes; label sanitization (control/bidi/ANSI in labels
  never reach output); same-identity guard copy; default-workspace switch narration.
- **New recovery tests (MINOR 12):** accept 403 + live membership → success path; accept 403
  + no membership → the single uniform message; pre-existing principal → reuse, no create;
  double-run of a full accept → exactly one membership + one principal; re-run after invite
  consumed → converges from checkpoint.
- **Server tests:** invite response carries workspace_id/labels as fresh-only (absent on
  replay, absent from ledger/events/audit).
- **Local integration:** invite → accept E2E on the live local stack, asserting single
  membership + single principal after a double-run.
- Hosted proof deferred to a real second-human drive (operator), narrated end to end.

## 5. Residual risks (accepted, recorded)

- A tampered link with an allowlisted origin can still mislabel the workspace/inviter
  (display-only, no authority). Mitigated by sanitization + the fact that real tenancy
  derives from the invitation row.
- Shell history retains a positional link forever; the capability is dead after consumption
  but the payload (url/anon_key/labels) persists. Mitigated by `--link-stdin` + warning.
- Anyone holding a live link can accept (forwarded invites are valid for any verified
  holder — decision #78/#13, by design). Documented in invite output so it isn't a surprise
  (NIT 15).
