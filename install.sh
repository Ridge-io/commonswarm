#!/bin/sh
# CommonSwarm installer.  Usage:
#
#   curl -fsSL https://commonswarm.com/install.sh | sh
#
# Installs a single file to ~/.local/bin/cswarm (no sudo, no node_modules).
# Override with CSWARM_INSTALL_DIR=/usr/local/bin, or CSWARM_VERSION=x.y.z.
#
# POSIX sh on purpose: this runs before we know anything about the machine.
set -eu

# Releases live beside their source, on the public repo. The old default was
# Ridge-io/coswarm-dist — a repo that CARRIED THE RETIRED PRODUCT NAME AND NEVER EXISTED, so
# this installer 404'd for every stranger who ran it. The separate -dist repo was specified
# back when source was going to stay private; source is public now, so the reason is gone.
#
# Repointed from Ridge-io/cloud-swarm to Ridge-io/commonswarm on 2026-08-10. That was NOT a
# rename: cloud-swarm's history carried two operator work addresses in commit metadata, and a
# force-push cannot purge them because GitHub keeps unreachable objects fetchable by SHA. A new
# repo never receives them.
#
# ORDERING, because it is not obvious and it 404s every install if you get it wrong: site's
# `sync:installer` copies THIS FILE into site/public/ on EVERY build, so changing the line below
# ships on the next site deploy whether or not that deploy was about the installer. It was
# changed only after commonswarm was public and serving all 14 releases, and after a real
# install from it was verified with CSWARM_REPO= as an override.
REPO="${CSWARM_REPO:-Ridge-io/commonswarm}"
VERSION="${CSWARM_VERSION:-latest}"
# Accept both `0.1.12` and `v0.1.12`. The URL below adds its own `v`, so a value copied from the
# releases page — where all 14 tags are displayed WITH the v — built `.../download/vv0.1.12` and
# 404'd. The failure names the version, so it reads as "that release does not exist".
VERSION="${VERSION#v}"
INSTALL_DIR="${CSWARM_INSTALL_DIR:-$HOME/.local/bin}"

die() { printf '\nCommonSwarm install failed: %s\n\n' "$1" >&2; exit 1; }

# --- Node check first. -------------------------------------------------------
# CommonSwarm ships JavaScript, not a native binary. Checking here means the failure
# is one clear sentence instead of "node: command not found" from a shebang later.
# A bare `command -v node` is correct but its ADVICE is wrong for a large share of users.
# Version managers (nvm, fnm, asdf) put node on PATH from a shell init file, so node is
# invisible to any non-login, non-interactive shell -- ssh, CI, docker exec, a GUI-spawned
# process. Telling someone who already runs v22 under nvm to "brew install node" is a false
# statement on the very first thing they see. So we say WHERE we looked, and name the case.
command -v node >/dev/null 2>&1 || die \
"CommonSwarm needs Node.js 22 or newer, and node was not found on this PATH:

  $PATH

If you use a version manager (nvm, fnm, asdf), node is set up by your shell's startup
files and is not visible to a non-interactive shell. That is the most likely cause here.
Open a normal terminal and run this installer again, or run it through a login shell:

  zsh -lic 'curl -fsSL https://commonswarm.com/install.sh | sh'

If you genuinely do not have Node yet:

  macOS:  brew install node
  other:  https://nodejs.org/en/download"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 22 ] 2>/dev/null || die \
"CommonSwarm needs Node.js 22 or newer. You have $(node -v 2>/dev/null || echo 'an unknown version').

  macOS:  brew upgrade node
  other:  https://nodejs.org/en/download"

# --- Resolve the download URL. -----------------------------------------------
# CSWARM_BASE_URL exists so this installer can be TESTED against a local server
# before it is published. An installer nobody has run is the same class of defect as
# a check that cannot fail.
if [ -n "${CSWARM_BASE_URL:-}" ]; then
  BASE="$CSWARM_BASE_URL"
