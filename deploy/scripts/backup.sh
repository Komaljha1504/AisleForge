#!/usr/bin/env sh
# PostgreSQL backup of the Compose stack (custom format, compressed) + SHA-256 checksum.
#   deploy/scripts/backup.sh [output-dir]        (default: ./backups — keep backups OFF the synced workspace in production)
# PostgreSQL is the only system of record; Kafka topics and Redis are rebuilt from it (outbox republish, cache refill).
set -eu
OUT_DIR="${1:-./backups}"
mkdir -p "$OUT_DIR"
TS=$(date -u +%Y%m%dT%H%M%SZ)
FILE="$OUT_DIR/aisleforge-$TS.dump"
docker compose exec -T postgres sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" --format=custom --no-owner --compress=6' > "$FILE"
if [ ! -s "$FILE" ]; then echo "backup failed: empty dump" >&2; exit 1; fi
( cd "$OUT_DIR" && sha256sum "$(basename "$FILE")" > "$(basename "$FILE").sha256" )
echo "$FILE"
