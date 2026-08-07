# CHARTER §6 launchable — audit, 2026-07-25

**Who:** Vane, product & launch lane, first task.
**Object under test:** `origin/main` — audited at `1bdf8ef`, re-checked at `710a731`, `c27ec9a`,
`3b8831f` and `ee11ff8`.
**Method:** the CLI was built from the audited tree into a private worktree and invoked by
path. The machine's `/opt/homebrew/bin/coswarm` was **not** used: on both machines it resolves
to a working tree on whatever branch happens to be checked out (at audit time, 29 commits
behind main). Hosted target: `https://ukezjcnxjvkpkeezxaew.supabase.co`.
**Nothing was fixed. Nothing was written to hosted.**

---

## Verdict: 0 of 5

§6 lists five things a stranger can do unaided. Items 2 and 4 were known blocked. Items 1, 3
and 5 are blocked as well, and items 2–5 all sit downstream of item 1 — so the count that
matters is that **a stranger cannot take step one.**

| § | item | state | class |
|---|---|---|---|
| 1 | install + authenticate unaided | **blocked**, three independent ways | missing feature + missing explanation |
| 2 | create their own workspace | **blocked**, two locks not one | missing feature |
| 3 | invite a collaborator, no terminal ritual | **blocked**, definitionally | missing feature |
| 4 | post/read signals from both machines | **blocked** for a stranger | collapses into item 1 |
| 5 | understand it without reading source | **blocked**, plus one real bug | marketing debt + bug |

---

## Item 1 — install and authenticate. Blocked three ways.

**(a) The artifact is unobtainable. — RULED ON, `54795ec`, and still not obtainable.**

> **Operator ruling, 2026-07-25: distribution is a signed installer / release tarball. The repo
> stays private and `coswarm` stays unpublished.** That is answer 3 of the four below, and it
> **closes the decision, not the item** — the installer does not exist. Item 1(a) moves from
> *open question* to **DECIDED, NOT BUILT**, and §6 stays 0 of 5 for the same reason it always
> has: a stranger still cannot obtain the artifact.
>
> The ruling also landed a mechanism rather than a rule: `package.json` had no `private` field,
> so `npm publish` would have succeeded. `"private": true` is now set.
>
> **Its RED arm was unverified for hours and is now verified — by Atlas, with a cheaper method
> than the one the succession plan records.** Three seats failed it first, all the same way:
> `npm publish --dry-run` exits 0 and never mentions the flag, and an *unauthenticated* publish
> dies at `ENEEDAUTH` before the guard is ever consulted. **npm checks auth before it checks
> `private`**, so every cheap attempt was vacuous.
> The discriminating pair needs auth *presented* — a fake token suffices, no registry and no
> `adduser`:
> ```
> private:true  + fake _authToken  ->  EPRIVATE, "marked as private", never opens a socket
> no private    + fake _authToken  ->  ECONNREFUSED — reaches the network
> ```
> **The flag is the stop** — it fires after packing and *before any network I/O*, which is the
> client-side fail-closed property the ruling needs.
>
> **Closed with a full discriminating pair, `54aa090`.** Quill produced the arm that makes it a
> discriminator rather than a demonstration: **remove only the field under test** — with it,
> `EPRIVATE`; without it, an actual publish and retrieval. Lead6 re-derived both arms before
> editing the baton and corrected their own residual, which had over-costed a closed task at
> *"verdaccio plus a real adduser"*.
>
> **The operative subtlety, Atlas's, and it is the whole task:** auth is **resolved** before
> `private`, not **checked** — and resolution is satisfiable locally. **A dummy token suffices
> and the registry never has to exist.** With no token you get `ENEEDAUTH`, the guard is never
> reached, **and that reads exactly like success** — which is how three seats produced vacuous
> arms in a row.
>
> *Boundary on this audit's own re-derivation: only the `EPRIVATE` arm was re-run in this lane;
> the second timed out here. One arm is not a discriminating pair, so the closure is Quill's,
> Atlas's and Lead6's — corroborated in part from here, not established from here.*
>
> *The original finding, kept because the fix has not shipped:*

