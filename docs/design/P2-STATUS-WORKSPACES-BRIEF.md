# P2-2 design brief: `coswarm status` + workspace visibility & selection

**Status:** v1.1 — CLEARED FOR IMPLEMENTATION after Sable review (v1 → CONDITIONAL GO; both
BLOCKING items folded). Mason implements this document.

> **v1→v1.1:** the TTY picker is **CUT** (v1 contradicted itself — step 4 specified a picker while
> Q4 leaned cut, and the acceptance tests demanded both); the read-authority rule is **refined**
> from "no new views" to **"no new authorization predicate"**, because the literal version made
> this slice's own deliverables unbuildable; Q1/Q2/Q3/Q5 resolved into the body; foreign-vs-unknown
> id error uniformity added.
**Author:** Lead4, 2026-07-24.
**Pre-pinned contracts** (agreed *before* this brief existed — see SUCCESSION-PLAN P2-2):
the **A+B fix pair**, the **non-interactive contract**, and the **`use` selection contract**.
Those are requirements, not suggestions; this brief expands them into a buildable slice.

## 0. Why this slice, and why it grew

Two forces converge here.

**The felt feedback (§1c).** The operator drove the two-human connect and said *"I didn't
really know what I was doing or why."* They flew blind: there was no way to see members,
agents, tasks, or leases. `coswarm status` is the direct answer — comprehension requires
visibility.

