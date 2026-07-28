# P2-connect-UX — sub-slice 1 design brief: `cswarm accept <invite-link>`

**Status:** v2.1 — CLEARED FOR IMPLEMENTATION. Two adversarial rounds by Sable[grok]:
v1 → NO-GO (BLOCKING 1–3, MAJOR 4–8, NIT 13); v2 → CONDITIONAL GO pending R1–R4 + O1–O3,
now folded in place. Mason implements this document.
**Author:** Lead4, 2026-07-24. **Governs:** the most direct answer to the §1c felt-dogfood
feedback.

> **v1→v2 changes:** verb renamed `join`→`accept` (spec-locked vocabulary, BLOCKING 3);
> `workspace_id` + server-derived labels added to the payload (BLOCKING 1, MAJOR 6);
> recovery state machine that never interprets a 403 (BLOCKING 1); principal reuse via
> `swarm_read.agent_principals` (BLOCKING 2); endpoint origin pin (MAJOR 4); one uniform
> recovery message replacing per-cause copy (MAJOR 5); agent-safe invocation specced
> (MAJOR 7); default-workspace overwrite narration (MAJOR 8); mint wording corrected (NIT 13).
>
> **v2→v2.1 changes:** checkpoint short-circuit is now step 0 and the server's
> `workspace_id` always beats the hint, with non-claiming copy for membership-at-hint
> (R1 — closed a false-success path); principal read filters live + escapes a
> revoked-held name (R2); ordered positional grammar with legacy-token precedence (R3);
> default-workspace policy split into two non-contradictory cases (R4); confirm requires
> re-typing the host and target composition is never mixed (O1–O3); profile schema
> extension, email fallback, and `cswarm status` forward-reference fixed (minors).

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

The baton (§1c NEXT PHASE item 1) wrote this as `cswarm join <invite-link>`. **That verb
is not available.** `SWARM-CLOUD.md:696` locks the vocabulary — *"a **member** is a human…
an **agent** is a registered AI process… Members **accept invites**; agents **join
swarms** — the verbs are never interchanged"* — and §7 (`:322`) hardened this exact
`join`-collision through multi-model review, because `swarm join` already means *an agent
registers on the roster*. Overloading `join` for human onboarding reopens the precise
confusion the spec closed.

**Ruling:** the human one-command verb is **`cswarm accept <invite-link>`**. It extends
the existing `cswarm accept` (which already consumes an invitation) rather than adding a
verb — so this is a *widening of an existing spec-correct verb*, not new vocabulary. The
operator's "join" in §1c was colloquial for "one command"; the intent (collapse the steps)
is fully preserved. Backward compatibility: `cswarm accept --invitation-token-stdin`
keeps working unchanged (§3.3).

## 1. The pain, concretely (today's invitee path)

Four commands + five concepts the invitee should never have to hold:

```
cswarm login --url … --anon-key …            # concept: PKCE, anon key, url
printf %s "$INVITATION_TOKEN" | cswarm accept --invitation-token-stdin   # concept: capability token, stdin safety
cswarm principal create --name laptop-agent   # concept: "principal"
cswarm token mint --principal-id … --run-id … --task-id … --epoch 1      # concept: run, task, epoch binding
```

## 2. The target: ONE command

```
cswarm accept <invite-link>          # or: cswarm accept --link-stdin
```

collapses **login → accept-invitation → principal (auto-named) → ready**, narrating each
internal step in one plain-language line. The human states intent; the CLI does the rest.

