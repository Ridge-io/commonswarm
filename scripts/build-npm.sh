#!/bin/bash
# build-npm — stage the npm distribution of the `cswarm` CLI.
#
#   scripts/build-npm.sh              # requires dist-release/cswarm (run build-release.sh first)
#
# Output: dist-npm/  — a directory ready for `npm publish` (dry-run it first).
#
# WHY THIS EXISTS: sandboxed agent environments (Claude Cowork and similar) allow egress
# to package registries but block arbitrary hosts, so `curl | sh` from commonswarm.com
# never arrives. `npm install -g cswarm` is the same artifact through a door those
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

node -e "
const fs = require('fs');
const manifest = JSON.parse(fs.readFileSync('npm/package.template.json', 'utf8'));
manifest.version = '$VERSION';
fs.writeFileSync('$OUT/package.json', JSON.stringify(manifest, null, 2) + '\n');
"

# Verify the staged artifact runs and reports the version, from the staging dir itself
# (its package.json has no "type", so the .cjs parse path is what a user gets).
got="$(node "$OUT/cswarm.cjs" --version)"
case "$got" in
  *"$VERSION"*) ;;
  *) echo "FAIL: staged cswarm.cjs did not report version $VERSION — got: $got" >&2; exit 1 ;;
esac

echo "staged  $OUT/  (cswarm.cjs $(du -h "$OUT/cswarm.cjs" | cut -f1))"
echo "version $VERSION — verified by running the staged artifact"
echo "publish: (cd $OUT && npm publish --dry-run)  then without --dry-run"
