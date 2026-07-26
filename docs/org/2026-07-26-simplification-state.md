# Simplification mission — state at Lead6 handoff (2026-07-26)

Written because this session is at its context limit and the operator's direction
changed mid-flight. A successor should be able to continue from `origin/main` plus this
file without reading the transcript.

## The direction, in the operator's words

> The benefit is agent-to-agent communication so that collaborators are unblocked and
> don't step on each other's toes. Reduce the safeguards. Count on agents being
> intelligent enough not to do stupid things. Simpler is better.

This replaced an "authority / authorised / on the record" framing that the Lead had
written into `docs/marketing/SITE-BRIEF.md` and that nine agents faithfully built to.
See that file for the retired framing (kept and marked) and the vocabulary table.

## Landed on main

| commit | what |
|---|---|
| `e0287ba` | `install.sh` + `scripts/build-release.sh` + working `coswarm --version` |
| `9c56936` | the marketing site (`site/`, Astro, static, self-hosted fonts) |
| `571cc0e` | removed `coswarm.dev` — an unowned domain serving a stranger's root installer |
| `273c472` | brief re-pointed: authority framing retired |
| `b13ebd0` | installer no longer tells nvm/fnm/asdf users they have no Node |
| `4cfab0d` | the heading/command coupling recorded before someone tidies it away |
| `eed9299` | **current-target persistence — `--url`/`--anon-key` gone from every human command** |

## Specced, NOT implemented — and the order is binding

Target: first use goes from two commands and seven flags to `coswarm token mint --scope <scope>`.

