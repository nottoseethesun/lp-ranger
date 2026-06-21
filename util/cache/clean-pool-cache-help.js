/**
 * @file util/cache/clean-pool-cache-help.js
 * @description
 * --help text for `clean-pool-cache.js`. Extracted to a sibling module
 * so the main CLI script stays under the 500-LOC cap as new cache
 * surfaces are documented. No behavior here — pure data.
 */

"use strict";

const HELP_TEXT = `
clean-pool-cache.js — wipe every cached entry for one pool

USAGE
  node util/cache/clean-pool-cache.js <poolAddress> \\
       --chain <name> --nft-factory <addr> [options]

ARGUMENTS
  <poolAddress>
        0x-prefixed 20-byte hex address of the V3 pool to clean.
        Required.

REQUIRED OPTIONS
  --chain <name>
        Blockchain identifier.  Accepts either the abbreviated key
        (e.g. "pulsechain", "pulsechain-testnet") or the full
        human-readable display name (e.g. "PulseChain", "PulseChain
        Testnet v4").  Match is case-insensitive.  The set of valid
        values is whatever lives in app-config/
        app-defaults-for-user-configurable/chains.json on this checkout.

        How to find it: open the in-app "Pool Details" dialog
        (gear-icon area on the dashboard).  The blockchain name is
        printed as the subtitle directly beneath the "Pool Details"
        title at the top of the dialog.

  --nft-factory <addr>
        0x-prefixed 20-byte hex address of the NonfungiblePositionManager
        (the NFT-issuing contract for this pool's protocol — for 9mm
        Pro V3 on PulseChain that is
        0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2).

        How to find it: open the same "Pool Details" dialog.  The
        "NFT Contract" row in the details list shows this address.
        Click the copy icon next to it to copy.

OPTIONS
  --preserve-pool-history
        Skip the event-cache, P&L-epochs, liquidity-pair-details, and
        lp-position-cache surfaces.  Only the small lookup caches
        (pool-creation-blocks, gecko-pool) are cleared.  Use this when
        you want to verify a cold pool-creation-block lookup WITHOUT
        triggering a full event re-scan or losing accumulated P&L
        history for the pool.  --chain and --nft-factory are still
        REQUIRED in this mode for consistency, even though they are
        not used by the lookup-only surfaces.

  -h, --help
        Print this message and exit.

DEFAULT BEHAVIOUR (no options)
  Cleans EVERY pool-scoped cache surface for the given pool:

    1. tmp/pool-creation-blocks-cache.json
         Removes every key whose value contains the pool address
         (matched as a case-insensitive substring of each key).

    2. tmp/gecko-pool-cache.json
         Removes every key containing the pool address.

    3. tmp/event-cache-*.json   (one file per wallet that has positions
                                 in this pool)
         Resolves (token0, token1, fee) by calling pool.token0/1/fee()
         on the address, then deletes every event-cache file whose
         filename matches both prefix
         event-cache-{chain:5}-{nftFactory:6hex}- AND suffix
         -{token0:8hex}-{token1:8hex}-{fee}.json (wallet wildcarded).

    4. tmp/pnl-epochs-cache.json
         Removes every internal key of the form
         {chain}.{nftFactory}.{wallet}.{token0}.{token1}.{fee} that
         matches the supplied chain + nft-factory + token0 + token1 +
         fee (wallet wildcarded), so accumulated P&L history for this
         pool configuration is dropped.

    5. tmp/liquidity-pair-details-cache.json
         Removes every top-level key whose prefix
         {chain:5}-{nftFactory:6hex}- AND suffix
         -{token0:8hex}-{token1:8hex}-{fee} match this pool's scope
         (wallet wildcarded). Drops the cached "Initial Wallet Residual
         (Pool)" snapshot so the next scan re-resolves wallet balances
         + historical prices at the first-mint block.

    6. tmp/lp-position-cache-*.json   (one file per wallet that has
                                        any positions on this chain +
                                        nft-factory)
         Surgically removes every entry from the cached positions[]
         array whose (token0, token1, fee) matches this pool's scope.
         Other pools' entries in the same file are preserved, and the
         file's lastBlock cursor is left untouched so the freshness
         check for the remaining pools stays valid. If a file's
         positions[] becomes empty after filtering, the whole file is
         deleted.

  Match dimensions enforced TOGETHER across surfaces 3-6: blockchain,
  nft-factory, token0, token1, fee. Wallet is the only intentionally
  wildcarded dimension — every wallet's entry for the same pool
  configuration is wiped.

  Caches that are NOT touched (intentional — not pool-scoped):
    - tmp/historical-price-cache.json   keyed by token + block
    - tmp/nft-mint-date-cache.json      keyed by tokenId
    - tmp/block-time-cache.json         keyed by chain + block

REQUIREMENTS
  Default mode reads token0/token1/fee from the pool via RPC.  Uses
  config.RPC_URL from .env (with config.RPC_URL_FALLBACK if primary
  fails).  If the RPC is unreachable, default mode aborts with a
  non-zero exit and surfaces 3-6 are NOT touched.  Use
  --preserve-pool-history to clean only the lookup caches without
  needing RPC.

EXAMPLES
  Full wipe (default), abbreviated chain name:
    node util/cache/clean-pool-cache.js \\
         0xE8FdBb02cdfbDb43807E33190Ebcea809316f2B9 \\
         --chain pulsechain \\
         --nft-factory 0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2

  Full wipe, full chain display name:
    node util/cache/clean-pool-cache.js \\
         0xE8FdBb02cdfbDb43807E33190Ebcea809316f2B9 \\
         --chain "PulseChain" \\
         --nft-factory 0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2

  Lookup-caches only (preserves event cache + P&L epochs + lp-position cache):
    node util/cache/clean-pool-cache.js \\
         0xE8FdBb02cdfbDb43807E33190Ebcea809316f2B9 \\
         --chain pulsechain \\
         --nft-factory 0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2 \\
         --preserve-pool-history

  Print this help:
    node util/cache/clean-pool-cache.js --help

EXIT CODES
  0 — completed (even if zero entries matched)
  1 — invalid args, unparseable cache file, unknown blockchain, or
      RPC failure in default mode
`;

module.exports = { HELP_TEXT };
