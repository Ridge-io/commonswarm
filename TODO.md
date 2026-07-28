# TODO — blocked on the operator

Work that is finished as far as the repo can take it and is now waiting on a human
decision, a fact only the operator holds, or an action outside this repository.

Nothing here is blocked on engineering. Each item says what is blocked, who is blocked by
it, and how the current state was verified, so it can be picked up by someone who was not
here. Verify again before acting — these were checked on branch `l6/self-serve-front-door`
on 2026-07-27.

---

## 1. Name and domain are DECIDED — three operator actions still block them

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
   unresolvable `coswarm.invalid` placeholder is gone.

   Still open here: the Vercel **project** is still named `coswarm-site`. Renaming it moves
   the deployment URL and is an operator action; the custom domain makes it cosmetic.
2. **The mailboxes do not exist.** `legal@commonswarm.com` and `security@commonswarm.com`
   must actually **receive mail** before the legal documents publish. A terms page naming an
   address that bounces is worse than a placeholder: it is a stated channel that silently
   discards notice, including security reports and legal service.
3. **No USPTO check has been done on "CommonSwarm."** The rename happened because the old
   name collided with a competitor; nobody has searched TESS or checked common-law use for
   the new one. Do this **before** any public announcement or domain launch, not after.

**Fills that unblock once (2) lands:**

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

Interim hosting stays the Vercel alias `https://coswarm-site.vercel.app`. The Vercel
project keeps its `coswarm-site` name; renaming it is a separate operator action that would
move the URL, so it is deliberately untouched by the rename.

---

## 2. Release repository decision — blocks distribution

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

## 6. `SWARM_SELF_SERVE=1` in production — deliberately NOT yet

Self-serve workspace creation is implemented and tested server-side in
`supabase/functions/command/index.ts`, gated on:

```ts
const selfServeEnabled = Deno.env.get("SWARM_SELF_SERVE") === "1";
```

The variable is **unset in production**, so a stranger gets 403. Opening signup requires
setting it in the production edge-function environment.

**It should not be set yet.** The code comment states the intent — it "ships dark: until
the free-tier abuse controls land, an operator must opt in." In place today: a
per-verified-identity cap of `FREE_TIER_WORKSPACE_LIMIT = 3` live workspaces (archiving
frees a slot), a per-identity daily invite cap, a workspace seat ceiling, a live agent
principal ceiling, and a disposable-email-domain speed bump. Still missing, and named in
§9 P5 as launch-blocking: the **global spend circuit breaker** that trips to a
signup-paused mode before cost runs away. That needs infrastructure this repo does not
have, so it is a real gap, not an oversight.

★ SUPERSEDED, kept so nobody re-derives it: this section used to say there is "no CLI verb
that calls `create_workspace`" and that reaching it "requires a hand-rolled request."
**That is dead.** `cswarm new "<name>"` exists in `src/cli.ts` and posts the command.

**THE ORDERING CONSTRAINT THAT MATTERS MOST HERE.** The marketing site and the edge
function deploy **independently** — `cd site && vercel deploy` is not coupled to a Supabase
function deploy, and there is no CI. So the switch is really three steps, and doing them
out of order publishes a false claim:

1. Deploy the edge function carrying `create_workspace` (it is on a branch, not on `main`;
   `git show origin/main:supabase/functions/command/index.ts | grep -c createSelfServeWorkspace`
   returns 0).
2. Set `SWARM_SELF_SERVE=1` in the production edge-function environment.
3. **Only then** deploy site copy that says signup is open.

Until step 2, site copy must not promise self-serve. The copy in this branch is written to
be true *before* the switch — it says signup is built but not open on this deployment. When
the switch flips, that wording is what needs revisiting, in `SiteFooter.astro`,
`download/AfterInstall.astro`, `landing/Invite.astro`, and `install.sh`'s closing text.

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
| 2 | Release repo (`-dist` vs public `cloud-swarm`) | Decision | ⬜ **OPEN** — with Forge; needs the operator's A/B answer | `curl \| sh` installing at all |
| 3 | State of formation | Fact to confirm | ✅ **DONE** — WA-formed LLC, TX office, venue kept | correctness of the terms |
| 4 | DMCA agent | External filing | ◐ **HALF** — named in the document, **not registered** | the §512 safe harbour |
| 5 | Supabase hosting region | Fact from dashboard | ✅ **DONE** — East US (North Virginia) | the privacy policy |
| 6 | `SWARM_SELF_SERVE=1` | Deferred on purpose | ⬜ **OPEN** — also needs the spend circuit breaker | public signup |
| 7 | Attorney review | External review | ⬜ **OPEN** | publishing the legal docs as in-force |
| 8 | One re-login per dogfood machine | Human action | ⬜ **OPEN** | dogfood surviving the rename |
| 9 | `legal@commonswarm.com` delivers | Test to run | ⬜ **OPEN** — never confirmed | every document that names it |
| 10 | USPTO check on "CommonSwarm" | Research | ⬜ **OPEN** — prompt written for an agent | launching under a name nobody has cleared |

**THE LEGAL DOCUMENTS ARE NOW GATED ON THREE THINGS, NONE OF THEM TEXT IN THIS REPO:**
items **4** (the filing), **9** (does the mailbox actually deliver) and **7** (attorney
review). Every `[[placeholder]]` is filled — the writing is finished. What is left is a
filing, a test, and a review, and all three happen outside version control. That is why the
draft banner is still up and why no amount of further editing will lift it.

Item **2** gates distribution on its own: everything else could be perfect and a stranger
still could not install. Item **6** gates the product being self-serve at all.
