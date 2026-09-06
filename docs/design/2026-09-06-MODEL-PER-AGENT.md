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
- `model` keeps its name and becomes the **declaration**: written only by `declare_agent_model` (the agent). It means "this is what I run". The migration copies today's `model` into `assigned_model` where the last writer was a person, and leaves it as the declaration otherwise. **Which log and which field, exactly (the Opus arm corrected draft 1 here):** both commands emit the **same** event type, `AgentModelDeclared` (`src/protocol/workspace-events.ts:187`; emitted at `workspace-commands.ts:987` for `declare_agent_model` and `:1014` for `set_agent_model`), and `actor_user` is non-null for both, because an agent token's actor carries its owner (`command/index.ts:2591`). The discriminator is the one the event's own comment documents (`workspace-events.ts:181-185`) and the repo tests (`tests/protocol-workspace.test.ts:1392-1394`): **a self-declaration carries the agent principal; a human set carries the user and a NULL principal.** A third event matters: `AgentPrincipalCreated` carries `model` when a person set it at creation (`workspace-commands.ts:832-838`). The backfill therefore takes, per principal, the newest of `AgentModelDeclared` and `AgentPrincipalCreated` from the workspace event log (the table `appendEvents` inserts into, `command/index.ts:3749`; L1 names it from that function) and: principal field NULL, or type `AgentPrincipalCreated` with a model → a person set it → copy into `assigned_model`; principal field non-null → the agent declared it → leave in `model`. With that field the answer to "how many rows can be attributed" is all of them; the migration prints the two counts as a `RAISE NOTICE` and L1's evidence records them from the local run.
- `swarm_read.agent_principals` projects both. The `agent_principals_model_bounded` constraint is duplicated for the new column.

### 2.2 The listener honours the assignment where it can measure it

The bridge is built **before** the runtime starts (`newModel` at `src/cli.ts:5782-5843`, called at `:5929-5931`, then `runListenerRuntime` at `:5933`), and a bridge's model is a constructor option (`src/listener/grok-model.ts:41`), so the assignment must be known before that call. `listen start` therefore performs **one inbox read before building the bridge** (the same `readAgentSignalPage` call the runtime makes first; it costs one invocation per start and stamps grant use, which is harmless) and takes `assigned_model` from that response (L1 adds `assigned_model` to `agent_delivery_read_context`'s output the way push delivery added `wake_id`, from the live body of that function with its three privilege statements). Then the listener:

1. If `--model` was given on the command line, it wins (operator at the keyboard beats the app), and the declaration says so.
2. Else if `assigned_model` is set and the provider has a **measured bridge mapping**, the listener starts the bridge with it. Measured today: grok and opencode take a `model` option (`cli.ts:5842`, `:5796`). **Not measured, and not assumed:** claude-agent-acp and codex-acp are spawned with no arguments and spoken to over ACP on stdio (`src/host/claude.ts:416-418`, `:588-590`; `src/host/codex.ts:277-279`, `:363-365`), so the only question is whether each bridge forwards a model over ACP (a session option) or reads one from its own configuration; nothing in this tree measures either. Lane L2 measures both under `--state-dir <temp>`: start the bridge, pass the candidate option or config, and confirm from the bridge's first session message (or the model's own answer to "which model are you") which model runs. The exact mechanism found is recorded in `src/host/bounds.ts` beside the pinned bridge version, so the mapping is a measured constant. Whichever mapping is measured working gets enabled; whichever is not stays refused with the same message as today, and the row shows the assignment as **not honoured (no bridge mapping for <provider>)**. This spec promises the grok/opencode path and the measurement of the other two, nothing more (§5).
3. The declaration becomes **truthful and bounded**: `declare_agent_model` sends the **bare model string** when the listener passed one to the bridge itself, and the existing provider label (`"codex (codex-acp 1.1.9)"`) when it did not. No composed `"<model> via …"` string, so the 120-character bound (`agent_principals_model_bounded`; refused at `workspace-commands.ts:507-509` and `command/index.ts:1989`) cannot be exceeded by concatenation and a fire-and-forget declaration (`runtime.ts:1303-1330`) cannot silently keep a stale label; `assigned_model` carries the same 1–120 bound. The provider and bridge version stay where they already are, in `listen status`. The comment at `cli.ts:4347-4352` ("never a guessed underlying model") still holds: the model is named only when the listener passed it.

### 2.3 The site shows both, and the gap

