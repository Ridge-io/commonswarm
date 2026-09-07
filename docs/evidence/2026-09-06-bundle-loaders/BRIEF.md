# Lane — the shipped bundle must run (`lane/bundle-loaders`)

**Live incident, 2026-09-06:** `commonswarm@0.1.62` was published to npm and CRASHES ON STARTUP:

```
TypeError [ERR_INVALID_ARG_VALUE]: The argument 'filename' must be a file URL object, file URL string,
or absolute path string. Received undefined
    at createRequire (node:internal/modules/cjs/loader:2156:11)
```

Cause: `src/cli.ts:356` `const requireFromCli = createRequire(import.meta.url);`, introduced by 4ea5aa1
("keep ACP host and model modules off the session import graph"). `scripts/build-release.sh` bundles the
CLI as single-file **CJS**; esbuild warns `"import.meta" is not available with the "cjs" output format and
will be empty`, so `createRequire(undefined)` throws when the bundle loads. The lane's gates all run from
source through tsx, so nothing exercised the bundle. `build-release.sh` DID catch it (exit 1, its
run-the-artifact check) and the release chain ignored the exit code. npm 0.1.62 is deprecated and `latest`
is back on 0.1.61; the GitHub release for 0.1.62 was never created, so the installer is unaffected.

## Second, latent defect to fix in the same lane
Even with a valid `createRequire`, `requireFromCli("./host/claude.js")` cannot resolve inside the
single-file bundle: esbuild cannot see through a runtime require, so nothing is inlined and there is no
`./host/claude.js` beside the artifact. Every loader in that group is affected
(`loadHostClaude`, `loadHostCodex`, `loadHostOpencode`, and the listener model loaders — enumerate them
yourself from `src/cli.ts`). Establish, and state in REVIEW.md, whether any of them is still REACHABLE at
runtime after 0.1.61 (the listener no longer starts a model). Then either:
(a) make them statically bundlable (a form esbuild resolves) while keeping the ACP host and model modules
off the **session** import graph, which is what 4ea5aa1 was protecting — that constraint has a test, find
it and keep it green; or
(b) if they are provably unreachable, delete them and the dead branches, and say what proved it.
Prefer (a) unless (b) is proven. Do not reintroduce a plain top-level import of the ACP hosts into the
session graph.

## The gate that would have caught this — add it
A test that runs the BUILT ARTIFACT, not the source: build with `scripts/build-release.sh`, copy the
single file to a temp dir with no `node_modules`, and assert `--version` prints the package version and
`--help` prints usage; plus one subcommand that reaches a loader from the group above if any is reachable.
Wire it so a normal lane run catches it: add it to the literal `npm test` list in `package.json` if it can
build within the suite's budget, otherwise add a `test:bundle` script AND name it in
`tests/p1-cli/test-gate-coverage.test.ts` so an unreferenced-file check cannot pass while it is unrun.
Mutation row: revert the `createRequire` line to `import.meta.url`, show the new test fails, restore.

## Also in this lane
`docs/design/SWARM-CLOUD.md` or the brain topic is NOT yours; instead add one trap to `AGENTS.md`
"Reachable traps": the source suites never load the shipped bundle, so a lane that changes module loading
must run `scripts/build-release.sh` and check its EXIT CODE (it runs the artifact and fails on a bad
build).

## Gates
`npm run build`, `npx tsc --noEmit -p tsconfig.json`, `npm test`, `env -u FORCE_COLOR npm run test:p1-cli`,
`npm run check:tests`, `npm run check:edge`, **`bash scripts/build-release.sh; echo "exit $?"` must be 0**,
**`bash scripts/build-npm.sh; echo "exit $?"` must be 0**, `scripts/check-commit-identity.sh origin/main..HEAD`.
Every gate as a plain statement whose exit code you report; never `cmd | grep`, which hides the exit code —
that is how this shipped. D-053. Enumerations from constants.

Freeze; `arms-<sha>/REVIEW.md` + `DIFF.patch`; ONE Gemini arm detached (absolute paths, quote-back, VERDICT
line). Write `/private/tmp/claude-501/-Users-yulanbot-Developer-Ridge-io-cloud-swarm/a866e6cd-5d6d-477f-af6a-740cd30407ed/scratchpad/lane-bundle-loaders-REPORT.md`. Stop; do not merge; never production.
