# Colour-code agents and their responses

**Status:** SPECIFICATION, draft 1, branch `spec/app-backlog`. Backlog item 5 (chat plan L5 / P2). Authored by CSwarmStrategist (`2121f81d`), 2026-09-06, from a read-only code map (`docs/evidence/2026-09-06-app-specs-arms/maps/markdown-colour-model.md`, Spec D) and the adopted chat design `docs/design/2026-09-04-chat-platform-reconciled.md` (R8, P2).
**Authority:** none until adopted; the chat design's rulings R8 and P2 stand and this spec implements them.

## 0. The answer in one paragraph

Agents already get a colour: a hash of the principal id becomes a hue on the avatar (`markAgentAvatar`, `LiveDashboard.astro:2317-2326`), and nothing else. People get none, message text carries none, and the only feed filter is a client-side All/Broadcast/Direct toggle (`site/src/lib/signal-feed.ts:1-38`). The chat design already decided the shape (R8: "derived from the entity's durable id, fixed contrast-checked palette, extended to people… never the only signal"; P2: site only, no migration). This spec makes it buildable: one palette constant, one `markEntityColour` for agents and people, colour applied to the name, the rail entry, and the message's left edge, a filter that is a server-side query keyed by `?agent=`/`?person=`, and a test that strips every colour and proves nothing is lost.

## 1. Today, measured

| part | fact | source |
|---|---|---|
| agent hue | FNV-1a of `principalId` → `hash % 360` → CSS var `--avatar-hue`, class `dashboard__avatar--tinted`; called only for agents | `LiveDashboard.astro:2317-2326`; call sites `:2596`, `:4023`, `:5061` |
| where it shows | avatar in the entity panel, the roster row, the feed row, via `color-mix(in oklab, hsl(var(--avatar-hue) …))` | `:10581-10585`, `:10786-10788` |
| people | no colour anywhere | map, Spec D |
| name control | `entityControl(label, entity, className)` renders a `<strong>` with `data-entity-kind`/`data-entity-id`; click opens the entity panel, does not filter | `:2461-2474`; used `:5075`, `:5090`, `:5096`, `:5116`, `:5160` |
| filter | `SignalFilter = "all" \| "broadcast" \| "direct-to-you"`, client-side over loaded rows; the plan names this as the anti-pattern P2 must not repeat | `signal-feed.ts:1-38`; `LiveDashboard.astro:3625`; plan `:634-636` |
| plan | R8 (`:30`); P2 (`:624-639`): `markEntityColour`, `PALETTE[unsigned % PALETTE.length]`, a focusable avatar control, a filter bar with URL params, server-side filtering; `ENTITY_COLOUR_PALETTE` is named at `:836` but **does not exist in `site/src/`** | `2026-09-04-chat-platform-reconciled.md` |
| tests | plan asks for determinism golden vectors and a strip-colour-and-nothing-lost check (`:836`, `:865-867`); real-Chrome harness exists (`agent-row-geometry.observer.test.ts` and siblings) | map |

## 2. The design

### 2.1 The palette

`ENTITY_COLOUR_PALETTE` in `site/src/lib/entity-colour.ts`: **twelve** named OKLCH colours at fixed lightness and chroma (light theme: L 0.62, C 0.13; dark theme: L 0.75, C 0.11), hues spaced 30° apart starting at 20°. Twelve because more than twelve are not distinguishable at avatar size, and a workspace with more than twelve entities will share colours, which is why colour is never the only signal (R8). Each swatch is checked once, in a test, for ≥ 3:1 contrast against both themes' message background for the 2 px edge and the name text's **underline**, not for body text (colour is never used for body text).

The twelve, by index, as OKLCH `L C H` for light / dark: 0 `0.62 0.13 20` / `0.75 0.11 20` (rose); 1 `… 50` (orange); 2 `… 80` (amber); 3 `… 110` (lime); 4 `… 140` (green); 5 `… 170` (teal); 6 `… 200` (cyan); 7 `… 230` (sky); 8 `… 260` (blue); 9 `… 290` (violet); 10 `… 320` (purple); 11 `… 350` (pink), where `…` is the fixed L and C for that theme. They are defined once as CSS custom properties `--entity-colour-0` … `--entity-colour-11` under `:root` and the dark-theme block, and the TypeScript palette holds only the twelve names, so the colour values live in CSS and nowhere else.

`entityColour(entityId)`: FNV-1a (the existing hash, the function at `LiveDashboard.astro:2317-2326` moved into `entity-colour.ts` unchanged) modulo 12 → a palette index; deterministic, so an id has the same colour on every device and every session. **Golden vectors:** the lane computes the index for six fixed ids — `00000000-0000-4000-8000-000000000001` through `…006` — with the function once, pins the six results in `entity-colour.test.mjs` as literal expected indices, and hand-checks two of them against an independent FNV-1a implementation (a 20-line reference in the test itself), so the pin is a measured snapshot, not a claim this document types.

### 2.2 Where the colour goes

`markEntityColour(node, entity)` replaces `markAgentAvatar` and is called for agents **and people**; it sets `--entity-hue`/`--entity-colour` on the node and a `data-entity-colour="<index>"` attribute (so tests and screen-reader tooling can see it as data, not paint). Applied to:

