# TODO — blocked on the operator

Work that is finished as far as the repo can take it and is now waiting on a human
decision, a fact only the operator holds, or an action outside this repository.

Nothing here is blocked on engineering. Each item says what is blocked, who is blocked by
it, and how the current state was verified, so it can be picked up by someone who was not
here. Verify again before acting — these were checked on branch `l6/self-serve-front-door`
on 2026-07-27.

---

## 1. Name and domain are live — one launch check remains open

★ SUPERSEDED, kept so nobody re-derives it: this item used to read *"Domain not chosen"*
and floated `coswarm.dev` / `coswarm.ai` / `coswarm.app`, with a warning that
**`coswarm.dev` is a real, live, unrelated shipping product** (a self-hosted PaaS serving
its own root `/install.sh`) and was once used here as a placeholder that pointed real users
at a stranger's installer. **That whole decision is dead.** It is superseded by the rename:

| | decided value |
|---|---|
| product name (prose) | **CommonSwarm** |
| binary / command | **`cswarm`** |
| domain | **`commonswarm.com`** |
| legal contact | **legal@commonswarm.com** |
| security contact | **security@commonswarm.com** |

The old name `coswarm` collided with a competitor in the same space. Keep the `coswarm.dev`
warning in mind only as history — nothing should point at it either way.

**What is blocked now is execution, not choice. Three things, all outside this repo:**

1. ~~**DNS is parked.**~~ ★ **DONE, 2026-07-28.** Kept and struck rather than deleted so
   nobody re-derives it. The superseded text read *"`commonswarm.com` points at nothing; it
   is not pointed at Vercel and no certificate exists"* — **that is dead.** The operator
   repointed `A @` and `A www` to `76.76.21.21`, removed the parking page and the redirect,
   and left the `eforward*` MX and SPF records untouched. Both names were added to the
   Vercel project `coswarm-site`; the apex certificate did **not** auto-issue and needed an
   explicit `vercel certs issue commonswarm.com --scope ridgedotio`.

   Verified: `https://commonswarm.com` and `https://www.commonswarm.com` both return **200**
   with 17 content markers and a control string at 0; apex cert `CN=commonswarm.com` valid
   to 26 Oct 2026; `https://coswarm-site.vercel.app` still 200, so nothing broke.
   `site/astro.config.mjs` now sets `site: "https://commonswarm.com"` — the deliberately
   unresolvable `coswarm.invalid` placeholder is gone. DNS subsequently moved to Cloudflare;
   its nameservers are now `chelsea.ns.cloudflare.com` and `ezra.ns.cloudflare.com`.

   Still open here: the Vercel **project** is still named `coswarm-site`. Renaming it moves
   the deployment URL and is an operator action; the custom domain makes it cosmetic.
2. ~~**The mailboxes do not exist.**~~ ★ **DONE, 2026-07-29.** The superseded sentence is
   **dead**: the operator reports `legal@commonswarm.com` and
   `security@commonswarm.com` verified end to end (D-007/D-008). This seat independently
   verified that root MX and SPF now use Cloudflare Email Routing; DNS alone would not prove
   delivery.
3. **No USPTO check has been done on "CommonSwarm."** The rename happened because the old
   name collided with a competitor; nobody has searched TESS or checked common-law use for
   the new one. The domain is already live; do this **before any further public
   announcement**, not after.

<details>
<summary>★ SUPERSEDED pre-merge fill snapshot — DEAD as current status</summary>

The following table and branch measurements are retained as the state before the legal
surface and canonical URL landed. They are not current instructions.

| Blocked thing | Where | Fill with |
|---|---|---|
| Legal contact email — **12 `[[CONTACT EMAIL]]` sites** | branch `legal/terms-and-policies`: `site/src/pages/terms.astro` (5), `privacy.astro` (6), `acceptable-use.astro` (1) | `legal@commonswarm.com` |
| Security contact — `[[SECURITY CONTACT EMAIL]]` | branch `legal/terms-and-policies`: `SECURITY.md` | `security@commonswarm.com` |
| Canonical URL for the marketing site | `site/astro.config.mjs` — `site: "https://coswarm.invalid"`, a deliberately unresolvable placeholder | `https://commonswarm.com`, but **only after (1)** |

