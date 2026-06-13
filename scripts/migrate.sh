#!/usr/bin/env bash
# Migration reconciler for job-pipeline D1.
#
# Reads target version from config.json, reads applied version from the real DB,
# then dry-runs on the sandbox DB before touching production.
#
# Usage:
#   ./scripts/migrate.sh           # local wrangler dev
#   ./scripts/migrate.sh --remote  # production D1 (requires CF creds in env)

set -euo pipefail

REMOTE_FLAG=""
if [[ "${1:-}" == "--remote" ]]; then
  REMOTE_FLAG="--remote"
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
MIGRATIONS_DIR="$ROOT_DIR/migrations"
CONFIG_FILE="$ROOT_DIR/config.json"
SNAPS_DIR="$ROOT_DIR/.migration-snaps"

DB_NAME="job-pipeline"
SANDBOX_DB_NAME="resumaestro-pipeline-sandbox"

mkdir -p "$SNAPS_DIR"

# ---- helpers ----------------------------------------------------------------

d1() {
  local db="$1"; shift
  npx wrangler d1 execute "$db" $REMOTE_FLAG "$@" > /dev/null
}

d1_json() {
  local db="$1"; shift
  npx wrangler d1 execute "$db" $REMOTE_FLAG --json "$@"
}

snap_file() {
  printf "%s/snap_%04d.sql" "$SNAPS_DIR" "$1"
}

export_snap() {
  local db="$1"
  local version="$2"
  local file
  file=$(snap_file "$version")
  echo "  Exporting $db as snap_$(printf '%04d' "$version").sql..."
  npx wrangler d1 export "$db" $REMOTE_FLAG --output="$file"
}

restore_snap() {
  local db="$1"
  local version="$2"
  local file
  file=$(snap_file "$version")
  echo "  Restoring $db from snap_$(printf '%04d' "$version").sql..."
  npx wrangler d1 execute "$db" $REMOTE_FLAG --file="$file" > /dev/null
}

find_migration_file() {
  local version="$1"
  local direction="$2"
  local padded
  padded=$(printf "%04d" "$version")
  ls "$MIGRATIONS_DIR"/${padded}_*.${direction}.sql 2>/dev/null | head -1
}

ensure_migrations_table() {
  local db="$1"
  d1 "$db" --command "
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version     INTEGER PRIMARY KEY,
      applied_at  TEXT NOT NULL DEFAULT (datetime('now'))
    );
  "
}

get_applied_version() {
  local db="$1"
  d1_json "$db" --command "SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations;" \
    | jq -r '.[0].results[0].v // 0'
}

apply_up() {
  local db="$1"
  local version="$2"
  local file
  file=$(find_migration_file "$version" "up")
  if [[ -z "$file" ]]; then
    echo "ERROR: no up file for version $version"
    exit 1
  fi
  d1 "$db" --file "$file"
  d1 "$db" --command "INSERT INTO schema_migrations (version) VALUES ($version);"
}

apply_down() {
  local db="$1"
  local version="$2"
  local file
  file=$(find_migration_file "$version" "down")
  if [[ -z "$file" ]]; then
    echo "ERROR: no down file for version $version"
    exit 1
  fi
  d1 "$db" --file "$file"
  d1 "$db" --command "DELETE FROM schema_migrations WHERE version = $version;"
}


# ---- read versions ----------------------------------------------------------

TARGET=$(jq -r '.applied_migration_version' "$CONFIG_FILE")
ensure_migrations_table "$DB_NAME"
ACTUAL=$(get_applied_version "$DB_NAME")

echo "actual=$ACTUAL target=$TARGET"

if [[ "$TARGET" -eq "$ACTUAL" ]]; then
  echo "Already at version $TARGET. Nothing to do."
  exit 0
fi

# ---- ensure sandbox migrations table ----------------------------------------

ensure_migrations_table "$SANDBOX_DB_NAME"

# ---- ensure we have a snap of actual state ----------------------------------

ACTUAL_SNAP=$(snap_file "$ACTUAL")
ACTUAL_SNAP_EXISTED=true
if [[ ! -f "$ACTUAL_SNAP" ]]; then
  ACTUAL_SNAP_EXISTED=false
  export_snap "$SANDBOX_DB_NAME" "$ACTUAL"
fi

# ---- up ---------------------------------------------------------------------

if [[ "$TARGET" -gt "$ACTUAL" ]]; then
  echo ""
  echo "==> Dry-run: testing migrations $((ACTUAL + 1))..$TARGET on sandbox..."

  FAILED=false
  for ((v = ACTUAL + 1; v <= TARGET; v++)); do
    echo ""
    echo "  [$v] Testing up→down roundtrip..."

    snap_before_file=$(mktemp)
    snap_after_file=$(mktemp)
    npx wrangler d1 export "$SANDBOX_DB_NAME" $REMOTE_FLAG --output="$snap_before_file"

    apply_up "$SANDBOX_DB_NAME" "$v"
    apply_down "$SANDBOX_DB_NAME" "$v"

    npx wrangler d1 export "$SANDBOX_DB_NAME" $REMOTE_FLAG --output="$snap_after_file"

    if ! diff -q "$snap_before_file" "$snap_after_file" > /dev/null 2>&1; then
      rm -f "$snap_before_file" "$snap_after_file"
      echo "  [$v] ROUNDTRIP MISMATCH"
      FAILED=true
      break
    fi

    rm -f "$snap_before_file" "$snap_after_file"
    echo "  [$v] OK"
    apply_up "$SANDBOX_DB_NAME" "$v"
  done

  if [[ "$FAILED" == "true" ]]; then
    echo ""
    echo "Dry-run failed. Restoring sandbox to snap_$(printf '%04d' "$ACTUAL").sql..."
    restore_snap "$SANDBOX_DB_NAME" "$ACTUAL"
    exit 2
  fi

  echo ""
  echo "==> Applying migrations $((ACTUAL + 1))..$TARGET to real DB..."
  for ((v = ACTUAL + 1; v <= TARGET; v++)); do
    echo "  Applying $v..."
    apply_up "$DB_NAME" "$v"
  done

  export_snap "$SANDBOX_DB_NAME" "$TARGET"
  echo ""
  echo "Done. Real DB and sandbox are now at version $TARGET."
fi

# ---- down -------------------------------------------------------------------

if [[ "$TARGET" -lt "$ACTUAL" ]]; then
  echo ""
  echo "==> Dry-run: testing rollback $ACTUAL→$TARGET on sandbox..."

  FAILED=false
  for ((v = ACTUAL; v > TARGET; v--)); do
    echo "  [$v] Applying down on sandbox..."
    if ! apply_down "$SANDBOX_DB_NAME" "$v"; then
      FAILED=true
      break
    fi
  done

  if [[ "$FAILED" == "true" ]]; then
    echo ""
    echo "Dry-run failed. Restoring sandbox to snap_$(printf '%04d' "$ACTUAL").sql..."
    restore_snap "$SANDBOX_DB_NAME" "$ACTUAL"
    exit 2
  fi

  export_snap "$SANDBOX_DB_NAME" "$TARGET"

  echo ""
  echo "==> Applying rollback $ACTUAL→$TARGET to real DB..."
  for ((v = ACTUAL; v > TARGET; v--)); do
    echo "  Rolling back $v..."
    apply_down "$DB_NAME" "$v"
  done

  echo ""
  echo "Done. Real DB and sandbox are now at version $TARGET."
fi
