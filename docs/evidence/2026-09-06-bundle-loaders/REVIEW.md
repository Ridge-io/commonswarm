# lane/bundle-loaders — review, SHA 47b51d607cef00609e9f164afe97d7d0092861c7

Claim: the shipped single-file CJS bundle starts. `createRequire(import.meta.url)` (empty under
esbuild --format=cjs, the cause of the 0.1.62 startup crash) is gone; the ACP host and listener-model
loaders are literal `import("./…")` calls esbuild inlines, so they also resolve inside the bundle;
`src/listener/claude-canary-classify.ts` carries the shared classifier so the session import graph still
does not reach an ACP host. New gate `tests/p1-cli/release-bundle.test.ts` builds the artifact and runs it.

Gates on this SHA (each a plain statement, exit code recorded by the lead):
build 0, tsc --noEmit 0, check:tests 0, check:edge 0, build-release.sh 0 ("verified by running the
artifact", sha256 313b8907…), build-npm.sh 0 ("verified by running the staged artifact"),
npm test 925/925, test:p1-cli 553/553, check-commit-identity 0.

Author: Grok. Lead verification: reproduced the 0.1.62 crash, confirmed the cause at src/cli.ts:356,
and confirmed build-release.sh exits 0 on this SHA where it exited 1 before.
