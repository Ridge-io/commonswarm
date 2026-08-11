#!/usr/bin/env bash
# Fail if any commit in the given range carries an author or committer address that is not on the
# measured allowlist.
#
# SCOPE, stated honestly because overstating it would be the defect: this is an ACCIDENT GUARD.
# A workflow living in the repo cannot police identity against a hostile change — GitHub runs the
# workflow that ships WITH the ref under test, so anything it reads can be supplied by the thing
# it is checking. It catches the class that actually happened: an agent picking up an address out
# of a session-context field and committing under it. It does not stop someone who means to.
#
# It is a CI job and not a git hook on purpose. Every offending push in the incident used
# --no-verify under a standing ruling that permits it, so a hook would have caught none of them.
#
# The allowlist is DERIVED BY MEASUREMENT, never written from memory. Enumerate first:
#     git log <ref> --format='%ae%n%ce' | sort | uniq -c | sort -rn
# Writing it from memory is how noreply@github.com — the committer on every squash merge — gets
# omitted and CI fails on main forever.
set -euo pipefail

RANGE="${1:-}"
if [ -z "$RANGE" ]; then
  echo "usage: $0 <git-range>   e.g. origin/main..HEAD" >&2
  exit 2
fi

# Measured on commonswarm main, 2026-08-11: these six cover 1792/1792 address-fields.
ALLOWED='
yulanbot@gmail.com
tom@ridge.io
noreply@github.com
quarry3@cloud-swarm.local
ferry@cloud-swarm.local
newel@cloud-swarm.local
'

# Non-routable agent-seat identities. A .local address cannot name an employer, so allowing the
# shape does not weaken the guard — the incident address was routable.
LOCAL_SUFFIXES='.local'

bad=0
checked=0
while IFS='|' read -r sha addr kind; do
  [ -z "${addr:-}" ] && continue
  checked=$((checked + 1))
  if printf '%s\n' "$ALLOWED" | grep -qxF "$addr"; then continue; fi
  case "$addr" in *"$LOCAL_SUFFIXES") continue;; esac
  printf 'DISALLOWED %s  %s  %s\n' "$kind" "$addr" "$sha"
  bad=$((bad + 1))
done < <(git log "$RANGE" --format='%h|%ae|author%n%h|%ce|committer')

if [ "$checked" -eq 0 ]; then
  echo "no commits in range $RANGE — nothing to check"
  exit 0
fi

if [ "$bad" -gt 0 ]; then
  cat >&2 <<'MSG'

COMMIT IDENTITY NOT ON THE ALLOWLIST.

If this is your address and it is legitimate, add it to ALLOWED in
scripts/check-commit-identity.sh in the same PR, and say in the commit message why.

If you did NOT choose this address, that is the defect this guard exists for: an agent seat can
pick an address out of a session-context field and commit under it. Do not pass -c user.email at
all; state the identity explicitly. Fix with:

    git -c user.email=<correct> commit --amend --reset-author     # last commit
    git rebase -r --exec 'git commit --amend --no-edit --reset-author' <base>   # several

This guard is accident-scope. It cannot stop a deliberate change, because GitHub runs the
workflow that ships with the ref under test.
MSG
  exit 1
fi

printf 'commit identity OK: %d address-fields checked in %s\n' "$checked" "$RANGE"