```
gh repo view Ridge-io/cloud-swarm --json isPrivate   -> true
curl -o /dev/null -w %{http_code} .../cloud-swarm     -> 404
npm view coswarm                                      -> E404
npm view cloud-swarm                                  -> E404
```
`Ridgeio/swarm` is **public** — the local CLI is obtainable and the product is not.
**This is a ruling, not a build.** It blocks items 1, 3 and 4 simultaneously and no
engineering moves the bar until it is made.

**(b) A committed symlink shipped on `main`.** `node_modules` was tracked as mode `120000`
pointing at `/Users/yulanbot/Developer/Ridge.io/cloud-swarm/node_modules`, landed in `ff1cc1d`
— whose subject is *"cleanliness was verified at the registry layer, and the machine is
dirty"*. A fresh clone resolved outside itself; on the second machine that path does not exist.

*Why the gate did not fire:* `.gitignore` line 1 was `node_modules/` **with a trailing slash**,
which matches directories only. The committed object was a symlink. The rule everyone trusts
was verified against a directory; a different object got committed.

**Fixed at `c85d5ff`, and that fix closed the instance, not the class. The class is now closed
too** — the six remaining non-negation trailing-slash patterns were dropped and landed in ship 6.
Verified on landed `origin/main`: symlinks named `dist`, `build`, `coverage`, `scratchpad` and
`node_modules` all report IGNORED; the only trailing slash left is `!uxtest/rounds/*/`, which is
a **negation and remains unexamined rather than clean.**

*The original RED, kept because it is what the class looked like:* seven trailing-slash
patterns remained after `c85d5ff`. Demonstrated RED against the `.gitignore` at `710a731`, fresh repo, symlinks
with those names:
```
git status --short          ?? build   ?? coverage   ?? dist
git check-ignore -v  node_modules   -> IGNORED   (the fix works)
                     dist / build / coverage / scratchpad / supabase/.temp -> NOT IGNORED
```
`dist` is the live one: the uxtest harness already creates a `dist` symlink as a matter of
routine, and `package.json` `bin` points into it. Fix is one character per line.

**(c) The git-install route is broken too.** `bin` -> `dist/cli.js`; `dist/` is gitignored;
scripts have `build`/`prebuild`/`postbuild` and **no `prepare`**. npm runs `prepare` on git
installs, not `build`. So `npm i -g <git-url>` — the one route that could survive a private
repo — installs a bin pointing at a file that was never built. No `files` field either.

> **Closed by Pitch, and it was a stated limit of this audit.** This audit did not perform a
> clean-machine install; `node_modules` was shared throughout. Pitch ran it: fresh clone at
> `75dc05e`, the README's exact steps, `npm install` and `npm run build` **both exit 0** — and
> then
> ```
> test -e node_modules/.bin/coswarm       -> NO
> PATH=/usr/bin:/bin command -v coswarm   -> NOT FOUND
> ```
> **The documented sequence produces no `coswarm` anywhere on PATH.** It resolves on the fleet's
> machines only via a global `npm link` created by a step the README does not contain. So item 1
> fails at the *first command a stranger runs*, and that is now measured rather than argued.

> **Half-addressed — LANDED as `21b6425` in ship 5.** (Reviewed as `0ce100f`; the landed
> `package.json` blob is byte-identical to the cleared one — verified, not assumed.)
> Adding `"prepare": "npm run build"` and `"files": ["dist"]` was measured RED→GREEN, and the
> two install routes must be named by command because they behave differently:
>
> ```
> npm i [-g] git+<url>        c216050 -> no dist, no .bin, SILENTLY      RED
>                             0ce100f -> both present, coswarm runs      GREEN
> npm install in a clone      0ce100f -> dist built, .bin ABSENT,
>                                        command -v coswarm NOT-FOUND    unchanged
> ```
>
> npm never links a **root** package's own `bin`; only `npm link` or a global install does. So
> the git-install route is fixed and **the README's documented clone sequence is not** — that is
> a distribution decision, not a `package.json` line, and it stays item 1.
> Publish surface also went 195 entries / 11.3 MB → 62 / 484 KB; the 195 included the uxtest
> personas and harness scripts and all 53 files of `docs/`.
>
> *Recorded because the distinction cost a round-trip:* "install from git" is two different npm
> behaviours sharing one English phrase. Name the command, not the workflow.

