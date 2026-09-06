# Colour-code agents and their responses

**Status:** SPECIFICATION, draft 2 (Gemini and Grok round-1 findings folded; the filter path changed), branch `spec/app-backlog`. Backlog item 5 (chat plan L5 / P2). Authored by CSwarmStrategist (`2121f81d`), 2026-09-06, from a read-only code map (`docs/evidence/2026-09-06-app-specs-arms/maps/markdown-colour-model.md`, Spec D) and the adopted chat design `docs/design/2026-09-04-chat-platform-reconciled.md` (R8, P2).
**Authority:** none until adopted; the chat design's rulings R8 and P2 stand and this spec implements them.

## 0. The answer in one paragraph

Agents already get a colour: a hash of the principal id becomes a hue on the avatar (`markAgentAvatar`, `LiveDashboard.astro:2317-2326`), and nothing else. People get none and message text carries none. The feed already has one **server-side** filter, the channel predicate on the PostgREST page query (`signalPage`, `:2272-2304`, `.eq("channel_id", …)` at `:2286`), and one client-side toggle over the loaded rows (All/Broadcast/Direct, `site/src/lib/signal-feed.ts:1-41`, applied at `:5003`), which the plan names as the pattern not to repeat (P2, `:634-636`). The chat design decided the shape (R8: "derived from the entity's durable id, fixed contrast-checked palette, extended to people… never the only signal"; P2: site only, no migration). This spec makes it buildable: one palette in `tokens.css`, one `markEntityColour` for agents and people at every call site, colour on the name underline, the message's left edge, and the rail entry, a per-entity filter that is **one more predicate on the same PostgREST query the channel filter uses**, carried in the URL beside `?w=` and `?c=`, and a test that strips every colour and proves nothing is lost. No edge-function change, no migration.

## 1. Today, measured

| part | fact | source |
|---|---|---|
| agent hue | FNV-1a of `principalId` → `hash % 360` → CSS var `--avatar-hue`, class `dashboard__avatar--tinted`; called only for agents | `LiveDashboard.astro:2317-2326`; live call sites `:2596` (entity panel), `:3614` (mention picker), `:3969` (header stack), `:4023` (dialog roster), `:5062` (feed row; `:5061` is its `aria-hidden`) |
| where it shows | avatar via `color-mix(in oklab, hsl(var(--avatar-hue) …))` | `:10581-10585`, `:10786-10788` |
| people | no colour anywhere: panel person branch `:2647-2651`; rail `dashboard__sidebar-person-avatar` with no tint (`site/src/lib/participant-rail.ts:128-136`); feed `if (authorAgent)` | map, Grok arm |
| the rail | `renderSidebarParticipants` in `participant-rail.ts` (called from `:3909`); agents there show a model glyph, not an avatar (`:89-116`) | `participant-rail.ts` |
| name control | `entityControl(label, entity, className)` returns an `HTMLButtonElement` with `data-entity-kind`/`data-entity-id` (`:2461-2474`); the feed wraps it in a `<strong>` (`:5068-5079`); click opens the entity panel; also used at `:2618`, `:2667`, `:5075`, `:5090`, `:5096`, `:5116`, `:5160` | `LiveDashboard.astro` |
| `EntityRef` | `{ kind: "agent" \| "person"; id: string }` | `:1364-1366` |
| feed query | `signalPage` reads `swarm_read.signals` through PostgREST with the member's JWT, `SIGNAL_PAGE_SIZE = 25` (`:1685`), `.eq("channel_id", channelId)` when a channel is open (`:2286`, comment `:2264-2270`); the same view the CLI reads (`site/src/lib/commonswarm.ts:2261-2278`) | `:2272-2304` |
| sender columns | table `from_principal`, `from_kind` (`20260724000003_signals.sql:6-7`); view exposes `from_principal AS "from"` and `from_kind` (`:49-50`); a person's `from` is the user id, an agent's is the principal id | migration |
| URL grammar | `?w=<workspace>` and `?c=<channel>` written by `syncChannelUrl` with `replaceState` (`:6678-6690`) | `LiveDashboard.astro` |
| empty states | server-empty page hits the channel/waiting copy at `:4974-4984`; the client-filter empty is `:5008-5013` | `LiveDashboard.astro` |
| fresh-row edge | `.dashboard__message--fresh` sets `border-inline-start: 2px` and animates it to transparent, `fill-mode: both` (`:12805-12820`) | `LiveDashboard.astro` |
| message backdrop | `.dashboard__message` background is `var(--message-row-background)`, default `transparent` (`:12773-12787`) | `LiveDashboard.astro` |
| tokens | `site/src/styles/tokens.css`: `:root` at `:53`; **two** dark maps at `:507` and `:559` that must stay identical | `tokens.css` |
| tests pinning old names | `access-lifecycle.observer.test.ts:119-120`, `header-roster.observer.test.ts:100-101`, `composer.observer.test.ts:247` pin `markAgentAvatar` / `--avatar-hue` | `site/src/components/app/` |
| plan | R8 (`:30`); P2 (`:624-639`); `ENTITY_COLOUR_PALETTE` named at `:836` but absent from `site/src/`; tests asked at `:836`, `:865-867` | `2026-09-04-chat-platform-reconciled.md` |

