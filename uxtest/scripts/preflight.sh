#!/usr/bin/env bash

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "$0")" && pwd -P)/_lib.sh"

round="${1:-1}"
validate_round "$round"
load_cloud_env
require_env DATABASE_URL
require_env UXTEST_HUMAN1_UID
require_env UXTEST_HUMAN2_EMAIL
require_env UXTEST_OAUTH_CONSENT

case "$UXTEST_HUMAN1_UID" in
  ????????-????-????-????-????????????) ;;
  *) die "UXTEST_HUMAN1_UID must be a UUID" ;;
esac
case "$UXTEST_HUMAN2_EMAIL" in
  *@*.*) ;;
  *) die "UXTEST_HUMAN2_EMAIL must look like an email address" ;;
esac
case "$UXTEST_OAUTH_CONSENT" in
  first|returning) ;;
  *) die "UXTEST_OAUTH_CONSENT must be first or returning" ;;
esac

for command in node npm git rsync ssh curl shasum jq sqlite3; do
  require_command "$command"
done
[ -x "$UXTEST_SWARM_BIN" ] || die "mini swarm binary is unavailable"

say "Checking SSH reachability and non-GUI laptop prerequisites."
remote_zsh "true"
remote_zsh "
  command -v node >/dev/null
  command -v npm >/dev/null
  command -v git >/dev/null
  command -v rsync >/dev/null
  command -v screen >/dev/null
  test -d /Applications/cmux.app
  test -x '$UXTEST_REMOTE_SWARM_BIN'
  test -x /opt/homebrew/bin/coswarm
" >/dev/null
say "Laptop prerequisites verified; cmux.app was checked by its app path, not PATH."

mini_bin="$UXTEST_MINI_HOME_ROOT/bin/coswarm"
laptop_bin="$UXTEST_REMOTE_HOME_ROOT/bin/coswarm"
[ -x "$mini_bin" ] || die "mini persona copy is missing; run sync-machine2.sh"
[ ! -L "$mini_bin" ] || die "mini persona coswarm must not be a symlink"
mini_resolved="$(PATH="$UXTEST_MINI_HOME_ROOT/bin:$PATH" command -v coswarm)"
[ "$mini_resolved" = "$mini_bin" ] ||
  die "mini persona PATH does not resolve to the isolated launcher"
case "$(cd "$(dirname "$mini_resolved")" && pwd -P)/$(basename "$mini_resolved")" in
  "$UXTEST_REPO"/*) die "mini persona coswarm resolves inside the product repository" ;;
esac

remote_zsh "
  set -e
  bin='$laptop_bin'
  test -x \"\$bin\"
  test ! -L \"\$bin\"
  resolved=\$(PATH='$UXTEST_REMOTE_HOME_ROOT/bin':\$PATH command -v coswarm)
  test \"\$resolved\" = \"\$bin\"
  case \"\$resolved\" in '$UXTEST_REMOTE_REPO'/*) exit 31 ;; esac
" >/dev/null || die "laptop persona PATH is not an isolated non-repo copy"

mini_sha="$(<"$UXTEST_MINI_HOME_ROOT/product/SOURCE_SHA")"
laptop_sha="$(remote_zsh "cat '$UXTEST_REMOTE_HOME_ROOT/product/SOURCE_SHA'")"
repo_dist_sha="$(bundle_sha "$UXTEST_REPO/dist")"
remote_dist_sha="$(remote_zsh "
  cd '$UXTEST_REMOTE_REPO/dist'
  find . -type f -print0 |
    LC_ALL=C sort -z |
    xargs -0 shasum -a 256 |
    shasum -a 256 |
    awk '{print \$1}'
")"
[ "$mini_sha" = "$laptop_sha" ] ||
  die "FAIL CLOSED: mini/laptop persona coswarm hashes differ"
[ "$mini_sha" = "$repo_dist_sha" ] ||
  die "mini persona copy is not the currently built repository output"
[ "$mini_sha" = "$remote_dist_sha" ] ||
  die "laptop persona copy is not Tom's currently built repository output"

mini_node="$(<"$UXTEST_MINI_HOME_ROOT/product/NODE_BIN")"
mini_version="$("$mini_node" "$UXTEST_MINI_HOME_ROOT/product/dist/cli.js" --help |
  head -n 1)"
laptop_version="$(remote_zsh "
  node_bin=\$(cat '$UXTEST_REMOTE_HOME_ROOT/product/NODE_BIN')
  \"\$node_bin\" '$UXTEST_REMOTE_HOME_ROOT/product/dist/cli.js' --help | head -n 1
")"
printf '%s\n' "$mini_version" | grep -Eq '^coswarm [0-9]' ||
  die "mini copied --help lacks the coswarm version line"
[ "$mini_version" = "$laptop_version" ] ||
  die "FAIL CLOSED: mini/laptop version lines differ"
remote_global_version="$(remote_zsh "/opt/homebrew/bin/coswarm --help | head -n 1")"
[ "$remote_global_version" = "$laptop_version" ] ||
  die "Tom's linked coswarm still serves a different build"
say "Version skew gate passed: $mini_sha ($mini_version)."

existing_18790="$(
  curl -fsS --max-time 2 \
    "http://127.0.0.1:18790/.well-known/agent-card.json" 2>/dev/null || true
)"
if [ -n "$existing_18790" ]; then
  existing_name="$(
    node -e '
      const value = JSON.parse(process.argv[1]);
      process.stdout.write(String(value.name ?? "unknown"));
    ' "$existing_18790"
  )"
  case "$existing_name" in
    Avery-r*|Dana-r*) die "uxtest must never use the mini's reserved port 18790" ;;
  esac
  say "Mini port 18790 belongs to '$existing_name'; it will not be touched."
else
  say "Mini port 18790 did not answer; the harness still reserves 18791 and will not touch it."
fi

base_members="$(remote_zsh "$UXTEST_REMOTE_SWARM_BIN members --swarm uxtest")"
printf '%s\n' "$base_members" | grep -Fq "Dana [" || die \
  "the one-time laptop launcher is absent. In a laptop cmux GUI tab run: mkdir -p ~/uxtest/human2/launcher && cd ~/uxtest/human2/launcher && swarm spawn --agent claude --name Dana --cwd ~/uxtest/human2/launcher --swarm uxtest --terminal cmux"
say "Persistent laptop launcher Dana is present in the base uxtest swarm."

setup="$(round_setup_path "$round")"
if [ -f "$setup" ]; then
  profile="$(profile_id)"
  [ ! -e "$HOME/.coswarm/credentials.d/$profile.profile.json" ] ||
    die "mini profile sidecar is warm after reset"
  remote_zsh "test ! -e '$UXTEST_REMOTE_HOME_ROOT/../.coswarm/credentials.d/$profile.profile.json'" ||
    die "laptop profile sidecar is warm after reset"
  if security find-generic-password -a "refresh:$profile" \
    -s io.ridge.coswarm >/dev/null 2>&1; then
    die "mini keychain still holds a warm coswarm login after reset"
  fi
  if remote_zsh "security find-generic-password -a 'refresh:$profile' -s io.ridge.coswarm >/dev/null 2>&1"; then
    die "laptop keychain still holds a warm coswarm login after reset"
  fi
  say "Round $round client-state reset is cold on both machines."
fi

say "Preflight passed for round $round."
