# P3 design brief: governed `create_workspace` — the bootstrap path

**Author:** Atlas · **Date:** 2026-07-25 · **Status:** DRAFT v2 — amended after Sable review, re-routed to Sable
**Contract source of truth:** Sable's contract pin (swarm msg `#9185`), pins P1–P6 and gates G-C1–G-C8.
**Ruling folded in:** Lead6 — **Option A**, self-serve for verified humans plus a credential-scoped rate limit.

> **Do not re-derive the contract.** It was adversarially attacked and it held. This brief turns that
> contract into something a builder can work from. Where I disagree with nothing, I have restated
> nothing — §2 is a pointer, not a paraphrase.

**Every code fact below was re-derived against `origin/main` at `c2b59e4` by the author.** Line
numbers drift; the *facts* are what matter, and each is stated so it can be re-checked by grep rather
than by trusting the number.

---

## 0. Why this slice

`create_workspace` exists in the protocol and **has no product path**. Every workspace to date was
created with a privileged `DATABASE_URL`. Until this ships, nobody can start using coswarm without the
operator personally seeding their tenant — which makes it, in §0h's words, *"the last thing between
demo and product."*

It is also **launchable item 2**: *a stranger can create their own workspace.* Currently impossible.

---

## 1. The two defects, stated separately

They are usually conflated and they have different fixes.

### 1.1 The authorization is locked shut

`decideWorkspace`'s create branch gates on `ctx.operatorAllowed(ctx.actor)`
(`src/protocol/workspace-commands.ts`, the `cmd.kind === 'create_workspace'` block). The edge wires
that predicate to a constant:

```
supabase/functions/command/index.ts   operatorAllowed: () => false
supabase/functions/_shared/protocol.js   (mirrored copy of the same branch)
```

**The protocol is ready and the allowlist is empty.** Even a correct client is refused with
`operator_not_allowed`.

### 1.2 The CLI cannot bootstrap (the circularity)

The generic `coswarm command <kind>` path runs through `commandWorkspaceAndCredential` (`src/cli.ts`),
which resolves a `selectedWorkspace` **before** dispatching. So the only route to `create_workspace`
requires already having selected a workspace — the thing it creates.

**Fixing 1.1 alone changes nothing a user can reach.** Both are required.

---

## 2. What is already pinned (pointer, not restatement)

Sable's `#9185` is normative. Its six pins, in one line each, **for orientation only — read `#9185`
for the reasoning, which is where the attack survived**:

- **P1** — P2-2's "no new authorization predicate" governs **read** projections. It does not ban a
  tenant-founding write.
- **P2** — `create_workspace` is authorized by verified human + rate, never agent, never `is_member`
  of a tenant that does not yet exist.
- **P3** — creator becomes sole Owner **atomically** via the `WorkspaceCreated` fold plus same-tx
  projection. Not create-then-join.
- **P4** — `audit_log.workspace_id` may carry the new id on accept; the column is already nullable.
- **P5** — the CLI must gain a **non-circular entrypoint**. Construction, not polish.
- **P6** — smallest slice: self-serve human create with rate limiting, not an authority platform.

**Lead6's ruling** replaces the empty allowlist for the default path:

```
bootstrapAllowed = (credential_kind == human) AND identityVerified AND (not agent)
```

`operatorAllowed` **may remain** as a separate hard override for emergencies. The default path must
not depend on a secret list the operator edits by hand.

---

## 3. Deliverables

### 3.1 Wire `bootstrapAllowed` in the edge

Replace the constant. The predicate is `credential_kind == human` **and** `identityVerified`.

**Shape — pin one so two builders do not diverge.** The contract permits `operatorAllowed` to survive
as an emergency override. **Implement as a composition, not a replacement:**

```
allowed = bootstrapAllowed(actor)  ||  operatorAllowed(actor)
bootstrapAllowed = credential_kind == human && identityVerified(user_id)
operatorAllowed  = the existing hook, still defaulting to false
```

Composing rather than replacing keeps the emergency lever available without the default path
depending on a hand-edited secret list — which is exactly what §2's ruling requires. A builder who
*replaces* `operatorAllowed` outright removes the override the contract deliberately kept.

> ★ **The tautology risk Sable flagged, and it is the thing most likely to be built wrong.**
> `HUMAN_ONLY_COMMANDS` already forbids agents before this predicate runs. So a `bootstrapAllowed`
> that only checks `credential_kind == human` is **true for every caller that reaches it** — a gate
> that cannot fail, which is this program's most-repeated defect. **`identityVerified` is the whole
> predicate.** If the implementation flips the constant without wiring `identityVerified`, the brief
> has been implemented in name and not in substance.
>
> **`identityVerified` IS already defined and in production use** — see §6.1. It means GoTrue
> `email_confirmed_at` present, and `accept_invitation` already refuses on it. Reuse that, do not
> invent a second meaning. What remains open is a ruling to *confirm* the reuse, not a definition.

