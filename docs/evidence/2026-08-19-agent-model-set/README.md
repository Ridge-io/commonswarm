# set_agent_model — the human-editable agent model field

**2026-08-19, worktree lane.** The mirror of `declare_agent_model`: an agent may only
describe itself; a person may relabel agents in their workspace from the manage dialog.
Together they close the operator directive — model family icons fill automatically
(listeners self-declare since v0.1.21) and a person can correct or set the label by hand.

## What was built

- **Protocol** (`workspace-commands.ts`, `workspace-events.ts`): command
  `set_agent_model { principal_id, model }`, HUMAN-only via HUMAN_ONLY_COMMANDS. The
  authorization matches `revoke_agent_principal`'s convention exactly — owner/admin may
  relabel any principal in the workspace, a plain member only their own — because model
  editing is agent management and a second convention would be a trap. Normalization is a
  SHARED helper (`normalizedModel`) used by both commands, so the agent path and the human
  path cannot drift; `declare_agent_model` was refactored onto it with no behavior change
  (its seven reducer tests unchanged-green). The event stays `AgentModelDeclared`: the
  envelope's `actor_user`/`actor_agent_principal` already distinguish a human set (user,
  null principal) from a self-declaration (agent principal set) — a sibling event would
  duplicate the payload to restate what the envelope carries. The event's doc comment now
  says both writers exist.
- **Edge** (`command/index.ts`): wire validation (exact keys, UUID principal,
  normalize-before-validate in declare's landing-round order), conversion arm, and the same
  two pre-reducer guards as declare: unchanged sets are accepted no-ops appending nothing
  (`unchanged: true`), changed values ride the shared 10/hour bucket — keyed by the HUMAN
  user id, since that is the acting identity. Projection is untouched: the compound-keyed
  `AgentModelDeclared` UPDATE already serves both writers.
- **Web** (`LiveDashboard.astro`, `lib/agent-model-editor.ts`, `lib/commonswarm.ts`): an
  "Edit model" affordance on each manage-dialog row, shown under the same gate as Remove.
  The editor itself is an extracted, importable builder so the observer drives the REAL
  code (the hand-written-markup method is refuted in this repo); values reach the DOM only
  as element properties. Save issues `setAgentModel` with the human session and re-opens
  the workspace — the same one-authority refresh path removal uses — so the rail glyph
  updates without a reload. Empty clears to the neutral glyph.

## Gates (this worktree, committed tree)

- `npm test` **548/548** (5 new set_agent_model reducer suites, incl. envelope attribution)
- `test:p1-cli` **272/272** (after `npm run build` — the dist-staleness trap fired once
  more, exactly as S3's evidence recorded)
- `check:tests` clean · `check:edge` clean (bundle regenerated)
- `test:p1-server` **90/92** on a fresh reset — S1–S5 green (owner relabels a member's
  agent with human audit attribution; member refused on another's, allowed on own; agent
  token 403 on this kind; unchanged no-op appends zero events; empty clears and the wire
  refuses 121 chars). The two failures are the pre-existing self-serve pair.
- Site build clean, site suite **167/167**.
- **Mutations, both directions**: the editor observer fails (0/1) when the builder
  interpolates the value through innerHTML (the hostile `<img onerror>` parses and the
  value pin breaks), passes (1/1) restored.

## Instrument note

One full p1-server run showed S1–S5 all failing while the standalone file passed 5/5; the
next full sequential run passed 90/92. The failing run overlapped a still-dying
`functions serve` from a previous invocation on the same port — my own contamination, not
the product. Recorded because a first-run red that vanishes must be explained, not called
transient.

## Not established

- No production deploy from this lane (edge change committed, not deployed — the parent
  ships it).
- The dialog flow was exercised through the real builder and real command tests, but not
  as a signed-in click-through against a served dashboard.
- Whether `unchanged: true` should surface in the dialog copy (currently silent success).
