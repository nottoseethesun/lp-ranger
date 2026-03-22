#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# restore-settings.sh — Restore settings previously backed up by wipe-settings.sh.
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/.."

BACKUP_DIR="tmp/.settings-backup"

if [ ! -d "$BACKUP_DIR" ]; then
  echo "ERROR: No backup found at $BACKUP_DIR"
  echo "Nothing to restore."
  exit 1
fi

restored=0

# Use find to catch dotfiles and nested files that glob would miss
while IFS= read -r -d '' f; do
  # Relative path from backup dir (e.g. ".env", "tmp/event-cache.json")
  rel="${f#$BACKUP_DIR/}"
  mkdir -p "$(dirname "$rel")"
  mv "$f" "$rel"
  echo "  restored: $rel"
  restored=$((restored + 1))
done < <(find "$BACKUP_DIR" -type f -print0)

rm -rf "$BACKUP_DIR"

echo ""
echo "Restored $restored file(s). Backup directory cleaned up."