Those counts were verified earlier on `legal/terms-and-policies` and were **not** re-checked
during the rename — that branch is not checked out here. `SECURITY.md` does not exist on
`l6/self-serve-front-door` at all; it lives on the legal branch.

All three legal pages currently pass `draft={true}`, which renders the **"Draft — not yet
in force"** band. The legal branch is **not merged** — verified:
`git branch --merged main` does not list `legal/terms-and-policies`, and it holds 4
commits not on `main`. Nothing above is live today.

</details>

~~Interim hosting stays the Vercel alias `https://coswarm-site.vercel.app`.~~ ★
**SUPERSEDED — DEAD as the canonical-host instruction.** `https://commonswarm.com` is the
live public URL on Cloudflare. The Vercel alias still returns 200 and the Vercel project
keeps its `coswarm-site` name; renaming that underlying project remains a separate operator
action.

---

## 2. Release repository and installer — **RESOLVED 2026-07-29**

Published releases live on the public `Ridge-io/cloud-swarm` repository. Release `v0.1.1`
carries both `cswarm` and `cswarm.sha256`, and the installer published at
`https://commonswarm.com/install.sh` defaults to that repository. A fresh install reports
`cswarm 0.1.1`.

Measured again 2026-07-29: the repository is `PUBLIC`; the release has both assets;
`/install.sh` returns 200 while `/nope.sh` returns 404; and the served script sets
`REPO="${CSWARM_REPO:-Ridge-io/cloud-swarm}"`.

<details>
<summary>★ SUPERSEDED release-decision snapshot — DEAD as current instruction</summary>

**Decision needed:** where published releases live.

`install.sh` defaults to `REPO="${CSWARM_REPO:-Ridge-io/coswarm-dist}"`. **That repository
does not exist.** Verified with a positive control on the same invocation: an
authenticated `gh` token that lists **17** repos in the `Ridge-io` org, and resolves
`Ridge-io/cloud-swarm` fine, returns *"Could not resolve to a Repository with the name
'Ridge-io/coswarm-dist'"*. So the installer's default download URL 404s for everyone.

**Recommendation on the table:** publish releases on `Ridge-io/cloud-swarm` instead, which
is already **public** (verified: `visibility: PUBLIC`). The only reason for a separate
`-dist` repo was a "source stays private" ruling that no longer holds.

**This is a decision, not a build.** The artifact is ready: `scripts/build-release.sh`
produces `dist-release/cswarm` + `dist-release/cswarm.sha256`, and self-tests by copying
the binary to a temp directory with no `node_modules` and requiring it to report the
injected version.

The artifact was **renamed** with the product (`coswarm` → `cswarm`) in both
`scripts/build-release.sh` and `install.sh`. Anything already sitting in `dist-release/` or
published anywhere under the old name is stale and does not match what the installer now
downloads — rebuild before publishing. The default `REPO` value still names
`Ridge-io/coswarm-dist` on purpose: it encodes this undecided answer, so do not "fix" it
as part of the rename.

</details>

---

## 3. ~~State of formation~~ — **RESOLVED 2026-07-28, and the inference was wrong**

★ SUPERSEDED, kept so nobody re-derives it. This item read: *"The legal documents state
that Yulan Ventures, LLC is a limited liability company organised under the laws of
Texas. Texas was inferred from the Austin principal place of business, not supplied."*
**The inference was WRONG.** Operator-confirmed:

| | |
|---|---|
| entity type | **LLC** — not a corporation. "Yulan Ventures, LLC" was already correct in all 5 sites. |
| state of formation | **Washington** |
| place of business | Austin, TX (unchanged) |
| governing law / venue | **Texas law, Travis County — deliberately kept** |

Corrected in `terms.astro` and `privacy.astro`; "organised under the laws of Texas" now
appears 0 times in the built output.