**A MAJOR product bug the UX harness found before it ever ran.** `src/cloud/auth.ts:410` —
`discoverSoleWorkspace` persists a default workspace **only when the identity has exactly one
live membership** (`body.length !== 1 → return null`). So **any human belonging to two or more
workspaces cannot invite anyone after a logout**, because `invite` then needs `--workspace-id`,
the very flag §1c called undiscoverable (**bug #3**). A second *real* collaboration triggers it
identically — this is not a test artifact.

That bug makes workspace visibility **load-bearing rather than nice-to-have**: listing is the
only way a multi-workspace human discovers what to pass. So P2-2 is one coherent slice —
*see your state, and select which project you're acting on* — not two.

## 1. Deliverables

### 1.1 `coswarm status` — one screen, plain words

Answers, in this order, for the currently selected project: **who is here, what their agents
are, what work exists, and who holds it.**

- **You**: signed-in identity + which project is selected (name **and** full id).
- **Members**: display name, role, and whether they are you.
- **Agents**: principals per member, live vs revoked, and whether one belongs to this machine.
- **Tasks**: slug, state, and holder — with leases rendered as *"held by X, expires in 12m"*
  rather than raw epochs and timestamps.
- **Nothing-yet states are first-class**: an empty project must say *"No work yet — create a
  task with …"*, never print an empty table. The §1c complaint was not knowing what was
  happening; a blank screen is the same failure.

Plain language over domain vocabulary throughout: "project" not "workspace" in prose, "agent"
not "principal", "holding" not "lease epoch". Where a raw id is needed for copy-paste, show it
**next to** the human label, never instead of it.

### 1.2 `coswarm workspaces` — the list that unblocks selection

Every row shows **name AND full id** — never name-only — plus role and a marker for the current
selection. This is the unambiguous copy-paste target that makes §1.3 safe.

### 1.3 `coswarm use <id|name>` — explicit, inspectable selection

Writes the selected project to the profile default. **Selection contract (pinned):**

- **No slug aliases, no prefix matching, no "closest name".** Names are attacker-influencable
  display strings (we sanitize them on the accept path already — FIX-5 class). A resolution
  convenience whose failure mode is **silent wrong-tenant selection** is not a convenience.
- **Ambiguous name → fail**, list the collisions, leave the stored default **unchanged**.
- **Selection by id always works**, including when names collide.
- **Confusable names that sanitize to the same string** are treated as ambiguous when both are
  live.
- **Foreign or unknown id → fail with NO profile write.**

### 1.4 Multi-workspace resolution everywhere (the bug fix)

Resolution order for `invite` and **every** workspace-scoped command:

1. explicit `--workspace-id`
2. profile default — *if still a live membership* (if the membership was **revoked**, warn once,
   clear the stale default so no zombie project stays selected, then continue resolving)
3. exactly one live membership → use it (today's behavior, retained)
4. n > 1 → **fail closed** with the list + guidance. **There is no interactive picker in this
   slice** (decision below); the same path serves humans and agents.

**The TTY picker is CUT.** v1 hedged and contradicted itself. Reasons to cut: the non-interactive
path is mandatory *and* complete on its own; a picker would be the CLI's only interactive prompt,
which is a new class of surface to harden right after P2-1 spent a whole slice guaranteeing agent
mode never hangs; and a human served a good list plus one copy-pasteable `use` command is not
meaningfully worse off. **The cost of cutting it is paid in copy quality** — the fail-closed
message must be genuinely excellent, not a bare error. Revisit only if it reads as friction in
practice.

**The non-interactive contract is absolute** (P2-1 hardened agent mode to never hang; the same
discipline applies): never block on a TTY prompt when stdin is not a TTY, `--json` is set, or the
process is otherwise non-interactive. The failure body — and `--json` stdout — carries a
deterministic machine-readable list of `{workspace_id, name, role}` plus one plain-language line
pointing at `coswarm workspaces` / `coswarm use <id|name>`. No hang, no half-rendered prompt.

**Agents select out-of-band:** list → `use` → invite. **Do not** invent a second silent env
default; `use` is the explicit, inspectable selector. The interactive picker is a **human
convenience only**.

## 2. Read authority — no new surface

**The rule is NO NEW AUTHORIZATION PREDICATE — not "no new views."** v1 said the latter and it was
wrong in a way worth recording: today there is **no `swarm_read.workspaces`** and **no user-display
projection**, so a literal reading forbade project *names* and co-member *display names* — meaning
§1.2's "name AND full id on every row" and §1.1's "Members: display name" were banned by my own
principle. That would have shipped id-only lists and **reopened the exact undiscoverable-identifier
friction this slice exists to remove**. An over-strict rule doesn't produce safety; it produces
either a crippled screen or someone smuggling names in through `service_role`.

**Allowed:** membership-gated projections that expose only fields of rows the caller can *already*
reach through `is_member` / co-membership — the same tenancy gate with a join:
- `swarm_read.workspaces` — `WHERE swarm.is_member(workspace_id, auth.uid())`, exposing
  `workspace_id`, `name`, `archived_at`.
- `swarm_read.member_profiles` (only if needed for display names) — `display_name` for `user_id`s
  that share a **live** membership with the caller in a workspace the caller can already read.

**Still forbidden, and these are the actual risk:** any *looser* predicate — a public user
directory, a non-member workspace probe, cross-tenant search or aggregation, or any read returning
rows for a tenant the caller does not belong to. Every new view is `security_barrier`, owner-pinned
to `swarm_admin`, and its predicate gets explicit review (§4 asserts it).

Existing views to reuse unchanged (`migration:633-680`): `memberships`, `agent_principals`,
`agent_runs`, `tasks`, `leases`. P2-1 already proved the REST read pattern (`accept-profile:
swarm_read`, the `discoverSoleWorkspace` shape at `auth.ts:385-416`). **A migration is therefore in
scope for this slice** — additive views only, no changes to existing tables or policies.

## 3. Scope boundaries

**IN:** `status`, `workspaces`, `use`; the §1.4 resolution order across workspace-scoped
commands; `--json` for all three; plain-language rendering incl. empty states; tests per §4;
README.

**OUT:** the agent-skill layer (P2-3); the hosted invite page and `https://` link form (P2-4);
`create_workspace` wiring (still deferred — status must therefore render a fixture-seeded
project correctly, and must not imply the user can create one); messaging/board (P3); rate
limiting; revoke wiring; the T-sweep.

## 4. Acceptance (evidence-gated)

- `tsc` clean; core untouched (zero bundle drift); CLI + server suites green.
- **Selection tests:** use-by-id; use-by-unique-name; **ambiguous name → fail + list, default
  unchanged**; id works when names collide; foreign/unknown id → fail with **no profile write**;
  confusable names sanitizing to one string → ambiguous when both live.
- **Non-interactive tests:** n>1 with `--json` → deterministic list, **exit non-zero, no
  prompt**; n>1 with non-TTY stdin → same; n>1 on a TTY → picker path; **non-TTY never blocks**
  (assert no hang, not just correct output).
- **Resolution tests:** each of the five steps in order, including a **stale profile default
  whose membership was revoked** → falls through rather than acting on a dead tenant.
- **Status tests:** empty project renders guidance not a blank table; lease rendered as
  human-readable remaining time; labels sanitized (control/bidi/ANSI — FIX-5 class) since member
  and project names are attacker-influencable; every row that shows a name also shows its id.
- **Authority tests:** no query returns rows for a non-member workspace (the views enforce it —
  assert it anyway); **every new view carries an `is_member`-class predicate** and is
  `security_barrier` + owner-pinned; **foreign id and unknown id produce identical errors** (the
  no-enumeration oracle test, §5 Q5).
- **Revoked-default tests:** `use` a project, have the membership revoked, then run a scoped
  command → warns once, clears the stale default, and does not act on the dead tenant.
- **Picker-cut assertions:** `n>1` on a **TTY** fails closed with the list and **does not wait on
  stdin** — assert no hang, not merely correct text. There must be no code path that prompts.
- Local integration against the live local stack; hosted verified after deploy (migration applies
  to hosted, additive views only).
- README: the multi-member invite path documented end to end — `workspaces` → `use` → `invite`.

## 5. Resolved decisions (were open questions in v1)

- **Q1 — `status` shows a COUNT, not every project name.** One line: *"You're in 3 projects
  (selected: Launch redesign)."* or *"…(none selected). Run `coswarm workspaces`, then `coswarm
  use …`."* The count is `distinct workspace_id` over the caller's live memberships — already
  permitted, no cross-tenant aggregation. Names stay behind `coswarm workspaces` so `status`
  doesn't become the switcher and doesn't turn into noise.
- **Q2 — a revoked default is announced once, then cleared.** Silence risks the user believing
  their invites and tasks still land in a project they've been removed from. Warn plainly, **clear
  the stale default** (never leave a zombie id selected), then continue resolution. Identical
  message in human and `--json` output, carrying `code: default_membership_revoked`.
- **Q3 — `use` validates liveness at SELECTION time.** Failing at the moment of selection produces
  an error the user can act on immediately; deferring it means the next unrelated command fails
  confusingly. The extra read is worth it. Use-time still re-checks (step 2), because a membership
  can be revoked between selection and use.
- **Q4 — the picker is CUT.** See §1.4.
- **Q5 — no-enumeration:** a **foreign** workspace id (real, caller not a member) and an
  **unknown** id (nonexistent) must produce **byte-identical** errors. Otherwise `use` becomes an
  existence oracle for other tenants' workspaces — exactly the property #80f protects on the accept
  path. This is a required test, not a nicety.
