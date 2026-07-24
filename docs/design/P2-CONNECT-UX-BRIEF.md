# P2-connect-UX — sub-slice 1 design brief: `coswarm join <invite-link>`

**Status:** DRAFT for Kimi K3 model-inversion review, then Mason implementation.
**Author:** Lead4, 2026-07-24. **Governs:** the single most direct answer to the §1c
felt-dogfood feedback.

## 0. Governing feedback (verbatim-adjacent, from SUCCESSION-PLAN §1c)

After personally driving the two-human connect, the operator said:
1. "**A lot of steps** — I'd like it much simpler. Driving this via an agent would help…
   I don't want the end user to need to do much via terminal."
2. "I **didn't really know what I was doing or why** — I don't understand why there were
   multiple steps; it all felt very technical."

**Design rule (both points collapse to one):** a user-facing step must either (a) explain
itself in one plain-language line — what just happened and why — or (b) not exist as a
user-facing step. This brief eliminates steps where possible and narrates the rest.

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
coswarm join <invite-link>
```

collapses **login → accept → principal(auto-named) → ready**, narrating each internal
step in one plain-language line. Token **mint stays automatic at first agent work**
(server-side, decision #80) — it is NOT part of join. The human states intent ("join
this swarm"); the CLI does the rest.

### 2.1 The invite link (design decision — Kimi: attack this)

`coswarm invite` currently emits `{invitation_token: swm_inv_…, invitation_id, message}`.
The invitee still needs URL + anon key out-of-band → friction + "didn't know why."

**Proposal:** `coswarm invite` emits a single opaque **invite link** that carries
everything the invitee needs with zero prior config:

```
coswarm://join/<base64url(payload)>
  payload = { v:1, url, anon_key, invitation_token, workspace_label, inviter_label }