### 3.2 Rate limit, credential-scoped

Bucket key `create_workspace:credential:user:<uid>`. Provisional cap **5/day**, and provisional means
the number is a starting point for the operator to move, not a measured value. Optional global bucket
`create_workspace:global` as a blast-radius brake.

Reuse the pin-13 rate-limit class. Do not invent a second mechanism.

### 3.3 Atomic create + owner

One command, one transaction, one fold. `WorkspaceCreated` → reducer establishes
`members[created_by] = owner`. Projection write in the **same** transaction: workspaces row,
memberships row, workspace stream head. Mid-transaction failure rolls back entirely.

**No orphan tenant with zero members is reachable.**

### 3.4 A non-circular CLI entrypoint

A dedicated path that does **not** call `commandWorkspaceAndCredential`'s existing-workspace
resolution. Shape: `coswarm project create <name>`, human session only.

- Sends `create_workspace` without selecting a prior tenant.
- On success prints name + id.
- **Sets the new workspace as the profile default, once.** Sable leaned yes; I am pinning yes, so
  that `coswarm status` works immediately after create. Documented, not silent.

> ★ **A CODE CONSTRAINT THE CLI AUTHOR MUST KNOW.** *(Draft v1 called this "my inference"; Sable
> confirmed it is a constraint of `decideWorkspace` as currently written, so it is stated as one.)*
>
> The create branch refuses when `cmd.workspace_id !== ctx.workspace_id`. For a *new* workspace the
> context must therefore already resolve to the id being created. **A CLI that lets the server assign
> the id hits `bad_state` on this check.**
>
> **PIN: the client generates a CSPRNG UUID.** That is the path requiring **no protocol change**.
> Collision returns the domain error `workspace_exists`, which the branch already produces.
>
> The alternative — relaxing `workspace_id === ctx.workspace_id` for the null-state create case — is a
> protocol change and is **not** in this slice. Anyone who prefers it should say so before the CLI is
> built, not after.

---

## 4. Acceptance — RED then GREEN, all eight

Sable's gates, adopted unchanged. **Each needs a RED that actually fails before the fix.**

| Gate | GREEN | RED |
|---|---|---|
| **G-C1** Bootstrap authorize | zero-membership verified human creates → 200, sole owner | split into G-C1a and G-C1b below — **one RED is not enough** |
| **G-C1a** Credential kind | — | agent token, same command → authz refuse, **zero rows** |
| **G-C1b** ★ Identity bar | — | **human** credential with `identityVerified` false → `identity_not_verified`, **zero rows** |
| **G-C2** No orphan | tx abort leaves no workspace without owner membership | partial write impossible under real tx (or fault-injected) |
| **G-C3** Idempotency | same `command_id` retried → one workspace | two `command_id`s, same `workspace_id` → second returns `workspace_exists`, not two owners |
| **G-C4** Probe | create against an existing foreign `workspace_id` as non-member → authz | response is indistinguishable from a random unknown id (no enumeration signal) |
| **G-C5** Rate | over-cap → 429; a different identity is unaffected | over-cap still inserts |
| **G-C6** Audit | accepted create has an audit row with actor + `workspace_id` + `accepted` | agent attempt produces an authz audit row and zero workspace rows |
| **G-C7** CLI non-circular | zero-membership human creates without `--workspace-id`; multi-membership human also creates | the old path still requiring select-existing fails **closed with guidance**, or is replaced |
| **G-C8** Reads unchanged | new views remain `is_member`-only | create introduces no public workspace listing |

> ★ **WHY G-C1 IS SPLIT, AND IT IS THE MOST IMPORTANT LINE IN THIS BRIEF.** `HUMAN_ONLY_COMMANDS`
> blocks agents *before* `bootstrapAllowed` runs. So **G-C1a goes red whether or not
> `bootstrapAllowed` was wired at all** — it discriminates the credential kind, which was already
> enforced, and says nothing about the predicate this slice adds.
>
> **G-C1b is the only gate that can fail if `identityVerified` is not wired.** A `bootstrapAllowed`
> that checks `credential_kind == human` alone is *true for every caller that reaches it* — a gate
> that cannot fail, which is this program's most-repeated defect and which it has now found three
> times in its own harness. **If only G-C1a is implemented, the slice can ship green with the
> predicate absent.**

---

## 5. Out of scope — say no once, here

Multi-step onboarding wizards · org hierarchy · billing · admin consoles · cross-tenant search ·
`service_role` product paths · **agent-created workspaces** · GitHub-org allowlists · any general
authority platform.

Also out: hard "one workspace per human forever". Sable considered and rejected it — it blocks the
multi-project humans already supported via invite. **Soft rate over hard cap**, unless the operator
overrules.

---

## 6. ★ What I did not settle