**(d) Authentication cannot be self-served.** `--url` and `--anon-key` are required with no
baked-in production default (`src/cloud/config.ts`); verified by running `coswarm login` with
no arguments -> `coswarm: --url is required`, exit 1. Neither value appears in the README. A
stranger must be handed them out of band — the exact thing §6.1 forbids.

---

## Item 2 — create a workspace. Two locks, and the known one is the second.

`operatorAllowed: () => false` at `supabase/functions/command/index.ts:1634`, consumed at
`src/protocol/workspace-commands.ts:268`. Confirmed.

**But there is no CLI verb at all.** Demonstrated:
```
coswarm command create_workspace --name X  -> unknown option: --name
coswarm command create-workspace --name X  -> unknown option: --name
coswarm workspace create --name X          -> unknown command: workspace
```
`create_workspace` exists in the protocol (`workspace-commands.ts:21,107,261`) with no surface.
**Flipping the flag would change nothing a user can reach.**

The only path that creates a workspace today is `seed-fixture`, which the README itself calls
*"fixture/test-only, not a governed product workspace-creation path"* and which requires a
privileged `DATABASE_URL`. Both live hosted workspaces came that way.

> **Boundary:** the constant was read in the repo. The **deployed** edge function was not
> verified to match. Treat the server half as read, not run.

---

## Item 3 — invite and accept without a terminal ritual. Definitionally unmet.

- The accept path **is** a terminal ritual and the README documents it as one:
  `printf '%s' "$LINK" | coswarm accept --link-stdin`
- `coswarm://accept/…` is minted at `src/cloud/invite-link.ts:177` with **no OS handler
  registered anywhere in the tree**. It is not a clickable link; it is a string pasted into a
  shell pipeline.
- **No web surface exists.** `git ls-files` matching `\.(html|tsx|jsx|vue|svelte)$` returns
  **zero files**. Edge functions are `command`, `read`, `_shared`. The Appendix A board UI does
  not exist as code.
- **No delivery.** Nothing in `src/` or `supabase/functions/` sends mail. `--email` only
  *binds* the invitation; `cli.ts:783` tells the inviter to share the link themselves.
- And the invitee must clear item 1 first, which nobody can.

> **Boundary:** no live invite was sent — that emails a real person. Read from source and from
> the printed contract.

---

## Item 4 — signals from both machines. Blocked for a stranger.

Measured on the second machine:

| check | result |
|---|---|
| `coswarm` on PATH (`zsh -lc`) | **present** — `/opt/homebrew/bin/coswarm` |
| `node` on PATH (`zsh -lc`) | **present** |
| signal verbs in that build | **0** — it is the Jul 24 16:47 build |
| `~/.coswarm/credentials.d/` | **empty** — no login |

**A correction to `docs/dogfood/2026-07-25-p3-1-first-real-use.md` §F3**, which records
`coswarm` as *not found* and concludes the product *"is not present on the second machine at
all."* Both halves are false; the probe measured the **non-interactive ssh PATH** and reported
it as the machine's PATH.

```
ssh tom@… 'command -v coswarm'            -> NOT-FOUND      <- what F3 measured
ssh tom@… 'zsh -lc "command -v coswarm"'  -> /opt/homebrew/bin/coswarm
```

*And a correction to that correction, from Ferry:* a machine does not have **one** PATH, it has
one per shell form. `zsh -lc` and `zsh -lic` resolve different nodes on that laptop (v25.9.0 vs
v24.14.1). Any probe that picks one form and reports its answer as the machine's repeats the
error one level in.