elif [ "$VERSION" = "latest" ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/v$VERSION"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

printf 'Downloading cswarm (%s)...\n' "$VERSION"
curl -fsSL "$BASE/cswarm"        -o "$TMP/cswarm" \
  || die "could not download $BASE/cswarm
If this is a private release you will need access; ask whoever invited you."
curl -fsSL "$BASE/cswarm.sha256" -o "$TMP/cswarm.sha256" \
  || die "downloaded the binary but not its checksum from $BASE — refusing to install unverified."

# --- Verify before installing. -----------------------------------------------
# A curl|sh installer that does not check its own download is the thing people are
# right to be afraid of. This is not optional and there is no flag to skip it.
EXPECTED="$(cut -d' ' -f1 < "$TMP/cswarm.sha256")"
if command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 "$TMP/cswarm" | cut -d' ' -f1)"
elif command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$TMP/cswarm" | cut -d' ' -f1)"
else
  die "no shasum or sha256sum available to verify the download — refusing to install."
fi
[ "$EXPECTED" = "$ACTUAL" ] || die \
"checksum mismatch — the download does not match its published checksum.
  expected $EXPECTED
  actual   $ACTUAL
Nothing was installed."

# --- Install. ----------------------------------------------------------------
mkdir -p -- "$INSTALL_DIR" || die "could not create $INSTALL_DIR"

# cswarm ships as a CommonJS bundle in a file with no extension. Node decides
# CJS-vs-ESM from the NEAREST package.json, so installing under a directory tree that
# contains one with "type":"module" makes node load it as ESM and die with
# `require is not defined in ES module scope` — a baffling error for an install that
# otherwise succeeded. Standard bin dirs have no package.json; check anyway and say so
# plainly rather than letting the user meet that message.
# Start this parent walk from a physical absolute path. Besides making each parent real,
# this prevents `dirname .` from looping forever for a relative install directory such as
# `-bin` or `./bin`.
_d="$(CDPATH='' cd -P -- "$INSTALL_DIR" 2>/dev/null && pwd -P)" \
  || die "could not inspect $INSTALL_DIR after creating it"
while [ "$_d" != "/" ] && [ -n "$_d" ]; do
  if [ -f "$_d/package.json" ] && grep -q '"type"[[:space:]]*:[[:space:]]*"module"' "$_d/package.json" 2>/dev/null; then
    die "$INSTALL_DIR sits under $_d, whose package.json declares \"type\": \"module\".
Node would load cswarm as an ES module and it would fail with a confusing error.

Install somewhere outside that tree, e.g.:
  curl -fsSL https://commonswarm.com/install.sh | CSWARM_INSTALL_DIR=\$HOME/bin sh"
  fi
  _d="$(dirname -- "$_d")"
done
chmod +x "$TMP/cswarm"
mv -- "$TMP/cswarm" "$INSTALL_DIR/cswarm" || die "could not write to $INSTALL_DIR
Try:  curl -fsSL https://commonswarm.com/install.sh | sudo env CSWARM_INSTALL_DIR=/usr/local/bin sh"

# Select and normalize the same version line for both the installed-file and PATH probes.
# A runtime can write a banner before it, and CRLF leaves a carriage return on the last field.
cswarm_version_line() {
  printf '%s\n' "${1:-}" | awk '
    {
      sub(/\r$/, "", $0)
      if ($1 == "cswarm" && NF >= 2) {
        line = $0
        sub(/^[[:space:]]+/, "", line)
        sub(/[[:space:]]+$/, "", line)
        print line
        found = 1
        exit
      }
    }
    END { if (!found) exit 1 }
  '
}

cswarm_release() {
  printf '%s\n' "${1:-}" | awk '
    $1 == "cswarm" && NF >= 2 {
      release = $2
      sub(/\r$/, "", release)
      print release
      found = 1
      exit
    }
    END { if (!found) exit 1 }
  '
}

# Read the version back OUT OF THE INSTALLED FILE rather than echoing what we meant to
# install. `--version` already prints "cswarm X.Y.Z (protocol A.B.C)", so print that line
# as-is instead of prefixing it — an earlier draft produced "Installed cswarm cswarm 0.0.1".
_INSTALLED_VERSION_OUTPUT="$("$INSTALL_DIR/cswarm" --version 2>/dev/null || true)"
INSTALLED_VERSION="$(cswarm_version_line "$_INSTALLED_VERSION_OUTPUT")" || INSTALLED_VERSION=""
INSTALLED_RELEASE="$(cswarm_release "$INSTALLED_VERSION")" || INSTALLED_RELEASE=""
if [ -n "$INSTALLED_VERSION" ]; then
  printf '\nInstalled %s\n  -> %s\n' "$INSTALLED_VERSION" "$INSTALL_DIR/cswarm"
else
  printf '\nInstalled cswarm to %s\n' "$INSTALL_DIR/cswarm"
  printf '  (warning: the installed binary did not report a version)\n'
