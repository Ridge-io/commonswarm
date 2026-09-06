# Brain wiki: hierarchy, index pages, backlinks, without new storage

**Status:** SPECIFICATION, draft 1, branch `spec/app-backlog`. Backlog item 7 ("brain upgrade, Karpathy-wiki style: navigable structure and hierarchy"). Authored by CSwarmStrategist (`2121f81d`), 2026-09-06, from a read-only code map (`docs/evidence/2026-09-06-app-specs-arms/maps/brain.md`) and the brain topic `knowledgebase-design` (CSwarmDevLead, 2026-09-01).
**Authority:** none until adopted; CSwarmDevLead PMs the lanes. This is navigation work for what a reader already has; it precedes roadmap H2 (`docs/org/2026-09-04-ROADMAP-DRAFT.md`, whose H2 slices are search, transcript banking, and a retention quota) and is not one of H2's slices.
**Draft 2** folds the Opus arm's findings on `fa44311` (a 500-name cap exists; every body download is a command that writes two ledger rows; a raw-body extraction is not the linkifier's rule; anchors would open the sanitizer; an on-disk cache outlives revocation). The mechanism changed accordingly; the goal did not.

## 0. The answer in one paragraph

The brain is 43 flat topics today, listed alphabetically, opened one at a time, with links only *from* a message *to* a topic. A wiki adds three things a reader uses to navigate: **a tree**, **index pages**, and **what links here**. All three can be built on what exists: a topic is a file named `brain--<topic>.md` (`src/cloud/brain.ts:1-8`; `20260818000001_file_artifacts.sql`), the list call returns names and versions but never bodies (`read/index.ts:652-672`), and the site already validates topic mentions against the live list (`site/src/lib/brain-links.ts`). So: hierarchy is a **naming convention** (`area.topic`, using the dot the name grammar already allows), index pages are **views generated from the list**, backlinks are **computed from bodies the site already downloads, cached by version**, and the per-topic table of contents comes from the headings the renderer already parses. No migration, no new table, no new command kind. The one new CLI verb, `cswarm brain tree`, is a view too.

## 1. Today, measured

| part | fact | source |
|---|---|---|
| storage | a topic is a `swarm.files` row named `brain--<topic>.md` with content in `swarm.file_versions`; rolling window of 20 live versions, retired kept | `src/cloud/brain.ts:1-8`; `src/protocol/brain-version-window.ts:14`, `:82-103`; `20260902000005_brain_version_window.sql` |
| names | `BRAIN_TOPIC_RE = /^[a-z0-9][a-z0-9._-]*$/`, max 245 chars; `/` is refused (files reject it); a dot is legal inside a name (`release_notes.v2` is one flat topic) | `src/cloud/brain.ts:21,34-46`; `brain-version-window.ts:16`; `tests/brain-namespace.test.ts:31,37` |
| hierarchy | none; every list is a flat alphabetical sort | `brain.ts:116-124`; `site/src/lib/brain-view.ts:57-68` |
| list shape | names, versions, counts, sizes; **no bodies**; no dedicated brain resource (topics are filtered client-side from `resource: "files"`) | `read/index.ts:656-665`; `src/cloud/files.ts:156-172` |
| reading | CLI `brain ls|get|put` (`src/cli.ts:7285-7443`); site Brain panel: flat list, Markdown render, raw toggle, version history, edit bound to file id | `LiveDashboard.astro:695-748`; `brain-view.ts:75-278` |
| links | a mention of an existing topic becomes a control; slug topics link anywhere, bare-word topics only in a code span; no `[[topic]]`, rejected by design; **no backlinks, no index page** | `brain-links.ts:5-40`, `:130-139`; `docs/design/2026-09-04-BRAIN-LINKS-IN-SIGNALS.md:24-30`; `AGENTS.md:274-295` |
| digest | the listener injects "N topics; NEW/UPDATED since your last check" from a per-principal version map, never bodies | `src/listener/brain-digest.ts:104-114`; `engine.ts:207-209`; `hook.ts:751-770` |
| sizes | body up to 25 MB; workspace quota 1 GB; **500 file names per workspace, shared with every other file artifact, tombstoned names counting for 30 days** | `src/cloud/files.ts:21`; `command/file-artifacts.ts:52-54`, `:517-526` |
| reading a body | is a **command**: `file_download_url` (`site/src/lib/commonswarm.ts:1198-1214`, `LiveDashboard.astro:4413-4427`), which writes one `idempotency_keys` row and one `audit_log` row per call (`command/index.ts:8368-8402`) | Opus arm |
| doctrine | "Scoping: workspace scoping suffices at current size; **topic-name prefixes next**"; search deferred until ~50 topics, lexical-first | brain topic `knowledgebase-design` |