**Why the venue did NOT move with the formation state**, since the old text said it
should: venue belongs where the company would actually appear, which is Austin. Selecting
Washington would mean litigating in a state holding a filing and no people. There is also
no conflict to resolve — Washington law governs the LLC's *internal* affairs (member
rights, manager duties) under the internal-affairs doctrine whatever these Terms say,
while these Terms govern the *user* relationship, which a contract may assign to Texas.
The reasoning is restated in `terms.astro`'s header so it is not mistaken for a leftover.

If the OFFICE moves, revisit the venue. If the FORMATION STATE changes, do not.

---

## 4. DMCA designated agent — **named in the document; NOT yet registered**

★ HALF DONE, and the half that is done is the half that does not create the safe harbour.

Filled 2026-07-28 (operator): **Thomas Langridge, Yulan Ventures, LLC, 1200 W 6th St,
Ste 600-188, Austin, TX 78703, legal@commonswarm.com**. That was the last placeholder
anywhere on the legal surface — `[[...]]` now matches 0 times across all three documents
and `SECURITY.md`.

**WHAT REMAINS IS THE FILING, AND IT IS THE PART THAT MATTERS.** The designated agent must
be registered with the **US Copyright Office** through its online directory. Two practical
notes for whoever does it:

- The registration asks for a **telephone number**, which nothing in this repo has. The
  document does not print one and does not need to, but the filing will not submit without
  one.
- Registration carries a fee and a **renewal cycle** (every three years). A lapsed
  registration is the same as none.

Until it is filed, the safe harbour does not exist. The Terms are written so this is not a
false claim today — the copyright section says only where to send a notice and that we may
remove material and terminate repeat infringers, all of which is true regardless. **Do not
add language asserting §512 protection until the registration is confirmed.**

### How to confirm it is actually done — do not take "I filed it" for it

The Copyright Office publishes a **public, searchable directory of designated agents**.
That makes this one of the few items here a stranger can verify independently, so verify
it that way rather than by anyone's say-so:

1. Search the public DMCA designated-agent directory for **Yulan Ventures, LLC**.
2. Confirm the listed agent name and address match what `terms.astro` prints. If the
   document and the registry disagree, the registry is what a court reads and the document
   is what a complainant reads — a mismatch is worse than either alone.
3. Record the **registration date** and the resulting **expiry date** in this file.

### ★ THE RENEWAL IS THE PART THAT WILL BE MISSED

Registration **lapses after three years** and a lapsed registration is legally identical to
never having filed. Nothing in this repository can fire in three years — a TODO is not a
reminder, and whoever reads this file next will most likely be reading it about something
else. **Put the expiry in a calendar the company actually watches, not here.** This
paragraph exists to say that the file cannot do that job, not to do it.

When the filing is confirmed, this item does not get deleted: strike it, record the dates,
and leave the renewal note standing.

---

## 5. Supabase production hosting region — needed by the privacy policy

`privacy.astro` carries `[[HOSTING REGION]]`. The value is the region of the production
Supabase project and **lives in the Supabase dashboard, not in this repo** — nothing in
the tree records it. The operator must read it off the project and supply it.

---

## 6. `SWARM_SELF_SERVE=1` in production — **LIVE 2026-07-28**

Self-serve workspace creation is implemented and tested server-side in
`supabase/functions/command/index.ts`, gated on:

```ts
const selfServeEnabled = Deno.env.get("SWARM_SELF_SERVE") === "1";
```

The production value has been `1` since 2026-07-28. Signup is open and free at
`https://commonswarm.com/start`: a verified identity may hold three live workspaces, and
no card is required. All 10 migrations were pushed, the three edge functions were
redeployed, and the web app was deployed with its public Supabase configuration.

★ SUPERSEDED, kept so nobody re-derives it: this section used to say there is "no CLI verb
that calls `create_workspace`" and that reaching it "requires a hand-rolled request."
**That is dead.** `cswarm new "<name>"` exists in `src/cli.ts` and posts the command.