1. the avatar (as today, both kinds);
2. the author name in the message header: the name keeps its text colour and gains a 2 px underline in the entity colour;
3. the message's left edge: a 3 px border in the entity colour on `.dashboard__message` (this is "their responses": every message an entity wrote carries its colour at the edge, so a busy channel reads as bands);
4. the rail entry (roster row): the same avatar plus a 3 px left border.

Never: body text, backgrounds, or badges. The PERSON/AGENT badge and the name text stay as they are, so a reader who cannot see colour loses nothing (R8, "never the only signal").

### 2.3 Click to filter, server-side

The avatar becomes a real `<button>` (today it is `aria-hidden`), labelled `Filter by <name>`. Clicking it, or the name control's new secondary action (a small "filter" glyph after the name, so the name itself still opens the entity panel), sets the URL to `?agent=<principal_id>` or `?person=<user_id>` and reloads the feed **from the server** with that filter: the read edge's signals resource already accepts sender-scoped queries for `inbox`; P2's filter is one more predicate on the workspace stream read (`supabase/functions/read/index.ts`, the signals branch), and the site passes it through `readWorkspaceSignals`. **The wire contract:** the read body gains two optional fields, `author_agent_principal_id` (uuid) and `author_user_id` (uuid); at most one may be present (both → 400 `malformed`, the parser's existing shape); the predicate is `s.author_agent_principal_id = $1` or `s.author_user_id = $1` on the same query the unfiltered feed uses, so paging, `since`, and the existing kind filters compose unchanged. The URL carries `?agent=<uuid>` or `?person=<uuid>`, mapped one-to-one onto those two fields; if both appear in a URL the site keeps the first and drops the second. L2 runs `EXPLAIN` on the filtered query against the local stack with a synthetic 50,000-signal workspace; if the plan is a sequential scan, L2 adds `signals_workspace_author_agent (workspace_id, author_agent_principal_id, created_at DESC)` and its user twin in the same migration, else no index. **Navigation:** in place — `history.pushState` updates the URL and the feed refetches from the server with the new field; the feed's scroll anchoring (`LiveDashboard.astro:4919-`) resets to the top for a filter change. **Empty state:** the feed shows `No signals from <name> yet` with the chip still visible, so the filter is obviously the cause. A filter bar above the feed shows the active entity as a chip with its colour and a `×`; the state is in the URL, so it survives reload and can be shared. The existing All/Broadcast/Direct toggle is unchanged and composes with it.

Why server-side: the client-side toggle filters the ~25 loaded rows and is exactly the anti-pattern the plan names; a per-entity filter over a long history must page from the server or it lies.

### 2.4 Accessibility

`data-entity-colour` and the badge carry the identity for assistive tech; the filter button has a text label; the chip announces "Filtering by <name>"; contrast checks are tests, not opinions.

## 3. Acceptance

- Two agents and two people in a fixture workspace each show a stable colour on avatar, name underline, message edge, and rail entry, identical across reloads and identical to the golden vectors.
- Removing every colour rule (a mutation control: `--entity-colour: transparent` everywhere) leaves every name, badge, and filter state readable and the tests that assert identity by `data-entity-colour` still passing — nothing is lost.
- Clicking an agent's avatar sets `?agent=<id>`, the feed shows only that agent's signals, the network request carries the filter (asserted), the chip shows the colour and name, `×` clears it.
- Contrast test passes for all twelve swatches in both themes.

## 4. Lanes

| lane | branch | author | files | tests | after |
|---|---|---|---|---|---|
| **L1** palette and marking | `lane/entity-colour` | Gemini | new `site/src/lib/entity-colour.ts` (+ `.test.mjs`), `LiveDashboard.astro` (`markEntityColour`, call sites `:2596`, `:4023`, `:5061`, name underline, message edge, rail edge), CSS block at `:10581-10585`, `:10786-10788` | golden vectors; contrast; strip-colour control; `agent-row-geometry.observer.test.ts` extended | — |
| **L2** server filter | `lane/entity-filter-read` | Grok | `supabase/functions/read/index.ts` signals branch (author predicates), `src/cloud/signals.ts` (request field), `tests/p1-server/signals-author-filter.test.ts` (glob-reached, no gate edit) | filter by agent, by person, by neither; a foreign workspace id returns nothing | — (holds the local database) |
| **L3** filter UI | `lane/entity-filter-ui` | Gemini | `LiveDashboard.astro` (avatar button, name glyph, filter bar, URL params), `site/src/lib/signal-feed.ts` (compose with the existing toggle), observer test | click → URL → server request → chip; `×` clears; reload keeps | L1, L2 |

Order: L1 ∥ L2 → L3. Site deploys after L2's edge is deployed. No migration.

## 5. What was NOT established

- Whether twelve is the right palette size for the operator's eye; it is the standard bound for categorical colour and is easy to change in one constant.
- The exact read-edge signals branch lines for the author predicate; the map located the resource (`read/index.ts:652-672` is the files branch; the signals branch is above it) and L2 cites the lines it changes.
- Whether the name control should filter on plain click (the plan's wording) or keep opening the panel; this spec keeps the panel on the name and puts the filter on the avatar and a glyph, because the panel is the older, more used affordance. The lead may swap them; it is one line.
