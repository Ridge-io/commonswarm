# P2-2 design brief: `coswarm status` + workspace visibility & selection

**Status:** v1 DRAFT for Sable adversarial review, then Mason implementation.
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
2. profile default — *if still a live membership*
3. exactly one live membership → use it (today's behavior, retained)
4. n > 1 **and** interactive TTY → optional picker
5. n > 1 **and** non-interactive → **fail closed**, structured

**The non-interactive contract is absolute** (P2-1 hardened agent mode to never hang; the same
discipline applies): never block on a TTY prompt when stdin is not a TTY, `--json` is set, or the
process is otherwise non-interactive. The failure body — and `--json` stdout — carries a
deterministic machine-readable list of `{workspace_id, name, role}` plus one plain-language line
pointing at `coswarm workspaces` / `coswarm use <id|name>`. No hang, no half-rendered prompt.

**Agents select out-of-band:** list → `use` → invite. **Do not** invent a second silent env
default; `use` is the explicit, inspectable selector. The interactive picker is a **human
convenience only**.

## 2. Read authority — no new surface

Everything above must be served by the **existing** `swarm_read.*` views, which are
`security_barrier` and `is_member`-gated (`migration:633-680`): `memberships`,
`agent_principals`, `agent_runs`, `tasks`, `leases`. P2-1 already proved the REST read pattern
(`accept-profile: swarm_read`, the `discoverSoleWorkspace` shape at `auth.ts:385-416`).

**If a display field cannot be served by an existing view, cut the field — do not add
authority.** Read surface is where tenancy leaks hide. Specifically: no cross-workspace
aggregation query, and no read that returns rows for a workspace the caller is not a member of.

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
- **Authority test:** no query returns rows for a non-member workspace (the read views enforce
  it; assert it anyway).
- Local integration against the live local stack; hosted verified after deploy.

## 5. Open questions for review

- **Q1:** Should `status` show *all* projects you belong to (a "you have 3 projects" line) or
  strictly the selected one? Showing all aids discovery of the multi-workspace state that caused
  the bug, but risks a cross-tenant aggregation read. My lean: a **count only** from the
  already-permitted memberships read, with names behind `coswarm workspaces`.
- **Q2:** When the profile default names a workspace whose membership was **revoked**, do we
  silently fall through (step 3) or tell the user their previous project is gone? Silence risks
  the user believing they are still acting on it. My lean: **tell them once**, plainly.
- **Q3:** Does `use` need to validate liveness at selection time, or is validating at use-time
  sufficient? Validating early gives a better error but adds a read on every `use`.
- **Q4:** Is a TTY picker worth building at all in this slice, given the non-interactive path is
  mandatory and complete on its own? Cutting it would shrink the slice and remove the only
  interactive surface in the CLI. My lean: **cut it**, print the list plus `use` guidance for
  humans too, and revisit only if it reads as friction.
- **Q5:** Anything in this slice that weakens the §3.4 authority model, the no-enumeration
  guarantees (#80f), or P2-1's non-interactive hardening?
