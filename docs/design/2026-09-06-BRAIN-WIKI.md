# Brain wiki: hierarchy, index pages, backlinks, without new storage

**Status:** SPECIFICATION, draft 1, branch `spec/app-backlog`. Backlog item 7 ("brain upgrade, Karpathy-wiki style: navigable structure and hierarchy"). Authored by CSwarmStrategist (`2121f81d`), 2026-09-06, from a read-only code map (`docs/evidence/2026-09-06-app-specs-arms/maps/brain.md`) and the brain topic `knowledgebase-design` (CSwarmDevLead, 2026-09-01).
**Authority:** none until adopted; CSwarmDevLead PMs the lanes. This is the first slice of roadmap H2 (`docs/org/2026-09-04-ROADMAP-DRAFT.md`).

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
| sizes | body up to 25 MB; workspace quota 1 GB; no topic-count cap | `src/cloud/files.ts:21`; `command/file-artifacts.ts:52-53` |
| doctrine | "Scoping: workspace scoping suffices at current size; **topic-name prefixes next**"; search deferred until ~50 topics, lexical-first | brain topic `knowledgebase-design` |

The lead's design already names prefixes as the next step. The "Karpathy wiki" phrase is the operator's; no repo document defines it, so this spec defines what is meant by it in §2 and does not claim more.

## 2. The design

### 2.1 Hierarchy is a naming convention

A topic name may contain dots today. This spec gives the dot a meaning: **`area.topic`**, at most three levels (`area.sub.topic`), where every segment obeys the existing per-segment grammar. Nothing in storage or validation changes; `BRAIN_TOPIC_RE` already admits it. Existing flat names stay valid and appear under the root. The convention is written into `brain-how-to` (§4) and `AGENTS.md`'s brain paragraph, and the list views below make it visible, which is what makes people use it.

Why not `/`: the file layer rejects it (`command/file-artifacts.ts`), so a slash would need a migration and a new validation surface for a purely cosmetic gain. Why not `-`: forty-three topics already use `-` inside one name (`false-success-signals`), so it cannot be a separator. Why dot: it is legal, rare in current names (one topic), and reads as a path.

Renaming: there is no rename. A topic moved into an area is a new topic whose first line says `Moved from <old>`, and the old topic's last version says `Moved to <new>`; both stay readable through their history. The tree shows the old name under the root until it is retired by a `brain put` with the pointer. Bulk migration of the 43 existing names is **not** part of this spec; the lead decides per topic when it is next written.

### 2.2 The tree and index pages are views of the list