The roster row and the entity panel show `runs <declaration>` and, when an assignment exists, `assigned <assigned_model>`; when the two disagree, or the assignment is not honoured, a small mark reads `not honoured` with a reason. **Where the reason lives, exactly (durable, in Postgres, because the browser cannot read a listener's local status file and a Realtime frame is not stored):** `declare_agent_model` gains an optional field `assignment_state` with the closed values `honoured | no_mapping | cli_override`; the handler stores it in a new column `swarm.agent_principals.model_assignment_state text` with a closed check constraint and **default `pending`**, projected to `swarm_read.agent_principals`, written only by that command, and **reset to `pending` by `set_agent_model`** (so a seat that has not started since a person changed the assignment shows `assigned X · pending`, which is the truth). The listener's status file carries the same value as a **top-level** key `modelAssignment` (the top-level allow-list `STATUS_ALLOWED_KEYS` is tolerant of absence, `control.ts:241-291`; the wake block is not, `:407-409`, `:596`, and putting it there would make an upgraded CLI fail to read an older running listener's status during a rolling upgrade). **The site's rule:** the mark shows when `model_assignment_state` is `no_mapping`, `cli_override`, or `pending` with a non-null assignment, or when the state is `honoured` and `normalizedModel(model) !== normalizedModel(assigned_model)` (bare strings on both sides, equality, no prefix, no regex). The edit UI edits the assignment only; it never writes the declaration.

### 2.4 What does not change

`declare_agent_model` and `set_agent_model` keep their names, gates, and normalisation; the commit-trailer mechanism stays separate (it is about commits, not seats); `--model` stays an explicit override.

## 3. Acceptance

- Migration: an existing row set by a person keeps its value in `assigned_model`; a row set by a listener keeps it in `model`; the view shows both.
- `set_agent_model` then a listener restart on grok: the listener starts with the assigned model (asserted on the bridge's constructor options in the fake), and `declare_agent_model` reports the bare model with `assignment_state: honoured`; the row reads `runs <model> · assigned <model>`.
- The same on codex with a measured mapping, or `assigned <model> · not honoured (no bridge mapping for codex)` if L2 measures none.
- `--model X` with an assignment Y: runs X, declares X with `cli_override`, row marks `assigned Y · not honoured (cli override)`.
- `set_agent_model` on a seat that is stopped: the row reads `assigned <model> · pending` until the next start.
- A person editing the model never changes `model` (the declaration); the listener never changes `assigned_model`.

## 4. Lanes

| lane | branch | author | files | tests | after |
|---|---|---|---|---|---|
| **L1** columns and wire | `lane/assigned-model` | Codex (gpt-5.6-sol, high) or Grok | migration (`assigned_model` and `model_assignment_state` with their constraints, view projection, the backfill over `AgentModelDeclared`/`AgentPrincipalCreated` by the principal field, `agent_delivery_read_context` output column from its live body with its three privilege statements — the push-delivery rule), `src/protocol/workspace-commands.ts` and `workspace-events.ts` (`set_agent_model`/`create_agent_principal` write `assigned_model` and reset the state; `declare_agent_model` writes `model` and the state), `supabase/functions/command/index.ts` handlers, `supabase/functions/read/index.ts` (both columns and the state on the agent's own read), `tests/protocol-workspace.test.ts`, `tests/p1-server/agent-model-split.test.ts` (glob), `tests/p1-local/` migration test named in `package.json:26` + pin | the split; the backfill counts on a fixture with all three histories; the gate unchanged | — (holds the local database) |
| **L2** listener honours | `lane/listener-assigned-model` | Grok | `src/cli.ts` (the pre-bridge read, `--model` precedence, bridge mapping per provider, the bare-model declaration), `src/listener/runtime.ts` (`declareModel` payload with `assignment_state`), `src/host/bounds.ts` (measured mechanisms), `src/listener/control.ts` (`modelAssignment` at the top level), `tests/listener-*.test.ts`; **a live control per provider** with `--state-dir <temp>`: the bridge's first session message or the model's own answer naming the model | precedence; mapping measured or refused; the declaration is the bare string; the status key is tolerant of absence | L1 |
| **L3** site | `lane/agent-model-rows` | Gemini | `LiveDashboard.astro:4030-4032`, `:5113`, `:2625`, `:4109-4123`; `agent-model-editor` (edits the assignment); `agent-model-editor.observer.test.ts` | both facts; the mismatch mark; the editor writes the assignment only | L1 |

Order: L1 → L2 ∥ L3. Production apply: migration → command and read edges → client → site.

## 5. What was NOT established

- Whether claude-agent-acp and codex-acp accept a model at launch and honour it; L2 measures both before enabling either, and the spec does not promise it.
- How many existing rows can be attributed to a person versus a listener from the event log; the backfill leaves the ambiguous ones with no assignment rather than guessing.
- Whether the operator wants a per-workspace default model for new agents; not in scope, one column if wanted.