> ### RE-MEASURED LIVE, 2026-07-25 ~21:30, and the charter is the side that is wrong.
>
> `docs/org/CHARTER.md:279` states item 4's blocker as **"the CLI is not on the second machine at
> all."** That is the original F3 probe error, and it is still live in
> `docs/dogfood/2026-07-25-p3-1-first-real-use.md:77`. (That document *has* a ★ CORRECTED marker
> at `:98` — it belongs to a different entry. A correction marker in a document is not a
> correction of the document.)
>
> Re-run just now on `toms-m1-max-mbp` (`tom@100.95.177.37`, `hostname` = `MacBookPro.lan`),
> **both probe forms in one session**, which is the only way to show the defect rather than
> assert it:
>
> ```
> command -v coswarm                    ->  NOT-FOUND                     <- what F3 measured
> zsh -lc "command -v coswarm"          ->  /opt/homebrew/bin/coswarm     <- the machine's truth
> coswarm --help | grep -c signal       ->  0        (stale build, no signal verbs)
> ls ~/.coswarm/credentials.d/ | wc -l  ->  0        (no login)
> ```
>
> **The CLI is on the machine. It is stale and unauthenticated.** The verdict item 4 reaches is
> unchanged — nobody can post signals from it, and for a stranger it collapses into item 1 — but
> the charter's *reason* is a retracted claim, and the two probe forms above are the demonstrated
> RED and GREEN of the instrument that produced it.
>
> **Bound, and it is not small:** the *other* laptop (`nikkis-macbook-air`, `100.75.195.7`) is
> **offline — `tailscale status` reports last seen 8m ago** — so it could not be probed. That is a
> measured fact rather than a failed instrument: a control ssh to `100.95.177.37` succeeded in the
> same minute, so the tailnet and this machine's ssh both work. **If the charter's "second
> machine" means that host rather than this one, this section has not tested it.**

**Consequence for scope:** distribution did not fail to happen. It happened once, by `npm
link`, on both machines, on Jul 24, and `uxtest/scripts/sync-machine2.sh` is an existing update
path that has run. Getting machine two current is **one script run plus a login** — not a
build, and **not the P2-connect-UX agent-skill layer.**
For a **stranger**, item 4 stays blocked, because a stranger has no harness to rsync from our
mini. It collapses into item 1.

---

## Item 5 — understand it without reading source. Blocked by the private repo.

> ### CORRECTION, 2026-07-25 21:2x — THIS SECTION MEASURED THE WRONG BLOCKER.
>
> **Everything below is a real defect and none of it is item 5's blocker.** The charter says so
> in the criterion itself (`docs/org/CHARTER.md:280`):
>
> > *"blocked today: **THE REPO IS PRIVATE**, so a stranger cannot read the README at all"* …
> > *"`c1d1213` … improves the document for everyone **WITH ACCESS** and **does not move this
> > item**"* … *"the unblock is the installer plus a public surface to read, **not more copy**"*
>
> §6's opening clause is *"a **stranger**, on their own machine, can:"* (`:267`). A stranger
> cannot reach this repo — Ledger measured it as **404, not 403**: they are not refused, they
> are told it does not exist. **No amount of README work can move item 5 while that holds.**
>
> **What this seat got wrong, in both directions inside ninety minutes.** It recited `0 of 5`
> from this document while `c1d1213` had already landed; then, having re-measured, it broadcast
> that `c1d1213` **moved item 5** and that a LICENSE file would make §6 read `1 of 5`. Both are
> false. Licensing is not a §6 criterion at all: `licen|copyright|rights` returns **zero across
> all 298 charter lines**, on an instrument checked with a live positive control (`installer` =
> 5) after an identical grep returned a *vacuous* zero against an empty file at the wrong path.
> **The bar was invoked repeatedly and never grepped.**
>
> **The findings below keep their value on a narrower claim, which is Pitch's:** the readers who
> exist today are the **invited dogfooders**, not strangers. Comprehension defects are real for
> them. They are quality work on the document, not evidence against a criterion whose audience
> cannot see it. Ferry's cold read (never having opened the README) is the better instrument for
> that narrower claim and found three live blockers this section does not contain — the best of
> them: **eighteen command lines and not one shows its output**, on a product whose entire claim
> is that others can *see* your intent.
>
> **Status of the three items below:** the comprehension defect was fixed by `c1d1213`; the
> usage-block bug by ship 6; the LICENSE by `ae1cb74` (`Copyright (c) 2026 Ridge.io`, holder and
> MIT grant both ratified by the operator on the day — the grant deliberately, with
> *"source stays private"* confirmed as a **distribution plan, not a legal control**).
> **All three are closed and item 5 is exactly as blocked as it was before any of them.**

