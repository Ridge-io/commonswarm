#!/usr/bin/env bash

set -euo pipefail
# shellcheck disable=SC1091
source "$(cd "$(dirname "$0")" && pwd -P)/_lib.sh"

mode="${1:-}"
path="${2:-}"
label="${3:-persona}"
round="${4:-}"

[ -n "$path" ] || die "verify-persona-workspace requires a path"

case "$mode" in
  sweep)
    assert_workspace_sweep "$path" "$label"
    ;;
  round)
    validate_round "$round"
    assert_round_brief_only "$path" "$label" "$round"
    ;;
  *)
    die "verify-persona-workspace mode must be sweep or round"
    ;;
esac
