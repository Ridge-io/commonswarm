#!/usr/bin/env bash

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "$0")" && pwd -P)/_lib.sh"

require_command git
require_command npm
require_command rsync
require_command ssh
require_command shasum
load_cloud_env

remote_manifest() {
  remote_zsh "
    cd '$UXTEST_REMOTE_REPO'
    find . \
      \\( -path './.git' -o -path './node_modules' -o -path './dist' \
         -o -path './uxtest/rounds' \\) -prune -o \
      -type f ! -name '.env' ! -name '.env.*' -print0 |
      LC_ALL=C sort -z |
      xargs -0 shasum -a 256 |
      shasum -a 256 |
      awk '{print \$1}'
  "
}

say "Verifying Tom's product worktree is safe to update."
sync_marker="$UXTEST_REMOTE_HOME_ROOT/run/synced-source.sha"
prior_manifest="$(remote_zsh "test -f '$sync_marker' && cat '$sync_marker' || true")"
current_manifest="$(remote_manifest)"
remote_status="$(remote_zsh "git -C '$UXTEST_REMOTE_REPO' status --porcelain")"
sync_state=clean
if [ -n "$prior_manifest" ]; then
  [ "$prior_manifest" = "$current_manifest" ] ||
    die "Tom's source changed after the last harness sync; refusing to overwrite it"
  sync_state=harness-owned
elif [ -n "$remote_status" ]; then
  say "No prior sync marker exists; checking whether the dirty tree already byte-matches this harness source."
  dry_run="$(
    rsync -azn --delete --itemize-changes \
      --exclude='.git/' \
      --exclude='node_modules/' \
      --exclude='dist/' \
      --exclude='.env' \
      --exclude='.env.*' \
      --exclude='uxtest/rounds/' \
      "$UXTEST_REPO/" "$UXTEST_REMOTE:$UXTEST_REMOTE_REPO/"
  )"
  [ -z "$dry_run" ] ||
    die "Tom's cloud-swarm worktree has changes not owned by this harness"
  sync_state=harness-owned
fi

if [ "$sync_state" = "clean" ]; then
  say "Trying a fast-forward before copying the exact mini source tree."
  if remote_zsh "git -C '$UXTEST_REMOTE_REPO' pull --ff-only"; then
    say "Tom's repository fast-forwarded."
  else
    say "GitHub auth is unavailable in the SSH session; continuing with exact-source rsync and bundle verification."
  fi
else
  say "Tom's existing source changes match the prior/current harness sync; preserving idempotent ownership."
fi

say "Installing dependencies and building cswarm on the mini."
(cd "$UXTEST_REPO" && npm install && npm run build)

say "Copying the exact source tree to Tom's clean repository."
rsync -az --delete \
  --exclude='.git/' \
  --exclude='node_modules/' \
  --exclude='dist/' \
  --exclude='.env' \
  --exclude='.env.*' \
  --exclude='uxtest/rounds/' \
  "$UXTEST_REPO/" "$UXTEST_REMOTE:$UXTEST_REMOTE_REPO/"
synced_manifest="$(remote_manifest)"
remote_zsh "
  mkdir -p '$UXTEST_REMOTE_HOME_ROOT/run'
  chmod 700 '$UXTEST_REMOTE_HOME_ROOT/run'
  printf '%s\\n' '$synced_manifest' >'$sync_marker'
  chmod 600 '$sync_marker'
"

say "Installing dependencies and rebuilding Tom's existing cswarm target."
remote_zsh "cd '$UXTEST_REMOTE_REPO' && npm install && npm run build"

install_local_copy() {
  local home_root="$1"
  local tool
  local real_tool
  mkdir -p "$home_root/product/dist" "$home_root/bin" "$home_root/config" \
    "$home_root/.internal"
  chmod 700 "$home_root" "$home_root/product" "$home_root/bin" \
    "$home_root/config" "$home_root/.internal"
  rsync -a --delete "$UXTEST_REPO/dist/" "$home_root/product/dist/"
  install -m 600 "$UXTEST_REPO/package.json" "$home_root/product/package.json"
  install -m 600 "$UXTEST_REPO/package-lock.json" "$home_root/product/package-lock.json"
  (
    cd "$home_root/product"
    npm install --omit=dev --ignore-scripts
  )
  install -m 700 "$UXTEST_DIR/scripts/cswarm-wrapper.sh" "$home_root/bin/cswarm"
  for tool in base64 node python python3 jq openssl perl ruby; do
    real_tool="$(command -v "$tool" 2>/dev/null || true)"
    [ -n "$real_tool" ] || continue
    printf '%s\n' "$real_tool" >"$home_root/product/REAL_$tool"
    chmod 600 "$home_root/product/REAL_$tool"
    install -m 700 "$UXTEST_DIR/scripts/isolation-tripwire.sh" \
      "$home_root/bin/$tool"
  done
  for tool in cat ls find head tail sed grep rg readlink realpath which strings; do
    real_tool="$(command -v "$tool" 2>/dev/null || true)"
    [ -n "$real_tool" ] || continue
    printf '%s\n' "$real_tool" >"$home_root/product/REAL_$tool"
    chmod 600 "$home_root/product/REAL_$tool"
    install -m 700 "$UXTEST_DIR/scripts/path-tripwire.sh" \
      "$home_root/bin/$tool"
  done
  install -m 600 "$UXTEST_DIR/scripts/redacting-tee.mjs" \
    "$home_root/.internal/stream.mjs"
  command -v node >"$home_root/product/NODE_BIN"
  chmod 600 "$home_root/product/NODE_BIN"
  bundle_sha "$home_root/product/dist" >"$home_root/product/SOURCE_SHA"
  chmod 600 "$home_root/product/SOURCE_SHA"
  install -m 600 "$UXTEST_REPO/.env.cloud" "$home_root/config/cloud.env"
}

