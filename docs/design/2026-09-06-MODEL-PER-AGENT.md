# A model per agent: assigned by a person, honoured by the listener, declared by the agent

**Status:** SPECIFICATION, draft 1, branch `spec/app-backlog`. Backlog item 6 ("assign a different model per agent — `declare_agent_model` exists on the wire; no UI"). Authored by CSwarmStrategist (`2121f81d`), 2026-09-06, from a read-only code map (`docs/evidence/2026-09-06-app-specs-arms/maps/markdown-colour-model.md`, Spec E).
**Authority:** none until adopted; CSwarmDevLead PMs the lanes.

## 0. The answer in one paragraph

The backlog line is out of date: the UI exists. A person can already set an agent's model in the app (`mayEditModel` → `agent-model-editor` → `set_agent_model`, `LiveDashboard.astro:4109-4123`), and the agent already declares one at start (`declare_agent_model`, `src/listener/runtime.ts:1305-1330`). What is missing is the loop: **both write the same column** (`swarm.agent_principals.model`, `20260730000001_workspace_access_lifecycle.sql:8-23`), so a person's assignment is overwritten by the listener's next start; the listener **never reads** the assignment, and for Claude and Codex `--model` is refused outright ("no measured bridge mapping", `src/cli.ts:4395-4399`); and what the listener declares is a provider label (`"claude (claude-agent-acp 0.64.2)"`, `listenerModelLabel`, `:4353-4363`), not a model. This spec splits the column into an **assignment** (a person's intent) and a **declaration** (what actually runs), makes the listener read the assignment at start and pass it to a bridge where a mapping is measured, and shows both on the agent row with a mismatch mark. That is the whole feature; the wire already has the two commands.

## 1. Today, measured

| part | fact | source |
|---|---|---|
| storage | one column `agent_principals.model` (text, 1–120, no control chars), projected to `swarm_read.agent_principals.model` | `20260730000001:8-23`, `:69`, `:112-125` |
| agent writes it | `declare_agent_model { model }`, self-only, fire-and-forget at listener start | `workspace-commands.ts:96-101`; `command/index.ts:1959-1997`; `runtime.ts:297`, `:1305-1330`; `command-client.ts:836-875` |
| person writes it | `set_agent_model { principal_id, model }` under the revoke gate; `create_agent_principal` may set it | `workspace-commands.ts:108-118`, `:85-89`; shared `normalizedModel()` `:492-511` |
| what the agent declares | `listenerModelLabel(provider)`: `"claude (claude-agent-acp 0.64.2)"`, `"codex (codex-acp 1.1.9)"`, `"grok"`, `"opencode"` — the provider and bridge, deliberately never a guessed model | `cli.ts:4347-4363`, `:5945` |
| `--model` | accepted for grok/opencode and passed to the bridge (`:5842`, `:5796`); **refused** for claude/codex (`:4395-4399`, `:5588-5592`); Claude/Codex constructors never read it (`:5804-5822`) | map |
| site | roster row `${agent.model ?? "Model not specified"} · owned by …` (`:4030-4032`); operator line (`:5113`); entity panel (`:2625`); **edit UI** gated to owner/admin/self-owner (`:4109-4114`) → `buildAgentModelEditor` (`currentModel: agent.model`, `:4123`) → `setAgentModel` | `LiveDashboard.astro` |
| commit trailers | `Agent-Model:` on commits comes from the coding agent's transcript (`scripts/agent-trailers.sh`, `docs/development/agent-trailers.md`); a separate mechanism, not wired to the column | map |

The defect in one line: a person sets `gpt-5.6-sol`; the listener restarts and writes `"codex (codex-acp 1.1.9)"` over it; the row now says the bridge label, and the bridge ran whatever its default was. Nobody lied; the two facts share one cell.

## 2. The design

### 2.1 Two facts, two columns

- `assigned_model text NULL` on `swarm.agent_principals`: written only by `set_agent_model` (a person) and by `create_agent_principal`'s `model` field, which is renamed on the wire to `assigned_model` with the old key accepted for one release. It means "run this".
- `model` keeps its name and becomes the **declaration**: written only by `declare_agent_model` (the agent). It means "this is what I run". The migration copies today's `model` into `assigned_model` where the last writer was a person, and leaves it as the declaration otherwise. **Which log, exactly:** the reducer appends every accepted command's event to the workspace event log (`appendEvents`, `supabase/functions/command/index.ts:3749`; the table is the one that function inserts into, and L1 names it in the migration by reading that function rather than this document); the backfill selects, per principal, the newest event whose kind is the model-set event (the kind the `set_agent_model` handler emits) or the model-declared event (the kind `declare_agent_model` emits) and looks at its envelope's `actor_user`: non-null → a person set it → copy into `assigned_model`; null → the agent declared it → leave in `model`. A principal with no such event keeps `assigned_model = NULL`. Where the two event kinds cannot be told apart in old rows, `assigned_model` stays NULL and the row shows only the declaration, which is the honest state. The migration prints the three counts (copied, left, ambiguous) as a `RAISE NOTICE`, and L1's evidence records them from the local run.
- `swarm_read.agent_principals` projects both. The `agent_principals_model_bounded` constraint is duplicated for the new column.

### 2.2 The listener honours the assignment where it can measure it

At start, after the first inbox read (which already returns the principal's own row through `agent_delivery_read_context`; L1 adds `assigned_model` to that function's output the way push delivery added `wake_id`), the listener:

