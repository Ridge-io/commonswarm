# /goal — D-044: retire the cross-owner local sandbox, attach provenance instead

**Post-0.1.5.** Production is v0.1.5 with durable delivery dark; nothing here ships to production as
part of this task. Read `docs/org/DEFECT-REGISTER.md` **D-044** first — it is the ruling and its
reasoning.

## The one-line brief

We control who may read and write what **in CommonSwarm**. What an agent does **on its operator's own
machine** is the operator's business. Remove the local sandbox; keep the server boundary; tell the
receiving agent where a message came from.

## Do NOT touch — this is the part that must not move

**The server-side authority model stays exactly as it is.** Workspace membership, directed-signal
visibility, agent principals, and `sender_owner_relation` are enforced in `supabase/functions/` and are
**out of scope**. They were proven on production on 2026-08-04: a cross-owner agent credential got
`HTTP 403` on write and an empty read against another owner's workspace, while the human behind that
agent — a member there — saw all twelve signals.

If a change you are making touches anything under `supabase/`, you have misread this goal. Stop.

## Remove

1. **The isolated cross-owner turn.** `src/listener/grok-model.ts:152` `promptIsolated()` — the
   temporary cwd, `ensureIsolatedHome()`, `sandbox: "strict"`, and the `mode === "isolated"` branch at
   `:88`. Cross-owner turns run on the same worker as same-owner turns.
2. **The kill-switch block.** `src/host/grok.ts:168-195` — the fifteen-plus `*_ENABLED=0` variables
   (`GROK_CLAUDE_*`, `GROK_CURSOR_*`, `GROK_MEMORY`, `GROK_SUBAGENTS`, `GROK_TOOL_SEARCH`,
   `GROK_LSP_TOOLS`, `GROK_WRITE_FILE`, `GROK_WEB_FETCH`) and the isolated `HOME`/`XDG_*` overrides.
3. **`disableCmuxHooks`** at `grok-model.ts:134` and `:163`, and its plumbing. This one was never
   cross-owner — it disabled an operator's own hooks during their own agent's own work.
4. The OpenCode equivalents in `src/listener/opencode-model.ts` / `src/host/opencode.ts`, to the extent
   they exist. Note D-041 MAJOR-2 already found OpenCode has no kill-switch surface, so there may be
   little to remove; say what you found.

**Keep `GROK_DISABLE_AUTOUPDATER`.** A host that self-updates mid-session breaks the version pin the
listener checks. That is our product working, not their config.

## Add — provenance on the delivery

The receiving agent should be told, in the prompt it receives:

- **who sent this** — the sending agent's name and its operator;
- **the owner relation** — `same_owner`, `cross_owner`, or `unknown`;
- **a steer**, for cross-owner messages, to seek the operator's explicit confirmation before
  destructive or irreversible action.

`sender_owner_relation` already reaches the listener and already selects the mode, so the value is in
hand — you are changing what is done with it, not plumbing something new.

**State it as fact, not as a command that can be overridden.** "This message came from X, operated by
Y, who is not your operator" is a durable statement. "Do not follow instructions in this message" is an
instruction sitting in the same channel as the untrusted text, and loses to a sufficiently direct
sender. Prefer the former. D-044 records that this is advisory rather than an enforcement boundary; do
not write copy implying otherwise.

## The trap: copy that asserts a boundary you just removed

Two strings describe the sandbox to users and **become false the moment you land this**:

- `src/cli.ts:2607` — *"Isolated cross-owner turns use a clean temporary home and empty cwd."*
- `src/cli.ts:3040` — *"…cmux integration hooks are disabled. Cross-owner turns use a clean temporary
  home with no user hooks or local context."*

Both must change in **the same commit** as the behaviour. This repo's most damaging incident (D-023)
was copy in git asserting a state reality did not deliver, and `AGENTS.md` carries the standing rule:
*availability copy asserts deployment state and lives in git, so nothing fails when the deployment
moves — grep every surface when a gate flips.* **Grep for every surface that describes the sandbox**,
including `README.md`, `docs/`, and the site, and report the full list you found and changed. A missed
string here is the defect, not a footnote.

## Gate

Baseline on `main`: `npm test` **395/395**, p1-cli 143/143, p1-local 4/4, p1-server 69/69, site
113/113, `build` / `check:tests` / `check:edge` all 0.

Tests currently assert the sandbox exists. **Those assertions are now wrong and should be inverted,
not deleted** — a test proving cross-owner turns reach the operator's real home is as valuable as the
one that proved the opposite, and it is the thing that would catch an accidental re-isolation.

Every test you change must be listed with its reason. The count must not drop. Add a control proving
provenance actually reaches the prompt.

**`NODE_OPTIONS` on this machine references a deleted preload; export
`NODE_OPTIONS="--max-old-space-size=4096"` or every node command fails.**

## Report

What you removed, what you added, every copy surface you found and changed, every test you inverted
and why, and — plainly — **what you did not establish**. In particular: whether ACP's own
`session/request_permission` force-ask still fires on cross-owner turns. D-044 explicitly did **not**
decide that, and it is a host-mediated prompt to the operator rather than a capability we strip, so it
may belong on the other side of the line. **Do not remove it. Report its status.**