~~Still missing, and named in §9 P5 as launch-blocking: the **global spend circuit
breaker** that trips to a signup-paused mode before cost runs away.~~ ★ **SUPERSEDED —
DEAD.** Migration `20260728000001_spend_circuit_breaker.sql` added the breaker and the
operator records it among the 10 pushed migrations. Its 100 workspace-creations/hour
production latch and manual reset requirement remain launch-operations debt; D-031 covers
the separate local-suite reset defect.

<details>
<summary>★ SUPERSEDED pre-launch status and instruction — DEAD</summary>

The variable is **unset in production**, so a stranger gets 403. Opening signup requires
setting it in the production edge-function environment.

**It should not be set yet.** Until step 2, site copy must not promise self-serve. The copy
in this branch is written to be true *before* the switch — it says signup is built but not
open on this deployment.

</details>

**THE ORDERING CONSTRAINT STILL MATTERS.** The marketing site, edge functions, and
production environment deploy independently; there is no CI coupling them. The 2026-07-28
switch completed in the safe order: migrations and functions, hosted configuration,
`SWARM_SELF_SERVE=1`, then public copy. If the gate ever changes again, sweep every
availability surface in the same change — at minimum `SiteFooter.astro`,
`download/AfterInstall.astro`, `landing/Invite.astro`, and `install.sh` — so git does not
keep instructing agents to publish the previous deployment state.

---

## 7. Legal documents have had no attorney review

The terms, privacy policy, and acceptable-use policy on `legal/terms-and-policies` were
AI-drafted (the commits carry `Co-Authored-By: Claude Opus 5`) and **no attorney has
reviewed them.**

Note the documents **carry no disclaimer to this effect** — verified by grepping the branch
for *attorney*, *counsel*, *legal advice*, and *AI-drafted*, which returns nothing across
`site/src`, `SECURITY.md`, and `docs/`. The only thing signalling draft status to a reader
is the "Draft — not yet in force" band.

That band is **not** automatic. It comes from an explicit `draft={true}` prop, set on all
three pages today. `LegalDoc.astro` has a build-time guard in the other direction: if a
document is flipped to `draft={false}` while `[[...]]` markers remain, the build **throws**
and names every unresolved marker. So the tree cannot ship a document that claims to be
final while it still has blanks.

What the guard does **not** check is whether anyone reviewed the text. Filling in the
domain removes the last mechanical reason to keep `draft={true}`, and flipping it is a
one-word edit. **Sequence attorney review before that flip**, not after.

---

## 8. Both dogfood machines need one re-login after the rename

The rename changed the **keychain service id** from `io.ridge.coswarm` to
`com.commonswarm.cli`, and the **config directory** from `~/.coswarm` to `~/.cswarm`.

A stored credential is looked up under the service id, so a renamed build **does not find
the old entry**. Nothing is lost or corrupted — the old keychain item and the old directory
simply stop being read. Each dogfood machine has to run `cswarm login` once (or
`cswarm accept --link-stdin` for the invitee) to write a credential under the new id.

This is a one-time human action per machine, which is why it is here and not in the code.
Tell both dogfood users **before** they upgrade, so a login prompt on a working setup reads
as expected rather than as a regression. The stale `~/.coswarm` directory and the old
keychain item can be removed by hand afterwards; nothing does it automatically.

Not verified here: whether either machine has actually been told, and whether any migration
path was attempted instead of a re-login. Neither was.

---

## Summary of who is blocked on what

Rewritten 2026-07-28. Four rows that were open when this table was first written are now
closed, and leaving them listed would have made the table lie about the state of the work.

