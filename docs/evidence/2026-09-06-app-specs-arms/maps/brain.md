# Map: the brain — storage, read paths, links, sizes, tests

Explore subagent report, 2026-09-06, branch `spec/app-backlog` at `origin/main`. Read-only.

## 1. Storage
- Not a separate table: a topic is a `swarm.files` row named `brain--<topic>.md` with content in `swarm.file_versions` (`supabase/migrations/20260818000001_file_artifacts.sql:5-58`). `20260902000005_brain_version_window.sql:1-71` adds the `retired` state and `live_version_count`/`retired_version_count` on `swarm_read.files`.
- Window: `BRAIN_LIVE_VERSION_LIMIT = 20` (`src/protocol/brain-version-window.ts:14`); `planFileVersionWindow` (:82-103): create blocked only by 20 in-flight uploads; commit retires the oldest beyond 20 live. Server: `supabase/functions/command/file-artifacts.ts:393-501,789-840`.
- `--if-version`: `brain-version-window.ts:22-75` (integer compare-and-set against the newest live version; narrower than the spec's opaque-ETag primitive, :33-39); CLI `src/cli.ts:7383-7419`.
- Names: `BRAIN_FILE_NAME_RE = /^brain--[a-z0-9][a-z0-9._-]*\.md$/i` (`brain-version-window.ts:16`), max 245 (:12-13); CLI `BRAIN_TOPIC_RE = /^[a-z0-9][a-z0-9._-]*$/` (`src/cloud/brain.ts:21,34-46`); `topic@version` selector (:49-64).
- Hierarchy: none. `brain.ts:1-8` says `brain--` stands in for a `brain/` path because file names cannot contain `/` (`file-artifacts.ts` rejects it). `tests/brain-namespace.test.ts:37` pins that a slash is invalid; a dot inside a name is one flat topic (:31). Lists are flat alphabetical (`brain.ts:116-124`; `site/src/lib/brain-view.ts:57-68`).

## 2. Read paths
- CLI `brain ls|get|put` (`src/cli.ts:7437-7443`; usage :562-564, :617). `runBrainLs` (:7285-7313) lists metadata only; `runBrainGet` (:7315-7368) fetches a download grant then the object; `runBrainPut` (:7370-7435) uploads via `uploadNamedFile` with optional `ifVersion`; 25 MB cap (`src/cloud/files.ts:21`).
- Agent path: `src/cloud/brain-agent.ts:1-44` wraps `listFilesAsAgent`.
- Read edge: `resource: "files"` (`supabase/functions/read/index.ts:652-672`) selects `file_id, name, current_version, size_bytes, content_type, sha256, created_by_kind, created_by, uploaded_by_kind, uploaded_by, created_at, committed_at, tombstoned_at, live_version_count, retired_version_count`; no bodies; no `resource: "brains"`.
- Site Brain panel: `LiveDashboard.astro:307-309/372-375` (tab), `:695-748` (list, detail, raw/markdown toggle, edit form, version history); logic `site/src/lib/brain-view.ts` (`brainTopics()` :57-68, `createBrainView()` :75-278; Markdown via `setSanitizedMessageMarkdown` :182; raw toggle keeps full text out of the DOM until asked :90-97; version history :108-124; edit bound to file id :81-85, :216-222); wiring `LiveDashboard.astro:1268-1279`, `:4377-4388`.
- Listener digest: `~/.cswarm/listeners/<instance>/brain-digest.json` (`src/listener/brain-digest.ts:117-165`; `{version, principalId, topicVersions}`, never bodies — `tests/brain-namespace.test.ts:143`; 128 KB / 2048 topics; 0600). `renderBrainDigest` (:104-114) emits one line for changed topics (`BRAIN_DIGEST_TOPIC_LIMIT = 2` first run). Injected at `src/listener/engine.ts:207-209`; hook `src/listener/hook.ts:751-770,945-951`. Nudge `BRAIN_END_OF_TASK_NUDGE` (`brain.ts:18-19,138-144`) after a replied outcome.

## 3. Links
- `site/src/lib/brain-links.ts` (390 lines), rules in :5-40: validate against the live topic list; slug topics (`BRAIN_SLUG_SEPARATORS = ["-", "_", "."]`, :53) link anywhere; bare-word topics only inside a code span equal to the word (`isLinkable`, :130-139); runs of slug/URL/path characters matched whole (`RUN_RE`, :80; history :64-89).
- No `[[topic]]`: `docs/design/2026-09-04-BRAIN-LINKS-IN-SIGNALS.md:24-30` chose "linkify only text that matches a topic that actually exists" over explicit syntax.
- `AGENTS.md:274-295`: cite topics by name; the separator set is deferred to `brain-links.ts` (:293-294); `site/src/components/app/brain-links.observer.test.ts:247` pins non-duplication.
- No backlinks, no "what links here", no index page: `brainLinkClickOutcome()` (:199-230) resolves forward targets only (`open`/`missing`/`abandoned`); the panel is a flat list (`brain-view.ts:126-149`).

## 4. Sizes and limits
- Body: 25 MB (`files.ts:21`; `file-artifacts.ts:52`), enforced on file and stdin reads (`cli.ts:7263-7266`, `:7397-7398`).
- Topics per workspace: no count cap; a 1 GB byte quota (`FILE_WORKSPACE_MAX_BYTES`, `file-artifacts.ts:53`, `workspace_quota_exceeded` :416); unique name `files_workspace_name_ci` (`20260818000001:24-27`).
- List shape: metadata only at three layers (`read/index.ts:656-665`; `files.ts:156-172`; `brainTopicSnapshots()` `brain.ts:126-135`).
- Backlinks at read time: N reads (one `brain get` each) for N topics; worst case bounded by the 1 GB quota; the list call carries no body.

## 5. Karpathy reference
- `grep -rniI karpathy` over the checkout: zero matches. Not in the repo. (The brain topic `knowledgebase-design` was read separately by the lead: it defers search infrastructure until ~50 topics, lexical-first, and names topic-name prefixes as the next scoping step.)

## 6. Tests
- `tests/brain-namespace.test.ts` (195 lines): names, selector, window math, digest store, nudge, `--if-version` messages.
- `tests/p1-cli/brain-verbs.test.ts` (479 lines): `ls` facts, `get` streaming and JSON, additive retirement fields, usage block, `--if-version` cases.
- Site: `site/src/lib/brain-links.test.mjs` (572 lines), `brain-links-types.test.mjs`; observers `brain-view.observer.test.ts`, `brain-links.observer.test.ts` (405 lines), `brain-links-blocks.observer.test.ts` (267 lines).

## Unknowns
- Any planned topic-count cap.
- `lane/agent-identity` (sibling branch) may carry brain work; not inspected.
- Migrations newer than `20260906000002_file_versions_quota_index.sql` that might touch brain schema.
