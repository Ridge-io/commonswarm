# Single-source release version surfaces and built-artifact gate

Task: `deepseek/release-version-gate` · base `101d6038312fc654e4bbb15f7dd0c37604f58b2e`
· candidate `6d07c06f0d00849f40252a95ccf673b312c1704f` · repair on top of the candidate ·
evidence-correction follow-up (this doc, 2026-07-31) repairing two false probes: the
sentinel scan is now a discriminating enumerated `rg` probe with a mutation control, and
the clean site build is recorded as one unambiguous command (`cd site && rm -rf dist &&
npm run build`).

## Product change

The three hand-maintained `0.1.4` literals on `/download` are gone. Everything derives:

- `site/src/lib/release.ts` (shared, build-only): `CLI_VERSION` from the repo-root
  `package.json` `version`, the protocol from its one source (an import of
  `CLIENT_PROTOCOL_VERSION` from `src/cloud/config.ts`), `CLI_VERSION_LINE` composed in
  the binary's exact `--version` shape, and `INSTALL_CMD_PINNED` composed from the
  browser-safe `INSTALL_HOST` in `site/src/lib/install.ts`. Module-scope validators throw
  at load if either version reads empty.
- `site/src/lib/install.ts`: browser-safe string constants only. It imports nothing and is
  re-exported to nothing that references root metadata.
- `site/src/components/download/OtherWays.astro`: pin card renders `INSTALL_CMD_PINNED`
  from `release.ts` (no second derivation).
- `site/src/components/download/AfterInstall.astro`: `cswarm --version` example is
  `CLI_VERSION_LINE` from `release.ts`.
- `site/src/components/SiteFooter.astro`: version line is `CLI_VERSION_LINE`; the old
  `?raw`-per-file reads are dead, both versions derive once in `release.ts`.

No version was bumped, tagged, published, or deployed. Root manifest/lockfile, installer
logic, agent minimum-version copy, web-client protocol copy, runtime/DB/UI flows are all
untouched.

## The browser-leak repair (block 1)

The candidate's `install.ts` imported `CLI_VERSION` from `release.ts`. Because
`agent-prompt.ts` imports `INSTALL_CMD` from `install.ts`, the AgentConnect browser bundle
then pulled in `release.ts`, and through it the repo-root `package.json` (root-only npm
script names like `build:command-core` and `test:p1-server`) and `src/cloud/config.ts`,
which imports `node:crypto`. The clean build warned `node:crypto` was externalized for
browser compatibility, and the emitted JS carried the root-only strings.

Repair: the dependency direction is now one-way and inverted — `release.ts` imports the
browser-safe `INSTALL_HOST` from `install.ts`; `install.ts` imports nothing. The pinned
command moved to `release.ts`, and `OtherWays.astro` (build-time frontmatter) imports it
from there. `agent-prompt.ts` therefore pulls only plain string constants into the bundle.

Measured on the repaired tree: the clean build emits no `node:crypto` externalization
warning (grep -c on the log prints an explicit 0, with `built in` = 3 as the same-log
positive control) and no emitted browser JS contains `build:command-core`,
`test:p1-server`, or `node:crypto`. The sentinel probe is DISCRIMINATING: `rg -l` with a
real regex alternation, enumerated per sentinel, piped to `wc -l` for an explicit count
(each sentinel 0; combined 0), with `navigator.clipboard` = 3 files as the positive
control. A sentinel injected into a real emitted bundle turns that probe red (1 file),
and a `cmp`-proven byte-identical restore brings it back to 0 — see the red log. The
superseded record `grep -c 'build:command-core|test:p1-server|node:crypto'` is dead here:
basic grep treats `|` as literal text, so it could report 0 with a sentinel present. The
browser-bundle scan is pinned into the site test as
`site/scripts/release-browser-bundle.test.mjs` (which itself uses `includes()` per
sentinel, not the grep form).

## Gate addition: four independent surfaces (block 2)

`site/scripts/download-version.test.mjs` — picked up by `npm --prefix site test` through
the `scripts/*.test.mjs` glob. It DERIVES the expected version (repo-root package.json)
and protocol (src/cloud/config.ts), then requires the clean built
`site/dist/download/index.html` to carry each of FOUR version surfaces exactly once, each
scoped to its own stable output context:

1. the AfterInstall `cswarm --version` example, as the output block's code-line span
   (`<span class="ui-code__line">cswarm <v> (protocol <p>)</span>`);
2. the footer shipping-version line, in the footer's version span
   (`<span class="mono ft__version-str">…</span>`);
3. the visible pinned install command, as the pin code block's line text;
4. the pinned command's `data-copy` payload on the copy button.

A deletion-mutation control exists for EACH surface: removing exactly one (asserting the
other three counts stay at 1 and only the targeted one drops to 0) must turn the predicate
red. The whole-artifact stale control (version `0.1.4` -> `9.9.9` in memory) is kept.
This supersedes the old set-based shape, which passed when the AfterInstall output was
deleted (the footer carried the same string) and when the copy payload was deleted (the
visible pin still showed it).

This supersedes the F-1 shape (EXECUTION-ORDERS.md §2.5), which hard-coded
`0.1.4 present / 0.1.3 absent`.

## Direct module exercise (block 4)

`site/scripts/release-source.test.mjs` imports `site/src/lib/release.ts` directly under
the site test runner (`node --import tsx` — the same runner the repo uses) and compares
its exports (`CLI_VERSION`, `CLIENT_PROTOCOL_VERSION`, `CLI_VERSION_LINE`,
`INSTALL_CMD_PINNED`) against values derived INDEPENDENTLY: `package.json` read with fs,
the config constant read as source text, and the line/command composed by hand in the
test. The expected and actual sides are different code paths. `CLIENT_PROTOCOL_VERSION`
is validated as a non-empty string both in the module (it throws at load otherwise) and in
the test.