- **CLI:** `cswarm brain tree` renders the list grouped by area (one list call, no bodies): `strategy` → `commonswarm-roadmap`, `competitors`, …; each line keeps the existing `live · retired · updated · by` facts. `brain ls` is unchanged.
- **Site:** the Brain panel's flat list becomes a tree (areas collapsible, root topics last), and **selecting an area shows an index page** generated on the client from the list: the area's topics with their first body line (the question the topic answers, by `brain-how-to`'s rule) when that topic's body is cached (§2.3), or its updated-by line when it is not. Index pages are not stored; they are what the list looks like through the tree.
- **Sorting:** areas alphabetically; inside an area, most recently updated first, because staleness is a first-class property (`knowledgebase-design`).

### 2.3 Backlinks are computed from cached bodies, refreshed by version

The list carries every topic's current version. The site keeps a per-workspace cache `{ topic → { version, body } }` in memory (and `sessionStorage` when it fits), fills it lazily as topics are opened, and **completes it in the background** once per session: one `brain get` per topic not yet cached, in list order, at most four in flight, using the same file-download path the panel already uses. When a topic's version in the list changes, only that body is refetched. From the cached bodies the site computes, per topic, the set of topics it mentions using the **same rule the message linkifier uses** (`brain-links.ts` slug/bare-word gate, exported once so the two cannot drift), and inverts it into "what links here". A topic page then shows two lists under its body: **Links to** and **Linked from**, both as the existing topic controls.

Cost, stated: for N topics the first session costs N reads; a topic body is typically 2–20 KB (the 25 MB cap is not what topics are), so 43 topics is ~0.5 MB once. The same reads are what a person reading the brain would make anyway. At 500 topics it is 500 reads and a few MB, still once per session and incremental afterwards. Above that, the deferred trigger in `knowledgebase-design` (search infrastructure at ~50+ topics) is the right moment to move link extraction server-side; this spec does not.

- **CLI:** `cswarm brain links <topic>` computes the same two lists with the same cache under `~/.cswarm/brain-cache/<workspace>/` (0600, bodies stored, capped at 64 MB, evicted by version), so an agent can ask "what points at `shared-host`" without the site.
- **Agents' digest** is unchanged; it never carried bodies and still does not.

### 2.4 Table of contents

The renderer already parses headings (`message-markdown.ts`). A topic page gains a TOC from its `##`/`###` headings, rendered above the body when there are three or more, each entry an in-page anchor. No storage, no CLI change.

### 2.5 What is deliberately not built

- `[[topic]]` syntax: the 2026-09-04 design chose mention-of-an-existing-topic over explicit syntax and the reasons still hold (`BRAIN-LINKS-IN-SIGNALS.md:24-30`). Backlinks use the same rule, so nothing new has to be typed.
- A stored index topic (Karpathy's `index.md` maintained by the writer): it would be a shared write hotspot across many agents, churning the 20-version window and racing `--if-version`. Generated views make it unnecessary.
- Search: deferred per `knowledgebase-design`; the tree and backlinks are the navigation that makes a 50-topic brain usable without it.
- Server-side link extraction: the list would have to carry bodies or a links column; both are new storage or new edge work, and the client computation is cheap at this size.

## 3. Acceptance

- `cswarm brain tree` groups `strategy.x`, `strategy.y` under `strategy` and leaves flat names under the root; `brain ls` output is byte-identical to today's.
- Site: creating `ops.example` (via `brain put`) shows an `ops` area with an index page whose entry carries the topic's first line once cached.
- Backlinks: a topic that mentions `shared-host` in a code span (bare word) and `false-success-signals` in prose (slug) is listed under both targets' **Linked from**; a topic that mentions a non-existent name links to nothing.
- After `brain put` bumps `shared-host` to a new version, only that body is refetched (network count asserted in the observer test).
- `brain-how-to` v(n+1) and `AGENTS.md` carry the `area.topic` rule in one sentence each, and the site test that pins non-duplication of the separator set (`brain-links.observer.test.ts:247`) is extended to the dot rule.

## 4. Lanes

| lane | branch | author | files | tests | after |
|---|---|---|---|---|---|
| **L1** convention and CLI tree | `lane/brain-tree` | Gemini | `src/cloud/brain.ts` (`brainTree()` view over `brainRowsFromFiles`), `src/cli.ts` (`brain tree`), `tests/brain-namespace.test.ts` (tree grouping, three-level cap, root fallback), `tests/p1-cli/brain-verbs.test.ts` | grouping; `ls` unchanged; usage block | — |
| **L2** site tree and index pages | `lane/brain-tree-site` | Grok | `site/src/lib/brain-view.ts`, `LiveDashboard.astro:695-748`, `brain-view.observer.test.ts` | tree render; index page; sort rule; empty area | — (site only; parallel with L1) |
| **L3** backlinks | `lane/brain-backlinks` | Codex (gpt-5.6-sol high) or Grok | `site/src/lib/brain-links.ts` (export the mention rule), new `site/src/lib/brain-graph.ts` (cache, extraction, inversion), `brain-view.ts` (Links to / Linked from), `brain-links.observer.test.ts`; CLI: `src/cloud/brain.ts`, `src/cli.ts` (`brain links`), `tests/brain-namespace.test.ts` | slug and bare-word cases; version-driven refetch count; cache cap and eviction; 0600 on disk | L1, L2 |
| **L4** TOC | `lane/brain-toc` | Gemini | `site/src/lib/message-markdown.ts` (heading extraction), `brain-view.ts` | three-heading threshold; anchors | L2 |
| **L5** docs | `lane/brain-wiki-docs` | any | `brain-how-to` (brain put, v+1), `AGENTS.md:274-295` one sentence, `docs/design/2026-09-04-BRAIN-LINKS-IN-SIGNALS.md` addendum naming the shared rule | the non-duplication observer test | L3 |

No migration, no edge function, no D-036 hazard beyond each lane's two arms. Order: L1 ∥ L2 → L3 → L4 → L5.

## 5. What was NOT established

- What the operator means by "Karpathy-wiki style" beyond structure and hierarchy; this spec takes it as tree + index + backlinks + TOC and says so. If it also means an agent-maintained `log` topic, that is one more topic written by convention and needs no code.
- Typical topic body size in production (the 2–20 KB estimate is from this workspace's topics as read during the session, not measured across workspaces).
- `sessionStorage` capacity on iOS Safari for the body cache; the in-memory cache is the source and storage is best effort.
- Whether the lead wants the 43 existing topics re-homed now; this spec leaves them at the root and lets each move when next written.
