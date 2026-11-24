#!/usr/bin/env sh
# Restores a backup made by backup.sh. NON-DESTRUCTIVE BY DEFAULT: restores into a separate database
# (default aisleforge_restore_check) so the backup can be verified without touching live data.
#   deploy/scripts/restore.sh <dump-file> [target-db]
# Replacing the LIVE database requires BOTH --force as the third argument and CONFIRM_RESTORE=yes.
set -eu
FILE="${1:?usage: restore.sh <dump-file> [target-db] [--force]}"
TARGET="${2:-aisleforge_restore_check}"
FORCE="${3:-}"
DIR=$(dirname "$FILE")
( cd "$DIR" && sha256sum -c "$(basename "$FILE").sha256" ) || { echo "checksum mismatch: refusing to restore" >&2; exit 1; }
LIVE=$(docker compose exec -T postgres sh -c 'printf %s "$POSTGRES_DB"')
if [ "$TARGET" = "$LIVE" ] && { [ "$FORCE" != "--force" ] || [ "${CONFIRM_RESTORE:-}" != "yes" ]; }; then
  echo "refusing to overwrite the live database '$LIVE' without --force and CONFIRM_RESTORE=yes" >&2
  exit 1
fi
docker compose exec -T postgres sh -c "dropdb -U \"\$POSTGRES_USER\" --if-exists '$TARGET' && createdb -U \"\$POSTGRES_USER\" '$TARGET'"
docker compose exec -T postgres sh -c "pg_restore -U \"\$POSTGRES_USER\" -d '$TARGET' --no-owner --exit-on-error" < "$FILE"
echo "restored $FILE into database '$TARGET'"
