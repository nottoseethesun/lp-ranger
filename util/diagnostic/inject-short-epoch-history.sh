#!/usr/bin/env bash
#
# inject-short-epoch-history.sh
#
# Reproduces the state a partially-failed P&L reconstruction leaves
# behind, so the recovery path can be tested without waiting for an RPC
# outage to happen on its own.
#
# Drops the last N closed epochs from every pool entry in
# `tmp/pnl-epochs-cache.json`, leaving everything else — liveEpoch,
# lastNftScanBlock, lifetimeHodlAmounts — untouched.  The chain's
# rebalance events are not touched either, so on the next start the app
# still knows how many closed positions the chain HAS while its stored
# history covers fewer.  That mismatch is exactly what
# `isEpochHistoryComplete` measures, and it is what a reconstruction
# that gave up part-way through actually produces.
#
# Entries holding N epochs or fewer are skipped: truncating them to
# nothing tests a different path (the empty-cache cold start), not this
# one.
#
# Backs the original up to a timestamped sibling so the test is
# trivially reversible.
#
# Usage:
#   util/diagnostic/inject-short-epoch-history.sh [N]     # N defaults to 3
#
# Then:
#   npm start -- --log-file      # or `npm run debug` to step through it
#
# Restore:
#   cp <backup-path-printed-on-exit> tmp/pnl-epochs-cache.json
#
set -euo pipefail

DROP="${1:-3}"

# 1. Stop any running LP Ranger.  No-op if not running.
npm run stop 2>/dev/null || true

# 2. Require an existing cache file.  No file → nothing to shorten, and
#    a cold start tests the wrong path.
if [ ! -f tmp/pnl-epochs-cache.json ]; then
  echo "tmp/pnl-epochs-cache.json does not exist."
  echo "Run \`npm start\` once with a managed position that has rebalanced, then re-run this script."
  exit 1
fi

# 3. Back up the original so the test is reversible.
BACKUP="tmp/pnl-epochs-cache.json.bak-short-epochs-$(date -u +%Y%m%dT%H%M%SZ)"
cp tmp/pnl-epochs-cache.json "$BACKUP"

echo "Before:"
jq -r 'to_entries[] | "  \(.key[0:44])…  closedEpochs=\(.value.closedEpochs | if type == "array" then length else 0 end)"' \
  tmp/pnl-epochs-cache.json

# 4. Drop the last N epochs from every entry that has more than N.
jq --argjson n "$DROP" 'with_entries(.value |= (
      if (.closedEpochs | type) == "array" and (.closedEpochs | length) > $n
      then .closedEpochs = (.closedEpochs | .[0:(length - $n)])
      else . end
    ))' tmp/pnl-epochs-cache.json > tmp/pnl-epochs-cache.json.tmp \
  && mv tmp/pnl-epochs-cache.json.tmp tmp/pnl-epochs-cache.json

echo ""
echo "After (dropped up to $DROP per entry):"
jq -r 'to_entries[] | "  \(.key[0:44])…  closedEpochs=\(.value.closedEpochs | if type == "array" then length else 0 end)"' \
  tmp/pnl-epochs-cache.json

cat <<EOF

Run \`npm start -- --log-file\` to test.

Expected:
  - [pnl] Reconstructing N historical epoch(s) from chain…
  - [pnl] Epoch #k: NFT #… — fees \$…          (one per closed NFT)
  - [pnl] Reconstructed N historical epoch(s)
  - NO  '[pnl] Reconstruction incomplete'      (the rebuild should succeed)
  - NO  '[bot] … Auto-rescanning lifetime'     (30 min later — proves the
        rescan flag was lowered once the history came back complete)

If the rebuild DOES come up short, the two '[pnl]' warning lines say so
and name the shortfall, and the rescan 30 minutes later should log
'epochHistoryIncomplete=true' as its reason and re-read only the NFTs
that failed — look for '(buffered)' on the ones it skipped.

Restore the pre-test cache when done:
  cp "$BACKUP" tmp/pnl-epochs-cache.json
EOF
