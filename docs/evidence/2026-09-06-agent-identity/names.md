# Lane B — UUID UI and creation affordance

Worktree: `/private/tmp/cswarm-astra-identity-20260906-01a07471/names-r2`
Branch: `lane/identity-names-r2`
Lane file: this document.

This lane is not the whole identity feature. Session status UI is deferred. Server
protocol support for `allow_duplicate_name` is Lane A.

## Inventory (name-based lookup and stored identity)

### Site (this lane owns)

| Surface | Path | Before | After |
|---|---|---|---|
| Mention parser | `site/src/lib/mention-address.ts` | Name match; shared names refused | Same refusal; duplicate names selectable via `Name · <uuid-prefix>` label. Generated labels are unique across every raw name and every other generated label. A tag that still matches two records is refused. |
| Mention picker | `LiveDashboard.astro` `renderMentionPicker` / `selectMention` | Option id was list index; insert used display name | Option id is `kind`+principal/user UUID; insert uses `identityDisplayLabel` |
| To: chips | `LiveDashboard.astro` `renderComposerTo` | `data-composer-to-chip` = `kind:id` already | Label is disambiguated; key still UUID |
| Draft | `commonswarm:composer-draft:<user>:<workspace>:all-signals` | `{ body, to:[{kind,id}], applied }` | Same UUID `to`; old `{name}` or name-in-`id` resolves only if unique |
| Last-sent To: | `commonswarm:composer-to:<user>:<workspace>` | `[{kind,id}]` | Same; non-UUID roster ids still restore by id; name-only ambiguous is dropped with notice |
| Feed target / author | `LiveDashboard.astro` `buildMessageRow` | Raw `agent.name` | `identityDisplayLabel` from UUID |
| Header dialog roster | `renderDialogRoster` | `data-agent-row = principalId`; label was raw name | UUID key kept; duplicate names get suffix |
| Entity panel open | `data-entity-id` | UUID already | Unchanged |
| Participant rail | `site/src/lib/participant-rail.ts` | Raw `agent.name` | Duplicate names get UUID suffix |
| AgentConnect select | `AgentConnect.astro` `#fillIdentities` | `option.value = principalId` | Same; duplicate labels get UUID suffix |
| AgentConnect create | `site/src/lib/agent-connect.ts` | `{ kind: "create_agent_principal", name }` | Flag omitted unless explicit create-another |
| Create-another control | `AgentConnect.astro` `data-action="create-another"` | None | Shown only after `principal_name_taken`; sends `allow_duplicate_name: true` |

### Not owned (inventory only)

| Surface | Path | Behaviour at this SHA |
|---|---|---|
| CLI `--to` | `src/cloud/signals.ts` `resolveSignalRecipient` | UUID first; unique name; ambiguous names refused with ids |
| CLI principal create | `src/cli.ts` | No `allow_duplicate_name` flag |
| Accept CLI | `src/cli.ts` accept path | Calls `acceptInviteLink` with no `allowDuplicateName` |
| Protocol command | `src/cloud/command-client.ts` `ConnectCommand` | `{ kind: "create_agent_principal"; name; model? }` — no flag type |
| Protocol decider | `src/protocol/workspace-commands.ts` | Unique-name refusal; no `allow_duplicate_name` |
| Prompt identity | `src/listener/engine.ts` `buildListenerPrompt` | Sender provenance; no recipient UUID |

## Wire the client now sends

Default create (synthetic):

```json
{ "kind": "create_agent_principal", "name": "echo" }
```

Explicit create-another only:

```json
{ "kind": "create_agent_principal", "name": "echo", "allow_duplicate_name": true }
```

The field name is `ALLOW_DUPLICATE_NAME_FIELD` in `site/src/lib/identity-label.ts`. It is
never sent as `false`. Lost-response retry reuses the caller command id; it does not mint a
new principal.

`src/cloud/accept-link.ts` sends the same extra field only when
`AcceptLinkOptions.allowDuplicateName === true`. Default accept still suffixes auto names
and still refuses an explicit taken name.

## Server dependency (Lane A)

This worktree does not edit `src/protocol/` or `supabase/`. Until Lane A lands:

- The edge may reject an unknown `allow_duplicate_name` key, or ignore it and still return
  `principal_name_taken`.
- The UI still offers create-another. The button is honest about the request, not about
  server acceptance.
- Tests stub `fetch`. They do not prove the server accepted a duplicate principal.

Needed client change after Lane A: none on the JSON shape if the field name stays
`allow_duplicate_name: true`. If Lane A exports the field from `session-wire.ts` or
`ConnectCommand`, replace the type assertion in `cloudAcceptOperations.createPrincipal`.

## CLI seam (later client lane)

Do not infer duplicate create. `cswarm accept` and `cswarm principal create` have no
caller choice today. A later CLI flag should pass `allowDuplicateName: true` into
`acceptInviteLink` / the create command. This lane does not add that flag.

## Round 2 — generated labels vs raw names

Codex gpt-5.6-sol DEFECT: `identityDisplayLabel` suffixed only among duplicate raw
names. It never checked a generated label against every other record's raw name.
Measured: two distinct records both rendered as `Echo · 11111111` (one raw name was
literally that string). A UUID-backed picker choice could then route to the other
principal through `selectMention` and the mention parser.

Fix in `site/src/lib/identity-label.ts`: assign labels for the whole roster. Unique
raw names stay bare. Shared names get a UUID suffix that is unique across **all raw
names and all generated labels**. On collision the prefix grows by one character,
then the full UUID.

Fix in `site/src/lib/mention-address.ts`: collect every longest match at a tag
(label and raw name). Refuse when more than one record matches, or when a name-only
tag is a shared name (existing rule).

Tests:

- Arm case: raw name equal to another record's generated `Echo · 11111111`
- Three-way collisions (8-char and 9-char forms taken; generated uses 10 chars)
- Full UUID when every shorter prefix is taken
- Parser refuses a hand-built colliding label
- Observer control: picker option id is `kind`+UUID of the record clicked

## Tests run (round 2)

| Command | Exit | Result |
|---|---|---|
| `cd site && npm run build` | 0 | 12 pages |
| `cd site && npm test` | 0 | 548 tests / 547 pass / 0 fail / 1 skip (`baseline audit prints common rendered geometry`) |

Real Chrome ran (`Slack-shaped composer geometry stays aligned in real Chrome`,
`real Chrome keeps composer mechanics and their four required controls`).
`site/.env` is present.

Not run: root `npm test`, `test:p1-local`, `test:p1-server`, `db:*`, `check:edge`.
No `cswarm` command. No network. No push.

## Integration

1. Land Lane A so `allow_duplicate_name` is a real command field.
2. Rebase this branch onto that SHA.
3. Keep site create-another and `acceptInviteLink({ allowDuplicateName: true })`.
4. Add the CLI flag in the client lane; do not default it on.
5. Do not add session status UI here.

## Gaps

- Server does not yet accept the flag in this worktree.
- CLI has no duplicate-name choice.
- No session status UI (out of scope).
- Same-OS-user token theft is out of the claimed protection.

## HEAD

Round 1: `c4b5f7d` on `lane/identity-names`.
Round 2 fix: `c5d6cdd368b7a51a606edd9ac237a482a68d5efe` on `lane/identity-names-r2` (site labels + mention parser + tests), parent `d141c1e`. This file's HEAD line lives on the same branch.