| # | Item | Kind | State | Unblocks |
|---|---|---|---|---|
| 1 | Name and domain | Operator actions | ✅ **DONE** — commonswarm.com live, apex + www, certs issued | canonical URL, contact addresses |
| 2 | Release repo + published installer | Decision + deploy | ✅ **DONE** — repo is public, release `v0.1.1` carries `cswarm` + `cswarm.sha256`, and `commonswarm.com/install.sh` serves the repo's installer (verified end to end: a clean `curl \| sh` installed a working `cswarm 0.1.1`) | `curl \| sh` installing at all |
| 3 | State of formation | Fact to confirm | ✅ **DONE** — WA-formed LLC, TX office, venue kept | correctness of the terms |
| 4 | DMCA agent | External filing | ◐ **HALF** — named in the document, **not registered** | the §512 safe harbour |
| 5 | Supabase hosting region | Fact from dashboard | ✅ **DONE** — East US (North Virginia) | the privacy policy |
| 6 | `SWARM_SELF_SERVE=1` | Production gate + deploy | ✅ **DONE** — set on the production project 2026-07-28, after all 10 migrations were pushed and the three edge functions redeployed. The web app is now wired to the backend too (`PUBLIC_SUPABASE_URL` / anon key at build time) and GitHub OAuth answers 302 to github.com with a real client id | public signup |
| 7 | Attorney review | External review | ⬜ **OPEN** | publishing the legal docs as in-force |
| 8 | One re-login per dogfood machine | Human action | ✅ **DONE 2026-07-29** — mini logged in as GitHub `Ridgeio`, laptop as `tlangridge`, both live in project `CommonSwarm Build`. First real two-machine, two-identity dogfood run; see `docs/evidence/2026-07-29-first-real-dogfood.md` | dogfood surviving the rename |
| 9 | `legal@commonswarm.com` delivers | Test to run | ✅ **DONE 2026-07-29** — operator-confirmed end-to-end delivery for `legal@` and `security@` (D-007/D-008); this seat independently verified the Cloudflare Email Routing DNS | every document that names it |
| 10 | USPTO check on "CommonSwarm" | Research | ⬜ **OPEN** — prompt written for an agent | launching under a name nobody has cleared |
| 11 | **Custom SMTP for magic-link sign-in** | External account + DNS | ◐ **IN FLIGHT** — Resend verified; Supabase custom SMTP is active at 30 emails/hour with `CommonSwarm <hello@commonswarm.com>`; production accepted a request and Resend recorded delivery, but inbox-visible receipt and the magic-link return leg are not established | complete email sign-in, not only sender delivery |

### Item 11 in full — cutover complete, return leg still needs proof

The email sign-in **UI and sender path are built and deployed** on
https://commonswarm.com/start: a real `<form>`, `signInWithOtp`, a "link is on its way"
state that echoes the address back, and typed handling for the two ways it fails. A
production request was accepted and Resend recorded delivery, but inbox receipt and the
magic-link return/sign-in leg are not established. Email stays above the GitHub button on
purpose — a GitHub-only door tells a non-developer the product is not for them.

<details>
<summary>SUPERSEDED snapshot — the pre-custom-SMTP 2/hour blocker (dead)</summary>

**What it could not do was scale, and the cap was not ours to raise from code.** With no
custom SMTP configured, Supabase's built-in sender allowed **2 emails per hour for the
entire project**. Measured, not assumed — the Management API refused the change outright:

```
PATCH /v1/projects/<ref>/config/auth  {"rate_limit_email_sent": 30}
401  {"message":"Custom SMTP required to configure SMTP_SENDER_NAME or RATE_LIMIT_EMAIL_SENT.
      Missing SMTP_ADMIN_EMAIL, SMTP_HOST, SMTP_PORT, SMTP_USER, SMTP_PASS fields."}
```

So the third stranger to try email in any given hour was refused through no fault of their
own. The page handled that honestly — it said the limit was ours, not their address, and
pointed at GitHub — but honest degradation was not the same as working.

</details>

**Step 1 is done and cost nothing.** Resend scopes by DOMAIN, not by project or account, so
`commonswarm.com` was added to the account that already holds `ridgehq.com` and
`prompteden.com` — no second subscription, no second bill, and the existing full-access API
key in `ridgehq/marketing/.env` was enough to do it.

