#!/bin/bash
# build-npm — stage the npm distribution of the `cswarm` CLI.
#
#   scripts/build-npm.sh              # requires dist-release/cswarm (run build-release.sh first)
#
# Output: dist-npm/  — a directory ready for `npm publish` (dry-run it first).
#
# WHY THIS EXISTS: sandboxed agent environments (Claude Cowork and similar) allow egress
# to package registries but block arbitrary hosts, so `curl | sh` from commonswarm.com
# never arrives. `npm install -g commonswarm` is the same artifact through a door those
# environments leave open. The npm package ships the IDENTICAL bundle build-release.sh
# produced — one file, no dependencies — so the two install paths cannot drift.
#
# The bundle is staged as cswarm.cjs (not extensionless, not .js): it is CJS, and an
# ambient "type": "module" in a parent package.json must not be able to change how Node
# parses it. That exact misread cost a debugging round on 2026-08-17.
set -euo pipefail
cd "$(dirname "$0")/.."

[ -f dist-release/cswarm ] || { echo "FAIL: dist-release/cswarm missing — run scripts/build-release.sh first" >&2; exit 1; }

VERSION="$(node -p "require('./package.json').version")"
OUT=dist-npm
rm -rf "$OUT"; mkdir -p "$OUT"

cp dist-release/cswarm "$OUT/cswarm.cjs"
cp npm/README.md "$OUT/README.md"
cp LICENSE "$OUT/LICENSE"

# npm creates the bin link, but the shebang is what makes the linked file runnable on
# Unix — a bundle that lost it would install fine and die at first invocation.
head -c 20 "$OUT/cswarm.cjs" | grep -q '^#!/usr/bin/env node' \
  || { echo "FAIL: staged cswarm.cjs lost its shebang" >&2; exit 1; }

# Version goes through the environment, not shell interpolation into JS source —
# an apostrophe in a version string must not become a syntax error (review finding).
CSWARM_NPM_VERSION="$VERSION" node -e "
const fs = require('fs');
const manifest = JSON.parse(fs.readFileSync('npm/package.template.json', 'utf8'));
manifest.version = process.env.CSWARM_NPM_VERSION;
fs.writeFileSync('$OUT/package.json', JSON.stringify(manifest, null, 2) + '\n');
"

# Verify the staged artifact runs and reports EXACTLY this version, from the staging dir
# itself (its package.json has no "type", so the .cjs parse path is what a user gets).
# Exact match, not substring: 0.1.1 must not accept a bundle reporting 0.1.10.
got="$(node "$OUT/cswarm.cjs" --version | awk '{print $2}')"
[ "$got" = "$VERSION" ] \
  || { echo "FAIL: staged cswarm.cjs reports version '$got', expected '$VERSION'" >&2; exit 1; }

echo "staged  $OUT/  (cswarm.cjs $(du -h "$OUT/cswarm.cjs" | cut -f1))"
echo "version $VERSION — verified by running the staged artifact"
echo "publish: (cd $OUT && npm publish --dry-run)  then without --dry-run"