```

- `url` + `anon_key` are **public** (anon key is a publishable JWT — already printed in
  README; embedding is not a secret leak).
- `invitation_token` (`swm_inv_`) is a **one-time bearer capability, 24h TTL** that is
  ALREADY meant to be handed to the invitee — embedding it in the link IS the delivery
  mechanism (same trust model as a Slack/GitHub invite URL). It never touches argv in the
  invitee flow (see 2.3).
- `workspace_label` + `inviter_label` are **display-only**, so `join` can say *"You're
  joining <workspace> — invited by <inviter>"* BEFORE committing (comprehension-before-
  commitment, Appendix C invite-page principle) — they are NOT trusted for authority
  (real tenancy derives server-side from the invitation row, per decision #78/#80).

**Custom URI scheme `coswarm://`** keeps it copy-pasteable as one token and future-proofs
a desktop-app deep-link, but it is just a container — `join` also accepts the bare
base64url payload and (Kimi to rule) possibly an `https://` invite-page URL whose path
carries the same payload (item #4, later sub-slice).

### 2.2 `coswarm join` step sequence + narration

Each line is what the user SEES (plain language, no jargon), one per internal step:

1. **Decode + preview** (no network): *"You're joining the "<workspace_label>" swarm,
   invited by <inviter_label>. This will sign you in with GitHub and connect your agent."*
2. **Login** (skip if a live session for a DISTINCT-email identity already exists — see
   2.4): *"Signing you in with GitHub… opening your browser."* → on success: *"Signed in
   as <email>."*
3. **Accept** (governed `accept_invitation`, capability-only, atomic): *"Joined
   "<workspace_label>" as a member."* Persist the returned workspace as the profile
   default (bug #3 machinery already exists) so the invitee never types `--workspace-id`.
4. **Principal create** (auto-named from hostname/user, e.g. `<user>@<hostname>`):
   *"Registered this machine's agent identity: <principal-name>."*
5. **Ready**: *"You're connected. Your agent can now pick up work in <workspace_label>.
   Run `coswarm status` to see what's happening."*

### 2.3 Secret hygiene in join

- The invitation token arrives inside the link arg → it WILL be in argv/history. Mitigation
  options for Kimi to weigh: (a) accept `coswarm join --link-stdin` as the documented-safe
  form + positional link as documented-unsafe convenience (mirrors FIX-3's invite-token
  decision); (b) since the token is single-use and 24h-TTL and `join` consumes it
  immediately (atomic accept), residual history exposure is low-value post-consumption.
  **Lead4 lean:** support `--link-stdin`, keep positional as warned convenience — consistent
  with the FIX-3 precedent. Kimi: is immediate-consumption enough, or is argv exposure of a
  pre-consumption capability a real window?
- Raw token/link material stays fresh-response-only in `invite` output; never logged.

### 2.4 Idempotency / resumability (Kimi: the hard part)

`join` is a **multi-step orchestration across 3 governed commands + an OAuth round-trip**.
It can fail or lose a response at any step. Requirements:
- Re-running `join` with the same link after a partial completion must **converge, not
  double-apply**. Reuse the client-side pending-command_id machinery (decision #81) for
  accept + principal_create so a response-lost retry replays instead of re-executing.
- If already signed in (live session, distinct email): skip step 2, narrate *"Already
  signed in as <email>."*
- If already a member (invitation already consumed by this identity): skip step 3, narrate
  *"You're already a member of <workspace_label>."* — do NOT surface the accept 403 as an
  error (bug-#1-class: a committed prior accept must read as success, not failure — this is
  exactly Kimi FIX-4's concern; #81 handles the response-lost case, but join must also
  handle the "genuinely already joined" case gracefully).
- If a principal for this machine already exists: reuse it, narrate accordingly (needs a
  read — see open question Q3).
- **Distinct-email guard (lesson #5):** if login resolves to the SAME uid as the inviter
  (shared verified email), stop with a plain-language explanation — *"This GitHub identity
  shares an email with the inviter, so it's treated as the same person. Use a GitHub account
  with a different verified email to join as a second human."* — not a raw 403.

## 3. `coswarm invite` changes

- Emit the **invite link** (2.1) as the primary, copy-one-thing output, with a plain
  message: *"Send this link to the person you want to join <workspace_label>. It works
  once and expires in 24h."*
- Keep `--json` for machine/agent use (the skill layer, P2-3) exposing the structured
  fields. Raw `invitation_token` still available in `--json` for power users.

## 4. Scope boundaries

**IN (this sub-slice):** `coswarm join <link>` orchestration + narration; invite-link
format + `coswarm invite` emitting it; `--link-stdin`; idempotent/resumable join; distinct-
email guard copy; auto-named principal. Unit + integration tests. README rewrite of the
invitee flow to the one-command form.

**OUT (later sub-slices / deferred):** `coswarm status` read surface (P2-2); agent-skill
layer (P2-3); hosted invite *page* (P2-4, item #4 — the https:// link variant); automatic
mint-at-first-work (verify current server-side behavior suffices; separate if not); rate
limiting; revoke wiring; T-sweep.

## 5. Acceptance (evidence-gated)

- `npx tsc --noEmit` clean; core unchanged (zero drift); CLI suite green with new
  join/invite-link tests; server suite green.
- New CLI tests: link encode/decode round-trip; join happy path (mocked steps); join
  resumability (partial-completion re-run converges); already-member graceful path;
  distinct-email guard; `--link-stdin`.
- Local integration test: invite → join E2E against the live local stack (login mocked or
  seeded), asserting single membership + single principal after a double-run.
- Hosted proof deferred to a real second-human drive (operator), narrated end to end.

## 6. Open questions for Kimi (adversarial)

- **Q1 (secret-in-link):** Is embedding the `swm_inv_` capability in a copy-pasteable link
  an acceptable trust model given single-use + 24h TTL + immediate consumption? Any
  enumeration/replay/logging surface this opens that the current stdin flow closes?
- **Q2 (resumability correctness):** Does #81's pending-command_id fully cover join's
  multi-step partial-failure matrix, or are there orderings (accept committed, principal
  failed; principal committed, response lost; re-run after TTL expiry) that double-apply,
  strand the user, or surface a committed success as an error?
- **Q3 (principal reuse read):** Auto-named principal reuse needs "does this machine already
  have a principal?" — is there a governed read for that, or does join need to tolerate a
  create-conflict and treat it as reuse? Which is safer (no new read-surface authority vs.
  idempotent create)?
- **Q4 (display labels):** `workspace_label`/`inviter_label` are attacker-controllable (the
  inviter authored them; the link is attacker-holdable). They're display-only — confirm no
  path treats them as authority, and that they're control/bidi/ANSI-stripped before render
  (FIX-5 class) in BOTH invite emit and join preview.
- **Q5 (scheme):** `coswarm://` custom scheme vs. bare base64url vs. `https://` invite-page
  URL — which is the right primary now, and does accepting multiple forms create a parser
  ambiguity/injection surface?
- **Q6:** Anything in the one-command collapse that weakens the §3.4 authority model or the
  no-enumeration guarantees (decision #80) relative to the four-command path?
