# Agent model self-identification — `declare_agent_model`

**2026-08-18.** Implements docs/design/2026-08-03-AGENT-SELF-IDENTIFY.md for the cloud: a
listener declares what it factually is — the provider its operator chose — over its own
credential, once, after ready. The app's owner-grouped rail then shows real model marks
without human input or backfills.

## Shape

- **Protocol**: command `declare_agent_model { model: string | null }` — agent credential
  only, and the subject is ALWAYS the presenting token's own principal (no target field,
  the renew_agent_token fence shape). Reducer trims, treats empty as null, and mirrors
  `agent_principals_model_bounded` (≤120 chars, no control chars) so an accepted event
  cannot fail projection. Event `AgentModelDeclared`; new rejection reasons
  `model_invalid`, `principal_not_presented`.
- **Edge**: wire validation beside renewal's (exactly `{kind, model}`), conversion, a
  scope-gate exemption with the same justification as token self-surrender (the reducer
  confines the command to the presenting principal; existing minted tokens can never carry
  a new scope), and a projection that updates exactly one unrevoked row.
- **CLI**: `listen start` passes a provider-derived label (`claude (claude-agent-acp
  0.64.2)`, `codex (codex-acp 1.1.9)`, `opencode`, `grok`) into the runtime, which declares
  once after the ready event, best-effort: a failure is a `listener_model_declared
  ok:false` event line, never a listener failure.

## What ran (this worktree, fresh `supabase db reset`)

| gate | result |
|---|---|
| `npm run build` + `build:command-core` + `check:edge` | clean |
| `npm test` | 543/543 (7 new reducer cases; the detached-CLI process tests now pin declare-once with the provider label, and the cursor-fallback fake server REFUSES the declaration to prove best-effort) |
| `npm run test:p1-cli` | 255/255 |
| `npm run check:tests` | clean |
| `npm run test:p1-server` | 82 tests, 80 pass — 5 new M-tests all pass; the 2 failures are the self-serve cap tests proven pre-existing in the S1+S2 lane |
| `npm run test:p1-local` | 4/4 |

Which script reaches each new test: the reducer cases live in
`tests/protocol-workspace.test.ts` (named in the `npm test` literal list); the declare-once
and best-effort pins live in `tests/listener-cli-process.test.ts` (same list);
`tests/p1-server/agent-model-declare.test.ts` is reached by the `test:p1-server` glob.

## Decisions where the brief left room

- **No new scope.** A `declare_agent_model` scope would be ceremony: the reducer already
  confines the command to the presenting principal, and already-minted tokens could never
  carry a new scope — the point is that TODAY'S listeners can declare. Same argument the
  gate already records for token self-surrender.
- **Static provider labels, no bridge-version probe.** `session.ts`'s initialize handling
  sends OUR clientInfo and does not retain the agent's; the pinned bridge versions the CLI
  itself instructs installing are the honest label. If the pins move, the labels move in
  the same file.
- **Humans refused** (`credential_kind_forbidden`): a human sets model at
  `create_agent_principal`; declaring by proxy would be a guess, which the design doc
  forbids.
- **The declaration failure swallow also swallows credential loss** — deliberately: a lost
  credential surfaces on the next read within seconds, and identity metadata must never
  take down receipt.

## NOT established

- No end-to-end run against production (S6-style deploy is the parent's call; the edge
  function change is committed but NOT deployed).
- The two pre-existing self-serve cap failures (out of scope, already on record).
- Whether any provider bridge exposes its underlying model id at initialize — if one ever
  does, the label could carry it; not probed here.
- CLI mint path still lacks a `--model` flag for `principal create` (out of scope; the web
  create already accepts model).

## Landing round (two-arm findings), all five fixed

1. **Wire-vs-reducer normalization** — the wire now trims and empty→nulls BEFORE validating,
   exactly as the reducer does; raw `""` is a clear (and, when already clear, an unchanged
   no-op), a padded value is measured trimmed. Pinned by M6/M7 on the HTTP path.
2. **C1 control range** — the reducer's class is now invite-link's (C0 + DEL + C1 + bidi),
   deliberately stricter than the DB's `[[:cntrl:]]`, which is the safe direction. Pinned by
   the U+0085 reducer case. (The wire's `boundedText` already covered C1.) A raw \x07 byte
   that an earlier edit left in the TEST SOURCE was replaced with `String.fromCharCode`.
3. **Fire-and-forget declaration** — the runtime no longer awaits the declare after ready:
   it is a detached best-effort task tied to the listener's stop signal, so a hanging
   request can neither delay first-page receipt nor block shutdown. Pinned by the
   cursor-fallback process test, whose fake server now NEVER ANSWERS the declaration while
   the listener must still receive, reply, and stop.
4. **Abuse guards** — an unchanged redeclaration (compared against the TABLE the projection
   targets, not folded stream state, because out-of-band backfills exist) is an accepted
   no-op with `unchanged: true` and NO event/audit/ledger/charge; changed values ride a
   per-principal 10/hour bucket on the file lane's pattern (keyed by principal — token ids
   rotate). Pinned by M8 (no-op), M9 (429 at the bound, no-ops still free while limited).
5. **No-target fence pinned** — M10 sends a raw request with an extra `principal_id` key:
   400 at the wire, both principals' rows byte-identical before and after.

Gates re-run after the fixes (fresh `supabase db reset`): build + bundle + check:edge
clean · `npm test` 543/543 · p1-cli 255/255 · check:tests clean · p1-server 87 tests,
85 pass (all 10 M-tests green; the 2 failures remain the pre-existing self-serve pair) ·
p1-local 4/4.