~~**Step 2 is the blocker: three DNS records at Namecheap.**~~ ★ **SUPERSEDED — DEAD.**
DNS is now on Cloudflare and all three Resend records resolve publicly. They correctly sit
on subdomains:

| Type | Host | Value |
|---|---|---|
| TXT | `resend._domainkey` | `p=MIGfMA0GCSqGSIb3DQEBAQUAA4GNADCBiQKBgQDDHAv5/O9Nu3IwwfMiAEnZXQ8GXNQ48fhp0aH7bd9fvcVYVfKpw2EugxPKEIFN5EcQbJ3r+X8TJYhnYO5suh77/0yShPxKIfWFFMYnFXoPhhvo2dr85z2jX9zsuZQJiKnLVWSHTuMk9UVAvNFlYnVW39AhMzQYlvb0mqfeI9OQLQIDAQAB` |
| MX | `send` (priority 10) | `feedback-smtp.us-east-1.amazonses.com` |
| TXT | `send` | `v=spf1 include:amazonses.com ~all` |

★ **THE TRAP, UPDATED AFTER THE DNS MOVE.** The superseded root records —
~~`eforward1..5.registrar-servers.com` and
`v=spf1 include:spf.efwd.registrar-servers.com ~all`~~ — are **dead**. Cloudflare Email
Routing now supplies root MX records at `route1..3.mx.cloudflare.net` and root SPF
`v=spf1 include:_spf.mx.cloudflare.net ~all`; that is what makes `legal@commonswarm.com`
and `security@commonswarm.com` deliver. Resend's records belong on the `send` and
`resend._domainkey` subdomains precisely so they do not collide. A domain may hold only
one SPF record per host: moving Resend's SPF onto the root would break forwarding and
sending. **Add, never replace.** Preserve the Cloudflare apex/www site records too.

~~**Step 3 is now the blocker:** trigger verification, create a domain-scoped Resend API key,
put the SMTP credentials into Supabase, and only then raise `rate_limit_email_sent`.~~
★ **SUPERSEDED — DONE 2026-07-29.** Resend is verified; `hello@commonswarm.com` is an Active
Cloudflare route; Supabase Management GET reports sender
`CommonSwarm <hello@commonswarm.com>`, host `smtp.resend.com`, port `465`, user `resend`, and
`rate_limit_email_sent=30`. A production request at `/start` was accepted and Resend recorded
`Confirm your CommonSwarm email` delivered from the exact sender. The credential was never
placed on the bus or disk.

**The ordering rule remains load-bearing:** configuring Supabase SMTP before domain
verification would replace a sender that works-but-is-capped with one that fails outright.
That sequence was followed; the old line ~~"Today magic links do send, just 2 per hour"~~ is
dead.

**The remaining proof is the human-visible return leg, not the sender cutover:** inspect the
mailbox receipt, follow the magic link in a cold browser, and confirm the resulting signed-in
`/app` state. The sender-side production evidence does not establish those steps. Run the
remaining test at https://commonswarm.com/start with a real address, confirm the mail arrives,
and confirm the link returns signed in. The return leg is the half that was silently broken
before — `site_url` and the redirect allow-list both pointed at `localhost` in production until
2026-07-28, so every OAuth callback would have bounced a real user to a dead address while the
outbound redirect looked perfect.

**THE LEGAL DOCUMENTS ARE NOW GATED ON TWO THINGS, NEITHER OF THEM TEXT IN THIS REPO:**
items **4** (the filing) and **7** (attorney review). Item **9**, mailbox delivery, is
done. Every `[[placeholder]]` is filled — the writing is finished. What is left is a filing
and a review, and both happen outside version control. That is why the draft banner is still
up and why no amount of further editing will lift it.

Items **2** and **8** are closed: the public release and installer mechanics work, and the
two-machine operator dogfood run completed production GitHub sign-in, workspace creation,
invite acceptance, and signal exchange. That run did **not** establish cold-stranger
install/auth without a walkthrough, cold-browser signup, or magic-link sign-in; the legal
items remain external.