## 2. The design

### 2.1 The palette

Twelve OKLCH colours at fixed lightness and chroma (light theme: L 0.62, C 0.13; dark: L 0.75, C 0.11), hues 20° + 30n for n = 0..11 (rose, orange, amber, lime, green, teal, cyan, sky, blue, violet, purple, pink). Twelve because more are not distinguishable at avatar size; a workspace with more than twelve entities shares colours, which is why colour is never the only signal (R8). They live **once as CSS custom properties** `--entity-colour-0` … `--entity-colour-11` in `site/src/styles/tokens.css`: under `:root` (`:53`) with the light values, and in **both** dark maps (`:507` and `:559`, which the lane keeps identical) with the dark values. `site/src/lib/entity-colour.ts` exports `ENTITY_COLOUR_PALETTE`, the twelve names in index order, and `entityColourVar(index) = \`var(--entity-colour-${index})\``; no colour value is typed in TypeScript.

`entityColourIndex(entityId)`: FNV-1a, the existing function at `LiveDashboard.astro:2317-2326` moved into `entity-colour.ts` unchanged, `>>> 0` then `% 12`; deterministic, so an id has the same colour on every device and session. **Golden vectors:** the lane computes the index for six fixed ids, `00000000-0000-4000-8000-000000000001` through `…006`, pins the six results in `entity-colour.test.mjs` as literal expected indices, and hand-checks two of them against an independent 20-line FNV-1a in the test itself, so the pin is a measured snapshot.

**Contrast** is a real-Chrome measurement, not a token claim: for each swatch and theme the test reads the computed background of the nearest opaque ancestor of a `.dashboard__message` (the row itself defaults to transparent) and asserts ≥ 3:1 for the 2 px name underline and the 3 px edge. Body text never takes the colour, so no text-contrast rule applies.

### 2.2 Where the colour goes

`markEntityColour(node: HTMLElement, entity: EntityRef)` **replaces** `markAgentAvatar` at all five live call sites (`:2596`, `:3614`, `:3969`, `:4023`, `:5062`) and is called for people too; it sets `--entity-colour` to `entityColourVar(index)` on the node and `data-entity-colour="<index>"` (so tests and assistive tooling see it as data). The three tests that pin the old names (§1) are rewritten to the new name and variable in the same lane. Applied to:

1. the avatar, both kinds (the `color-mix` rules at `:10581-10585`, `:10786-10788` read `--entity-colour` instead of `--avatar-hue`);
2. the author name in the message header: the `<strong>` wrapper (`:5068-5079`) gets a 2 px underline in the entity colour; the text colour is unchanged;
3. the message's left edge: a 3 px `border-inline-start` in the entity colour on `.dashboard__message`. **The fresh-row animation** (`:12805-12820`) animates the same property to transparent, so it is changed to animate `box-shadow` (an inset 2 px highlight) instead, and the border stays the entity colour; the lane's observer asserts a fresh row keeps its edge colour after the animation ends;
4. the rail entry: `participant-rail.ts` gets the same 3 px left border and, for people, the avatar tint (`:128-136`); an agent's model glyph (`:89-116`) keeps its shape and gets the border only.

Never: body text, backgrounds, or badges. The PERSON/AGENT badge and the name text stay as they are, so a reader who cannot see colour loses nothing (R8).

### 2.3 Click to filter, on the query the feed already runs