**The sentence that explains the product is *(SUPERSEDED by `c1d1213`, which moved no §6 item)* at README line 134 of 260** — *"GitHub continues to
hold artifacts; Coswarm makes attention and intent machine-queryable inside one project"* —
buried inside a `###` subsection. A stranger reads, in order: "the cloud evolution of `swarm`"
(they have never heard of `swarm`), "P3-1 — invited dogfood" (an internal phase code), then
"reducer-complete authority core", "immutable signal plane", "transactional Supabase Edge
functions" — implementation vocabulary by sentence three. The only setup heading is `## Dev`.
There is no LICENSE file despite `package.json` declaring MIT. *(Closed by `ae1cb74`. Recorded
here because the sentence was true when written and a quoter should not lift it as current —
and because the fix cost an operator answer, not boilerplate: the copyright holder was not
recoverable from the repo. It moved no §6 item.)*

**The 30-second test fails, and not narrowly.**

> **Partially addressed by Ship 3 (`c27ec9a`), verified by execution from a build of landed
> main.** The three strings a stranger meets first were rewritten. `--url is required` now names
> the value (`https://<ref>.supabase.co`), names its source in the abstract ("the deployment
> operator who invited you"), and points at `accept --link-stdin` — **inventing no place, which
> was the constraint, because there is nowhere to point.** Argument errors now distinguish
> direction: `too few positional arguments: expected 2, received 1` and `too many … received 4`.
>
> **What Ship 3 did not address, and should not be read as having addressed:** the README's
> opening *(SUPERSEDED by `c1d1213`:* the explaining sentence is still at line 134*)*, the missing
> LICENSE *(SUPERSEDED by `ae1cb74`)*, and the usage-block defect below *(SUPERSEDED by ship 6)*.
> It fixed three strings, not item 5 — and none of the three supersessions moved item 5 either.
>
> *One shape note, and it is this audit's own recommendation coming back:* the new `--url` message
> is **328 characters on one line** — four wrapped lines at 80 columns carrying three routes. The
> recommendation asked for "one sentence, no invented place"; one sentence carrying three routes
> is how that becomes a wall. The constraint should have been on the reader's effort, not the
> sentence count.

**And one real bug — FIXED AND LANDED in ship 6.** Verified on landed `origin/main`: an unknown
command now prints **55 lines / 4123 chars**, exit 1, message first and the whole block after.
A `UsageError` carries only the sanitized message; `usage()` is written verbatim, and everything
it interpolates is validated at source — a `package.json` version containing ESC and a newline
renders as `coswarm unknown`, not as a clear-screen sequence.

*The original RED, kept because the shape is the finding:* mistype a command and the 54-line
usage block was flattened to **one line and truncated mid-flag**:
```
coswarm help              -> 54 lines, 4087 chars
coswarm workspace create  ->  1 line,  1010 chars, exit 1
```
`src/cli.ts:1711` embeds `usage()` in an `Error`; `safeError()` (`:1714-1719`) maps the C0
control range `U+0000..U+001F` to spaces — **which includes newline** — then slices to 1000.
A sanitizer built for hostile server text is pointed at our own help output. The user never
sees `use`, `invite`, `accept`, `principal`, `token`, `command`, `dogfood`.

---

## Checked clean

A findings list that only finds is not calibrated.

- **F1 and F2 are genuinely fixed and live.** Re-derived against hosted with a main build, not
  taken from report. The feed renders name, `— you —`, relative time and horizon in both `feed`
  and `status`. F2 in particular is properly closed: the `until` model is visible now.
- **Auth works first try.** The stored profile was verified to be bound to that origin rather
  than assumed: `sha256(url)[:24] == 3dbdc39fb06df6ff59e3decb ==` the profile filename.
- **Exit codes are correct** (1 on error). Empty-state copy is good. `coswarm help` itself is
  well organised and honest about unsafe forms.
- **The two signal read paths agree.** `humanSignals` (PostgREST) and the agent path
  (`functions/v1/read`) select from the same `swarm_read.signals` view with the same columns,
  ordering, limit and filters; measured on the same data through both paths, identical rows.
  Tenancy is single-sourced in the view, which is `security_barrier`, definer-owned, and no
  migration sets `security_invoker`.

## Filed, not blocking

**Agents have no addressable identity as a recipient.** `--to` resolves against live *members*
(humans); an agent authenticates as its owner (`read/index.ts:165-173` sets
`request.jwt.claims.sub` to `owner_user_id`), so the view's own predicate rejects a signal
addressed to an agent before any call-site predicate runs. A directed `ask` in a workspace with
one human and three agents reaches all four and none can tell it was not meant for them.
**Changing this costs a migration, not a call-site edit** — the view is definer-owned by
`swarm_admin`. Defensible behaviour; nowhere stated. P4-shaped, not a launch blocker.

**Signals have no instrumentation channel.** Signals are immutable and never deleted by design.
There is no test/system flag and `--kind` cannot separate probes from coordination. Six
benchmark rows and three real signals currently share one workspace feed, distinguishable only
because their author typed "(ignore)" in the body. **The first person who benchmarks their own
workspace permanently pollutes its primary read surface**, and the product offers no remedy.
A design gap, not a defect.

---

## Ranked, by blocks-most over costs-least — status at handoff

| # | item | cost | state |
|---|---|---|---|
| 1 | **Distribution** — ruled `54795ec`: signed installer / tarball, repo private | the decision is made; the installer is not built | **DECIDED, NOT BUILT. Still blocks §6 1, 3 and 4.** |
| 2 | `.gitignore` — close the class, not the instance | minutes | **CLOSED**, ship 6 |
| 3 | `prepare` script + `files` field | minutes | **CLOSED**, `21b6425` |
| 4 | `safeError` eating the usage block | minutes | **CLOSED**, ship 6 |
| 5 | README top 30 lines, rewritten around line 134's sentence | hours | OPEN |
| 6 | Second-machine update + login | one existing script run | OPEN |
| 7 | Workspace-create CLI verb + a real operator policy | the only genuinely large one | OPEN |

Items 2–4 were all *"a gate that could not fail"* or *"a sanitizer aimed at the wrong object"* —
the two shapes §3 already names — and all three are now on `main`, verified there rather than on
the branch that produced them.

---

## For whoever picks this up

**The ruling has been made and the bar has not moved.** `54795ec` decided distribution: a signed
installer / release tarball, repo private, `coswarm` unpublished. **§6 is still 0 of 5**, because
a decision is not an artifact and the installer does not exist.

What the ruling closes and what it does not:

| | |
|---|---|
| **Closed** | the open *question*. Nobody needs to re-litigate public-vs-npm-vs-tarball. |
| **Closed** | the publish hole — `"private": true` is a mechanism where "do not publish" was a rule. Its RED arm is unverified; see item 1(a). |
| **Open** | the installer itself. Until it exists, items 1, 3 and 4 stay blocked exactly as before. |
| ~~Open~~ | ~~items 5 (README opening, LICENSE)~~ — **wrong on both counts, corrected above.** The README opening closed (`c1d1213`) and LICENSE closed (`ae1cb74`), and *neither moved item 5*, which is blocked by the private repo. This row also said item 5 was **"unaffected by the ruling"**; it is the item the ruling most directly blocks. |
| **Open** | item 7 (workspace-create verb). |

**The next thing this lane would do, and the one warning worth leaving:**

The §6 gate for item 1 is *"a stranger installs it and authenticates **without being walked
through it**."* **That is a comprehension claim, not a packaging one.** An installer that places
a working binary and explains nothing still fails that sentence, and it fails at the moment a
stranger has the least context they will ever have.

Every installer emits three lines whether or not anyone designs them: **what it is about to do ·
what it did · what to run next.** The third is the product's front door, and the product's real
entry point is `coswarm accept <invite-link>` — which **nothing in the product has ever said.**
The structure to use already shipped twice in this codebase (Ship 3's *what happened · what is
now true · what happens next*); an installer that ends `Installed.` is the `Signal shared.` of
the install path — complete, and the one thing a stranger cannot act on.

**Do not let the installer be reviewed as packaging.** It is first-contact text, and first-contact
text is the class that produced C11, C12 and C0.

---

## What this audit did not verify

- The **deployed** edge function was not compared against the repo.
- No live invite was sent.
- No path was exercised under a real agent credential.
- Only the seven trailing-slash patterns were tested, and only for the symlink hole; the
  negation block at `.gitignore:22-30` is **unexamined**, not clean.
- ~~A clean-machine `npm install` was not performed~~ — **closed by Pitch**, see item 1(c).
- **There is nowhere to send a stranger for a project URL.** Verified: no landing page, no
  docs site, no CNAME, and no `homepage`/`repository`/`bugs` field in `package.json`. The
  only URL in the whole README is the *other* repo, `Ridgeio/swarm`. Any error string that
  tells a user where to obtain a URL would be false today.