**`SWARM_CAPABILITY_URLS` is deliberately still dark.** The §7 zero-install on-ramp is built
and its two DoS blockers are fixed, but the capability endpoint answers `404` both when the
feature is off AND when a presented token is bad — that uniformity is the no-enumeration rule
working as designed, and it means flipping the gate produces NO externally observable change.
Turning on a switch whose effect cannot be measured from outside is the "green check against
the wrong target" failure. It should be flipped during dogfood, when a real session can mint a
capability URL and fetch it, and the flip verified rather than assumed. ★ SUPERSEDED:
~~Item **6** gates the product being self-serve at all.~~ **Dead** — item 6 is live;
`SWARM_CAPABILITY_URLS` is the separate gate described here.

---

## 11. Renewal loses the successor if its HTTP response is lost — **FIXED**

Found by cross-model review (codex BLOCK / grok SHIP — they split on the same code, and
that disagreement is the interesting part rather than a tie to break). Closed on
2026-07-28; the original statement of the defect is kept below the fix because the
reasoning is what constrains anyone editing this path next.

**The fix, in one sentence:** a successor is PENDING until something authenticates with
it, supersession of the predecessor moves to that moment, and the caller who never got an
answer — identified by its own `command_id` — may retry and be issued a fresh one.

Four parts, each of which had to be there:

1. `swarm.agent_tokens.first_used_at` (migration `20260728000003`). NULL means PENDING.
   The one-successor CAS index is narrowed to `revoked_at IS NULL` so a discarded
   successor releases the slot.
2. The stamp lives in `loadAgentCredential` (`_shared/agent-auth.ts`), so EVERY edge
   function that authenticates an agent records the use. It was briefly in the command
   function only, which meant an agent polling `read` stayed PENDING for ever and had its
   live credential revoked by the next renewal.
3. Recovery is scoped to the retry, not to any renewal. `selfHealStranded` defaults to
   **false** and is set true in exactly one place: the idempotency replay path, when the
   successor the stored response names is still live and unused. A concurrent sibling or a
   second process carries a different `command_id` and is refused `predecessor_superseded`.
4. Stranded slots are credited, not refunded (migration `20260728000004`). Effective spend
   is `successors_used - successors_stranded`; both counters are monotone, so no code path
   anywhere lowers a number on that table.

**Three blockers were found and fixed between the first build and this entry**, all by
adversarial review rather than by the build lanes:

- The refund was `successors_used - 1`, which the counter guard refuses unconditionally —
  so it failed on 100% of invocations, was swallowed as best-effort, and every stranded
  retry permanently burned a slot. The 800-successor budget was drainable inside one
  predecessor TTL.
- The reducer subtracted one from the ceiling while the database fence did not, so at the
  boundary they disagreed and the caller got a 500 or a refusal naming the wrong cause.
- "Pending" was read as "nobody holds it". It is not: three concurrent renewals each found
  the previous winner's successor still pending, each discarded it, and all three were
  accepted — two callers holding credentials revoked microseconds later. This is what
  item 3 above exists to prevent, and the concurrency test now asserts it directly.

**Still true, and still the rule:** do NOT fix anything here by storing the raw successor
in the idempotency row, the audit detail, or any other table. That places a live credential
at rest in a table read on every replay, trading a bounded outage for an unbounded exposure.
The secret exists in exactly one response body and nowhere else.

**The cost that was accepted:** between issue and first use, predecessor and successor are
both live — bounded by the predecessor's remaining TTL (≤ 1h) and kept from extending by
`predecessor_pending_first_use`, which refuses a renewal from a credential that has never
been used. A consequence worth knowing: `first_used_at` is not backfilled, so at the moment
the migration applies every token in the field is PENDING and each one's first renewal is
refused exactly once before succeeding.

<details>
<summary>The original defect report, kept because it is what the fix is answering</summary>