The lead's design already names prefixes as the next step. The "Karpathy wiki" phrase is the operator's; no repo document defines it, so this spec defines what is meant by it in §2 and does not claim more.

## 2. The design

### 2.1 Hierarchy is a naming convention

A topic name may contain dots today. This spec gives the dot a meaning: **`area.topic`**, at most three levels (`area.sub.topic`), where every segment obeys the existing per-segment grammar. Nothing in storage or validation changes; `BRAIN_TOPIC_RE` already admits it. **The grouping rule, so a dot in an old name does not invent an area:** the tree splits a name at its first dot only when the resulting area has **at least two topics** in the list (or an explicit `<area>._index` topic, which is how a person declares an area with one topic in it). A lone `release_notes.v2` therefore stays at the root as one flat name, exactly as today, until a second `release_notes.*` topic exists. Names with more than three segments split at the first dot into area and the rest, and the rest at its first dot into sub and the remainder; the remainder keeps any further dots as part of the topic name (`a.b.c.d` → area `a`, sub `b`, topic `c.d`). The same function (`brainTree()` in `src/cloud/brain.ts`, mirrored by one exported function in `site/src/lib/brain-view.ts`, with one shared test vector file so the two cannot drift) is the only place the rule lives. The convention is written into `brain-how-to` (§4) and `AGENTS.md`'s brain paragraph, and the list views below make it visible, which is what makes people use it.

Why not `/`: the file layer rejects it (`command/file-artifacts.ts`), so a slash would need a migration and a new validation surface for a purely cosmetic gain. Why not `-`: forty-three topics already use `-` inside one name (`false-success-signals`), so it cannot be a separator. Why dot: it is legal, rare in current names (one topic), and reads as a path.

Renaming: there is no rename. A topic moved into an area is a new topic whose first line says `Moved from <old>`, and the old topic's last version says `Moved to <new>`; both stay readable through their history. **The price, against the 500-name cap:** each move consumes a second name for at least 30 days (a tombstoned name keeps counting, `file-artifacts.ts:518-519`), so re-homing all 43 topics at once would hold 86 of 500 names. Bulk migration is therefore **not** part of this spec; the lead moves a topic only when it is next rewritten, and never more than ten in one month.

### 2.2 The tree and index pages are views of the list

