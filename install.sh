#!/bin/sh
# coswarm installer.  Usage:
#
#   curl -fsSL https://<host>/install.sh | sh
#
# Installs a single file to ~/.local/bin/coswarm (no sudo, no node_modules).
# Override with COSWARM_INSTALL_DIR=/usr/local/bin, or COSWARM_VERSION=x.y.z.
#
# POSIX sh on purpose: this runs before we know anything about the machine.
set -eu

REPO="${COSWARM_REPO:-Ridge-io/coswarm-dist}"
VERSION="${COSWARM_VERSION:-latest}"
INSTALL_DIR="${COSWARM_INSTALL_DIR:-$HOME/.local/bin}"

die() { printf '\ncoswarm install failed: %s\n\n' "$1" >&2; exit 1; }

# --- Node check first. -------------------------------------------------------
# coswarm ships JavaScript, not a native binary. Checking here means the failure
# is one clear sentence instead of "node: command not found" from a shebang later.
command -v node >/dev/null 2>&1 || die \
"coswarm needs Node.js 24 or newer, and node was not found on your PATH.

  macOS:  brew install node
  other:  https://nodejs.org/en/download

Then run this installer again."

NODE_MAJOR="$(node -p 'process.versions.node.split(".")[0]' 2>/dev/null || echo 0)"
[ "$NODE_MAJOR" -ge 24 ] 2>/dev/null || die \
"coswarm needs Node.js 24 or newer. You have $(node -v 2>/dev/null || echo 'an unknown version').

  macOS:  brew upgrade node
  other:  https://nodejs.org/en/download"

# --- Resolve the download URL. -----------------------------------------------
# COSWARM_BASE_URL exists so this installer can be TESTED against a local server
# before it is published. An installer nobody has run is the same class of defect as
# a check that cannot fail.
if [ -n "${COSWARM_BASE_URL:-}" ]; then
  BASE="$COSWARM_BASE_URL"
elif [ "$VERSION" = "latest" ]; then
  BASE="https://github.com/$REPO/releases/latest/download"
else
  BASE="https://github.com/$REPO/releases/download/v$VERSION"
fi

TMP="$(mktemp -d)"
trap 'rm -rf "$TMP"' EXIT INT TERM

printf 'Downloading coswarm (%s)...\n' "$VERSION"
curl -fsSL "$BASE/coswarm"        -o "$TMP/coswarm" \
  || die "could not download $BASE/coswarm
If this is a private release you will need access; ask whoever invited you."
curl -fsSL "$BASE/coswarm.sha256" -o "$TMP/coswarm.sha256" \
  || die "downloaded the binary but not its checksum from $BASE — refusing to install unverified."

# --- Verify before installing. -----------------------------------------------
# A curl|sh installer that does not check its own download is the thing people are
# right to be afraid of. This is not optional and there is no flag to skip it.
EXPECTED="$(cut -d' ' -f1 < "$TMP/coswarm.sha256")"
if command -v shasum >/dev/null 2>&1; then
  ACTUAL="$(shasum -a 256 "$TMP/coswarm" | cut -d' ' -f1)"
elif command -v sha256sum >/dev/null 2>&1; then
  ACTUAL="$(sha256sum "$TMP/coswarm" | cut -d' ' -f1)"
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

# coswarm ships as a CommonJS bundle in a file with no extension. Node decides
# CJS-vs-ESM from the NEAREST package.json, so installing under a directory tree that
# contains one with "type":"module" makes node load it as ESM and die with
# `require is not defined in ES module scope` — a baffling error for an install that
# otherwise succeeded. Standard bin dirs have no package.json; check anyway and say so
# plainly rather than letting the user meet that message.
_d="$INSTALL_DIR"
while [ "$_d" != "/" ] && [ -n "$_d" ]; do
  if [ -f "$_d/package.json" ] && grep -q '"type"[[:space:]]*:[[:space:]]*"module"' "$_d/package.json" 2>/dev/null; then
    die "$INSTALL_DIR sits under $_d, whose package.json declares \"type\": \"module\".
Node would load coswarm as an ES module and it would fail with a confusing error.

Install somewhere outside that tree, e.g.:
  COSWARM_INSTALL_DIR=\$HOME/.local/bin curl -fsSL <url>/install.sh | sh"
  fi
  _d="$(dirname "$_d")"
done
chmod +x "$TMP/coswarm"
mv "$TMP/coswarm" "$INSTALL_DIR/coswarm" || die "could not write to $INSTALL_DIR
Try:  COSWARM_INSTALL_DIR=/usr/local/bin curl -fsSL <url>/install.sh | sudo sh"

# Read the version back OUT OF THE INSTALLED FILE rather than echoing what we meant to
# install. `--version` already prints "coswarm X.Y.Z (protocol A.B.C)", so print that line
# as-is instead of prefixing it — an earlier draft produced "Installed coswarm coswarm 0.0.1".
INSTALLED_VERSION="$("$INSTALL_DIR/coswarm" --version 2>/dev/null | head -1 || true)"
if [ -n "$INSTALLED_VERSION" ]; then
  printf '\nInstalled %s\n  -> %s\n' "$INSTALLED_VERSION" "$INSTALL_DIR/coswarm"
else
  printf '\nInstalled coswarm to %s\n' "$INSTALL_DIR/coswarm"
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
# Access is by invitation and `accept` is the only first-contact verb that needs no
# --url, because an invite link carries its own target. Sending someone to `login`
# would send them looking for a project URL that has no page to come from.
printf '\nNext: accept your invite.\n\n  coswarm accept <invite-link>\n\n'
