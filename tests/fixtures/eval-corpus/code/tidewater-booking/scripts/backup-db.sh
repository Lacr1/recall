#!/usr/bin/env bash
# Nightly database backup: dump, compress, upload to object storage, keep 35 days.
set -euo pipefail

STAMP="$(date +%Y-%m-%d)"
FILE="/var/backups/booking-$STAMP.sql.gz"

pg_dump --no-owner "$DATABASE_URL" | gzip -9 > "$FILE"
aws s3 cp "$FILE" "s3://tidewater-backups/booking/$STAMP.sql.gz" --storage-class STANDARD_IA

# Delete local copies older than 3 days and remote copies older than 35 days.
find /var/backups -name 'booking-*.sql.gz' -mtime +3 -delete
aws s3 ls s3://tidewater-backups/booking/ | awk '{print $4}' | while read -r name; do
  day="$(basename "$name" .sql.gz)"
  if [[ "$(date -d "$day" +%s)" -lt "$(date -d '35 days ago' +%s)" ]]; then
    aws s3 rm "s3://tidewater-backups/booking/$name"
  fi
done