## Release bump mechanics corrected + lockfile gate (block 3)

The superseded guidance "edit package.json and nothing else" is gone from `AGENTS.md`, the
`release.ts` comments, and this doc. Truthful statement, now in all three: **no site string
is edited**, but a real npm release syncs the root manifest AND its lockfile — normal
release work updates both `package.json` and `package-lock.json` (prefer
`npm version --no-git-tag-version <version>` or the repo's final release procedure).

`site/scripts/release-lockfile.test.mjs` is a pure gate reached by `npm --prefix site
test`: `package.json.version == package-lock.json.version ==
package-lock.json.packages[""].version`, all non-empty strings. Causal mutation control:
in-memory clones set `packages[""].version = "9.9.9"` and `version = "9.8.7"`; each turns
the gate red, while the on-disk lockfile's sha256 digest is proven unchanged before/after
and a fresh re-read still passes — so the mutation was causal and left no artifact behind.

## Required gates and causal controls (repair tree, all run)

- `cd site && rm -rf dist && npm run build` (one unambiguous command, clean is
  load-bearing) → exit 0, 8 pages; `externalized for browser compatibility` = 0 (grep -c
  prints an explicit 0) with `built in` = 3 as the same-log control → the old warning is
  absent, and the instrument is proven live.
- `npm --prefix site test` → **82 tests, 82 pass, 0 fail** (72 before this repair; ten new
  tests: four added to the download-version gate's six, three module-exercise, two
  lockfile-gate, one browser-bundle scan — see counts below).
- Four in-memory surface-deletion mutations (one per surface); the AfterInstall arm is
  additionally demonstrated on disk below.
- Lockfile-version mutation: turns the alignment gate red; on-disk digest verified
  unchanged.
- Emitted-browser-JS sentinel probe: discriminating `rg` probe (each sentinel 0,
  combined 0 files) with `navigator.clipboard` positive control, plus an injected-sentinel
  mutation that turns the probe red and a `cmp`-proven byte-identical restore.
- Root `npm test` → 241 pass, 0 fail.
- `npm run check:tests` → green (exit 0).
- Root `npm run build` → green (exit 0).
- `git diff --check` → clean.

### RED on-disk demonstrations (block 5, byte-identity proven)

Two separate on-disk controls, each with a `cmp`-proven byte-identical restore.

RED 1 — the download gate artifact. The four in-memory deletion controls are inside the
gate; here the AfterInstall output line was deleted from the BUILT
`site/dist/download/index.html` on disk (footer, visible pin, and copy payload: all three
still present at count 1). The same gate standalone exited 1 with 6/6 red. The file was
then restored from a backup and `cmp` proved byte-identity while both files existed
(sha256 `17998fb01cd8af66104a47a3527e361b791945a787dca8521e58774a923a5aa7` on both).
Gate rerun → 6/6 green.

RED 2 — the sentinel probe. `build:command-core` was appended to a real emitted bundle
(`site/dist/_astro/LiveDashboard…J5bGi8lo.js`); the probe went red (1 file); the backup
was restored and `cmp` proved byte-identity (sha256
`2ad304bafa7eb2af21c9d0a9ce111e745597f81f28f19fd22039c357f74fb56f` on both); the re-probe
returned 0. The probe can therefore fail, which is what makes the 0-on-clean a result.

Both are logged in full in `2026-07-31-release-version-gate-red.log`.

## Evidence files

- `2026-07-31-release-version-gate-green.log` — EXCERPT of the unambiguous clean site
  build (`cd site && rm -rf dist && npm run build`), the discriminating enumerated
  sentinel probe with positive control, the four-surface counts, and the standalone
  download gate, plus the full site-test total (82/82) recorded separately.
- `2026-07-31-release-version-gate-red.log` — EXCERPT of BOTH on-disk causal controls
  (the one-surface deletion → gate red, and the injected sentinel → probe red), each with
  a `cmp`-proven byte-identical restore and a green re-run.

## Decision set reviewed

- Pin `INSTALL_CMD_PINNED` in `release.ts` (build-only) rather than re-deriving it in
  `OtherWays.astro`: one version source, no browser exposure.
- `install.ts` stays browser-safe and imports nothing; `release.ts` imports the host from
  it. One-way, inverted from the candidate.
- Lockfile gate is pure and lives under the site test script rather than editing the root
  `package.json` `test` list — same purity, no manifest churn on a repair that must not
  touch release tooling.
- Deletion controls operate on the built HTML (in memory and, for the record, on disk with
  a `cmp`-proven restore) so the gate is causal without touching sources.

## Not established

- No bump happened; the v0.1.5 path is *predicted* to be `package.json` + `package-lock.json`
  only, but no bump was run and the artifact was not re-verified at 0.1.5.
- The deployed site (commonswarm.com) was not touched or grepped; the built
  `site/dist/download/index.html` under this worktree is the artifact verified, not a
  deployed copy.
- `site/scripts/install-command.mjs` remains unreferenced by any script; unchanged.
- Root `npm run test:p1-*` (DB/network gates) were not run — not applicable to this
  docs/site-surface slice, and this lane contains no DB or network gate by design.
- Determinism of the site build across Astro versions (the `data-astro-cid` hash in the
  footer span) was not re-checked; the styled footer-span regex is the only part of the
  gate that depends on emitted markup rather than pure text.
- The first-draft evidence's `grep -c 'build:command-core|test:p1-server|node:crypto'`
  (literal `|`) and the ambiguous `rm -rf site/dist && npm run build` record were both
  false and are superseded; their correction is what this follow-up records.