say "Installing an isolated, instrumented product copy on the mini."
install_local_copy "$UXTEST_MINI_HOME_ROOT"

say "Installing the same isolated product copy on Tom's laptop."
remote_zsh "
  set -euo pipefail
  root='$UXTEST_REMOTE_HOME_ROOT'
  repo='$UXTEST_REMOTE_REPO'
  mkdir -p \"\$root/product/dist\" \"\$root/bin\" \"\$root/config\" \"\$root/.internal\"
  chmod 700 \"\$root\" \"\$root/product\" \"\$root/bin\" \"\$root/config\" \"\$root/.internal\"
  rsync -a --delete \"\$repo/dist/\" \"\$root/product/dist/\"
  install -m 600 \"\$repo/package.json\" \"\$root/product/package.json\"
  install -m 600 \"\$repo/package-lock.json\" \"\$root/product/package-lock.json\"
  cd \"\$root/product\"
  npm install --omit=dev --ignore-scripts
  install -m 700 \"\$repo/uxtest/scripts/cswarm-wrapper.sh\" \"\$root/bin/cswarm\"
  for tool in base64 node python python3 jq openssl perl ruby; do
    real_tool=\$(command -v \"\$tool\" 2>/dev/null || true)
    [ -n \"\$real_tool\" ] || continue
    printf '%s\\n' \"\$real_tool\" >\"\$root/product/REAL_\$tool\"
    chmod 600 \"\$root/product/REAL_\$tool\"
    install -m 700 \"\$repo/uxtest/scripts/isolation-tripwire.sh\" \"\$root/bin/\$tool\"
  done
  for tool in cat ls find head tail sed grep rg readlink realpath which strings; do
    real_tool=\$(command -v \"\$tool\" 2>/dev/null || true)
    [ -n \"\$real_tool\" ] || continue
    printf '%s\\n' \"\$real_tool\" >\"\$root/product/REAL_\$tool\"
    chmod 600 \"\$root/product/REAL_\$tool\"
    install -m 700 \"\$repo/uxtest/scripts/path-tripwire.sh\" \"\$root/bin/\$tool\"
  done
  install -m 600 \"\$repo/uxtest/scripts/redacting-tee.mjs\" \"\$root/.internal/stream.mjs\"
  command -v node >\"\$root/product/NODE_BIN\"
  chmod 600 \"\$root/product/NODE_BIN\"
  (
    cd \"\$root/product/dist\"
    find . -type f -print0 |
      LC_ALL=C sort -z |
      xargs -0 shasum -a 256 |
      shasum -a 256 |
      awk '{print \$1}'
  ) >\"\$root/product/SOURCE_SHA\"
  chmod 600 \"\$root/product/SOURCE_SHA\"
"
rsync -a "$UXTEST_REPO/.env.cloud" \
  "$UXTEST_REMOTE:$UXTEST_REMOTE_HOME_ROOT/config/cloud.env"
remote_zsh "chmod 600 '$UXTEST_REMOTE_HOME_ROOT/config/cloud.env'"

mini_sha="$(<"$UXTEST_MINI_HOME_ROOT/product/SOURCE_SHA")"
laptop_sha="$(remote_zsh "cat '$UXTEST_REMOTE_HOME_ROOT/product/SOURCE_SHA'")"
[ "$mini_sha" = "$laptop_sha" ] ||
  die "copied cswarm bundle hashes differ after sync"

mini_node="$(<"$UXTEST_MINI_HOME_ROOT/product/NODE_BIN")"
mini_help="$("$mini_node" "$UXTEST_MINI_HOME_ROOT/product/dist/cli.js" --help |
  head -n 1)"
laptop_help="$(
  remote_zsh "
    node_bin=\$(cat '$UXTEST_REMOTE_HOME_ROOT/product/NODE_BIN')
    \"\$node_bin\" '$UXTEST_REMOTE_HOME_ROOT/product/dist/cli.js' --help | head -n 1
  "
)"
printf '%s\n' "$mini_help" | grep -Eq '^cswarm [0-9]' ||
  die "mini copied cswarm --help lacks the version line"
printf '%s\n' "$laptop_help" | grep -Eq '^cswarm [0-9]' ||
  die "laptop copied cswarm --help lacks the version line"

say "Sync verified: both copied builds are $mini_sha ($mini_help)."
