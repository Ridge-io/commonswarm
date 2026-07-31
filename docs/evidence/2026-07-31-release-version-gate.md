# Single-source release version surfaces and built-artifact gate

Task: `deepseek/release-version-gate` · base `101d6038312fc654e4bbb15f7dd0c37604f58b2e`

## Product change

The three hand-maintained `0.1.4` literals on `/download` are gone. Everything derives:

- `site/src/lib/release.ts` (new, shared): `CLI_VERSION` from the repo-root
  `package.json` `version` (the same field the binary's `--version` is built from) and
  the protocol number from its one source, an import of
  `CLIENT_PROTOCOL_VERSION` (`src/cloud/config.ts`). Validates at load; a blank version
  throws at build time.
- `site/src/lib/install.ts`: `INSTALL_CMD_PINNED` interpolates `CLI_VERSION`; the pipe
  semantics `curl ... | CSWARM_VERSION=<version> sh` are unchanged.
- `site/src/components/download/OtherWays.astro`: pin card now renders
  `INSTALL_CMD_PINNED` verbatim (no second derivation).
- `site/src/components/download/AfterInstall.astro`: `cswarm --version` example is
  `CLI_VERSION_LINE` from `release.ts`.
- `site/src/components/SiteFooter.astro`: version line is `CLI_VERSION_LINE`; the old
  `?raw`-per-file reads are dead, both versions derive once in `release.ts`.

No version was bumped, tagged, published, or deployed. `package.json`/lock untouched;
installer logic, agent minimum-version copy, web-client protocol copy, runtime/DB/UI
flows untouched. The module is proven in both environments it must load in: Astro/Vite
(build) and the repo test runner (`node --import tsx`).

## Gate addition

`site/scripts/download-version.test.mjs` — picked up by `npm --prefix site test` through
the `scripts/*.test.mjs` glob. It DERIVES the expected version (repo-root package.json)
and protocol (src/cloud/config.ts) and requires the clean built
`site/dist/download/index.html` to carry exactly those values on both surfaces — pinned
install command and `cswarm --version` line — and nothing else. The second test mutates
the real artifact in memory (current version replaced by `9.9.9`) and proves the same
predicate rejects it, so the gate discriminates rather than passing vacuously. This
supersedes the F-1 shape (EXECUTION-ORDERS.md §2.5), which hard-coded
`0.1.4 present / 0.1.3 absent`.

## Causal negative control (exact worktree)

1. Clean site build (`rm -rf site/dist && npm run build` in `site/`) → **GREEN**
2. `npm --prefix site test` → 72/72 pass, including both download-gate tests
   — log: `2026-07-31-release-version-gate-green.log`
3. Temporary mutation: `perl`-swap `0.1.4`→`0.1.3` in the BUILT
   `site/dist/download/index.html` (same sources). Same gate run standalone
   → **RED**, exit 1, both tests fail
   — log: `2026-07-31-release-version-gate-red.log`
4. Restore the artifact byte-identical (copy of backup); gate rerun → **GREEN**, exit 0
   (2/2 pass)

## Gates after restore

- `npm --prefix site test` → 72 pass, 0 fail (download gate included)
- `npm test` (root) → 241 pass, 0 fail
- `npm run check:tests` → green
- `npm run build` (root, tsc) → green, `dist/` deterministic
- `git diff --check` → clean

## Not established

- No bump happened; the v0.1.5 path is *predicted* to be `package.json`-only, but no
  bump was run and the artifact was not re-verified at 0.1.5.
- The deployed site (commonswarm.com) was not touched or grepped.
- `site/scripts/install-command.mjs` remains unreferenced by any script; unchanged.
- Root `npm run test:p1-*` (DB/network gates) were not run — not applicable to this
  docs/site-surface slice.