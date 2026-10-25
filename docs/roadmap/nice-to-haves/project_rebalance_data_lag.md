# Record Rebalances Made Outside LP Ranger Without a Reload

> **Status:** Nice-to-have — not a bug. Funds are never at risk. Every
> rebalance LP Ranger makes is recorded as it happens. This concerns
> only a rebalance made outside LP Ranger, which stays unrecorded until
> the operator uses Reload Current Position.

## Plain language

LP Ranger records each rebalance it makes the moment it finishes, so
those always appear in the Rebalance Events table. A rebalance made
outside LP Ranger is different: one done by hand on the 9mm site, or by
another copy of LP Ranger on another computer, after LP Ranger has
scanned the pool. LP Ranger can learn of it only by reading the chain,
and its routine scans cannot link the new position to the one it
replaced. Nothing reads the pool's history again on its own, so the
rebalance stays out of the Rebalance Events table, and out of the
bookkeeping report, until the operator uses Reload Current Position.

The reload has two limits:

- It runs only for a managed position that has finished syncing. On an
  unmanaged one, its dialog says so and points to Manage
  ([Re-scan Prices and Reload for unmanaged positions](project_rescan_reload_for_unmanaged.md)).
- It empties the pool's event cache, so the Routed Via column shows a
  dash afterward for the rebalances LP Ranger had recorded
  ([Show Swap Route Even If Only Blockchain Data Available](project_route_via_chain_scan_gap.md)).

The User Manual's section "Rebalancing or Compounding Outside LP
Ranger" advises operators to make their own rebalances and compounds
from another wallet, and walks those who do not through the reload.

## Mechanics

A pool's rebalances are kept in its event cache file, described in
`docs/engineering.md` § "Rebalance Event Caches". A scan reads only the
blocks after the file's `lastBlock`, and `pairTransfers()`
(`src/lib/event-scanner.js`) pairs only the transfers that scan read, in two
passes:

- **Pass 1:** an NFT leaving the wallet, then another arriving within
  `rebalancePairingWindowSec` (five minutes as shipped).
- **Pass 2:** each remaining NFT minted to the wallet, with the one
  minted before it: the drain-old, mint-new flow LP Ranger uses.

A rebalance made by hand mints one new NFT and keeps the old one. The
scan that reads its mint finds no earlier mint among the transfers it
read, since the predecessor is in the file, so it writes no record and
logs:

```text
[event-scanner] WARN: N new mint(s) produced 0 rebalance pairs; tokenIds=...
```

LP Ranger's own rebalances meet the same gap but do not depend on the
scan: `appendToPoolCache` (`src/lib/pool-scanner.js`), called from
`src/lib/bot-loop.js` after every successful rebalance, adds the record
itself.

## How it is recovered today

Every later scan starts after `lastBlock`, past the missed mint. The
file lapses only after `eventCacheTtlMs` (a year) without a write, which
a pool in use never reaches. The 30-minute `lifetimeRescanTimer` retries
only a lifetime scan that did not finish, and the dashboard's poll
re-renders what the server holds without scanning.

Reload Current Position (`src/lib/server-reload-position.js`) is the
recovery: `clearPoolCache` empties the file, and the scan that follows
reads the pool's history from the floor, where Pass 2 sees every mint
and pairs the missed rebalance with the rest.

Clearing the file after each rebalance LP Ranger makes would not serve:
every rebalance would read the pool's whole history again, thousands of
requests, and lose every recorded route, while a rebalance made by hand
would still wait for LP Ranger's next one.

## Fix when prioritized

When Pass 2 finds an unpaired new mint and `cachedEvents` is
non-empty, look up the latest cached mint for the same pool and use
it as the `mints[i-1]` predecessor. Pure additive — doesn't touch
happy-path code. The next scan of the pool would then record the
missed rebalance, with no reload.
