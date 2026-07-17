#!/bin/sh
set -eu

backup_dir=${OPS_BACKUP_DIR:-/var/backups/service-ops-console}
database_path=${OPS_DB_PATH:-/var/lib/service-ops-console/service-ops.sqlite}
retention_days=${OPS_BACKUP_RETENTION_DAYS:-14}
config_paths=${OPS_BACKUP_CONFIG_PATHS:-/etc/service-ops-console}
stamp=$(date -u +%Y-%m-%dT%H%M%SZ)

case "$retention_days" in (*[!0-9]*|'') echo "OPS_BACKUP_RETENTION_DAYS must be a non-negative integer" >&2; exit 2;; esac
install -d -m 0700 "$backup_dir"

database_backup="$backup_dir/database-$stamp.sqlite"
sqlite3 "$database_path" ".timeout 30000" ".backup '$database_backup'"
chmod 0600 "$database_backup"

archive_list=$(mktemp)
trap 'rm -f "$archive_list"' EXIT HUP INT TERM
old_ifs=$IFS
IFS=:
for item in $config_paths; do
  [ -e "$item" ] && printf '%s\n' "$item" >> "$archive_list"
done
IFS=$old_ifs
if [ -s "$archive_list" ]; then
  config_backup="$backup_dir/config-$stamp.tgz"
  tar --absolute-names --files-from "$archive_list" -czf "$config_backup"
  chmod 0600 "$config_backup"
fi

find "$backup_dir" -type f \( -name 'database-*.sqlite' -o -name 'config-*.tgz' \) -mtime "+$retention_days" -delete
