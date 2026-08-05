# /goal — remove the Model field from Add-an-agent

Operator, 2026-08-04: *"Get rid of the model picker on this step. The model should be auto-set by the
agent that joins (it should self-identify)."*

**This was already decided on 2026-08-03** and never built —
`docs/design/2026-08-03-AGENT-SELF-IDENTIFY.md`, from the operator's instruction that *"all the user
really needs to specify, if they want, is a name."* This packet does the **UI half**, which ships
tonight. The CLI half is separate and is not required for it.

## Why the UI half is safe on its own — measured

`model` is **already optional end to end**, so removing the input changes no contract:

- CLI: `args.optional("model")` — never required.
- Server: accepts `model` as an optional key.
- Schema: `agent_principals.model` is **nullable**.
- UI: already renders `Model not specified` when null (`LiveDashboard.astro`, and
  `AgentConnect.astro:429`).

Nothing breaks when the field stops being supplied. It becomes null, and every surface already has an
honest default for null.

## Build

In `site/src/components/connect/AgentConnect.astro`:

- **Remove the Model field** — the wrap at `:102`, its label `:103`, the input `:106-112`, the
  `<datalist id="ac-models">` at `:115`, and the hint at `:122`.
- **Remove the show/hide logic** that toggles it for existing agents (`:441-445`) along with it.
- **Fix the subtitle at `:56`** — *"Add the name and model collaborators will see in the feed."* It
  names a field that will not exist. Name only what is asked for.
- Keep `agent.model ?? "Model not specified"` at `:429` and everywhere else. The value still arrives
  from the CLI when supplied; you are removing the **prompt**, not the field.

## The consequence to state, not hide

Until the CLI half lands, **every agent created through the web UI will read `Model not specified`.**

That is the intended outcome, and `AGENT-SELF-IDENTIFY.md` explains why: a roster saying *"Model not
specified"* is honest, and a roster confidently showing the **wrong** model — because a value was
guessed or inherited — is worse than a blank and will be believed. Do not add a placeholder, a default
like `"unknown model"`, or an inferred guess to fill the gap.

## Also on this screen, while you are here

The credential warning — *"The key appears once, on this screen. It is not stored here and cannot be
shown again…"* — renders on the **naming** step, before any key exists. It warns about something that
has not happened yet, which trains people to skim exactly the warning that later matters. Move it to
the step where the key is actually shown, or say clearly in your report why it must stay.

## Out of scope

The CLI's self-identification (`detectHost()`-style host detection). `--model` remains available as an
explicit override — it stops being something anyone is *prompted* for, which is the whole point.

## Tests

Four files reference the model field: `access-lifecycle.observer.test.ts`,
`entity-panel.observer.test.ts`, `header-roster.observer.test.ts`,
`connect/agent-prompt.observer.test.ts`.

Assertions about **rendering a model that exists** stay — that path is unchanged. Assertions that the
**input exists** are now wrong: invert them to assert the field is absent, so the picker cannot
silently return. List every test you touched and which category it fell into.

## Gate

Baseline from the tree you start on; state it. Count must not drop.

`NODE_OPTIONS` here references a deleted preload; export `NODE_OPTIONS="--max-old-space-size=4096"`.

## Report

Diff scope, before/after counts, the tests you inverted, your decision on the premature key warning,
and plainly what you did not establish.
