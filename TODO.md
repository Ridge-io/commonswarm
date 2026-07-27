# TODO — blocked on the operator

Work that is finished as far as the repo can take it and is now waiting on a human
decision, a fact only the operator holds, or an action outside this repository.

Nothing here is blocked on engineering. Each item says what is blocked, who is blocked by
it, and how the current state was verified, so it can be picked up by someone who was not
here. Verify again before acting — these were checked on branch `l6/self-serve-front-door`
on 2026-07-27.

---

## 1. Domain not chosen — blocks the widest set of things

**Decision needed:** the public domain for coswarm. Candidates floated: `coswarm.dev`,
`coswarm.ai`, `coswarm.app`.

⚠ **`coswarm.dev` is not available.** It is a real, live, unrelated shipping product (a
self-hosted PaaS) that already serves a root `/install.sh`. Four files under `site/` warn
about it explicitly — `astro.config.mjs`, `src/layouts/Base.astro`,
`src/pages/download.astro`, and `README.md` — because it was once used as a placeholder
and pointed real users at a stranger's installer. Treat it as ruled out, not as a
candidate.

The name `coswarm` is decided. The domain is not.

**Blocked on this:**

| Blocked thing | Where |
|---|---|
| Legal contact email — **12 `[[CONTACT EMAIL]]` sites** | branch `legal/terms-and-policies`: `site/src/pages/terms.astro` (5), `privacy.astro` (6), `acceptable-use.astro` (1) |
| Security contact — `[[SECURITY CONTACT EMAIL]]` | branch `legal/terms-and-policies`: `SECURITY.md` |
| Canonical URL for the marketing site | `site/astro.config.mjs` — `site: "https://coswarm.invalid"`, a deliberately unresolvable placeholder |

All three legal pages currently pass `draft={true}`, which renders the **"Draft — not yet
in force"** band. The legal branch is **not merged** — verified:
`git branch --merged main` does not list `legal/terms-and-policies`, and it holds 4
commits not on `main`. Nothing above is live today.

Interim hosting stays the Vercel alias `https://coswarm-site.vercel.app`.

---

## 2. Release repository decision — blocks distribution

**Decision needed:** where published releases live.

`install.sh` defaults to `REPO="${COSWARM_REPO:-Ridge-io/coswarm-dist}"`. **That repository
does not exist.** Verified with a positive control on the same invocation: an
authenticated `gh` token that lists **17** repos in the `Ridge-io` org, and resolves
`Ridge-io/cloud-swarm` fine, returns *"Could not resolve to a Repository with the name
'Ridge-io/coswarm-dist'"*. So the installer's default download URL 404s for everyone.

**Recommendation on the table:** publish releases on `Ridge-io/cloud-swarm` instead, which
is already **public** (verified: `visibility: PUBLIC`). The only reason for a separate
`-dist` repo was a "source stays private" ruling that no longer holds.

**This is a decision, not a build.** The artifact is ready: `scripts/build-release.sh`
produces `dist-release/coswarm` + `dist-release/coswarm.sha256`, and self-tests by copying
the binary to a temp directory with no `node_modules` and requiring it to report the
injected version. Both files are present in `dist-release/` now.

Do not change `REPO`'s default until this is decided — the value encodes the answer.

---

## 3. State of formation for Yulan Ventures, LLC — **inferred, not supplied**

The legal documents state that Yulan Ventures, LLC is *"a limited liability company
organised under the laws of Texas"*. **Texas was inferred from the Austin principal place
of business (1200 W 6th St, Ste 600-188, Austin, TX 78703), not supplied by the operator.**
The commit that filled it (`59e5371`) flags this explicitly.

This is a fact about the entity, not a preference. If it is wrong, the terms misidentify
their own party. Confirm against the **certificate of formation**.

If the entity was organised in Delaware or elsewhere, it is wrong in two files
(`terms.astro`, `privacy.astro`) and the **governing-law and venue choice should be
revisited with it** — the documents currently select Texas law and exclusive venue in
Travis County, Texas, which was chosen on the assumption of a Texas home forum.

---

## 4. DMCA designated agent — must be registered, not just printed

`terms.astro` carries `[[DMCA AGENT NAME AND ADDRESS]]`. Filling it in is not sufficient.

**The designated agent must be registered with the US Copyright Office.** An address on a
web page does not create the DMCA safe harbour. Registration is a filing with a fee and a
renewal cycle, done outside this repository. Until it is filed, do not describe the safe
harbour as available.

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
**That is dead.** `coswarm new "<name>"` exists in `src/cli.ts` and posts the command.

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

## Summary of who is blocked on what

| # | Item | Kind | Unblocks |
|---|---|---|---|
| 1 | Domain choice (not `coswarm.dev`) | Decision | 12 contact-email sites, security contact, canonical URL |
| 2 | Release repo (`-dist` vs public `cloud-swarm`) | Decision | `curl \| sh` install actually working |
| 3 | State of formation | Fact to confirm | Correctness of terms + governing law |
| 4 | DMCA agent registration | External filing | Safe harbour |
| 5 | Supabase hosting region | Fact from dashboard | Privacy policy |
| 6 | `SWARM_SELF_SERVE=1` | Deferred on purpose | Public signup (also needs a CLI verb) |
| 7 | Attorney review | External review | Publishing legal docs as in-force |

Items 1, 3, 4, 5, and 7 all gate the same thing: taking the legal branch off draft and
merging it. Item 2 gates distribution independently. Item 6 gates the product being
self-serve at all.