**The failure:** a renewal that COMMITS and then loses its response — dropped connection, or
a 5xx raised after commit — strands the worker permanently. Server-side the successor exists,
the predecessor is superseded, and a successor slot is spent. But the raw credential lives
only in the fresh response body: `renewalReplayFields` deliberately stores ids and expiry and
never the secret, so replaying the same `command_id` returns a body with no `agent_token`,
and the client correctly refuses to invent one.

Net result: a live successor nobody can reach, an agent that stops working, and a human
reauthorisation triggered by a network blip — **the exact failure this feature was built to
remove.** It is attacker-triggerable to the extent anyone can disrupt one response.

**Why the reviewers split, and why both are right.** grok read it as fail-closed and correct;
codex read it as a denial of service. Both describe the same mechanism accurately.
Fail-closed is the right SAFETY behaviour and the wrong AVAILABILITY outcome — and for this
feature availability *is* the point, so it counts as a defect.

</details>

## Post-MVP — operator-deferred (recorded 2026-08-03, do not work during v0.1.5)

These are deferred by explicit operator decision, not forgotten. Recorded here so the deferral is
re-readable rather than living in a session someone has to reconstruct.

### Legal — all of it, operator-owned

Activation, counsel review, DMCA filing, and trademark search are deferred post-MVP. The Terms and
Privacy pages remain **drafts** and the site says so plainly ("drafts published for review (not yet
in force)") — that copy is honest and must not be quietly upgraded to sound binding. Open items
inside the deferral: the elapsed proposed-effective date (27 Jul 2026), and the factual errors
recorded in the handoff (GitHub-only auth, the static/no-third-party claim, missing Resend,
`~/.CommonSwarm` → `~/.cswarm`, GitHub-derived identity). **Do not activate anything.**

### D-037 — supported agent hosts

A host that cannot write to a running process's separate stdin cannot onboard an agent, because
`--agent-token-stdin` is the only credential input the CLI accepts. Measured on Codex; Grok and
Claude Code are **unmeasured**. Needs an operator ruling before v0.1.5 freeze — see the register.
Any new credential channel belongs in 0.1.6 with a real design (e.g. a short-lived pairing code over
HTTPS), **not** bolted on under freeze pressure, which would reopen the credential-escape review.

### Agent self-identifies its host/model; the human only optionally names it

Operator direction 2026-08-03. Full design note with the traced current behaviour and the constraints
worth importing: `docs/design/2026-08-03-AGENT-SELF-IDENTIFY.md`.

Short version: the `model` field is already optional end-to-end and already degrades to "Model not
specified" — the annoyance is that a human is *asked* at all. Take the local swarm's `detectHost()`
pattern (`swarm/src/hooks.ts:16`): runtime environment authoritative, config files as fallback, and
**`null` when it cannot tell**.

Import the scar along with the code. That function refuses to read `CLAUDE_CODE_ENTRYPOINT` because
it is inherited by every child process, so a codex or grok agent spawned from a Claude session would
be misdetected — *"mislabelling a family is worse than not knowing it."* Our listener spawns child
processes, so that trap applies directly: **if a signal can leak across a spawn, it is not evidence.**

Keep this as display metadata. `sender_owner_relation` is the field carrying authority, and this
release already fixed a replay that could change it — do not let the two blur.

Open question for the operator: can an agent change its reported model after joining, or is it fixed
at principal creation? Fixed matches the current schema; mutable is more truthful but adds surface.

### Carried from the earlier plan

- Credential-lifetime copy ("lasts a few hours" → the 30-day rotating reality)
- 30-day wall-clock canary completion
- Telemetry decision; self-serve export/delete; realtime wake hints; rich avatars; billing

### From the QM comparative analysis (`docs/design/2026-08-02-QM-COMPARATIVE-ANALYSIS.md`)

- **CI** — genuinely valuable and deliberately not done during a release freeze, because it changes
  the gating mechanism itself
- Shadow deliveries (enqueue-but-don't-send, for production dry-runs)
- Tape/replay determinism for host adapters — revisit when adapter #3 lands
- Reviewer-depth scaling — deferred because it licenses *shallower* review at the moment the flat
  gate is the protection
