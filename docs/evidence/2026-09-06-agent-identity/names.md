# Lane B — UUID UI and creation affordance

Worktree: `/private/tmp/cswarm-astra-identity-20260906-01a07471/names`
Branch: `lane/identity-names`
Lane file: this document.

This lane is not the whole identity feature. Session status UI is deferred. Server
protocol support for `allow_duplicate_name` is Lane A.

## Inventory (name-based lookup and stored identity)

### Site (this lane owns)

| Surface | Path | Before | After |
|---|---|---|---|
| Mention parser | `site/src/lib/mention-address.ts` | Name match; shared names refused | Same refusal; duplicate names selectable via `Name · <uuid-prefix>` label |
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

## Tests run

| Command | Exit | Result |
|---|---|---|
| `npx tsc --noEmit -p tsconfig.json` | 0 | accept-link types check |
| `cd site && npm run build` | 0 | 12 pages |
| `cd site && node --import tsx --test 'src/lib/*.test.mjs' <identity observers>` | 0 | 245 pass / 0 fail |
| `node --import tsx --test tests/p1-cli/accept-link.test.ts` | 0 | 24 pass / 0 fail |
| `cd site && node --import tsx --test src/components/app/composer-addressing.observer.test.ts src/components/app/dashboard-runtime.observer.test.ts` | 0 | 11 pass / 0 fail |

Full `cd site && npm test` was run once. Extra failures were provider-button and mobile
header checks that need `site/.env` / a deployment with OAuth. This worktree has no
`site/.env`. Those tests were not re-run as a gate. They are not identity tests.

Not run: `npm test` (root literal list), `test:p1-local`, `test:p1-server`, `db:*`,
`check:edge`. No Supabase slot.

## Integration

1. Land Lane A so `allow_duplicate_name` is a real command field.
2. Rebase this branch onto that SHA.
3. Keep site create-another and `acceptInviteLink({ allowDuplicateName: true })`.
4. Add the CLI flag in the client lane; do not default it on.
5. Do not add session status UI here.

## Gaps

- Server does not yet accept the flag in this worktree.
- CLI has no duplicate-name choice.
- Full `npm --prefix site test` depends on `site/.env`.
- No session status UI (out of scope).
- Same-OS-user token theft is out of the claimed protection.

## HEAD

Filled after commit.
