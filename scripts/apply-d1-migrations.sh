#!/usr/bin/env bash
# Apply email-worker/migrations/*.sql to the socialisn2-inbox D1 database,
# tracking applied filenames in `_d1_migrations` so re-runs are no-ops.
#
# Called from:
#   - .github/workflows/bootstrap-d1.yml (one-shot)
#   - .github/workflows/deploy-workers.yml (every push that changes
#     email-worker/** or feed-worker/**, before either deploy runs)
#   - email-worker/package.json scripts.d1:apply:remote (operator)
#
# Handles three scenarios safely:
#
#   1. First-time apply (tracker absent). Creates the tracker, applies
#      every migration in lexicographic order, records each.
#
#   2. Subsequent applies (tracker present). Skips files already
#      recorded.
#
#   3. Pre-tracker manual application — i.e. the operator ran a
#      migration file directly via `wrangler d1 execute --file` before
#      this tracker existed. On apply the wrangler call fails with
#      "duplicate column" / "already exists"; we treat that as success
#      and record the file, so subsequent applies are no-ops.
#
# Requires CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in env.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/email-worker"

DB="socialisn2-inbox"

# Tracker table — idempotent.
npx --yes wrangler d1 execute "$DB" --remote --yes --command \
  "CREATE TABLE IF NOT EXISTS _d1_migrations (filename TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)" \
  > /dev/null

shopt -s nullglob
files=(migrations/*.sql)
shopt -u nullglob
if [ ${#files[@]} -eq 0 ]; then
  echo "No migration files in email-worker/migrations."
  exit 0
fi

# Sort lexicographically — NNNN_*.sql ordering.
IFS=$'\n' sorted=($(printf '%s\n' "${files[@]}" | sort))
unset IFS

for file in "${sorted[@]}"; do
  basename=$(basename "$file")

  applied=$(npx --yes wrangler d1 execute "$DB" --remote --json --command \
    "SELECT COUNT(*) AS n FROM _d1_migrations WHERE filename = '$basename'" \
    | jq -r '.[0].results[0].n // 0')

  if [ "$applied" = "1" ]; then
    echo "Skipping $basename (already applied)"
    continue
  fi

  echo "Applying $basename..."
  if npx --yes wrangler d1 execute "$DB" --remote --file="$file" --yes > /tmp/apply.out 2>&1; then
    cat /tmp/apply.out
  else
    cat /tmp/apply.out
    if grep -q -iE "duplicate column|already exists" /tmp/apply.out; then
      echo "  -> pre-applied schema detected, recording as applied"
    else
      echo "::error::Migration $basename failed"
      exit 1
    fi
  fi

  ts=$(($(date +%s) * 1000))
  npx --yes wrangler d1 execute "$DB" --remote --yes --command \
    "INSERT INTO _d1_migrations (filename, applied_at) VALUES ('$basename', $ts) ON CONFLICT DO NOTHING" \
    > /dev/null
done

echo "Migrations up to date."
