#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage: scripts/push-email-templates.sh [--dry-run|--apply]

Compares CommonSwarm's rendered email templates with Supabase Auth configuration.
The default is --dry-run. --apply prints the same diff before sending one PATCH.

Required environment:
  SUPABASE_ACCESS_TOKEN          Supabase Management API access token
  SUPABASE_PROJECT_REF           Project reference to inspect
  COMMONSWARM_SMTP_ADMIN_EMAIL   Real sender address selected by the operator

Optional environment:
  SUPABASE_MANAGEMENT_API_URL    Management API origin (default: https://api.supabase.com)
EOF
}

mode="dry-run"
case "${1:-}" in
  "")
    ;;
  --dry-run)
    ;;
  --apply)
    mode="apply"
    ;;
  --help|-h)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit 2
    ;;
esac

for command_name in curl jq node; do
  if ! command -v "$command_name" >/dev/null 2>&1; then
    echo "Required command not found: $command_name" >&2
    exit 1
  fi
done

: "${SUPABASE_ACCESS_TOKEN:?Set SUPABASE_ACCESS_TOKEN to a Supabase Management API token}"
: "${SUPABASE_PROJECT_REF:?Set SUPABASE_PROJECT_REF to the target project reference}"
: "${COMMONSWARM_SMTP_ADMIN_EMAIL:?Set COMMONSWARM_SMTP_ADMIN_EMAIL to the operator-approved sender address}"

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
api_origin="${SUPABASE_MANAGEMENT_API_URL:-https://api.supabase.com}"
config_url="${api_origin%/}/v1/projects/${SUPABASE_PROJECT_REF}/config/auth"

desired_json="$(
  COMMONSWARM_SMTP_ADMIN_EMAIL="$COMMONSWARM_SMTP_ADMIN_EMAIL" \
    node "$repo_root/site/emails/build-payload.mjs"
)"

current_json="$(
  curl --fail --silent --show-error \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    "$config_url"
)"

if ! jq -e 'type == "object"' >/dev/null <<<"$current_json"; then
  echo "Supabase returned a response that was not an auth configuration object." >&2
  exit 1
fi

diff_json="$(
  jq -n \
    --argjson current "$current_json" \
    --argjson desired "$desired_json" '
      reduce ($desired | keys[]) as $key
        ({};
          if ($current | has($key)) and $current[$key] == $desired[$key]
          then .
          else .[$key] = {
            before: (if $current | has($key) then $current[$key] else null end),
            after: $desired[$key]
          }
          end
        )
    '
)"

changed_count="$(jq 'length' <<<"$diff_json")"
if [[ "$changed_count" -eq 0 ]]; then
  echo "No changes. Supabase already matches all CommonSwarm email fields."
  exit 0
fi

diff_dir="$(mktemp -d "${TMPDIR:-/tmp}/commonswarm-email-diff.XXXXXX")"
trap 'rm -rf "$diff_dir"' EXIT

echo "CommonSwarm auth email diff: $changed_count field(s) would change."
while IFS= read -r field_name; do
  jq -r --arg field "$field_name" '.[$field].before // ""' <<<"$diff_json" >"$diff_dir/before"
  jq -r --arg field "$field_name" '.[$field].after' <<<"$diff_json" >"$diff_dir/after"
  diff_status=0
  diff -u \
    --label "current/$field_name" \
    --label "desired/$field_name" \
    "$diff_dir/before" \
    "$diff_dir/after" || diff_status=$?
  if [[ "$diff_status" -gt 1 ]]; then
    echo "Could not render diff for $field_name." >&2
    exit "$diff_status"
  fi
done < <(jq -r 'keys[]' <<<"$diff_json")

if [[ "$mode" == "dry-run" ]]; then
  echo "Dry run only. Re-run with --apply to send this PATCH."
  exit 0
fi

printf '%s' "$desired_json" |
  curl --fail --silent --show-error \
    -X PATCH \
    -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
    -H "Content-Type: application/json" \
    --data-binary @- \
    "$config_url" \
    >/dev/null

echo "Applied $changed_count CommonSwarm auth email field change(s)."
