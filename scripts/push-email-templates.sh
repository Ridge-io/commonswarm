#!/usr/bin/env bash
set -euo pipefail
umask 077

# Supabase's Management API treats sender identity as part of custom SMTP, not
# as independent template configuration. Sending smtp_admin_email or
# smtp_sender_name without smtp_host, smtp_port, smtp_user, and smtp_pass is
# rejected. As observed in production on 2026-07-29, that validation error is
# returned as HTTP 401 rather than 400; do not diagnose a bad access token from
# the status alone. The payload builder therefore emits no smtp_* fields unless
# the complete block is present, and refuses a partial block before any request.

usage() {
  cat <<'EOF'
Usage: scripts/push-email-templates.sh [--dry-run|--apply]

Compares CommonSwarm's rendered email templates with Supabase Auth configuration.
The default is --dry-run. --apply prints the same diff before sending one PATCH.

Required environment:
  SUPABASE_ACCESS_TOKEN          Supabase Management API access token
  SUPABASE_PROJECT_REF           Project reference to inspect

Optional environment:
  SUPABASE_MANAGEMENT_API_URL    Management API origin (default: https://api.supabase.com)

Optional custom SMTP block (provide all five or none):
  COMMONSWARM_SMTP_ADMIN_EMAIL   Operator-approved sender address
  COMMONSWARM_SMTP_HOST          SMTP server hostname
  COMMONSWARM_SMTP_PORT          SMTP server port
  COMMONSWARM_SMTP_USER          SMTP username
  COMMONSWARM_SMTP_PASS          SMTP password

Optional with the complete SMTP block:
  COMMONSWARM_SMTP_SENDER_NAME   From-line name (default: CommonSwarm)
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

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
repo_root="$(CDPATH= cd -- "$script_dir/.." && pwd)"
api_origin="${SUPABASE_MANAGEMENT_API_URL:-https://api.supabase.com}"
config_url="${api_origin%/}/v1/projects/${SUPABASE_PROJECT_REF}/config/auth"

work_dir="$(mktemp -d "${TMPDIR:-/tmp}/commonswarm-email-config.XXXXXX")"
trap 'rm -rf "$work_dir"' EXIT
desired_path="$work_dir/desired.json"
current_path="$work_dir/current.json"
diff_path="$work_dir/diff.json"
response_path="$work_dir/response"

node "$repo_root/site/emails/build-payload.mjs" >"$desired_path"

curl --fail --silent --show-error \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  "$config_url" \
  --output "$current_path"

if ! jq -e -s 'length == 1 and (.[0] | type == "object")' "$current_path" >/dev/null; then
  echo "Supabase returned a response that was not an auth configuration object." >&2
  exit 1
fi

if ! jq -e -s 'length == 1 and (.[0] | type == "object")' "$desired_path" >/dev/null; then
  echo "The CommonSwarm email payload builder returned invalid JSON." >&2
  exit 1
fi

jq -s '
  .[0] as $current |
  .[1] as $desired |
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
' "$current_path" "$desired_path" >"$diff_path"

changed_count="$(jq 'length' "$diff_path")"
if [[ "$changed_count" -eq 0 ]]; then
  echo "No changes. Supabase already matches all CommonSwarm email fields."
  exit 0
fi

echo "CommonSwarm auth email diff: $changed_count field(s) would change."
while IFS= read -r field_name; do
  if [[ "$field_name" == "smtp_pass" ]]; then
    echo "--- current/smtp_pass"
    echo "+++ desired/smtp_pass"
    echo "@@ value would be sent; contents redacted @@"
    continue
  fi
  jq -r --arg field "$field_name" '.[$field].before // ""' "$diff_path" >"$work_dir/before"
  jq -r --arg field "$field_name" '.[$field].after' "$diff_path" >"$work_dir/after"
  diff_status=0
  diff -u \
    --label "current/$field_name" \
    --label "desired/$field_name" \
    "$work_dir/before" \
    "$work_dir/after" || diff_status=$?
  if [[ "$diff_status" -gt 1 ]]; then
    echo "Could not render diff for $field_name." >&2
    exit "$diff_status"
  fi
done < <(jq -r 'keys[]' "$diff_path")

if [[ "$mode" == "dry-run" ]]; then
  echo "Dry run only. Re-run with --apply to send this PATCH."
  exit 0
fi

patch_status=0
curl --fail-with-body --silent --show-error \
  -X PATCH \
  -H "Authorization: Bearer $SUPABASE_ACCESS_TOKEN" \
  -H "Content-Type: application/json" \
  --data-binary "@$desired_path" \
  "$config_url" \
  --output "$response_path" || patch_status=$?

if [[ "$patch_status" -ne 0 ]]; then
  if [[ -s "$response_path" ]]; then
    echo "Supabase PATCH response (an HTTP 401 may be validation, not bad authentication):" >&2
    node - "$response_path" <<'NODE' >&2
const { readFileSync } = require("node:fs");
const responsePath = process.argv[2];
const secret = process.env.COMMONSWARM_SMTP_PASS;
let body = readFileSync(responsePath, "utf8");
if (secret) {
  body = body.split(secret).join("[redacted]");
}
for (const line of body.split(/\r?\n/)) {
  process.stderr.write(`  ${line}\n`);
}
NODE
  fi
  exit "$patch_status"
fi

echo "Applied $changed_count CommonSwarm auth email field change(s)."