**Status after Sable's review — scannable:**

| | |
|---|---|
| **6.1** `identityVerified` | **CORRECTED.** Already defined; reuse pinned. Open: a ruling to *confirm* reuse, plus refusal copy |
| **6.2** Rate numbers | **OPEN.** 5/day is a placeholder, unmeasured, must stay labelled provisional |
| **6.3** `workspace_id` generation | **PINNED** (client CSPRNG). Open: whether to prefer the protocol-change alternative |
| **6.4** `protocol.js` drift | **CLOSED.** Generated artifact, regenerated by `pretest:p1-server` |
| **§3.1** `operatorAllowed` shape | **PINNED** by this brief: compose, do not replace. Overturnable |

Two things a Lead or the operator still owns and no amount of code reading settles: **the
stranger-facing refusal copy**, and **whether creating should carry a stricter bar than accepting**
(default: no).


A named hole is worth more than a smoothed one. Four, in descending order of how much they block.

### 6.1 `identityVerified` — **CORRECTED. It is already defined; the hole is narrower**

> **Draft v1 said "no definition anywhere." That was wrong.** Sable refuted it and I re-derived the
> refutation against `origin/main`. Recorded rather than silently fixed, because the overstatement
> would have sent a builder looking for something to invent.

The predicate exists and is in production use:

```
supabase/functions/command/index.ts   identityVerified = data.user.email_confirmed_at !== undefined
                                                          && data.user.email_confirmed_at !== null
src/protocol/workspace-commands.ts    identityVerified(user_id: string): boolean   (ctx interface)
src/protocol/workspace-commands.ts    accept_invitation branch:
                                        if (!ctx.identityVerified(user_id))
                                          return authz('identity_not_verified', …)
```

Agents are always `identityVerified: false`. **So the product already applies a verified-identity bar
to a non-member write — `accept_invitation` — and bootstrap must not invent a second meaning.**

**PIN (default, and what the builder implements absent an overturn):** `identityVerified` for
`create_workspace` means **exactly what it means for `accept_invitation`** — GoTrue
`email_confirmed_at` present on the human session. Refuse with the existing `identity_not_verified`
class, not a new one.

**OPEN (product, optional overturn):** whether *creating* a tenant should carry a **stricter** bar
than *accepting an invitation to one* — e.g. excluding some auth providers. **Default is: same bar.**
Creating is not obviously higher-risk than accepting, and inventing a second standard costs a second
thing to reason about forever.

**STILL OPEN either way: the stranger-facing refusal copy.** Whoever rules should say what an
unverified user *sees*, because that is a stranger's first contact with the product, and "you may not
create a workspace" with no remedy is a worse first impression than today's "no path at all".

§3.1 is therefore blocked on a **ruling to confirm reuse**, not on a blank definition.

### 6.2 Rate-limit numbers are provisional and unmeasured

5/day is Sable's suggestion and I have carried it. **Nobody has measured anything.** There is no
evidence about what a legitimate multi-project human does in a day. The number is a placeholder that
should be labelled as one in the implementation, so it is not later cited as a tuned value.

### 6.3 The `workspace_id` constraint — **PINNED, with the alternative left open**

Draft v1 held this as my inference; Sable confirmed it is a constraint of `decideWorkspace` as
currently written, so §3.4 now pins **client-generated CSPRNG UUID** as the no-protocol-change path.

**What stays open is the preference, not the fact:** relaxing `workspace_id === ctx.workspace_id` for
the null-state create case is a legitimate alternative design, and it is a protocol change this slice
does not make. **Anyone who prefers it should say so before the CLI is built**, because the two shapes
produce different clients.

### 6.4 The `_shared/protocol.js` copy — **CLOSED. It is generated, not hand-maintained**

> Draft v1 left this unchecked. Sable checked it; I re-derived the check.

```
supabase/functions/_shared/protocol.js  line 1:
  // GENERATED from src/protocol/index.ts; do not hand-edit.

package.json  "build:command-core": esbuild src/protocol/index.ts … --outfile=supabase/functions/_shared/protocol.js
package.json  "pretest:p1-server": "npm run build:command-core"
```

**There is one implementation site: `src/protocol/`.** The edge copy is a build artifact carrying a
do-not-hand-edit banner, and `pretest:p1-server` regenerates it before the server tests run — so a
builder who edits only the TypeScript and runs the existing test command cannot ship a stale edge copy.

**Builder instruction:** edit `src/protocol/workspace-commands.ts` only. Do **not** hand-edit
`protocol.js`. If a diff appears in it that you did not generate, that is a signal something was
hand-edited upstream, not a merge to resolve.

---

## 7. What this brief does not attempt

It does not sequence this against R1, P3-2, or the isolation fix. It does not estimate. It does not
choose whether this ships before or after the hosted invite page. **Those are the Lead's, and I have
deliberately not implied an order by writing one.**