fi

# The installed file can be healthy while an older copy earlier in PATH keeps winning.
# Check the command the user's shell will actually run, but never turn their PATH state into
# an install failure. The direct installed-file probe above remains the source of truth for
# the version we just wrote.
warn_if_cswarm_is_shadowed() {
  canonical_cswarm_path() {
    _CANONICAL_INPUT="${1:-}"
    [ -n "$_CANONICAL_INPUT" ] || return 1

    # POSIX sh has no portable readlink -f. Follow file symlinks one hop at a time,
    # resolving relative targets from the directory that contains each link.
    _CANONICAL_HOPS=0
    while [ -L "$_CANONICAL_INPUT" ]; do
      _CANONICAL_HOPS=$((_CANONICAL_HOPS + 1))
      [ "$_CANONICAL_HOPS" -le 32 ] || return 1
      _CANONICAL_DIRNAME="$(dirname -- "$_CANONICAL_INPUT" 2>/dev/null)" || return 1
      _CANONICAL_TARGET="$(readlink -- "$_CANONICAL_INPUT" 2>/dev/null)" || return 1
      case "$_CANONICAL_TARGET" in
        /*) _CANONICAL_INPUT="$_CANONICAL_TARGET" ;;
        *) _CANONICAL_INPUT="$_CANONICAL_DIRNAME/$_CANONICAL_TARGET" ;;
      esac
    done

    _CANONICAL_DIRNAME="$(dirname -- "$_CANONICAL_INPUT" 2>/dev/null)" || return 1
    _CANONICAL_BASENAME="$(basename -- "$_CANONICAL_INPUT" 2>/dev/null)" || return 1
    _CANONICAL_PARENT="$(CDPATH='' cd -P -- "$_CANONICAL_DIRNAME" 2>/dev/null && pwd -P)" || return 1
    printf '%s/%s\n' "$_CANONICAL_PARENT" "$_CANONICAL_BASENAME"
  }

  PATH_CSWARM="$(command -v cswarm 2>/dev/null || true)"
  [ -n "$PATH_CSWARM" ] || return 0

  _PATH_VERSION_OUTPUT="$("$PATH_CSWARM" --version 2>/dev/null || true)"
  PATH_VERSION="$(cswarm_version_line "$_PATH_VERSION_OUTPUT")" || PATH_VERSION=""
  PATH_RELEASE="$(cswarm_release "$PATH_VERSION")" || PATH_RELEASE=""

  INSTALLED_CANONICAL="$(canonical_cswarm_path "$INSTALL_DIR/cswarm")" || INSTALLED_CANONICAL=""
  PATH_CANONICAL="$(canonical_cswarm_path "$PATH_CSWARM")" || PATH_CANONICAL=""

  PATH_MISMATCH=""
  if [ -n "$INSTALLED_CANONICAL" ] && [ -n "$PATH_CANONICAL" ]; then
    if [ "$PATH_CANONICAL" != "$INSTALLED_CANONICAL" ]; then
      PATH_MISMATCH="path"
    elif [ -n "$INSTALLED_RELEASE" ] && [ -n "$PATH_RELEASE" ] && [ "$PATH_RELEASE" != "$INSTALLED_RELEASE" ]; then
      PATH_MISMATCH="version"
    fi
  fi

  if [ -n "$PATH_MISMATCH" ]; then
    printf '\nWARNING: cswarm on PATH does not match the cswarm just installed.\n' >&2
    printf '  installed: %s\n' "$INSTALL_DIR/cswarm" >&2
    printf '  PATH uses: %s\n' "$PATH_CSWARM" >&2
    printf '  installed version: %s\n' "${INSTALLED_VERSION:-unavailable}" >&2
    printf '  PATH version: %s\n' "${PATH_VERSION:-unavailable (cswarm --version failed)}" >&2

    UPDATE_VERSION="${INSTALLED_RELEASE:-${VERSION:-latest}}"
    if [ "$PATH_MISMATCH" = "path" ]; then
      printf '\nUpdate the copy that wins in PATH. If it is an npm-global install:\n\n' >&2
      printf '  npm i -g commonswarm@%s\n\n' "$UPDATE_VERSION" >&2
      printf 'Or put %s earlier in PATH.\n' "$INSTALL_DIR" >&2
    else
      printf '\nReinstall or update this copy. If it is an npm-global install:\n\n' >&2
      printf '  npm i -g commonswarm@%s\n' "$UPDATE_VERSION" >&2
    fi
  fi
}
warn_if_cswarm_is_shadowed || true

# --- PATH guidance. ----------------------------------------------------------
# Silently installing to a directory the user's shell cannot see is the most common
# way a working install looks broken.
case ":$PATH:" in
  *":$INSTALL_DIR:"*) ;;
  *)
    printf '\n%s is not on your PATH. Add it:\n\n' "$INSTALL_DIR"
    case "${SHELL:-}" in
      */zsh) printf "  echo 'export PATH=\"%s:\$PATH\"' >> ~/.zprofile && exec zsh -l\n" "$INSTALL_DIR" ;;
      */bash) printf "  echo 'export PATH=\"%s:\$PATH\"' >> ~/.bash_profile && exec bash -l\n" "$INSTALL_DIR" ;;
      *) printf '  export PATH="%s:$PATH"\n' "$INSTALL_DIR" ;;
    esac
    ;;