**Mint is explicitly OUT of this command** (correcting v1's wording — NIT 13): decision #80
says the `agent_runs` row is created *server-side at mint time*; **mint itself is still an
explicit client command** (`cswarm token mint`). There is no auto-mint today and this
sub-slice does not add one. Accept leaves a *mintable* state (persisted `workspace_id` +
`principal_id`), and the closing narration tells the user what comes next.

### 2.1 The invite link

`cswarm invite` emits a single opaque link carrying everything the invitee needs:

```
cswarm://accept/<base64url(payload)>
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
4. **Ready**: *"You're connected to "<workspace_name>". Your agent gets its credential when
   it starts work (`cswarm token mint`)."* Do **not** point at `cswarm status` — it does
   not exist until P2-2 (minor); either omit it or mark it explicitly as coming soon. Never
   send the user to a command that will 404 them.

**Email in the login-skip line (minor):** `refreshedCredential` carries no email, so
*"Already signed in as <email>"* has no source on the skip path. Do not add a `getUser`
round-trip solely for copy — store the email at login, and fall back to a `userId` prefix
when it is absent. Never block the flow on a missing label.

**Default-workspace policy — two cases, no contradiction (R4).** v2 said both "only
auto-switch when the previous default is null or matches" *and* "otherwise narrate the
switch," which cannot both hold. The rule is:
- **Fresh membership success** (accept returns 200, or a checkpoint is written for the first
  time): **always** set the default to the **server's** `workspace_id`. If the previous
  default was non-null and different, narrate it: *"Your default workspace is now "<new>"
  (was "<old>")."*
- **Already-connected re-run** (step 0 short-circuit fires): **never** change the default —
  the user may have deliberately switched since. Narrate membership/principal status only.

### 2.3 Secret hygiene + backward compatibility

- **`--link-stdin` is the documented-safe form**; a positional link is supported as
  convenience with a **stderr warning** that it lands in shell history and `ps` (mirrors the
  FIX-3 precedent). Sable's refinement: immediate consumption does NOT close the
  pre-consumption window — the OAuth round-trip is up to `CALLBACK_TIMEOUT_MS` (5m) wide,
  and history/scrollback retain the payload forever.
- **Never log or echo the raw link or token** — not on success, not in errors, not in
  `--json`. Redact to `cswarm://accept/<redacted>` in any diagnostic.
- Existing `cswarm accept --invitation-token-stdin` (bare token, `--workspace-id`
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

**Membership-at-hint is NOT proof the invitation was consumed (R1).** A wrong, stale, or
forged `workspace_id` hint can name a workspace W the user *already* belongs to, while the
real invitation (for workspace A ≠ W) is dead. A naive probe then reports success for an
invite that never worked. This is not an authz bypass — `is_member` still gates everything —
but it is a recovery-correctness bug, so the state machine is ordered and the copy never
over-claims:

**Step 0 — checkpoint short-circuit, BEFORE attempting accept.** If the profile holds
`{workspaceId, principalId}` for this CloudTarget matching the payload's `workspace_id`, and
both the membership and a live principal still hold, this is an already-connected no-op:
narrate the connected state and stop. Never re-burn an invitation on a converged state.

**On accept 200 — trust the server, never the hint.** Take `response.workspace_id` for the
default, the principal step, and the checkpoint. If it differs from `payload.workspace_id`
(stale or forged hint), the server value wins silently.

**On accept 403 — probe, don't guess, don't over-claim:**
1. `GET /rest/v1/memberships?select=…&workspace_id=eq.<hint>&user_id=eq.<uid>&revoked_at=is.null`
   with `accept-profile: swarm_read` — the exact pattern of `discoverSoleWorkspace`
   (`auth.ts:385-416`). Authority unchanged: the view is `is_member`-gated, so this reveals
   only what the user could already read (no-enumeration intact — Q6).
2. **Live membership at the hint** → do **NOT** say the invitation was accepted. Narrate:
   *"You're already a member of this workspace. If you expected this link to add you
   somewhere new, it can't be used — ask <inviter_display_name> for a new invite."* Then
   continue with principal reuse for that workspace (the user IS a member) and do not change
   the default (R4 case 2).
3. **No membership** → plain failure with **ONE uniform message for every cause** (MAJOR 5,
   preserving server semantics client-side): *"This invitation can't be used — it may have
   expired, already been used, or been revoked. Ask <inviter_display_name> for a new link."*
   Never branch this copy on a guessed cause.

**Persist a checkpoint** after each committed step — `{workspaceId, principalId,
principalName}` in the 0600 sidecar profile — so a re-run converges **without a live
invitation** (the invite may be consumed or TTL-expired by then).

**Profile schema extension (minor):** `CredentialProfile` today is `{version, userId,
workspaceId, pendingCommands}` (`storage.ts:47-52`). Add `principalId` and `principalName`
as optional fields with a **backward-compatible parse** — an existing profile lacking them
must load, not throw.

Failure matrix, resolved:

| Failure / state | Resolution |
|---|---|
| Full success re-run | Step 0 checkpoint + live membership & principal → no-op **before** accept |
| accept committed, response lost (#81 transport) | #81 replay → 200 → use **response** `workspace_id` → checkpoint |
| accept committed, pending cleared, no checkpoint | 403 → probe hint; if member → non-claiming copy (R1) + principal path + write checkpoint |
| accept ok, default never written | Use **response** `workspace_id` (not the hint) → write default + checkpoint |
| hint ≠ server `workspace_id` on 200 | Trust server, persist server id (R1) |
| forged/stale hint at a workspace user already belongs to + dead token | Non-claiming copy; **must not** report the invite succeeded (R1) |
| principal committed, response lost | #81 replay → `principal_id` → checkpoint |
| principal committed, re-run | Read live principal by stable name → reuse |
| principal name held only by a **revoked** row | Suffix the auto-name until free, then create (R2) |
| invite TTL expiry / foreign consume / invalid / revoked | 403 + no membership at hint → the **one** uniform failure copy |
| same uid as inviter | Pre-accept `inviter_user_id` equality → stop with same-person copy (§2.7) |
| re-run after login identity change | Credential is per-CloudTarget + uid; probe is uid-scoped → no cross-identity bleed |
| unknown origin, non-interactive | Hard-fail; **no login attempt** (§2.5) |
| unknown origin, interactive | Re-type-the-host confirm (§2.5 O1); else refuse |

### 2.5 Endpoint integrity — origin pin (MAJOR 4)

`cloudTarget()` (`config.ts:11-29`) validates URL *shape* (no credentials, query, or path)
but does **not** constrain the host. An unauthenticated pasted link therefore binds the
endpoint: a tampered payload can point `url` at an attacker's Supabase while keeping a
friendly `workspace_name`, and harvest the invitee's GitHub OAuth through a lookalike login.
The four-command path forced the human to type `--url` as a separate act of attention; the
link collapses that away.

**Fix:** ship a **known-origins allowlist** in the CLI. Parse rules:
- Origin in the allowlist → proceed silently.
- Origin NOT in the allowlist → **refuse by default**, with a loud explanation naming the
  host. Proceeding requires an interactive confirmation in which the user **re-types the
  exact origin string** (O1) — a click-through "yes" is phishing-compatible when friendly
  labels sit directly above it. Compare the typed value constant-time. In
  non-interactive/agent mode this **hard-fails with no login attempt**.
- **Allowlist contents (O3):** the hosted production origin plus loopback
  (`127.0.0.1`/`localhost`) for development, as a **build-time list**. A dev-only env
  override may add origins but must be documented as dev-only and must NOT be consulted in
  non-interactive mode — an unbounded env override reopens phishing exactly where the human
  isn't watching.
- **Target composition is never mixed (O2):** the CloudTarget comes **entirely** from either
  (a) the link payload after the pin passes, or (b) explicit `--url` + `--anon-key`. Never a
  flag `url` combined with a payload `anon_key`/token for a different host. Supplying both a
  link and target flags is a validation error unless the flags fully replace the target, and
  the replacement must itself pass the pin/confirm rules.

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

**Replay omits the adjunct (minor).** Being fresh-response-only means a replayed `invite`
returns neither the raw token nor the labels — the same loss that already applies to the
token today. The invite narration must say so plainly: if the output was lost, issue a new
invitation rather than expecting recovery.

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
- Otherwise the §2.4 membership probe resolves already-member into the **non-claiming
  recovery path** (R1) — *not* a "the invitation succeeded" path. Keep that distinction in
  the implemented copy.
- Distinct-email guidance belongs in the **invite emit output** and login help (partially
  present at `cli.ts:163-164`) — surfaced *before* the invitee burns a link, not after.

### 2.8 Principal reuse (BLOCKING 2, Q3)

Create-conflict tolerance alone is **unsafe**: `principal_name_taken` is a domain rejection
that does **not** return the existing `principal_id` (`workspace-commands.ts:464-469`;
prepare always mints a fresh id, `command/index.ts:1518-1523`), so accept would claim "ready"
with no mintable principal.

**Fix — read live first, create only if absent:** after membership is known,
`GET /rest/v1/agent_principals?select=principal_id,name&workspace_id=eq.<ws>&owner_user_id=eq.<uid>&name=eq.<stable>&revoked_at=is.null`
via `accept-profile: swarm_read`. The view exists and is `is_member`-gated (migration
`:662-667`) — **no new read authority**. Reuse the returned `principal_id`; else create via
#81. Persist `principal_id` + `principalName` to the profile either way.

**The `revoked_at=is.null` filter and the name predicate are both load-bearing (R2).**
`create_agent_principal` treats **any** same-named principal as taken — it does not ignore
revoked rows (`workspace-commands.ts:464-469`) — and the DB `UNIQUE (workspace_id, name)`
retains revoked rows (`migration:181`). So a revoked principal permanently occupies its name:
- Reusing a revoked `principal_id` would surface later as `principal_revoked` at mint.
- Filtering client-side to empty and then creating would hit `principal_name_taken` and
  strand the user with no id.

**Escape:** if no *live* principal matches but the name is occupied (by a revoked row),
**suffix the auto-name** (`-2`, `-3`, … or additional `deviceId` characters) until free, then
create. Never reuse a revoked `principal_id`. Persist the chosen name so later runs match it
verbatim.

### 2.8a Decision #83 — optional `--name` for link mode

§2.10's suffix cap has to fail *somewhere*, and it must not fail into a second command:
sending the user to `cswarm principal create --name …` would re-introduce the exact
multi-step friction §1c objects to, and it would do so **after membership is already
committed** — stranding them mid-state, told to run something else. So the one-command
promise needs a one-command escape.

**Ruling:** `cswarm accept` gains an optional **`--name <name>`** that names this machine's
agent identity, **link mode only**. Legacy token mode (`--invitation-token-stdin` / bare
`swm_inv_` positional) stays *unchanged* and creates no principal, so `--name` does not apply
there — supplying it with a legacy form is a validation error.

Semantics — exactly three outcomes:
- **Validation (before any network call):** control/bidi/ANSI stripped, `[a-z0-9._@-]`, ≤80
  chars. The client enforces this **stricter-than-server** alphabet itself, so the user gets a
  message naming `--name` rather than an opaque server 400 (server `boundedText` is more
  permissive). If sanitizing empties or alters the string, **fail validation** — do NOT fall
  through to the auto-name path; a user who passed `--name` expects that name or an error.
- **Reusable by the caller** — a *live* principal of that name owned by the caller exists →
  reuse it (idempotent, same as the auto path; no second create).
- **Not reusable by the caller** — the name is held by any other row, whether **another
  member's live principal** or **any revoked principal** → **fail plainly with ONE uniform
  message; never silently mutate a user-chosen name.**
  *"The name "<name>" is already taken in this workspace. Re-run with a different `--name`."*

  Two notes on this rule. First, `UNIQUE (workspace_id, name)` is **per-workspace, not
  per-owner** (`migration:181`), so another member's live principal collides exactly like a
  revoked one — this third case is real and must not fall through or get mislabeled. Second,
  the copy deliberately does **not** distinguish "retired" from "held by someone else": the
  uniform "taken" wording is accurate for both and avoids teaching a distinction the user
  doesn't need. (Members who care can already read `revoked_at` from the roster.)
- **Omitted** → the §2.8 auto-name path, including the capped suffix escape.

**The asymmetry stands and is not negotiable:** an auto-generated name may be suffixed freely;
a user-supplied `--name` is never suffixed under any flag.

**Do not build a roster oracle.** Resolve collisions with an *owner-scoped live read* →
reuse-if-hit → else create, and let `create_agent_principal`'s rejection be authoritative for
"taken." Do **not** issue an unfiltered `name=eq.<n>` read (without the owner filter) merely to
branch the copy between "retired" and "another member's" — that trains the client to treat the
roster as an oracle for no user benefit. Keep the client dumb; the server decides.

**`--name` is not a rename.** If the §2.10 step-0 checkpoint short-circuit fires, an existing
principal is reused and a differing `--name` is **ignored** (no accept, no create). Emit one
stderr note when it differs from `checkpoint.principalName` — *"Already connected as
<existing>; `--name` ignored."* — so the user isn't left thinking the flag silently failed.
- **Suffix-cap failure copy** must name the escape: *"Couldn't pick an automatic name for this
  machine's agent identity — names like "<auto>" are already taken here. Re-run with `--name
  <your-choice>` to pick one explicitly."*

This is one optional flag, needed by a path the brief already required, and it doubles as a
comprehension win (a user-meaningful `laptop-agent` reads better than
`tom@macbook-a1b2c3d4`). Nothing else in the flow changes.

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

### 2.10 Canonical execution order (implementation authority)

§2.2 lists what the *user sees*; this is the order the *machine* runs. Where they appear to
differ, this wins:

1. **Parse** the positional/stdin per the §3.3 ordered grammar.
2. **Origin pin** (§2.5) — refuse/confirm before anything touches the network.
3. **Preview** the sanitized labels (§2.6) — comprehension before commitment.
4. **Login** or skip-if-live-for-this-target (§2.2 step 1).
5. **Same-identity check** (§2.7) — needs the logged-in uid, so it follows login and precedes
   any invitation burn.
6. **Step 0 checkpoint short-circuit** (§2.4) — *before* accept, never after.
7. **Accept** → on 200 use the server `workspace_id`; on 403 probe (never decode the body).
8. **Principal** read-live-then-create (§2.8).
9. **Ready** narration + the §2.2 two-case default-workspace policy.

**Mixed-target rule, resolved (O2 — pick one, and this is the pick):** a link together with
`--url`/`--anon-key` is a **validation error**. No partial-override mode ships in this
sub-slice; it is the only variant that cannot be talked into a split-host state, and it is
trivially testable. Dev work uses flags *without* a link.

**Suffix attempts are capped** (§2.8): bound the revoked-name escape (e.g. ≤5 attempts), then
fail with a plain message pointing at **`--name`** (decision #83, §2.8a) — never an unbounded
probe loop, and never a redirect to a second command.

**Optional harden, only if a test exercises it:** on a 403 whose hint-probe is empty, a live
membership at `checkpoint.workspaceId` may also be checked before the uniform failure. Do not
build this speculatively.

## 3. Scope boundaries

**IN:** `cswarm accept <link>` orchestration + narration; link format + `cswarm invite`
emitting it; invite-response label/workspace_id adjunct (server); `--link-stdin` /
`--no-browser` / `--json`; origin allowlist + confirm gate; recovery state machine
(membership probe, principal read-reuse, profile checkpoint); label sanitization both sides;
same-identity guard; default-workspace narration; auto-name; tests; README rewrite of the
invitee flow to the one-command form.

**OUT:** `cswarm status` (P2-2); agent-skill layer (P2-3); hosted invite *page* and the
`https://` link form (P2-4); auto-mint (does not exist; stays out); rate limiting; revoke
wiring; T-sweep.

### 3.3 Parse grammar (Q5, MINOR 10, R3) — strict, ordered, no sniffing

The single positional on `cswarm accept` must serve BOTH the legacy bare token and the new
link, so precedence is explicit — a bare `swm_inv_` token must never reach a base64url
decoder (R3):

1. Matches `INVITATION_TOKEN_RE` (`/^swm_inv_[A-Za-z0-9_-]{43}$/`, `command-client.ts:17`)
   → **legacy token mode**, unchanged: existing FIX-3 warning, target flags required as today.
2. Else exact `cswarm://accept/<base64url>` → **link mode**.
3. Else strict base64url **whose decoded JSON has `v:1` plus all required keys** → link mode.
4. Else **refuse with teach-by-refusal** naming both accepted forms.
5. No `https://` sniffing until P2-4.

Mutual exclusion: link mode ⊕ `--invitation-token-stdin` ⊕ bare-token positional — any two
together is a validation error.

Reject: wrong/missing `v`, oversize payloads (cap bytes), non-strict base64url (padding
tricks), malformed UUIDs, and any `url` failing `cloudTarget()` or the §2.5 origin pin.
`cswarm://` is copy-paste only — no OS deep-link handler is registered or assumed (NIT 14).

## 4. Acceptance (evidence-gated)

- `npx tsc --noEmit` clean; core untouched (zero bundle drift); CLI + server suites green.
- **New CLI tests:** link encode/decode round-trip; strict-grammar rejections (bad v,
  oversize, bad base64url, non-allowlisted origin); happy path; `--link-stdin`; positional
  warning; `--json`/`--no-browser` shapes; label sanitization (control/bidi/ANSI in labels
  never reach output); same-identity guard copy; default-workspace switch narration.
- **New recovery tests (MINOR 12, extended for R1–R4):** accept 403 + live membership at the
  hint → the **non-claiming** copy (asserted to NOT say the invitation succeeded — R1);
  **forged/mismatched hint** at a workspace the user already belongs to + dead token → same
  non-claiming path, no false success; accept 200 with `response.workspace_id` ≠ hint → server
  value persisted; accept 403 + no membership → the single uniform message; pre-existing live
  principal → reuse, no create; **name held only by a revoked principal → suffixed name
  created, revoked id never reused** (R2); step-0 checkpoint short-circuit → no accept
  attempted at all; double-run of a full accept → exactly one membership + one principal;
  re-run after invite consumed → converges from checkpoint; positional **token-vs-link
  precedence matrix** including a bare `swm_inv_` never entering the base64url decoder (R3);
  default-workspace: fresh success switches + narrates was→now, re-run does not switch (R4);
  unknown origin non-interactive → hard-fail with **no login attempt**; unknown origin
  interactive → wrong host typed → refuse.
- **`--name` tests (decision #83):** explicit name reused when the caller's own **live**
  principal matches (asserting **no second create** — stable `principal_id`, no extra event);
  explicit name held by a **revoked** row → uniform "taken" failure with **no silent rename**;
  explicit name held by **another member's live** principal → the **same** uniform "taken"
  failure (not "retired", not reuse); auto-name suffix cap reached → failure copy names
  `--name`; `--name` with a legacy token form → validation error naming link mode; `--name`
  that sanitizes to empty or carries an illegal charset → **validation error before any network
  call** (never a silent fall-through to the auto name); `--name` supplied when the step-0
  short-circuit fires → no accept call, no create, and the ignore-note emitted when it differs
  from `checkpoint.principalName`.
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
