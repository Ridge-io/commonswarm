# Spec change — `coswarm token mint --scope <scope>`

**Status: SPEC ONLY. Do not implement.** Lead6 is sequencing this behind Quill's target-persistence
work so the two do not collide.

> ### ✔ HOLD RESOLVED — Lead6 upheld it and replaced DELETE with OPTIONAL. Kept for the reasoning.
>
> The `task_id`/`epoch` deletion below was ruled when the choice was framed as **enforce the binding
> or delete it**. Ledger has since established (and verified independently on `273c472`) that:
>
> - the **token's** epoch is never read, so epoch increment **revokes nothing** — Ledger's TTL
>   argument had counted it as one of three automatic revocation mechanisms; **there are two, and
>   both are manual**;
> - a leaked token is therefore bounded **by scope, not by binding** — any task, any epoch;
> - **the TTL is currently the only automatic containment that exists.**
>
> **The consequence for this document:** deleting the fields **forecloses the enforce option**. You
> cannot enforce a binding you have removed, and re-adding it later means a schema change plus the
> three-place fix Ledger scoped (validate at mint · add to the auth SELECT · enforce per request).
> **Deletion is cheap and irreversible-ish; enforcement is expensive and reversible.** By this
> document's own governing rule — *friction is justified only by irreversibility* — **the
> irreversible move here is the deletion, not the safeguard.**
>
> **Resolved:** Lead6 upheld this hold and replaced DELETE with **OPTIONAL**, which keeps the
> friction win without foreclosing enforcement. See the `--epoch` section for the three variants of
> "optional" and which one to build — **two of the three are wrong and one of those leaves mint dead.**
>
> **Unaffected and still safe to implement:** `--run-id` (server-generated, row preserved),
> `--principal-id` (defaulted), and self-registration. None of those touch the binding question.

**Target.** First useful work for an agent goes from **two commands and five identifiers** to **one
command and one flag**.

```
# today
coswarm principal create --url <url> --anon-key <key> --name <name>
coswarm token mint --url <url> --anon-key <key> \
  --principal-id <uuid> --run-id <uuid> --task-id <uuid> --epoch <n> [--ttl-ms <ms>]

# proposed (with Quill's persistence removing --url/--anon-key)
coswarm token mint --scope <scope>
```

Evidence for each verdict is in `2026-07-26-ceremony-before-first-work.md`; this document is the
change, not the argument.

---

## The five, and what happens to each

### `--run-id` — **removed from the surface, server-generated. NOT merely dropped.**

This is the one an implementer can get wrong, so it is first.

`run_id` is **load-bearing at authentication** — `_shared/agent-auth.ts:36-40` inner-joins
`agent_runs` on `r.run_id = t.run_id AND r.principal_id = t.principal_id`. A token whose `run_id`
has no matching row **cannot authenticate at all**.

The server already writes that row at mint (`command/index.ts:1928`), using the caller's value and
the device from the authenticated request. **The change is to stop taking the value from the caller
and generate it server-side; the INSERT stays exactly as it is.**

**Required:** a v4 UUID (the column is cast `::uuid`; a non-UUID string fails at the database, not
in validation).

**Also fixes:** `ON CONFLICT (run_id) DO NOTHING` currently lets a caller reuse another principal's
`run_id`. The insert silently no-ops, the mint succeeds, and the resulting token can never
authenticate because the join also requires a matching `principal_id`. Server generation makes the
collision unreachable.

**Does a caller-supplied `--run-id` still work? NO — reject it, do not silently override.** Sable
asked this and the answer follows from the paragraph above rather than from taste. A dual path where
the caller's value sometimes wins is exactly how the silent-dead-token collision comes back: the
failure is invisible at mint and appears as an unauthenticatable credential later. **Three options,
one correct:**

| on caller-supplied `--run-id` | result |
|---|---|
| accept and use it | the collision above is still reachable — **no**|
| accept and silently ignore it | caller believes a binding exists that does not — **worse** |
| **reject with an error naming the flag as removed** | **CORRECT** |

**`run_id` is therefore *removed*, not *optional*** — the opposite disposition from `task_id` and
`epoch`, for the opposite reason: those two are unread and safe to leave absent; this one is
load-bearing and unsafe to leave caller-controlled.

### `--task-id` — **OPTIONAL. See the `--epoch` section; the two are one change.**

> An earlier version of this heading said *"removed from the surface"*, which **contradicted the
> `--epoch` section ten lines below it** after the DELETE→OPTIONAL ruling. Same document, same
> change, two dispositions. Corrected rather than left for an implementer to reconcile.

Not consulted at authentication: `task_id` appears **0 times** in `agent-auth.ts`, control `run_id`
= 4 in the same file. **But it is required on the mint path** (`command/index.ts:1914-1916`,
`workspace-reducer.ts:314`), which is why it becomes optional rather than removed — and why it moves
together with `epoch`, not separately.

