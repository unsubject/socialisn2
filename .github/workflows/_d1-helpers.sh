# Shared D1 REST API helper sourced by other workflows. Wraps the curl
# call so the SQL gets sent via parameterised payload (no shell→SQL
# concatenation) AND the response is validated at BOTH layers:
#
#   - HTTP non-OK (e.g. 4xx/5xx) fails via `curl -fsS`
#   - HTTP-200-but-envelope-failed (top-level `.success: false`, which
#     curl -fsS does NOT catch) is detected here and turned into a
#     non-zero exit
#   - HTTP-200-envelope-true-but-statement-failed (one or more entries
#     in `.result[]` have `.success: false`) is ALSO caught here. This
#     is the silent-failure surface Codex flagged on PR #37: a typo'd
#     table name or constraint trip can return a green envelope while
#     the statement actually failed; downstream callers that fall back
#     to `meta.rows_written // 0` would then report success having
#     deleted nothing.
#
# Without these checks, a destructive workflow can report green while
# having deleted nothing — see the reset-d1 review on PR #31.
#
# Usage:
#   source "${GITHUB_WORKSPACE}/.github/workflows/_d1-helpers.sh"
#   response=$(d1_query "SELECT ...")
#
# Requires CF_API_TOKEN, CF_ACCOUNT_ID, DB_ID in the calling env.

d1_query() {
  local sql="$1"
  local payload
  payload=$(jq -n --arg sql "$sql" '{sql: $sql}')
  local response
  response=$(curl -fsS -X POST \
    -H "Authorization: Bearer $CF_API_TOKEN" \
    -H "Content-Type: application/json" \
    --data "$payload" \
    "https://api.cloudflare.com/client/v4/accounts/$CF_ACCOUNT_ID/d1/database/$DB_ID/query")

  # Layer 1: envelope-level success.
  local ok
  ok=$(echo "$response" | jq -r '.success')
  if [ "$ok" != "true" ]; then
    echo "::error::D1 envelope returned success=false for: $sql" >&2
    echo "$response" | jq -c '.errors' >&2
    return 1
  fi

  # Layer 2: per-statement success. `.result` is an array (one entry per
  # statement); each entry has its own `success`. A non-empty result
  # with any false entry is treated as failure. `length==0` is also
  # failure — a successful query always yields at least one result row.
  local result_len
  result_len=$(echo "$response" | jq -r '.result | length')
  if [ "$result_len" -eq 0 ]; then
    echo "::error::D1 envelope was success=true but .result[] was empty for: $sql" >&2
    echo "$response" | jq -c '.' >&2
    return 1
  fi
  local all_ok
  all_ok=$(echo "$response" | jq -r '[.result[].success] | all')
  if [ "$all_ok" != "true" ]; then
    echo "::error::D1 envelope was success=true but at least one statement failed for: $sql" >&2
    echo "$response" | jq -c '.result' >&2
    return 1
  fi

  echo "$response"
}
