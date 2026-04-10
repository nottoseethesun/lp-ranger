#!/usr/bin/env bash
# ─────────────────────────────────────────────────────────────────────────────
# wipe-settings.sh — Back up all user settings/state to tmp/.settings-backup/
# and remove them, simulating a fresh install.
#
# Restore with: npm run restore-settings
# ─────────────────────────────────────────────────────────────────────────────
set -euo pipefail

cd "$(dirname "$0")/.."

BACKUP_DIR="tmp/.settings-backup"

if [ -d "$BACKUP_DIR" ]; then
  echo "ERROR: Backup already exists at $BACKUP_DIR"
  echo "Run 'npm run restore-settings' first, or delete $BACKUP_DIR manually."
  exit 1
fi

mkdir -p "$BACKUP_DIR"

# Files to back up and remove. Runtime config now lives under app-config/.
# See the `app-config/` section of server.js for the layout.
FILES=(
  .env
  app-config/.wallet.json
  app-config/.bot-config.json
  app-config/.bot-config.backup.json
  app-config/.bot-config.v1.json
  app-config/api-keys.json
  app-config/rebalance_log.json
  tmp/pnl-epochs-cache.json
)

backed=0
for f in "${FILES[@]}"; do
  if [ -f "$f" ]; then
    # Preserve directory structure inside backup
    mkdir -p "$BACKUP_DIR/$(dirname "$f")"
    mv "$f" "$BACKUP_DIR/$f"
    echo "  backed up: $f"
    backed=$((backed + 1))
  fi
done

# Back up event cache files (pool-keyed and legacy tokenId-keyed)
for f in tmp/event-cache*.json; do
  if [ -f "$f" ]; then
    mkdir -p "$BACKUP_DIR/tmp"
    mv "$f" "$BACKUP_DIR/$f"
    echo "  backed up: $f"
    backed=$((backed + 1))
  fi
done

# Back up any keyfiles
for f in *.keyfile.json keyfile.json; do
  if [ -f "$f" ]; then
    mv "$f" "$BACKUP_DIR/$f"
    echo "  backed up: $f"
    backed=$((backed + 1))
  fi
done

if [ "$backed" -eq 0 ]; then
  rmdir "$BACKUP_DIR" 2>/dev/null || true
  echo "Nothing to back up — already clean."
else
  echo ""
  echo "Wiped $backed file(s). Settings saved to $BACKUP_DIR/"
  echo "Run 'npm run restore-settings' to put them back."
  echo ""
  echo "NOTE: Browser localStorage is not affected by this script."
  echo "To complete the fresh-install simulation, open the dashboard and"
  echo "click the Settings gear icon → \"Clear Local Storage & Cookies\"."
fi