**Artifact of record for this friction work** (Lead6 #14973): Vane's files, not any Lead
broadcast. A Lead's ruling is a *decision*; the file is the *specification*.

```
docs/friction/2026-07-26-ceremony-before-first-work.md   ON main (265edb0)
docs/friction/2026-07-26-spec-token-mint-one-flag.md     ON main (265edb0)
```

~~*origin/main NEITHER of those paths (yet)*~~ — **superseded.** Landed by Vane at `265edb0`
after Pitch named the 404 as the handoff's own failure mode. Control: `git cat-file -e
origin/main:docs/friction/2026-07-26-spec-token-mint-one-flag.md` resolves. The branch
`origin/vane/friction` may still exist as history; **main is now the durable copy.**

1. **`task_id` / `epoch` become OPTIONAL — as VARIANT 2, not as a bare word.**
   ~~*Binding fields (`run_id`, `task_id`, `epoch`) become OPTIONAL*~~ — **superseded wording.**
   `run_id` is *not* in this group (see item 2). `binding_required` is deleted; the
   `task_id`/`epoch` columns are not. Deletion would foreclose ever enforcing the binding;
   enforcement is expensive-but-reversible while deletion is cheap-and-irreversible.
   Optional gets the friction win and forecloses nothing — **only if implemented as the
   correct variant.**

   **"Optional" has three readings and only one is executable** (Lead6 #14973 confirming
   Sable; Vane's spec is the long form):

   | variant | result |
   |---|---|
   | 1. default NULL, **keep** the projection throw | **mint still dead** after "optional" |
   | **2. default NULL, drop the projection throw** | **THE RULING** — nullable, written when supplied, auth unchanged |
   | 3. default non-null (synthetic epoch/task) | re-opens Atlas's `current+1` trap |

   **Variant 2 is the ruling.** Variant 1 is what an implementer reaches by taking "make the
   fields optional" literally and touching only the CLI — exactly the failure the ordering
   constraint predicts, arriving through the wording instead of through the sequence.

2. **`--run-id` server-generated, `agent_runs` row still written.** It is INNER JOINed at
   every agent auth. Generate a real v4 UUID (the column casts `::uuid`) or every minted
   token authenticates against nothing.
   **`run_id` is NOT optional — it is REMOVED from the surface and server-generated.**
   This differs from `task_id`/`epoch` deliberately and the handoff previously left it
   ambiguous (Sable caught it). A caller-supplied `run_id` is *rejected*, not defaulted,
   because `agent_runs` has an ON CONFLICT path that can yield a silently dead token —
   Vane's measurement, banked at `origin/vane/friction`. `run_id` leaves the surface
   entirely; the server generates a v4 UUID while still writing the `agent_runs` row.

3. **`--principal-id` defaulted:** none → create; one → use it; many → require and list.
4. **Self-registration on first use**, justified by reversibility: `principal create` is
   reversible (`revoked_at`, checked at every mint) and minting is reversible (it expires).

### ⚠ Ordering constraint — reverse order breaks mint at runtime

The `AgentTokenMinted` handler throws when `task_id`/`epoch` are null, the reducer's
`req()` lists them as required, and `mintBindingsValid()` keys its `agent_runs` lookup by
the caller-supplied `run_id`. The database will NOT catch this: the columns are nullable.

> **⚠ THE LIST BELOW IS NOT AN INVENTORY. RE-GREP BEFORE IMPLEMENTING.** Sable found it
> already undercounts: besides the four named, the mint wire type requires
> `run_id`/`task_id`/`epoch` (~`164-169`) and there is a runtime `exactKeys` + UUID/integer
> check on the mint wire (~`879-901`, `command/index.ts`). That is the same silent-undercount
> class this session kept paying for. Treat these as *known* sites, not *all* sites.

**Land the server side first** — `prepareWorkspaceCommand`, the reducer event shape and
`req()` list, the null-check side-effect, `mintBindingsValid` — **then** change the CLI
surface. Found by Sable.

## The TTL stays. Permanently.

`fix the binding, drop the timer` is **RETRACTED**. The TTL is currently the *only*
automatic containment in the product — every other control (revocation, tombstones,
`principal_revoked`) requires a human to act first. Since the binding is not enforced,
deleting the timer would leave a credential with no automatic bound at all.

The friction fix is instead: **raise the default TTL**, and apply Ledger's rule —

> No human gate when a mint grants no authority the caller does not already hold: same
> principal, and scopes a subset of an existing live token's scopes for that principal.
> Anything that widens scope, or names a principal the caller has no live token for,
> keeps the human gate.

There is no `renew` verb and re-minting needs a human login. *That* is the ceremony an
honest agent actually meets — not the timer's existence.

## Safeguards that must SURVIVE this mission

Named as loudly as the deletions, because a friction mission is exactly where a real
safeguard gets removed by momentum:
`scope_not_allowed` · `scope_denylisted` · the `humanRights` ceiling · `principal_revoked`
· `principal_not_owned` · the `agent_runs` INSERT · the reducer's `assertEpochIncrease`.

## ⚠ THE LARGEST GAP: `supabase/functions/` IS TYPECHECKED BY NOTHING

Found by Atlas, who walked into it while verifying its own diff and then corrected its own
report. Verified independently by the Lead with a positive control:

```
tsconfig.json  "include": ["src/**/*.ts"]
npx tsc --listFiles | grep -c 'supabase/functions/'   ->  0
npx tsc --listFiles | grep -c '/src/'                 ->  21   (positive control)
```

**The edge functions are the deployed authority — the thing a stranger actually talks to —
and no typechecker in this repo covers them.** `esbuild` bundles them successfully, but a
bundle is a *parse*, not a typecheck: it proves the file is syntactically valid and nothing
more. The `p1-server` suite is the only real coverage and it needs a live stack.

This is not hypothetical. It already hid a real bug: `mintBindingsValid` referenced
`command.run_id` after that field had been deleted from the wire type, which at runtime
interpolates `undefined` into a `::uuid` cast. `tsc` reported exit 0 and could not have
caught it. Atlas's own summary is the right one: **a green check whose scope you have not
verified is indistinguishable from no check.**

**Consequence for the successor: every edge-function change made during this session landed
on parse-level confidence.** Before implementing the specced sequence — which is mostly edge
code — add real coverage: a `deno check` step, or a second tsconfig that includes
`supabase/functions/`. Nobody installed a Deno toolchain on the shared machine unilaterally,
and that restraint was correct.

## ~~THE SITE MISDESCRIBES THE PRODUCT~~ — FIXED at `6cdaa81`

Struck rather than deleted, per doctrine 5. Superseded by `6cdaa81`, which removed four
false claims from the page a stranger reads:

- the hero's "bound to one run, one task and one epoch" — **false**; the binding is
  write-only and a token mints against a well-formed UUID naming no task
- Authority's identical claim, plus a "four hours" maximum TTL that is really **eight**
- two places still instructing readers to pass `--url`/`--anon-key`, removed by `eed9299`
- the justification comment quoting "the url is the storage key and cannot be recovered",
  now marked SUPERSEDED in place (correct at its commit; `current-target.json` stores the
  url in plaintext)

**Two lessons banked from the fix itself.** The first pass corrected only the three sites
the report listed and the built page *still* carried the claim — a findings list treated as
an inventory, caught only by a positive control returning 1 where it should have returned 0.
And Ledger, who found that two of the three were its own errors, refused to fix them quietly:
*"that is exactly when a seat should not be the one to quietly fix the record."*

Ledger's sentence is the one to carry forward: **"My sentence travelled further than my
correction did."** The retraction reached the fleet in a broadcast; it never reached the file
that quoted it.

Still open on the site, and it is the positioning rewrite rather than a defect: the copy is
still built on the retired authority framing. See the vocabulary table in
`docs/marketing/SITE-BRIEF.md`.

## Known defects, not yet fixed

- **The binding is write-only at auth.** `loadAgentCredential` does not SELECT `task_id`
  or `epoch`; a token "for task X" drives its command kind against any task in the
  workspace. NOT a workspace escape and NOT an auth bypass — over-breadth inside a
  workspace the principal already legitimately holds.
- **Revocation tombstones are read on every agent request and written by nothing.**
  `agent-auth.ts` queries `revocation_tombstones` for seven target kinds (token,
  principal, run, device, membership, lineage, family); the table is `GRANT INSERT`ed
  and `p1_schema.sql:766` says *"Section 3.2 step 13 requires tombstone inserts"* — but
  there are **zero INSERT sites in the repo** (control: the same search finds 1 for
  `swarm.agent_runs`). So that query always returns zero rows and its branch can never
  be true. **What still works is the column path** — `token_revoked_at`,
  `principal_revoked_at`, `run_ended_at`, `device_revoked_at`, `surrender_only`,
  membership — which `revoke_agent_token` and `revoke_agent_principal` do set, so
  revoking a token or a principal genuinely works. **What does not exist is the
  cascade**: lineage/family revocation — the "stop this agent's whole succession"
  button — has no writer and no command. Relevant because renewal mints successors
  carrying `lineage_id`. Not an auth bypass: a *missing* containment, not a broken one.
  Source-and-schema trace, not executed.
- **`Ridge-io/coswarm-dist` does not exist**, so `install.sh`'s default target 404s.
  `COSWARM_BASE_URL` overrides it, which unblocks gate 5 without any publish decision.
- **The name `coswarm` collides** with a shipping self-hosted PaaS that owns `coswarm.dev`.
- **`/docs` and the GitHub nav link 404.** The repo is private.

## ⚠ THREE WORDS, NOT TWO — read before using the branch table below

Pitch enumerated every ref at `origin/main` and reconciled it: **18 branches on origin, exactly
1 is an ancestor of main, and that one is `main` itself.** No seat's branch has ever been merged
this session. Everything on main arrived by being committed on main or cherry-picked.

So the word "landed" has been doing two jobs and a successor will test the wrong one:

| word | means | check |
|---|---|---|
| **PUSHED** | the ref exists on origin | `git ls-remote` |
| **LANDED** | the **branch** is an ancestor of main | `git merge-base --is-ancestor` — true of **nothing** |
| **APPLIED** | the **content** is on main, by any route | `git cat-file -e origin/main:<path>` |

**Every "landed" said in this fleet meant APPLIED.** The row below marking
`origin/vane/friction` as landed is a claim about *files* wearing the grammar of a claim about a
*ref*: `docs/friction/*.md` is present on main, the branch is not an ancestor. A successor
running `--is-ancestor` on it gets "unmerged" and wrongly concludes the doc is wrong.

**`origin/ledger/epoch-binding-test` is now APPLIED, not landed** — `tests/protocol-agent-token-binding.test.ts`
is on main and named by the runner, protocol suite 66 → 70. The branch is still not an ancestor,
because it was cherry-picked. It no longer carries anything main lacks.

## Branch board — check each row (do not trust this heading as a uniform claim)

~~Unlanded branches — sole copies that nothing else points at~~ was load-bearing copy wearing
decoration. Once any row became **APPLIED** (content on main, branch still not an ancestor),
the heading overstated what the rows claimed: LANDED stayed false for every seat branch, but
"sole copy" stopped being true for Ledger's and friction's content. **Headings that assert a
uniform property across rows go stale the moment one row changes** (Lead6 #15541). The rows
below are the instrument; this heading only says *look at them*.

**Three words, not two (Pitch #15487, Ledger #15467):**

| word | means | instrument |
|---|---|---|
| **PUSHED** | ref exists on origin | `git ls-remote` |
| **LANDED** | the *branch* is an ancestor of `main` | `git merge-base --is-ancestor` |
| **APPLIED** | the *content* is on `main`, by any route | `git cat-file -e origin/main:<path>` |

**Frame at last re-derive of this section: re-run at your tip.** Heading fix `ce91d63` on
parent `810db36`; cherry-board over-elevation `903d3b8`; this paragraph demotes every single
command to a named failure mode. **18** origin heads (excluding the `origin` remote-tracking
alias), **1** is an ancestor of main (**`main` itself**), **17** are not — sum reconciles.
**No seat branch from this session is LANDED.** Work that appears on main was **committed on
main** (or APPLIED as content by re-application / cherry-pick). "Landed" in fleet speech almost
always meant APPLIED; a branch *table* must not use that word for content-only cases.

### No single-command board (Pitch #15539 → #15549 → #15562; Ledger)

Four instruments were run on the prune / "what remains" question. **Each fails in a different
direction.** There is no fleet-wide single-command answer. **The only rule that survived all
four: the owner confirms, or nothing is pruned / classified as salvageable.**

| instrument | what it answers | how it fails on this board |
|---|---|---|
| path-absence (`comm -23` of `ls-tree` tips; control `cat-file -e origin/main:README.md`) | path exists on main? | blind to **modified shared files** — Quill `current-target-followup` and Atlas `binding-deletion` both read **0** while holding live unapplied work (2 of 2 false "prunable") |
| `git cherry origin/main <ref>` | patch-id already on main? | blind to **squashed cherry-picks** — Ledger's content landed byte-identical as one commit `f6aab12`, so cherry reports **false NON-zero** (`+6` with zero unapplied *content*). Also can false-zero a modified landing. **Wrong both ways** |
| two-tree `git diff --name-only origin/main origin/<ref> \| wc -l` | tree distance | counts paths where **main is newer** too — cannot be thresholded. Atlas #15572 on `binding-deletion` at main `903d3b8` / merge-base `ccba540`: branch-side 8 + main-side 9 = two-tree 17 exactly — **53% of the row's "distance" was main moving under the branch**. A distance carries **both endpoints** (or it is unreadable; grows without anyone touching the branch) |
| blob-per-path | content identity per path | correct *shape*, still needs the **owner** to say what a modification *means* |

**Pitch withdrew "fourteen can be deleted"** (path-absence board) after Quill's counterexample.
Sable briefly banked `git cherry` as the unapplied board at `903d3b8` — **that over-elevation
is wrong for the same reason**; cherry counts may appear below as *historical measurements*,
not as prune authority. A broken blob-board run (Pitch #15562) nearly published `176` + sixteen
false zeros when `git` was missing inside a subshell — **implausible first cell + interleaved
errors** stopped publication; a plausible `8` would have shipped.

**Owner confirmations recorded so far (re-derive; do not invent the rest):**

| owner | ref | ruling |
|---|---|---|
| Atlas | `origin/atlas/binding-deletion` | **do not prune** — PUSHED / not LANDED / not APPLIED; `git cherry` `+3` (`55f1b41` `291d901` `325ce44`); path-absence 0 is the Quill-class false |
| Ledger | `origin/ledger/epoch-binding-test` | **prunable** (owner) — named test content on main at `f6aab12`; cherry `+6` is false non-zero for content |
| Ferry | `origin/ferry/r1-go-runbook` | **holds three files; cherry-pick them; never squash** |

Fourteen other non-ancestor rows remain **unconfirmed** by their owners. Pitch is not
classifying them. Sable is not classifying them.

Notable rows (successor must not misread these):

| branch | what |
|---|---|
| `origin/vane/friction` | **Content APPLIED, not LANDED** (`docs/friction/*.md` on main since `265edb0`). Branch tip is **not** an ancestor. ~~LANDED on main~~ was content-grammar wearing a ref word. Owner prune ruling: **not recorded here**. |
| `origin/vane/site-audit` | site command-string audit. Sole *new* file still useful to name: `docs/marketing/2026-07-25-command-copy-audit.md`. Owner prune ruling: **not recorded here**. |
| `origin/vane/launch-audit` | §6 launch-bar audit. Sole *new* file: `docs/launch/2026-07-25-launchable-audit.md`. Owner prune ruling: **not recorded here**. |
| `origin/ledger/epoch-binding-test` | **Named test APPLIED, not LANDED** — content on main at `f6aab12` (`tests/protocol-agent-token-binding.test.ts` resolves; suite 66→70). Branch tip **not** an ancestor. **Owner (Ledger): prunable** — cherry `+6` is the squashed-apply false non-zero. Four-arm characterisation; header was later measurement-only. |
| `origin/atlas/binding-deletion` | **TIP IS `325ce44`.** **PUSHED yes / LANDED no / APPLIED no** (Atlas #15545, owner): `binding_required` still on main; three unapplied commits. Path-absence 0 is *not* prunable. Two earlier SHAs in prose below are point-in-time records (doctrine 5); **both carry defects fixed later on this branch**: `55f1b41` has the `exactKeys` omit-path bug *and* accepts a caller `run_id`; `291d901` fixes the first only. **Only `325ce44` has both.** **VARIANT 2 (optional, not deleted), rebuilt on `ccba540` — NOT the deletion diff.** Delete discarded once Vane's hold landed. Fields stay, default NULL, `binding_required` gone on the *branch*, projection throw dropped, **auth path untouched — control: empty `git diff --stat` against `agent-auth.ts`** — **no migration**. 67 protocol tests pass on the branch. **Edge half esbuild-PARSED, NOT TYPECHECKED; `test:p1-server` never run against it.** **Parked sequence — must not land on that basis; owner: do not prune.** |
| `origin/ferry/r1-go-runbook` | **TIP `6126f1d`** (Ferry #15568). Three sole *new* files under `uxtest/findings/` still path-absent from main: `R1-GO-RUNBOOK.md`, `2026-07-25-r1-gate5-hang.md`, `2026-07-25-persona-surface-env-capture.md`. **Do not cherry-pick wholesale** — main already holds a verified spawn-hang root cause Ferry did not author (`uxtest/findings/2026-07-25-spawn-hang-root-cause.md` and three sibling isolation/blocker docs); Ferry's hang-file headline said *intermittent, cause unknown* and was **struck (not deleted) at `6126f1d`** once that was found. Path-count 3 means "three paths main lacks", **not** "three files worth having whole". Still unique / salvage-shaped per owner: SIP warning in §0, outcome taxonomy, negative-control fixture; **runbook remains the only executable gate path** (no main equivalent). **Never squash or `diff \| apply`.** Touches `uxtest/findings/` only; no commit on the branch deletes anything. **R1 hang is diagnosed on main; validity-blockers doc still names remaining independent blockers.** Operator ruling for go still gates the round. |

## The last open measurement is OPERATOR-ONLY — no seat can run it

`accept` followed by a bare command in a fresh process is the one arm nobody has closed.
**It is not "someone should run this."** Ledger tried and found it structurally closed to
every agent, measured with a controlled grep (control: a JWT-shaped literal in a temp file
*did* match, proving the pattern works):

- **No anon key exists anywhere a seat can reach** — not in `~/.coswarm`, not in tracked
  `supabase/`, not in the environment. Seats hold human *profiles* but no key to talk to the
  project with; the profile schema never contained one.
- **No invite link can be issued** without a stored human login, which is operator authority.

So the handoff must not read as a task. Closing it needs the operator to supply a target and
issue one invite. Until then: `writeCurrentTarget` is proven **wired** at four call sites in
`src/cli.ts` (~677 `target set`, ~914 legacy accept, ~1000 link accept, ~1760 login), and
that is call-site evidence, not a run. Parse + persist + next-process find remain unproven.

## Open, operator-only

1. The name collision.
2. Whether to create the public dist repo.
3. How deep the cut goes beyond the above.

## Doctrine earned this session — these are the transferable part

1. **Measure the artifact, not its name.** Resolve the path / URL / ref / symlink before
   trusting a result. Seven instances in one session, including a hero CTA that copied a
   stranger's root installer because nobody `curl`ed the placeholder domain.
2. **Run a positive control on the same invocation.** A check that cannot fail is
   indistinguishable from one that passed. When both arms of a probe produce identical
   output, that is a broken instrument, not a result. Ledger proved a new test ran by the
   suite count rising 66 → 70, not by it being green.
3. **Review the decision SET, not the items.** Two pairs of individually-correct,
   individually-reviewed rulings were unsafe in combination. Neither was findable by
   reviewing either ruling alone.
4. **When a ruling lands, re-read the still-live rulings for words it just emptied.**
   Four sentences outlived the things they named in one session.
5. **Corrections go in the artifact, not in a message.** A correction in chat does not
   reach whoever pulls the repo tomorrow. Keep the superseded sentence, marked dead, so
   nobody re-derives it.
6. **Ask who READS a field before asking whether it is correct.** Atlas's question
   invalidated a leg of one argument, corrected a spec twice, and overturned two rulings.
7. **A rule you only ever apply in the direction you are already going is not a rule.**
   Vane stopped a Lead's deletion using the same irreversibility rule the Lead had been
   using to justify deletions.
8. **A Lead's ruling is a decision, not a specification.** It is not done when the Lead
   has chosen; it is done when someone can execute it without guessing. Four rulings in
   one session needed a seat to push them back into implementable form: "server supplies
   current+1" was wrong on its own terms (Atlas); "delete the fields" foreclosed the
   enforce option (Vane); "same-binding re-mint" named a thing the ruling hollowed out
   (Ledger); "optional" had three readings and one ships a dead mint (Sable). Two of the
   four were right in *intent* — **the gap between intent and executable is where the
   defects lived**, and every seat that pushed one back was doing the job, not questioning
   it. Therefore **Vane's friction files, not any Lead broadcast, are the artifact of
   record for this work** (see paths under Specced above).
9. **A measurement's failure mode is undercount, and undercount is silent.** A stale
   instruction eventually becomes false and something contradicts it. An incomplete
   measurement never becomes false — no test fails, no ruling contradicts it, no reader
   trips; it sits there accurate and misleading. One require-path list went from two
   entries to five when a second seat looked, and both original entries were correct.
   **So a list in a durable artifact carries the command that regenerates it, or says
   plainly that it cannot be regenerated.** Absence from a list is not permission.
10. **"File beats broadcast" gives no answer once several files disagree — and the first
   file to check is the one you are writing in.** (Pitch's clause, from Atlas's failure;
   landed by Atlas because it is Atlas's error that is the evidence.) Doctrine 8 ranks
   files above broadcasts and stops there. Atlas was choosing among *three* live artifacts
   — handoff §2, Vane's spec, and Atlas's own branch row — cited a superseded Lead
   broadcast over the handoff, **and did it while editing the handoff**, in a paragraph
   whose stated purpose was telling the next seat which authority to follow.
   - **Pitch's tie-breaker: the document that names the seat who caught a refinement
     outranks the one that does not.** Handoff §2 read *"differs from `task_id`/`epoch`
     **deliberately** … the handoff previously left it ambiguous (**Sable caught it**)"*.
     **That parenthesis is the scar of a correction; the broadcast had no such mark. A
     refined document carries the scar, an unrefined one reads cleaner and is more
     dangerous.**
   - **Its limit, stated so it is not over-trusted: a scar proves refinement, not
     recency.** A scarred document can still be the older one. Where the two diverge, the
     later *decision* wins and the scar is only evidence about which document has been
     argued over. In Atlas's case §2 was both, which is why the heuristic looked total.
   - **The narrower rule that would actually have prevented it, and costs one command:
     before citing any external authority, read whether the artifact in front of you
     already answers the question.** Atlas never read §2 of the file being edited. The
     scar was there to be seen; nobody looked at the page.
11. **The label is authored by the expectation; the output is authored by the world — and
   they print adjacent so they read as one thing.** Atlas printed a grep captioned *"no
   run-id above = the flag is gone"* with `run-id` on line 7 of that same output, the
   caption having been written before the command ran. Pitch did the identical thing twice
   in a day. **The fix is not "read more carefully" — it is to put the raw output next to
   the claim, so a reader can catch what the writer structurally cannot.** A self-authored
   summary of evidence is not evidence.

## Residuals banked after Lead stand-down (2026-07-26, Sable)

Lead6 instructed: stop reporting into the Lead sink; put findings in the artifact;
do not implement the parked sequence; nobody deploys. The following were re-derived
from source after that instruction. They are not a reopening of closed rulings.

### 1. Atlas VARIANT 2 — omit-path exactKeys residual CLOSED on tip `291d901`

Commit `55f1b41` on **`origin/atlas/binding-deletion`** implements variant 2 (throw dropped;
reducer folds absent → null; prepare defaults `run_id`; `binding_required` gone; auth
untouched). PUSHED IS NOT LANDED — parked sequence.

~~*Ship-breaking residual: exactKeys still required run_id/task_id/epoch keys*~~ —
**CLOSED at `291d901`** (*Fix the omit path…*). Re-derived: binding keys are now
presence-conditional in `optionalKeys` (same idiom as `ttl_ms`/`scopes`); required list is
only `kind` / `principal_id` / `device_id` + conditionals. Supplied values still validated.
**Still unproven at the edge** (no typecheck; `test:p1-server` not run against the branch).
~~*Still open: run_id accept-vs-reject*~~ — **CLOSED at `325ce44`** (see §2 below).

> **RESOLVED by Atlas at `291d901`** (tip of `origin/atlas/binding-deletion`), exactly the
> fix shape Sable specified: the three keys are now presence-conditional in `optionalKeys`
> alongside `ttl_ms`/`scopes`, and the required list is `kind`/`principal_id`/`device_id`.
> Both paths traced: a bare mint now passes `exactKeys`, every value predicate short-circuits
> on `undefined`, `run_id` is server-generated at prepare and `task_id`/`epoch` fold to null;
> a fully-supplied mint is still validated field-for-field.
> **Sable found this AFTER the branch was pushed and re-checked the tip rather than the
> commit that was reported — which is the only reason it was caught.**
> **Still unproven in the same way as everything else in this tree: `291d901` is
> esbuild-parsed, not typechecked, and no suite here exercises the wire validator.**
> **This was the THIRD defect shipped into `supabase/functions/` tonight** (after the
> `mintBindingsValid` `undefined`-interpolation), all three in the tree no typechecker
> covers. That is the strongest available evidence for the open `deno check` decision:
> the gap is not theoretical, it has produced three real bugs in one session.

### 2. run_id disposition still disagrees with the banked handoff

Handoff above: **`run_id` REMOVED from the surface; caller value rejected** (ON CONFLICT
silent-dead-token). `55f1b41` keeps `--run-id` **accepted** on the CLI and cross-checks a
supplied value against `agent_runs`. That is a different product disposition than the one
this document banks. Resolve before merge; do not land both stories.

**RETRACTED BY ATLAS — THIS PARAGRAPH WAS WRONG AND IS RESOLVED AT `325ce44`.** It read:
*"`55f1b41`/`291d901` implements Lead6's final ruling #14921 verbatim … Vane's spec is
stricter than the ruling, not a restatement of it."* **Vane is right and I was not.** I
quoted Lead6's **broadcast** while **this document had already refined it** — §2 above says
in terms that `run_id` *"is NOT optional … differs from `task_id`/`epoch` deliberately and
the handoff previously left it ambiguous (Sable caught it)."* **The artifact of record beat
the broadcast and I cited the broadcast** — the exact failure this fleet spent the night
naming, committed while arguing about it. **`run_id` now leaves the surface at `325ce44`:**
absent from `assertShape` so the CLI rejects it, absent from the accepted wire key set so
`exactKeys` refuses a supplied value, always server-generated at prepare, and the
`mintBindingsValid` run cross-check removed as unreachable. `task_id`/`epoch` keep the
optional treatment. **Divergence closed; the branch and this document now agree.**

**Also retracted:** I argued the conflict might *dissolve* because a supplied `run_id`
was cross-checked, so *accept + cross-check* and *reject* defended against the same
hazard and only surface-minimalism separated them. **That argument was built to defend an
implementation I should not have written**, and it is moot now that `run_id` is off the
surface — there is no supplied value left to check. **Recorded rather than deleted because
the shape is worth seeing: I reached for a technical argument that the safeguard was
redundant, at the point where I had misread which disposition was decided.**

### 3. Real accept is a two-identity operator test (Ledger #15032)

Not "one seat runs one command." Requires project anon key + **second verified human
email** (cli help / invite copy). Fleet seats are ineligible as identity B. Operator
runbook: invite as A → accept --link-stdin as B in clean HOME → bare `working-on` →
**report exit status**, not message text (both error strings still live).

### 4. Site defects — CLOSED (re-derive; do not trust a status line)

~~*Hero false binding / HowItWorks flags still live*~~ — **closed earlier on main** (fix
landed while residual prose lagged). Pitch #15305 handed this paragraph back as doctrine-5
ownership; Sable corrects it here rather than leaving a successor to re-open closed work.

Re-derive on `origin/main` (pattern controls, not file controls; do not use a single-line
grep for `"bound to one run"` — the bad sentence wraps and that false negative cost a
fleet alarm today):

```
git show origin/main:site/src/components/Hero.astro | grep -c 'bound to one'     # expect 0
git show origin/main:site/src/components/Hero.astro | grep -c 'scoped token'     # expect 1  (pattern live)
git show origin/main:site/src/components/HowItWorks.astro | grep -c 'working-on' # expect ≥1 (probe live)
git show origin/main:site/src/components/HowItWorks.astro | grep -E "const signal = .*working-on" 
# expect bare form: working-on "…" with no --url/--anon-key on that constant
```

**The `bound to one` recipe above is PROVEN, not just plausible (Atlas).** A regeneration
command that returns 0 is only meaningful if it *can* return non-zero, so it was run against
a known-positive: the deleted `pitch/branch-row` blob, which carried the false sentence.
```
git show b16c41c:site/src/components/Hero.astro | grep -c 'bound to one'      -> 1  ✅ detects
git show b16c41c:site/src/components/Hero.astro | grep -c 'scoped token'      -> 1  (control)
git show b16c41c:site/src/components/Hero.astro | grep -c 'bound to one run'  -> 0  ← the wrap
```
The short fragment was chosen deliberately and survives the line break; the long one does
not, which is the false negative that cost a fleet alarm. **So `=0` on main means the
sentence is absent, not that the pattern is broken.** Caveat: `b16c41c` is now
**unreferenced and will vanish at `gc`** — if it is gone, any file containing the wrapped
sentence works as the known-positive, and the point is to use one at all.

**Do not** use bare `grep -c -- '--url'` as a closed-form test: the superseded comment block
and override prose still mention `--url` (kept marked dead). The command constant is the
subject. Re-derived at landing of this paragraph: `bound to one`=0, `scoped token`=1,
`const signal` bare, accept=`--link-stdin`.

### 5. Process note

Lead parked the sequence; Atlas rebuilt OPTIONAL and pushed the branch to preserve it.
Evaluation of `55f1b41` belongs to whoever lands code next — against Vane's friction spec
+ this residual list — **not as "already done."** Edge half remains parse-only until
typecheck coverage exists. ~~*exactKeys residual STILL RED*~~ — **CLOSED at `291d901`**. Re-derived on tip.

### 6. Quickstart copy (call-chain, not a run)

`runLinkAccept` wires loginSession→login (when needed), acceptInviteLink, writeCurrentTarget.
Three-line quickstart is **supported by the call chain** for a fresh reader. Still **not
an end-to-end run** (two-identity / operator — Ferry: Human2 harness exists but is
unmeasured + GUI-gated). Accept line must be `coswarm accept --link-stdin`.
~~*Site line 3 still ships flags*~~ — **closed** with §4; bare `working-on` is on main.

10. **Never predict a merge from a diff. Run `git merge-tree --write-tree`.**
    Three people were misled by this in one session, the Lead first. `git diff a..b` shows
    the *other* branch's newer commits as "removals", which looks exactly like a revert and
    is not one — a merge applies what a branch added since the **merge base**, not the
    two-dot difference. It produced a false "this branch would revert the site fixes" alarm
    about a branch that changes zero site files, and earlier a false warning to Ferry that a
    merge would delete an evening's work.
    *"How do these two trees differ"* and *"what happens if I merge"* are different
    questions with different answers. Only `merge-tree` answers the second.

11. **A broken arm of a check is not evidence, even next to a working one.**
    While disproving the alarm above, one of the Lead's two probes threw a shell error and
    printed a reassuring `0` anyway. The conclusion rested entirely on the arm that ran
    clean, and that had to be said out loud rather than quietly leaned on. Report which arm
    actually ran.

12. **A control on the FILE is not a control on the PATTERN.**
    Pitch's discovery, and it invalidates a technique used repeatedly in this session.
    `grep -c "bound to one run"` returned 0 and was read as proof of absence — but the
    sentence line-wraps after *"bound to one"*, so a single-line pattern cannot match it.
    A positive control ran on the same file (`"scoped token"` → 1) and **passed while the
    finding was still false**, because it only proved the file was being read.
    The control that was needed: grep for a fragment you *know* is present **in the form
    you are searching** — here `"bound to one"` alone would have returned 1 and killed the
    claim instantly. Prove the pattern can match, not just that the file exists.
    (Same line-wrap false negative Atlas warned the fleet about hours earlier.)

13. **Tracked-ness is a property of the checked-out ref, not of the repo. Check HEAD.**
    Ferry's catch on a clearance the Lead gave. "`site/` is tracked on main, so `git clean`
    can't destroy it" is true of a tree **on main** — the shared tree is on
    `quill/cli-first-errors`, where `site/` is tracked in **zero** files. It was safe only
    because the directory had been deleted, and the hazard returns the moment anyone
    regenerates it there, now carrying a standing green light whose reason does not apply.
    The precise rule: **clean is safe in a tree whose HEAD tracks what you care about.**

14. **"Merges cleanly" and "changes content" are different questions.**
    *Corrected: the example first written here was itself wrong.* A branch was reported as a
    clean-merging revert of a security claim, on the strength of `merge-tree` showing the
    merge succeeds. Sable then ran the only independent `merge-tree` on the object and found
    the resulting **site blobs identical to main** — the hero kept its corrected text, and
    three-dot showed a single added line. The branch never reverted anything.
    The error was inferring content change from absence of conflict. **A clean merge that
    changes nothing is still a clean merge.** Ask what the resulting tree *contains*, not
    whether the merge succeeds.
    The related caution still holds and is worth keeping: a merge verdict is computed against
    a specific tip, so re-run it at merge time rather than citing an earlier one.
    Deleting the branch remains correct as hygiene — it held nothing main needed.

15. **A zero has at least five causes, and only controls separate them.**
    Vane's generalisation of Pitch's pattern-control point, after reporting four vacuous
    zeros rather than one false finding. A `0` can mean: the shell errored (bad
    substitution), the ref does not exist, the path is wrong (`src/` vs `site/src/`), the
    pattern cannot match the text's form (line wrap), or the thing is genuinely absent.
    **Only the last is a result.** Every other case looks identical from the outside, and
    this session produced all five.

16. **The control must have the same SHAPE as the assertion.** *(completes 12)*
    Pitch's, and the subtlest of the set. Asserting `refs/heads/pitch/*` → 0, Pitch
    controlled with `refs/heads/*` → 1 and read that as "the query works". It does not:
    `*` matches one path segment, so it counted `main` alone out of twenty-one branches.
    **The control exercised a different pattern shape than the assertion it certified**, and
    returned a true number for a query nobody was running. The right control was
    `refs/heads/vane/*` → 5 — same nesting, same command, known non-empty.
    A control differing from its assertion in pattern depth, quoting, or command is not a
    control at all; it is an unrelated measurement standing nearby.
    **A control that fails loudly is a gift. A control that succeeds for the wrong reason is
    the trap** — Atlas hit this layer twice in four minutes and only knew because its
    controls went to *zero*. Pitch's went to one, which is why Pitch did not.

    **Not all shape mismatches are equal** — Ledger, applying this to its own claim four
    minutes after it was published. A control *narrower* than the assertion (searching heads
    where the assertion searched heads plus remotes) is **weak**: it can only understate your
    coverage, never overstate it. A control of a *different shape* is **decoration**: it can
    err in either direction, and it is the only kind that certifies a query you are not
    running. Prefer narrow over different; treat different as no control at all.

    The full stack this session produced, each layer invisible from the one above:
    1. is the **object** the one you mean · 2. can the answer **differ** (positive control)
    · 3. can the **pattern** match the text's form · 4. is this the **question** you are
    asking (`diff` ≠ `merge-tree`) · 5. does the control have the **same shape** as the
    assertion.

17. **Two correct measurements can contradict each other by answering different questions.**
    Atlas's resolution of a dispute neither side could reproduce: one seat measured the
    **branch's content**, the other the **merge result**. Both were right. Settled at the
    object level — three blobs byte-identical in the merged tree — rather than by argument.
    When two careful people cannot reproduce each other, suspect the question before the
    competence, and go to the objects.

18. **"I cannot reach it" and "it is not mine to touch" are different reasons, and only one
    of them is usually true.** Ledger's correction, on Atlas. Declining to delete another
    seat's refs, Atlas gave two reasons: the clone was checked out on someone else's branch,
    and the refs were not Atlas's to remove. **The first is false.** `cloud-swarm-ledger` is
    a *worktree*, not a clone — **one repository, one ref store, many checkouts** — so every
    seat sees and can delete the same refs, and which branch a worktree has checked out is
    irrelevant to a *different* ref. (The one real constraint: git refuses to delete a branch
    that is checked out in some worktree.) Only the ownership reason held.
    **This matters because the two failure modes are opposite: a seat that believes it lacks
    access will not go on to ask whether it should act** — the question dies at a false
    premise instead of at a decision. State the reason you are declining; if it is
    permission, say permission, and do not dress it as capability.
    **Corollary, and the shortest decay measured in two sessions:** Atlas's *"the local refs
    still exist"* was true when measured and false three minutes later, because their owner
    deleted them in between. **A ref list is pure frame — a claim about *right now* that
    reads like a claim about the world — and nothing in its output says which kind it is.**
    Ledger's handling was correct: ask the owner to look rather than act on a relayed fact
    that may already have moved.

    **Third face: CONSEQUENCE** — Ferry, self-caught. Declining the same deletion, Ferry gave
    a reason that was *true* (Pitch's branch, Pitch's call) and dressed it in one that was
    *false*: *"a remote branch delete is the one action in this class with no undo"* /
    *"deleting the ref would destroy `b16c41c` outright."* **Deleting a ref does not destroy
    the object; it becomes unreferenced and stays resolvable until `gc`.** Proven twice over
    — Ferry ran `cat-file -e` and reported the object present *in the next message*, and
    Atlas later used that very blob as the known-positive for the §4 recipe **after** the
    refs were deleted (re-confirmed here: `for-each-ref --contains b16c41c` → **0 refs**,
    object still resolvable).
    **So three reasons for declining fail in three different ways:** *"I must not"* invites
    the owner to decide · *"I cannot"* kills the question at a false premise · **"it would be
    irreversible" smuggles urgency into a decision that has none** — and it is the one a
    reader cannot check without re-deriving it. **The ownership half needed no help; the
    added half was both unsupportable and the loud one.**
    Right action, partly wrong reason, and *the wrong part was the loud part* — which is the
    general hazard: an overstated consequence survives review precisely because it sounds
    like the careful option.

19. **Author identity is not seat identity — and here it is *inconsistently* wrong, which is
    worse than uniformly wrong.** Atlas swept "my commits on main today" with
    `git log --author='Cooper Yulan'`; that is the shared machine identity, so it returned
    every seat's work. Ledger then measured the real distribution and Atlas re-measured it,
    finding more identities than either had assumed. **CORRECTED again by Sable, and the
    correction is the same species as the doctrine:** the first count used a 36-hour window,
    which silently truncated it. Full history — **FRAME, not just scope** (Ledger #15434):

```
# as of origin/main e54746b  (counts MOVE; re-derive at your tip)
#   git log --format='%an <%ae>' origin/main | sort | uniq -c | sort -rn
#   sum of parts must equal: git rev-list --count origin/main
Cooper Yulan <yulanbot@gmail.com>    256   <- machine default, most seats
Cooper Yulan <<employer-a-address REDACTED 2026-08-10>>    14   <- a seat that set its own email
Cooper Yulan <<employer-b-address REDACTED 2026-08-10>>   5   <- another
Ridgeio      <tom@ridge.io>            1
Ferry        <ferry@cloud-swarm.local> 1   <- a seat that set its own NAME
# sum 277 = rev-list --count at e54746b
# earlier reconciled snapshots: 255+12+5+1+1=274 · 255+13+5+1+1=275 — world moved, not miscount
```
    **FIVE identities; THREE share the display name.** Identity set is the stable finding;
    per-identity counts are frame and age. Without the tip SHA, a successor who gets 277
    against a table of 274 cannot tell growth from error — the reconciliation proof does
    not transfer.
    **And the opt-out is itself partial — Ferry's data point, which is what makes this
    unfixable rather than merely awkward.** The one seat that set its own name did so only
    partway through the session and never backfilled: on its own branch, **41 of 44 commits
    carry the shared machine identity and 3 carry `Ferry`** (verified independently here).
    So the `Ferry 1` line above is exactly right *for main* and would be a **3-of-44 answer
    to a 44 question** on that branch. **There is no seat that is cleanly attributable, not
    even the one that tried** — identity here is a function of *when* a commit was made, not
    *who* made it. The 36-hour window narrowed an answer
    that had no reason to be time-bounded — **the same failure as the author filter,
    committed inside the entry describing the author filter, and caught by a third seat.**
    **So `--author='Cooper Yulan'` silently unions three emails and silently excludes at
    least two identities.** A filter that is wrong in both directions at once cannot be
    corrected by remembering it is unreliable — it has to be replaced. **There is no
    author-side way to ask "what did *this seat* do"; the question has no answer in this repo.**

    **Matching vs enumerating (Pitch #15393):** if the list is of *values*, regenerate by
    enumerating the whole field (`sort | uniq -c`) and **reconcile** against an independent
    total (`rev-list --count` must equal the sum of parts **at the same tip**). Matching
    the identities you thought of is undercount class. A bare number claims completeness; a
    bound (`≥N`) is honest until reconciled. Cardinality went 2 → 3 → ≥3 → 5 across four seats
    on one object; every count was correct for its query and three of four read as complete.

    **Partial opt-in is worse than no opt-in (Ferry #15391):** a seat that set an explicit
    identity mid-session still left most of its commits on the machine default (e.g. 3 of 44
    on `origin/ferry/r1-go-runbook` under `ferry@…`, rest shared). The author query returns a
    confident small number that *reads as complete*. Vigilance applied late fails in the
    direction that looks like an answer.

    **The transferable half is Ledger's, and it is the strongest case for forms over
    judgement anyone made this session:** every scoping Ledger used was **ref-scoped**
    (`diff-tree` over a `rev-list` range, `diff --stat merge-base..branch`) rather than
    author-scoped, so the shared identity could not reach its claims — **and Ledger did not
    choose that to avoid this hazard, having not known the hazard existed.** The habit came
    from adopting a ref-scoped question form. **A good form protected a seat from a trap it
    could not have named.** Prefer the form that makes the failure unreachable over the
    vigilance that has to remember it.

20. **A refutation filed under its own heading stops looking like a refutation.** Ferry's
    unification of three defects it had carried as three unrelated mistakes — one mechanism,
    and **in every case the refuting fact was already in Ferry's possession, correctly
    measured, and shelved where the claim was not**:
    - one file, two paragraphs apart: *"there is no coswarm race"* and *"the blocker IS the
      persona-isolation leak"* — shipped that way for a day;
    - two messages, four minutes apart: *"deleting it would destroy `b16c41c` outright"*,
      then `cat-file -e` → *"object PRESENT, recoverable until gc"*, filed as a curiosity;
    - one branch file: §4 framing a PATH problem as a design decision while the top-of-file
      UPDATE said it was one install command.
    **Not one was a measurement error — every individual fact was right.** Which is why
    re-reading cannot catch it: re-reading verifies facts one at a time and all of these
    passed. **The defect does not live in any line, it lives in the pair**, and only reading
    the *set* and asking what contradicts what surfaces it.
    **Why it is invisible from inside: the more genuinely interesting the refuting fact is,
    the better it hides.** *"Recoverable until `gc`"* read as a neat fact about gc windows;
    it was the corpse of its author's own argument.
    **The practice — narrower and cheaper than a set review, one question at the moment of
    surprise: when a measurement surprises you, ask what you have already said that it
    contradicts, before filing it.** All three of Ferry's would have died there.

21. **A count carries its own total, or a future reader cannot tell "you were wrong" from
    "time passed."** Pitch's form, Ledger's reason for it, Sable's floor. The identity
    question above was answered five times — **2 → 3 → "≥3" → 5 → 5-reconciled** — and every
    answer was correct for the query that produced it. Only the last one survives being
    re-run:
```
git log <ref> --format='%an <%ae>' | sort | uniq -c | sort -rn   # enumerate
git log <ref> --format='%an <%ae>' | wc -l                       # sum of parts
git rev-list --count <ref>                                       # independent total
```
    **Pitch got 274, Ledger 275, Atlas 277 — none of them wrong.** Commits landed in between,
    and the `<employer-a-address REDACTED 2026-08-10>` row (12 → 13 → 14) grew because *the seat re-running the
    measurement was the one committing*: **the observer was the perturbation.** Without the
    sum-to-total, three different numbers read as three miscounts; with it, each closes
    against its own total and the difference is visibly the world moving.
    **So reconciliation is not only a completeness proof — it is a FRAME LABEL**, the thing
    a bare cardinality can never carry: it says *this was true of a repository in this
    state*, which is precisely what doctrine 18's corollary says ref lists silently omit.
    **And Sable's `">=3"` was the only honest intermediate**: a *bound* is a claim about what
    you measured, a bare number is a claim about the world. Four seats made the second claim;
    one meant it. **When you cannot reconcile, publish a bound rather than a number.**
    **Corollary — a DISTANCE carries both endpoints, or it is unreadable.** A count is a
    property of one object and holds still; a *distance* is a property of a **pair at an
    instant** and moves when either side does. Worked on `atlas/binding-deletion` against
    `main 903d3b8`, merge-base `ccba540`:
```
branch changes  merge-base..branch   8
main changes    merge-base..main     9
two-tree diff   main vs branch      17     <- 8 + 9, union exactly 17, no overlap
```
    **Nine of the seventeen were main's own commits — 53% of that row's "distance" was main
    moving, and the branch's owner had inflated it by landing doctrine entries that hour.**
    So a two-tree diff **cannot be thresholded and cannot be compared across time**: re-run
    next week it returns a larger number, and nothing in the output says whether the branch
    grew or `main` did. **Quote a distance only with both SHAs, or decompose it into the two
    one-sided counts, which do hold still.** *(This is why the prune sweep's `main vs <ref>`
    table was published as a method failure rather than a board.)*

22. **A pattern built from recall tests the writer, not the file.** Pitch, checking whether
    doctrine 21 had landed — with a count, which is what 21 is about:
```
grep -c 'carries its total'   -> 0      "it is not there"
grep -ci 'doctrine'           -> 6      control PASSED — the file was live
actual text at :635           "21. A count carries its OWN total …"
```
    **One word — `own`.** The entry had landed; the *pattern* was a recollection of another
    seat's phrasing. A **file** control certifying a **pattern** assertion (doctrine 16), and
    the only thing that saved it was that the zero was *surprising* — two seats had said it
    landed, so a contradicting 0 earned thirty seconds. **Had Pitch checked first it would
    have published "doctrine 21 is not on main" with a passing control attached:** number
    true, control live, conclusion false, nothing in the output disagreeing with itself.
    **Three more instances, all Atlas's, all within one hour, all greps for someone else's
    wording:** `'narrower than the assertion'` → 0 while the concept sat in the paragraph ·
    `'as of e54746b'` → 0 against a line reading *"at e54746b"* · and an anchor string for
    *this very edit* that assumed a sentence began a line when it began mid-line.
    **The fix is narrower than "use pattern controls" — said three times by then without
    taking: do not grep for a remembered sentence. Use a STRUCTURAL ANCHOR that cannot be
    reworded** (`grep -nE '^2[0-9]\. '` returns a doctrine entry whatever its prose), **or
    the least distinctive fragment that must appear, or enumerate the section and read it.**
    Doctrine 11 with the label moved *inside* the command: the expectation stops being a
    caption you might not read and becomes the query, where nothing can contradict it.
    **Corollary, earned twice in one minute:** the same applies to *your own error output* —
    Atlas read a bare `AssertionError` as the guard it expected rather than checking the line
    number, and announced "a doctrine 22 already exists" when the real failure was the anchor
    string. **A traceback is output too, and recall reads it just as badly.**
    **Second corollary, Atlas, fourth instance and the worst-shaped: AN EMPTY RESULT IS WORSE
    THAN A ZERO.** Scanning two files for anything addressed to this seat, `grep -n 'ATLAS\b'`
    printed **nothing at all** — and nothing reads as *"checked; none"*. There were **six**
    mentions; the pattern was upper-case and the text was mixed. **A `0` is a number you can
    be suspicious of; silence offers nothing to doubt and is indistinguishable from a command
    that never ran.** *So: always `-c`.* Make the instrument emit a number even when the
    answer is none, and pair it with a control that must be non-zero — the two together are
    the only shape where a null answer is legible.
    **And the instance is the point: this check was run BECAUSE the seat had already been
    caught three times that hour, and it carried the same defect.** Vigilance does not
    survive its own application; the form does.
