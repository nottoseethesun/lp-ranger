#!/usr/bin/env bash
#
# inject-stuck-lifetime-state.sh
#
# Reproduces the Production "stuck lifetime cache" state on the local
# Dev install for testing the recovery + sync-state UI behavior.
#
# Mutates `tmp/pnl-epochs-cache.json` so every pool entry matches the
# exact shape observed on Prod's 2026-06-09 paste of the file:
#
#   freshDeposits        : null
#   lifetimeHodlAmounts  : null
#   lastNftScanBlock     : 0
#
# Everything else (closedEpochs, liveEpoch, cachedAt) is left untouched,
# mirroring how the rebalance-then-fail path actually leaves the cache.
#
# Backs the original file up to a timestamped sibling so the test is
# trivially reversible.
#
# Usage:
#   util/diagnostic/inject-stuck-lifetime-state.sh
#
# Then:
#   npm start          # or `npm run debug` to step through the recovery
#
# Restore:
#   cp <backup-path-printed-on-exit> tmp/pnl-epochs-cache.json
#
set -euo pipefail

# 1. Stop any running LP Ranger.  No-op if not running.
npm run stop 2>/dev/null || true

# 2. Require an existing cache file.  No file → user hasn't run the
#    server yet, so there's nothing to mutate into a stuck state.
if [ ! -f tmp/pnl-epochs-cache.json ]; then
  echo "tmp/pnl-epochs-cache.json does not exist."
  echo "Run \`npm start\` once with a managed position so the scanner writes it, then re-run this script."
  exit 1
fi

# 3. Back up the original so the test is reversible.
BACKUP="tmp/pnl-epochs-cache.json.bak-stuck-test-$(date -u +%Y%m%dT%H%M%SZ)"
cp tmp/pnl-epochs-cache.json "$BACKUP"

# 4. Apply the Prod stuck shape to every pool entry.  closedEpochs /
#    liveEpoch / cachedAt are intentionally preserved — same as Prod.
jq 'with_entries(.value |= (
      .freshDeposits = null
      | .lifetimeHodlAmounts = null
      | .lastNftScanBlock = 0
    ))' tmp/pnl-epochs-cache.json > tmp/pnl-epochs-cache.json.tmp \
  && mv tmp/pnl-epochs-cache.json.tmp tmp/pnl-epochs-cache.json

# 5. Show one entry to confirm the shape, then print next steps.
echo "Stuck state injected (matches Prod 2026-06-09 paste). Sample entry:"
jq 'to_entries[0].value | {freshDeposits, lifetimeHodlAmounts, lastNftScanBlock}' tmp/pnl-epochs-cache.json
echo ""
echo "Run \`npm start\` (or \`npm run debug\`) to test."
echo ""
echo "Expected (with the lifetimeScanComplete fix on this branch):"
echo "  - Browser shows Syncing badge + blurred panels initially"
echo "  - Console: '[bot] <t0>/<t1> NFT #... <emoji>: Starting lifetime scan (fullRescan=...)'"
echo "  - Console: '[bot] <t0>/<t1> NFT #... <emoji>: Lifetime scan complete'"
echo "  - Browser flips to Synced + correct values"
echo ""
echo "Restore the pre-test cache when done:"
echo "  cp \"$BACKUP\" tmp/pnl-epochs-cache.json"
