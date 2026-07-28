#!/bin/bash
# build-release — produce the single-file `cswarm` binary plus a checksum.
#
#   scripts/build-release.sh [version]     # default: version from package.json
#
# Output: dist-release/cswarm  ·  dist-release/cswarm.sha256
#
# The artifact name must match what install.sh downloads (`$BASE/cswarm` and
# `$BASE/cswarm.sha256`). If you rename it here, rename it there in the same change.
#
# WHY A BUNDLE AND NOT A TARBALL OF dist/: the CLI has runtime dependencies
# (@supabase/supabase-js, postgres) and `dist/` alone is not runnable — it needs a
# node_modules beside it. Bundling makes the artifact ONE FILE with no install step
# and no dependency resolution on the user's machine, which is the whole point of a
# `curl | sh` installer.
#
# NODE IS STILL REQUIRED (>=24, see package.json engines). This ships JavaScript, not a
# native executable. The installer checks for it and says so; that is deliberate — a
# fake "self-contained binary" that dies on `node: command not found` is worse UX than
# an installer that names the requirement up front.
set -euo pipefail
cd "$(dirname "$0")/.."

VERSION="${1:-$(node -p "require('./package.json').version")}"
OUT=dist-release
rm -rf "$OUT"; mkdir -p "$OUT"

# --define injects the version. src/cli.ts prefers it and falls back to reading
# package.json, which is correct for dev builds and impossible for a bundled one.
# The define is STILL called __COSWARM_VERSION__ on purpose: it is a build-time
# identifier that src/cli.ts declares, so the two names must change together or the
# injection silently stops happening. Nobody types it, so the rename can wait.
npx esbuild src/cli.ts \
  --bundle --platform=node --target=node24 --format=cjs \
  --define:__COSWARM_VERSION__="\"$VERSION\"" \
  --outfile="$OUT/cswarm"

chmod +x "$OUT/cswarm"

# esbuild preserves the shebang already present in src/cli.ts. Do not add another —
# a shebang on line 2 is a syntax error, and prepending one is how this was first
# built and broken.
head -c 20 "$OUT/cswarm" | grep -q '^#!/usr/bin/env node' \
  || { echo "FAIL: bundle lost its shebang" >&2; exit 1; }

# Verify the artifact actually runs and reports the version we injected, from a
# directory with no node_modules. Building something that does not run is the
# failure this check exists to make impossible.
tmp="$(mktemp -d)"; cp "$OUT/cswarm" "$tmp/"
got="$("$tmp/cswarm" --version 2>/dev/null || "$tmp/cswarm" --help 2>&1 | head -1)"
rm -rf "$tmp"
case "$got" in
  *"$VERSION"*) ;;
  *) echo "FAIL: built binary did not report version $VERSION — got: $got" >&2; exit 1 ;;
esac

( cd "$OUT" && shasum -a 256 cswarm > cswarm.sha256 )

echo "built   $OUT/cswarm  ($(du -h "$OUT/cswarm" | cut -f1))"
echo "version $VERSION  — verified by running the artifact"
echo "sha256  $(cut -d' ' -f1 < "$OUT/cswarm.sha256")"