**Open question for whoever implements:** whether any consumer outside `supabase/functions/` and
`src/protocol/` reads a token's `task_id`. This spec searched both. **It did not search the
dashboard, migrations, or any external consumer.**

### `--epoch` and the `task_id`/`epoch` fields — **OPTIONAL. Not deleted, not auto-filled.**

> **Ruling history, because two superseded versions of this section are quoted elsewhere:**
> v1 said *"server supplies `current + 1`"* — **wrong, would have shipped a bug** (Atlas).
> v2 said **DELETE** — superseded; Lead6 upheld this document's HOLD and replaced it with
> **OPTIONAL**, because deletion forecloses the enforce option while optional does not.

**"Optional" has three possible implementations and only one is correct.** Sable raised this and it
is the difference between a working mint and a dead one:

| variant | result |
|---|---|
| default NULL, **keep** the projection throw | **mint still dead** after "optional" — the throw fires on NULL |
| **default NULL, drop the projection throw** | **CORRECT** — columns become write-only nullable, auth path unchanged |
| default non-null (synthetic epoch/task) | **re-opens the `current + 1` trap** — wrong on renew/submit/close |

**Implement the middle row.** Concretely — **four places, not three. An earlier version of this list
omitted the first, which rejects before any of the others run** (Sable):

1. **`command/index.ts:880-890` — wire validation, and it is a hard 400.** Two sub-parts at one
   site: `exactKeys([… "run_id", "task_id", "epoch", "device_id", …optionalKeys])` requires the keys
   be **present**, and the predicates below require them to be **valid**:
   ```ts
   typeof cmd.run_id  === "string" && UUID_RE.test(cmd.run_id)  &&
   typeof cmd.task_id === "string" && UUID_RE.test(cmd.task_id) &&
   integer(cmd.epoch) &&
   ```
   Both must change: move the keys into `optionalKeys` **and** make the predicates conditional.
   Leaving either half means mint 400s before the reducer is reached.
2. `workspace-reducer.ts:314` — move `task_id` and `epoch` out of the required list
3. `command/index.ts:1914-1916` — **remove** the projection guard (leaving it makes "optional" a lie)
4. CLI — flags become optional; `binding_required` (`workspace-commands.ts:512-517`) no longer
   refuses their absence

**Note for anyone quoting Ledger's demonstration:** the wire layer requires `task_id` to match
`UUID_RE`. Ledger's `task_id="NEVER-EXISTED"` arm passes the **reducer**, which is the layer they
drove; it would be rejected here. The accept-any-binding finding is true of `src/protocol/` and the
deployed endpoint has this second layer in front of it.

