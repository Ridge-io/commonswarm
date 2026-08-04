#!/bin/sh
# CommonSwarm installer.  Usage:
#
#   curl -fsSL https://<host>/install.sh | sh
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
REPO="${CSWARM_REPO:-Ridge-io/cloud-swarm}"
VERSION="${CSWARM_VERSION:-latest}"
INSTALL_DIR="${CSWARM_INSTALL_DIR:-$HOME/.local/bin}"

die() { printf '\nCommonSwarm install failed: %s\n\n' "$1" >&2; exit 1; }

# --- Node check first. -------------------------------------------------------
# CommonSwarm ships JavaScript, not a native binary. Checking here means the failure
# is one clear sentence instead of "node: command not found" from a shebang later.
# A bare `command -v node` is correct but its ADVICE is wrong for a large share of users.
# Version managers (nvm, fnm, asdf) put node on PATH from a shell init file, so node is
# invisible to any non-login, non-interactive shell -- ssh, CI, docker exec, a GUI-spawned
# process. Telling someone who already runs v24 under nvm to "brew install node" is a false
# statement on the very first thing they see. So we say WHERE we looked, and name the case.
command -v node >/dev/null 2>&1 || die \
"CommonSwarm needs Node.js 24 or newer, and node was not found on this PATH:

  $PATH

If you use a version manager (nvm, fnm, asdf), node is set up by your shell's startup
files and is not visible to a non-interactive shell. That is the most likely cause here.
Open a normal terminal and run this installer again, or run it through a login shell:

  zsh -lic 'curl -fsSL <url>/install.sh | sh'

If you genuinely do not have Node yet:

  macOS:  brew install node
  other:  https://nodejs.org/en/download"

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 24 ] 2>/dev/null || die \
"CommonSwarm needs Node.js 24 or newer. You have $(node -v 2>/dev/null || echo 'an unknown version').

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
mkdir -p "$INSTALL_DIR" || die "could not create $INSTALL_DIR"

# cswarm ships as a CommonJS bundle in a file with no extension. Node decides
# CJS-vs-ESM from the NEAREST package.json, so installing under a directory tree that
# contains one with "type":"module" makes node load it as ESM and die with
# `require is not defined in ES module scope` — a baffling error for an install that
# otherwise succeeded. Standard bin dirs have no package.json; check anyway and say so
# plainly rather than letting the user meet that message.
_d="$INSTALL_DIR"
while [ "$_d" != "/" ] && [ -n "$_d" ]; do
  if [ -f "$_d/package.json" ] && grep -q '"type"[[:space:]]*:[[:space:]]*"module"' "$_d/package.json" 2>/dev/null; then
    die "$INSTALL_DIR sits under $_d, whose package.json declares \"type\": \"module\".
Node would load cswarm as an ES module and it would fail with a confusing error.

Install somewhere outside that tree, e.g.:
  CSWARM_INSTALL_DIR=\$HOME/.local/bin curl -fsSL <url>/install.sh | sh"
  fi
  _d="$(dirname "$_d")"
done
chmod +x "$TMP/cswarm"
mv "$TMP/cswarm" "$INSTALL_DIR/cswarm" || die "could not write to $INSTALL_DIR
Try:  CSWARM_INSTALL_DIR=/usr/local/bin curl -fsSL <url>/install.sh | sudo sh"

# Read the version back OUT OF THE INSTALLED FILE rather than echoing what we meant to
# install. `--version` already prints "cswarm X.Y.Z (protocol A.B.C)", so print that line
# as-is instead of prefixing it — an earlier draft produced "Installed cswarm cswarm 0.0.1".
INSTALLED_VERSION="$("$INSTALL_DIR/cswarm" --version 2>/dev/null | head -1 || true)"
if [ -n "$INSTALLED_VERSION" ]; then
  printf '\nInstalled %s\n  -> %s\n' "$INSTALLED_VERSION" "$INSTALL_DIR/cswarm"
else
  printf '\nInstalled cswarm to %s\n' "$INSTALL_DIR/cswarm"
  printf '  (warning: the installed binary did not report a version)\n'
fi

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
printf '  read -r LINK    # paste the link, then press Enter\n'
printf '  printf %%s "$LINK" | cswarm accept --link-stdin\n\n'
printf 'The link is piped in rather than passed as an argument, because an argument would\n'
printf 'leave a live capability in your shell history and in the process list.\n'
printf '\nNo invite? Make your own workspace. It is free and takes no card:\n\n'
printf '  https://commonswarm.com/app\n\n'
# `<project name>`, not `<workspace name>`: that is the placeholder `cswarm --help` prints
# for this command, and a line shown to someone who has not run --help yet must match what
# they will read when they do. (The two nouns disagree across the product -- the site and
# the docs say "workspace" throughout. That drift is real and is not this file's to settle.)
printf 'Or stay in the terminal:\n\n  cswarm login\n  cswarm new "<project name>"\n\n'
printf 'And this works right now, with no account and no network:\n\n  cswarm --help\n\n'