1. If `--model` was given on the command line, it wins (operator at the keyboard beats the app), and the declaration says so.
2. Else if `assigned_model` is set and the provider has a **measured bridge mapping**, the listener starts the bridge with it. Measured today: grok and opencode take a `model` option (`cli.ts:5842`, `:5796`). Not measured: claude-agent-acp and codex-acp. Lane L2 measures both the same way: read the bridge's own `--help` and README at the version pinned in `src/host/bounds.ts` (`CODEX_ACP_LAST_MEASURED_VERSION`, the Claude equivalent) for a model argument, environment variable, or config key; start the bridge with it under `--state-dir <temp>`; and confirm from the bridge's process arguments or its first session message which model it runs. The exact flag or key found is recorded in `bounds.ts` beside the version, so the mapping is a measured constant, not a guess. Whichever mapping is measured working gets enabled; whichever is not stays refused with the same message as today, and the row shows the assignment as **not honoured (no bridge mapping for <provider>)**.
3. The declaration becomes **truthful**: `declare_agent_model` sends `"<model> via <provider> (<bridge> <version>)"` when a model is known, and the existing provider label when it is not. The comment at `cli.ts:4347-4352` ("never a guessed underlying model") still holds: the model is only named when the listener passed it to the bridge itself.

### 2.3 The site shows both, and the gap

The roster row and the entity panel show `runs <declaration>` and, when an assignment exists, `assigned <assigned_model>`; when the two disagree, or the assignment is not honoured, a small mark reads `not honoured` with a reason. **Where the reason lives, exactly:** `declare_agent_model` gains an optional field `assignment_state` with the closed values `honoured | no_mapping | cli_override | none`; the handler stores it in a new column `swarm.agent_principals.model_assignment_state text` (same closed check constraint, default `none`), projected to `swarm_read.agent_principals`, and written only by that command. The listener's status file carries the same value under the wake block's closed list as `modelAssignment` for `listen status`. **The site's rule:** the mark shows when `model_assignment_state` is `no_mapping` or `cli_override`, or when `assigned_model` is set and `model` does not start with `assigned_model` (the declaration is `"<model> via <provider> (…)"`, so prefix equality after `normalizedModel` is the comparison; no regex over the label). The edit UI edits the assignment only; it never writes the declaration.

### 2.4 What does not change

`declare_agent_model` and `set_agent_model` keep their names, gates, and normalisation; the commit-trailer mechanism stays separate (it is about commits, not seats); `--model` stays an explicit override.

## 3. Acceptance

- Migration: an existing row set by a person keeps its value in `assigned_model`; a row set by a listener keeps it in `model`; the view shows both.
- `set_agent_model` then a listener restart on grok: the listener starts with the assigned model (asserted on the bridge's constructor options in the fake), and `declare_agent_model` reports `<model> via grok`; the row reads `runs <model> · assigned <model>`.
- The same on codex with a measured mapping, or `not honoured (no bridge mapping for codex)` if L2 measures none.
- `--model X` with an assignment Y: runs X, declares X, row marks `assigned Y · not honoured (cli override)`.
- A person editing the model never changes `model` (the declaration); the listener never changes `assigned_model`.

## 4. Lanes

| lane | branch | author | files | tests | after |
|---|---|---|---|---|---|
| **L1** column and wire | `lane/assigned-model` | Codex (gpt-5.6-sol, high) or Grok | migration (`assigned_model`, constraint, view projection, `agent_delivery_read_context` output column with its three privilege statements and its live body as the base — the push-delivery spec's rule), `src/protocol/workspace-commands.ts` (`set_agent_model`/`create_agent_principal` write `assigned_model`; `declare_agent_model` writes `model`), `supabase/functions/command/index.ts` handlers, `supabase/functions/read/index.ts` (both columns on the agent's own read), `tests/p1-server/agent-model-split.test.ts` (glob), `tests/p1-local/` migration test named in `package.json:26` + pin | the split; the backfill rule; the gate unchanged | — (holds the local database) |
| **L2** listener honours | `lane/listener-assigned-model` | Grok | `src/cli.ts` (`--model` precedence, bridge mapping per provider, `listenerModelLabel`), `src/listener/runtime.ts` (read the assignment, `declareModel` payload), `src/host/bounds.ts` (measured versions), `src/listener/control.ts` (`modelAssignment` in the closed status list), `tests/listener-*.test.ts`; **a live control per provider** with `--state-dir <temp>`: the bridge process's arguments or config showing the model | precedence; mapping measured or refused; declaration text generated from the same constants | L1 |
| **L3** site | `lane/agent-model-rows` | Gemini | `LiveDashboard.astro:4030-4032`, `:5113`, `:2625`, `:4109-4123`; `agent-model-editor` (edits the assignment); `agent-model-editor.observer.test.ts` | both facts; the mismatch mark; the editor writes the assignment only | L1 |

Order: L1 → L2 ∥ L3. Production apply: migration → command and read edges → client → site.

## 5. What was NOT established

- Whether claude-agent-acp and codex-acp accept a model at launch and honour it; L2 measures both before enabling either, and the spec does not promise it.
- How many existing rows can be attributed to a person versus a listener from the event log; the backfill leaves the ambiguous ones with no assignment rather than guessing.
- Whether the operator wants a per-workspace default model for new agents; not in scope, one column if wanted.