The avatar becomes a real `<button>` (today `aria-hidden` at `:2573`, `:3613`, `:4022`, `:5061`), labelled `Filter by <name>`; the name control keeps opening the entity panel (§5). Clicking the avatar sets the entity filter and reloads the page **from the server**: `signalPage` (`:2272-2304`) gains one predicate, `.eq("from", entity.id)`, beside the channel predicate at `:2286`, on the same `swarm_read.signals` view; paging, `since`, and the channel filter compose unchanged because it is the same query. No edge function, no new request shape, no migration: the view already exposes `from` and `from_kind`, and RLS already scopes the view to the member's workspaces.

**URL:** `syncChannelUrl` (`:6678-6690`) gains a third parameter, `?e=<kind>:<id>` (`agent:<uuid>` or `person:<uuid>`), written with the same `replaceState` and read on load beside `?w=` and `?c=`; one entity at most, a malformed value is ignored. Sharing the URL shares the filter.

**Empty state:** the server-empty branch at `:4974-4984` checks the entity filter first and shows `No signals from <name> in this channel yet` with the chip still visible, so the filter is obviously the cause. **Filter bar:** a chip above the feed with the entity's colour, name, and a `×` that clears `?e=` and refetches. The client-side All/Broadcast/Direct toggle (`signal-feed.ts`) is untouched and composes on top of the loaded page, as it does today with the channel filter; nothing about the entity filter lives in that module (it already refuses channel logic, `:98-105`).

**Cost:** one PostgREST page per filter change, the same as opening a channel. The query is bounded by the workspace/channel index the page already uses and returns at most 25 rows; no new index in this spec. If a measured workspace makes the filtered page slow, an index on `swarm.signals (workspace_id, from_principal, created_at desc)` is a one-line migration lane of its own, outside P2.

### 2.4 Accessibility

`data-entity-colour` and the badge carry the identity for assistive tech; the filter button has a text label; the chip announces "Filtering by <name>"; contrast checks are measurements, not opinions.

## 3. Acceptance

- Two agents and two people in a fixture workspace each show a stable colour on avatar, name underline, message edge, and rail entry, identical across reloads and identical to the golden vectors.
- Removing every colour rule (a mutation control: `--entity-colour: transparent` everywhere) leaves every name, badge, and filter state readable, and the tests that assert identity by `data-entity-colour` still pass: nothing is lost.
- A fresh row keeps its entity-colour edge after the fresh animation ends.
- Clicking an agent's avatar sets `?e=agent:<id>`, the PostgREST request carries `from=eq.<id>` (asserted on the request), the feed shows only that agent's signals, the chip shows the colour and name, `×` clears it, reload keeps it.
- Contrast passes for all twelve swatches in both themes against the measured backdrop.

## 4. Lanes

| lane | branch | author | files | tests | after |
|---|---|---|---|---|---|
| **L1** palette and marking | `lane/entity-colour` | Gemini | new `site/src/lib/entity-colour.ts` (+ `.test.mjs`, reached by the `site/package.json:11` glob), `site/src/styles/tokens.css` (`:root` and both dark maps), `LiveDashboard.astro` (`markEntityColour` at the five call sites, name underline, message edge, the fresh animation on `box-shadow`, CSS at `:10581-10585`, `:10786-10788`), `site/src/lib/participant-rail.ts` (rail border and person tint), the three tests that pin the old names | golden vectors; contrast measurement; strip-colour control; fresh-row edge; rail geometry extended in `agent-row-geometry.observer.test.ts` | — |
| **L2** filter | `lane/entity-filter` | Gemini | `LiveDashboard.astro` (`signalPage` predicate, `syncChannelUrl` third parameter and its reader, avatar button, filter bar, empty branch at `:4974-4984`), a new observer case in an existing feed observer test | click → URL → request predicate → chip; `×` clears; reload keeps; a person filter and an agent filter; the channel + entity + toggle composition | L1 |

Order: L1 → L2; both touch `LiveDashboard.astro`, never at once. No edge change, no migration. **Shared files across specs:** `LiveDashboard.astro` is also touched by `lane/long-messages`, `lane/markdown-wordwrap-qa`, `lane/brain-toc`, and `lane/agent-model-rows`; CSwarmDevLead serialises them.

## 5. What was NOT established

- Whether twelve is the right palette size for the operator's eye; it is easy to change in one constant and twelve CSS lines.
- Whether the name control should filter on plain click (the plan's wording) or keep opening the panel; this spec keeps the panel on the name and puts the filter on the avatar, because the panel is the older, more used affordance; R9's panel "Show only …" entry is where a second entry point would go, and the lead may add it in L2 as one line.
- The filtered query's plan at scale; today's workspaces are small and the page is 25 rows, so no index is added until one is measured slow.
