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

1. **Binding fields (`run_id`, `task_id`, `epoch`) become OPTIONAL, not deleted.**
   `binding_required` is deleted; the fields are not. Deletion would foreclose ever
   enforcing the binding, and enforcement is expensive-but-reversible while deletion is
   cheap-and-irreversible. Optional gets the whole friction win and forecloses nothing.
2. **`--run-id` server-generated, `agent_runs` row still written.** It is INNER JOINed at
   every agent auth. Generate a real v4 UUID (the column casts `::uuid`) or every minted
   token authenticates against nothing.
3. **`--principal-id` defaulted:** none → create; one → use it; many → require and list.
4. **Self-registration on first use**, justified by reversibility: `principal create` is
   reversible (`revoked_at`, checked at every mint) and minting is reversible (it expires).

### ⚠ Ordering constraint — reverse order breaks mint at runtime

The `AgentTokenMinted` handler throws when `task_id`/`epoch` are null, the reducer's
`req()` lists them as required, and `mintBindingsValid()` keys its `agent_runs` lookup by
the caller-supplied `run_id`. The database will NOT catch this: the columns are nullable.

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

## Known defects, not yet fixed

- **The binding is write-only at auth.** `loadAgentCredential` does not SELECT `task_id`
  or `epoch`; a token "for task X" drives its command kind against any task in the
  workspace. NOT a workspace escape and NOT an auth bypass — over-breadth inside a
  workspace the principal already legitimately holds.
- **`Ridge-io/coswarm-dist` does not exist**, so `install.sh`'s default target 404s.
  `COSWARM_BASE_URL` overrides it, which unblocks gate 5 without any publish decision.
- **The name `coswarm` collides** with a shipping self-hosted PaaS that owns `coswarm.dev`.
- **`/docs` and the GitHub nav link 404.** The repo is private.

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