- **CLI:** `cswarm brain tree` renders the list grouped by area (one list call, no bodies): `strategy` → `commonswarm-roadmap`, `competitors`, …; each line keeps the existing `live · retired · updated · by` facts. `brain ls` is unchanged.
- **Site:** the Brain panel's flat list becomes a tree (areas collapsible, root topics last), and **selecting an area shows an index page** generated on the client from the list: the area's topics with their first body line (the question the topic answers, by `brain-how-to`'s rule) when that topic's body is cached (§2.3), or its updated-by line when it is not. Index pages are not stored; they are what the list looks like through the tree.
- **Sorting:** areas alphabetically; inside an area, most recently updated first, because staleness is a first-class property (`knowledgebase-design`).

### 2.3 Backlinks come from bodies the reader opens, plus a bounded prefetch that persists nothing

Reading a body is not free: `file_download_url` is a command that writes an `idempotency_keys` row and an `audit_log` row per call (§1). Draft 1's background fill of every body would therefore have written 2N durable rows per viewer per session and pulled up to the 1 GB quota into a tab; it is withdrawn. Draft 2 has three parts.

1. **The read-intent gate, applied to `file_download_url`.** Push delivery's §3.1 rule ("an audit row and an idempotency row are written for a state-changing command or a refused command, never for an empty read-intent command") already governs `claim_agent_inbox`. `file_download_url` mints a signed GET and changes no row (`command/index.ts:8248`, CodexDesktop's server pass), so L0 gates its two inserts the same way, in the same branch, with the same replay reasoning: a retried `command_id` re-executes and mints another URL, which is what the caller wanted. After L0, a body read is one edge invocation and zero rows.
2. **A bounded prefetch, not a fill.** The site keeps a per-workspace in-memory cache `{ topic → { version, body } }` keyed by the workspace the read **started** in (a body that arrives after a workspace switch is dropped, the way `brain-links.ts:205-211` and `brain-view.ts:82-85` already guard that seam), filled by the topics the reader opens, and by a prefetch that runs once per session and only while the Brain panel is open: topics whose `size_bytes` in the list (`read/index.ts:658`) is ≤ **256 KB**, newest-updated first, at most **60** topics and **4 MB** in total, at most four in flight, stopping the moment the panel closes. A topic outside those bounds is fetched only when opened. The `sessionStorage` mirror keeps its contract: bodies of at most 64 KB under `cswarm.brain.<workspaceId>`, at most 4 MB per workspace, newest-read first; a `QuotaExceededError` turns the mirror off for the session and memory stays the source. Backlinks are therefore **complete for the scanned set and grow as the reader opens more**; the topic page says so in one line (`Linked from · 41 of 43 topics scanned`), which is honest and cheap.
3. **Extraction is the linkifier's own DOM pass.** The message rule is two parts: the pure gate (`brainLinkSegments`/`isLinkable`, `brain-links.ts:130-139`) and the DOM walk that feeds it, which skips `PRE`, `A`, and `BUTTON` and passes a `CODE` element's whole text as a code span (`:92`, `:378-384`). Running the gate over raw Markdown would turn every topic named inside a fenced block into an edge (the product's own rule forbids that, `AGENTS.md:285-286`) and hide every bare-word topic. So the site extracts links by **rendering the cached body through the same sanitizer into a detached element** (`setSanitizedMessageMarkdown`, `message-markdown.ts:625-635`) and running the existing DOM pass over it: the same function that linkifies a message, called on a document fragment instead of a rendered row. That is "the same rule" by construction; the cost is one render per cached body, which the panel already pays to show it.

From those edges the site keeps `{ topic → mentions[] }` and its inverse, recomputed for a topic when its version changes. A topic page shows **Links to** and **Linked from** as the existing topic controls, with the scanned count. **Re-rendering:** the cache is a small store with a `revision` counter; every fill increments it and the panel re-renders its current view through the render functions `createBrainView` already uses (`brain-view.ts:75-278`); the wiring point is the panel's existing refresh handler, which L2 names from `LiveDashboard.astro:1268-1279` (the imports) and `:4377-4388` (`brainViewTargets`), not the markup block at `:695-748`.

- **CLI `brain links`:** deferred. The CLI has no DOM to run the linkifier's pass, and an on-disk body cache keyed by workspace would outlive revocation and cross principals on a shared host (Opus arm). If wanted later it needs a principal in the key, a TTL, and a revalidating read; not this spec.
- **Agents' digest** is unchanged; it never carried bodies and still does not.

### 2.4 Table of contents

The renderer already parses headings (`message-markdown.ts`). A topic page gains a TOC from its `##`/`###` headings, rendered above the body when there are three or more. **No anchors and no `id` attributes:** the sanitizer allows attributes on exactly three tags (`message-markdown.ts:73-78`) and headings carry none (`:497`); opening that allowlist to a member-authored value is the change the file exists to avoid (`:59-67`). Each TOC entry is a button that calls `scrollIntoView` on the nth heading element of the rendered body, found by index at click time; the sanitizer is untouched, and nothing member-authored becomes an id. No storage, no CLI change.

### 2.5 What is deliberately not built

- `[[topic]]` syntax: the 2026-09-04 design chose mention-of-an-existing-topic over explicit syntax and the reasons still hold (`BRAIN-LINKS-IN-SIGNALS.md:24-30`). Backlinks use the same rule, so nothing new has to be typed.
- A stored index topic (Karpathy's `index.md` maintained by the writer): it would be a shared write hotspot across many agents, churning the 20-version window and racing `--if-version`. Generated views make it unnecessary.
- Search: deferred per `knowledgebase-design`; the tree and backlinks are the navigation that makes a 50-topic brain usable without it.
- Server-side link extraction: the list would have to carry bodies or a links column; both are new storage or new edge work, and the client computation is cheap at this size.

## 3. Acceptance

- `cswarm brain tree` groups `strategy.x`, `strategy.y` under `strategy`, leaves a lone `release_notes.v2` under the root, and leaves flat names under the root; `brain ls` output is byte-identical to today's.
- Site: creating `ops.example` (via `brain put`) shows an `ops` area with an index page whose entry carries the topic's first line once cached.
- Backlinks: a topic that mentions `shared-host` in a code span (bare word) and `false-success-signals` in prose (slug) is listed under both targets' **Linked from**; a topic that mentions `false-success-signals` only inside a fenced block is **not**; a topic that mentions a non-existent name links to nothing; the page shows `N of M topics scanned`.
- After `brain put` bumps `shared-host` to a new version, only that body is refetched (network count asserted in the observer test); opening the panel in a fresh session issues at most 60 download-URL commands and, after L0, zero audit or idempotency rows.
- `brain-how-to` v(n+1) and `AGENTS.md` carry the `area.topic` rule in one sentence each, and the site test that pins non-duplication of the separator set (`brain-links.observer.test.ts:247`) is extended to the dot rule.

## 4. Lanes

| lane | branch | author | files | tests | after |
|---|---|---|---|---|---|
| **L1** convention and CLI tree | `lane/brain-tree` | Gemini | `src/cloud/brain.ts` (`brainTree()` view over `brainRowsFromFiles`), `src/cli.ts` (`brain tree`), `tests/brain-namespace.test.ts` (tree grouping, three-level cap, root fallback), `tests/p1-cli/brain-verbs.test.ts` | grouping; `ls` unchanged; usage block | — |
| **L2** site tree and index pages | `lane/brain-tree-site` | Grok | `site/src/lib/brain-view.ts`, `LiveDashboard.astro:695-748`, `brain-view.observer.test.ts` | tree render; index page; sort rule; empty area | — (site only; parallel with L1) |
| **L0** read-intent gate on `file_download_url` | `lane/download-url-persists-nothing` | Grok | `supabase/functions/command/index.ts` (the `file_download_url` branch only), `tests/p1-server/download-url-persists-nothing.test.ts` (glob) | a download URL command writes zero audit and zero idempotency rows; a retried `command_id` mints again; every other command unchanged | — (holds the local database) |
| **L3** backlinks | `lane/brain-backlinks` | Codex (gpt-5.6-sol high) or Grok | `site/src/lib/brain-links.ts` (expose the DOM pass for a fragment), new `site/src/lib/brain-graph.ts` (bounded prefetch, workspace-keyed cache, extraction via the sanitizer + DOM pass, inversion, scanned count), `brain-view.ts` (Links to / Linked from), `brain-links.observer.test.ts` | slug in prose links, bare word in a code span links, a topic inside a fenced block does **not** link, a non-existent name does not; the prefetch honours size, count, and byte bounds and stops on panel close; a body arriving after a workspace switch is dropped; version-driven refetch count | L0, L1, L2 |
| **L4** TOC | `lane/brain-toc` | Gemini | `site/src/lib/message-markdown.ts` (heading extraction to a list, no markup change), `brain-view.ts` | three-heading threshold; scroll by index; the sanitizer's attribute allowlist is byte-identical before and after | L2 |
| **L5** docs | `lane/brain-wiki-docs` | any | `brain-how-to` (brain put, v+1), `AGENTS.md:274-295` one sentence, `docs/design/2026-09-04-BRAIN-LINKS-IN-SIGNALS.md` addendum naming the shared rule | the non-duplication observer test | L3 |

One edge change (L0, a gate in one branch, no migration), no new storage. Order: L0 ∥ L1 ∥ L2 (L0 alone holds the database) → L3 → L4 → L5.

## 5. What was NOT established

- What the operator means by "Karpathy-wiki style" beyond structure and hierarchy; this spec takes it as tree + index + backlinks + TOC and says so. If it also means an agent-maintained `log` topic, that is one more topic written by convention and needs no code.
- Typical topic body size in production (the 2–20 KB estimate is from this workspace's topics as read during the session, not measured across workspaces).
- `sessionStorage` capacity on iOS Safari for the body cache; the in-memory cache is the source and storage is best effort.
- Whether the lead wants the 43 existing topics re-homed now; this spec leaves them at the root and lets each move when next written.
