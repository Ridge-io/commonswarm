# Ceremony before an agent says one word

**Assignment (Lead6):** inventory the ceremony before first useful work — `principal create`, then
`token mint` with five identifiers. What is the minimum? Can an agent self-register on first use?

**Test applied**, from the charter's own §0 and Lead6's reframe: *friction is justified only by
irreversibility*, and **the burden of proof is on the safeguard.**

**Method.** Read against `origin/main` = `571cc0e`. Command syntax from a build of that tree; the
validation logic from `src/protocol/workspace-commands.ts:505-548` and `src/cli.ts:1001-1026`.

---

## The headline: three of the five identifiers cannot be wrong

`token mint` validates `run_id`, `task_id` and `epoch` **for presence only** — never for value
(`workspace-commands.ts:512-517`):

```ts
if (!cmd.run_id || !cmd.task_id || !Number.isInteger(cmd.epoch) || cmd.epoch < 0) {
  return domain(ctx, cmd.kind, 'binding_required',
                'run_id, task_id, and a non-negative integer epoch are required');
}
```

`--run-id x --task-id x --epoch 0` satisfies all three. The values are then embedded verbatim into
the `AgentTokenMinted` event. The CLI adds nothing — `args.required("run-id")` is a presence check
and a pass-through (`cli.ts:1025-1026`).

**A requirement the caller can satisfy with any invented value is not a safeguard.** It is three
mandatory fields that cannot be wrong, and they are three of the five things standing between an
agent and its first word.

**Contrast, in the same function, with the checks that *are* real:** `principal_revoked` and
`principal_not_owned` are tested against server state; `token_ttl_invalid` has bounds; scopes are
checked against `humanRights` and a denylist. **Those are safeguards. The binding trio is
ceremony**, and the difference is visible in twelve consecutive lines.

---

## Item-by-item

| flag | validated as | verdict |
|---|---|---|
| `--principal-id <uuid>` | **real** — revoked / owned, against state | **KEEP, default it** |
| `--run-id <uuid>` | presence only | **DELETE from the surface** |
| `--task-id <uuid>` | presence only | **DELETE from the surface** |
| `--epoch <n>` | presence only *here*, load-bearing *elsewhere* | **SIMPLIFY — server-supplied** |
| `--ttl-ms <ms>` | bounds, 1h default / 8h max | Ledger's lane |

**`--principal-id` — keep, default it.** The check is genuine. But the product already has the
pattern for removing this kind of typing: *"a sole accepted project is saved automatically"*
(`cli.ts:281`). When a human owns exactly one principal, requiring the uuid is the same friction
that rule already rejects elsewhere. Ambiguity should prompt; sole ownership should not.

**`--run-id` / `--task-id` — delete**, but ~~*nothing is lost: no code path compares these against
anything*~~ — **that claim was FALSE for `run_id` and is corrected below.**

> ### CORRECTION — `run_id` IS load-bearing. This document searched the wrong directory.
>
> The original claim was measured against `src/protocol/`. **The deployed authority is
> `supabase/functions/`, which this document did not look at.** In it:
>
> ```sql
> -- _shared/agent-auth.ts:36-40, INNER joins
> FROM swarm.agent_tokens AS t
> JOIN swarm.agent_runs AS r ON r.run_id = t.run_id AND r.principal_id = t.principal_id
> JOIN swarm.devices  AS d ON d.device_id = r.device_id
> ```
>
> **Every agent request authenticates through `run_id`.** No matching run row → no rows →
> `return null` → denied.
>
> The deletion verdict survives on a **stronger** reason. `command/index.ts:1928` already writes the
> row the join depends on:
>
> ```sql
> INSERT INTO swarm.agent_runs (run_id, principal_id, device_id)
> VALUES (<token.run_id>::uuid, …)  ON CONFLICT (run_id) DO NOTHING
> ```
>
> So the argument is not *"nobody validates it"* — it is **"the server already writes this record,
> and only the server can write it correctly."**
>
> **And a third footgun lives in that one line.** `ON CONFLICT DO NOTHING`, combined with the auth
> join requiring `r.principal_id = t.principal_id`: reuse a `run_id` belonging to another principal
> and the insert silently does nothing, **the mint succeeds, and the token can never
> authenticate** — a credential dead on arrival, with no error at the point of the mistake.
> Server-generating `run_id` closes this too.
>
> **`--task-id` is unaffected and now better supported:** `task_id` appears **0 times** in
> `agent-auth.ts` against a control of **4** for `run_id` in the same file. It is genuinely not
> consulted at authentication.
>
> **Consequence for implementation:** "delete `--run-id`" must not mean *generate a random value and
> drop it*. The server must generate it **and keep writing the `agent_runs` row**. Implemented
> without that, every minted token authenticates against nothing.

**`--epoch` — simplify, and it is also a footgun.** Epoch is genuinely load-bearing *downstream*:
`reducer.ts:81-82` throws `StreamIntegrityError` on a non-increasing epoch, which is real
stale-writer fencing. **But mint never checks the epoch against stream state** — only `>= 0`. So a
caller can mint with a stale epoch, mint succeeds, and the failure surfaces later, somewhere else,
as a stream-integrity error. **The validation is in the wrong place.** The server knows the current
epoch; it should supply `current + 1`. That removes an identifier *and* closes the footgun.

---

## Can an agent self-register on first use?

**Nothing in the mint path prevents it.** The two commands exist to (a) create an owned principal
and (b) issue a scoped, expiring credential for it. Both are server-side facts the server could
establish on a first authenticated call:

- ownership comes from the human credential already required (`principal_not_owned` is checked
  against `user_id`, which the request already carries);
- scopes are already bounded by `humanRights` — an agent cannot self-grant beyond its human;
- `token_id` collision is already checked server-side.

**The irreversibility test:** creating a principal is **reversible** (`revoked_at` exists and is
checked on every mint). Minting a token is **reversible** (it expires — 1h default, 8h max). Under
the rule as written, **neither act justifies a gate**, and self-registration on first use is
consistent with the product's own stated ethos.

**What genuinely is irreversible, and should stay gated:** scope grants that exceed the human's
rights (already refused), and anything that writes to the immutable signal plane. Those are not in
this path.

---

## The minimum

An agent's first useful work today costs **two commands and five identifiers**, plus `--url` and
`--anon-key` on each (Quill's lane). Of the five, **three cannot be wrong** and one of the
remaining two is defaultable. The floor this analysis supports is:

```
cswarm token mint --scope <scope>          # principal auto-created, ids and epoch server-supplied
```

**One command, one argument that means something.**

---

## Bounds

- **Read, not run.** No credentials on this seat, so the mint path was traced rather than executed.
  Specifically untested: that a server-generated `run_id` breaks no existing consumer. `grep` finds
  no comparison of these fields anywhere in `src/protocol/`, but absence in one directory is not
  proof for the deployed edge function.
- **The epoch footgun is inferred from two files** (`workspace-commands.ts` accepts any `>= 0`;
  `reducer.ts:81` requires strictly increasing). I have not produced the failure — that would need a
  live workspace, and it is the one claim here worth demonstrating before acting on it.
- `--ttl-ms` is deliberately left to Ledger.
- Scope names were not audited; `--scope` in the proposed floor assumes the existing scope syntax.