> ### ⚠ TWO OF THESE FOUR SITES CANNOT CURRENTLY BE VERIFIED
>
> Sites 1 and 3 are in `supabase/functions/`. Measured on `origin/main`:
>
> ```
> tsconfig.json   "include": ["src/**/*.ts"]     <- supabase/functions/ IS NOT TYPECHECKED
> test:p1-server                                  <- needs a live edge runtime (Atlas: currently
>                                                    bind-mounted to another agent's worktree)
> ```
>
> **An implementer who changes the wire validation and the projection guard, then sees `tsc` pass,
> has verified nothing about either.** `esbuild` bundling that directory is a **parse, not a
> typecheck** (Atlas's phrase, and it is the accurate one).
>
> **This does not block the change — it bounds the confidence.** Sites 2 and 4 (`src/protocol/`,
> CLI) are covered by `tsc` and the protocol suite. Sites 1 and 3 are not. Whoever implements should
> either run `npm run test:p1-server` against their own branch or say plainly that the edge half is
> unproven. **Half of a four-place change landing on parse-level confidence is exactly how a partial
> implementation survives review**, and the nullable columns mean the schema will not catch it
> either.

**Why this is the variant that keeps the enforce option open:** the columns still exist and are still
written when supplied. Enforcement later means adding them to the auth SELECT and comparing — no
schema change, no re-migration. That is the whole reason OPTIONAL beat DELETE.

Validated at mint as `Number.isInteger && >= 0` only, never against stream state
(`workspace-commands.ts:511-517`). Ledger demonstrated the accept side: `epoch=0` and `epoch=999999`
both mint on the same task, with `epoch=-1` and `epoch=1.5` rejecting as controls, so the instrument
provably discriminates.

**But the failure is not "checked in the wrong place" — it is never checked at all.** The binding is
**write-only**. Measured on `origin/main` = `273c472`, occurrences in
`supabase/functions/_shared/agent-auth.ts`:

```
epoch     0        task_id   0        run_id    4  (control)     scopes    2  (control)
```

`loadAgentCredential` never SELECTs `t.task_id` or `t.epoch`, and no later gate re-derives them. The
only narrowing actually enforced on an agent credential is **scope-by-command-kind**
(`command/index.ts:2442-2444`). A token minted "for task X at epoch N" will drive that command kind
against any task in the workspace, at any epoch.

**Why auto-filling would have been wrong even if the field were read** (Atlas's point, and it is the
reason this section changed rather than being softened): `current + 1` is the correct binding only
for `acquire`, which bumps the epoch. For `renew` / `submit` / `close` the correct binding is
`current`, unchanged. **A server that always supplied `current + 1` would mis-bind every non-acquire
token** — a new defect introduced by a friction fix.

**The choice was: enforce the binding properly at auth, or stop requiring the fields. Not auto-fill
them.** ~~*Lead6 ruled delete.*~~ — **superseded; the ruling is OPTIONAL** (see the heading above).
Either way `binding_required` stops refusing their absence and two identifiers leave the CLI
surface; the difference is that **optional keeps the columns, and therefore keeps enforcement
available.**

**Scope note for the implementer — CORRECTED, and the earlier version of this paragraph would have
broken minting.** It said *"mint stops recording `task_id` and `epoch` on the token."* Doing only
that hard-fails every mint. Verified on `273c472`:

```ts
// supabase/functions/command/index.ts:1914-1916
if (!token || token.task_id === null || token.epoch === null) {
  throw new Error("folded token projection missing narrow binding");
}
```

```ts
// src/protocol/workspace-reducer.ts:314 — required envelope fields
'token_id', 'principal_id', 'run_id', 'task_id', 'epoch', 'scopes', 'issued_at', 'expires_at',
```

**"Nothing reads these fields" is true of the AUTH path and false of the MINT path.** Atlas
established the first; Sable found the second. This spec conflated *unused at auth* with *unused* —
the same generalisation-from-one-path error that produced its earlier `current + 1` instruction.

**So the change is a four-place one at minimum** (the wire-validation site is enumerated in the `--epoch` section above), and the schema will not catch a partial one
because both columns are nullable:

See the `--epoch` section for the enumerated four, including the wire-validation site that rejects
with a 400 before any of the others execute.

`run_id` is **not** in this group; see above, it is load-bearing at auth and its row must keep being
written.

### `--principal-id` — **optional, defaulted.**

The check is genuine (`principal_revoked`, `principal_not_owned` against `owner_user_id`). But the
product already ships the rule for this shape of friction: *"a sole accepted project is saved
automatically"* (`cli.ts:281`).

- human owns **zero** principals → **create one** (see below)
- human owns **exactly one** → use it
- human owns **more than one** → require `--principal-id`, listing the candidates

### `--ttl-ms` — **unchanged here.** Ledger's lane.

---

## Self-registration on first mint

`principal create` disappears as a required step. On a mint where the human owns no principal, the
server creates one.

**Justification under the charter's rule** — *friction is justified only by irreversibility*:

- creating a principal is **reversible** — `revoked_at` exists and is checked on every mint
- minting a token is **reversible** — it expires, 1h default, 8h maximum

**Neither act is irreversible, so neither justifies a gate.** The safety that matters is already
elsewhere and is untouched by this change: ownership derives from the human credential on the
request, and `humanRights` still ceilings the scopes an agent can hold.

**Naming.** `principal create` takes `--name`. Auto-creation needs a default; the device is already
known to the request (`prepared.wire.device_id`), so a device-derived name is available without a
new flag.

---

## What this change must NOT touch

- **Scope checks.** `scope_not_allowed`, `scope_denylisted`, and the `humanRights` ceiling are real
  safeguards against an irreversible act. They stay exactly as they are.
- **`principal_revoked` / `principal_not_owned`.** Both consult server state. Keep.
- **The `agent_runs` INSERT.** It moves from caller-supplied to server-supplied input. It does not
  go away.
- **The reducer's epoch fence.** `assertEpochIncrease` (`reducer.ts:81-82`) is correct and stays. It
  operates on the epoch carried in lease *events*, which is a different object from the epoch
  recorded on a *token* — conflating the two is what produced this spec's earlier wrong instruction.

## Bounds

- **Spec written from source, not from a running deployment.** The mint path was traced; Ledger
  executed the protocol layer. **Neither of us drove the deployed edge function.**
- **Ledger's demonstration is protocol-layer only.** Their `run_id="NEVER-EXISTED"` arm passes the
  reducer and would fail the deployed `::uuid` cast. The accept-any-binding finding holds for
  `src/protocol/`; the deployed endpoint has a second layer that was not tested.
- **There is no downstream epoch failure to demonstrate.** An earlier version of this spec predicted
  a later `StreamIntegrityError`; Atlas established the field is never read, so the failure does not
  exist. The prediction was wrong, not merely unproven.
- This document proposes; it does not implement. No code changed.
