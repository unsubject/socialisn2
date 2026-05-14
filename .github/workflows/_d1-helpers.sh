# Shared D1 REST API helper sourced by other workflows. Wraps the curl
# call so the SQL gets sent via parameterised payload (no shell→SQL
# concatenation) AND the response is validated:
#
#   - HTTP non-OK (e.g. 4xx/5xx) fails via `curl -fsS`
#   - HTTP-200-but-SQL-failed (success: false in body, which curl -fsS
#     does NOT catch) is detected here and turned into a non-zero exit
#
# Without that body-level check, a destructive workflow can report green
# while having deleted nothing — see the reset-d1 review on PR #31.
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
  local ok
  ok=$(echo "$response" | jq -r '.success')
  if [ "$ok" != "true" ]; then
    echo "::error::D1 returned success=false for: $sql" >&2
    echo "$response" | jq -c '.errors' >&2
    return 1
  fi
  echo "$response"
}