esac

# --- What to do next. --------------------------------------------------------
# Two kinds of people reach this line and only one of them was invited. An earlier draft
# said only "accept your invite", which is a dead end for anyone who arrived cold.
#
# WITH a link: `accept` is the only first-contact verb that needs no --url, because the
# link carries its own target. Sending someone to `login` would send them looking for a
# project URL that has no page to come from.
#
# WITHOUT one: sign them up. This used to read "invite-only today; creating your own
# workspace is not open yet", which was correct for exactly as long as SWARM_SELF_SERVE was
# unset in production -- create_workspace sits behind that flag in the edge function. It was
# turned on 2026-07-28, and NOTHING IN THIS FILE CHANGES WHEN THAT HAPPENS, so the installer
# went on telling every new user they could not have the thing they could now have. If the
# flag is ever turned off again, `cswarm new` prints "not open on this deployment yet" and
# this paragraph has to come back with it.
# The mechanism here was WRONG until 2026-08-04 and it broke the primary onboarding path.
# It said "cswarm accept --link-stdin" then "Paste the link when prompted". There is no
# prompt: --link-stdin reads stdin and REFUSES a TTY ("--link-stdin requires an invite link
# to be piped on stdin"), so paste-then-Ctrl-D does not work either. A stranger holding an
# invite link and following this text was stopped at the first instruction. Found by a
# second-machine dogfood on production, not by any test -- nothing here is executed by a gate.
# The stated REASON was always right and is kept; only the method was fiction. Piping is also
# what README.md documents.
printf '\nNext, if you have an invite link:\n\n'
# `-rs`, not `-r`: `-s` keeps the link off the screen and out of scrollback. Without it this
# text was telling a stranger to echo a live capability to their terminal on the line directly
# above the sentence explaining why we keep capabilities out of shell history -- the reason was
# right and the method contradicted it. README.md uses `read -rs` for the agent-token path for
# the same reason. The trailing `echo` restores the newline that `-s` swallows. Found by a
# second-machine dogfood on the shipped installer; nothing here is executed by a gate.
printf '  read -rs LINK; echo    # paste the link, then press Enter (stays hidden)\n'
printf '  printf %%s "$LINK" | cswarm accept --link-stdin\n\n'
printf 'The link is piped in rather than passed as an argument, and read hides it as you paste,\n'
printf 'because either would leave a live capability on screen, in your shell history, or in\n'
printf 'the process list.\n'
printf '\nNo invite? Make your own workspace. It is free and takes no card:\n\n'
printf '  https://commonswarm.com/app\n\n'
# `<workspace name>`: this must match the placeholder `cswarm --help` prints for this
# command, because a line shown to someone who has not run --help yet must match what they
# will read when they do. The two move together or not at all.
#
# It said `<project name>` until 2026-08-10. The drift this comment described -- the CLI
# saying "project" while the site and docs said "workspace" -- was MEASURED at 16 project to
# 11 workspace in cli.ts prose, and settled in favour of "workspace": that is what the schema
# (swarm.workspaces), the flag (--workspace-id) and the design doc already say. Someone else's
# "project" is left alone: Supabase's project base URL and OpenCode's project cwd are their
# nouns, not ours.
printf 'Or stay in the terminal:\n\n  cswarm login\n  cswarm new "<workspace name>"\n\n'
printf 'And this works right now, with no account and no network:\n\n  cswarm --help\n\n'
