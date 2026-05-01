/**
 * @file src/bot-loop-detect.js
 * @module bot-loop-detect
 * @description
 * Pre-loop initialization helpers extracted from `bot-loop.js` to keep
 * the main file under the 500-line cap.
 *
 * Exports:
 *   - `_detectPosition(provider, address, targetId)` — find the target
 *     NFT position with retry/backoff when the on-chain probe transiently
 *     returns "unknown" (RPC saturation, etc.).
 *   - `_initPnlTracker(...)` — restore P&L tracker from epoch cache or
 *     open a new epoch.
 *   - `_tryInitPnlTracker(...)` — convenience wrapper that fetches
 *     prices, derives lower/upper from ticks, and calls `_initPnlTracker`.
 */

"use strict";

const config = require("./config");
const { detectPositionType } = require("./position-detector");
const { getCachedEpochs, getCachedLifetimeHodl } = require("./epoch-cache");
const { createPnlTracker } = require("./pnl-tracker");
const rangeMath = require("./range-math");
const { getPoolState } = require("./rebalancer");
const {
  positionValueUsd: _positionValueUsd,
  fetchTokenPrices: _fetchTokenPrices,
} = require("./bot-pnl-updater");

/*- Retry policy for `_detectPosition`.  The detector swallows
 *  per-RPC-call errors (logged at [pos-detect] for diagnostics) and
 *  returns `unknown` on failure.  Without retry, a single transient RPC
 *  hiccup during a Manage click surfaces to the user as the cryptic
 *  "No V3 NFT position found" error even when the position exists.
 *  Four attempts with doubling backoff (750/1500/3000 ms = 5.25 s
 *  total) converts a blip — or even a sustained primary-RPC outage —
 *  into a brief pause.  Between attempts we also call
 *  `opts.onRpcFailure()` (wired to `sendTx.failoverToNextRPC()` in
 *  production) so the next attempt is routed through the fallback RPC.
 *  Sticky failover is idempotent and self-healing (1 h window then
 *  auto-reverts), so erroneous engagement on a truly empty wallet is
 *  cheap.  See PR fix-no-nft-found-error. */
const _DETECT_RETRIES = 4;
const _DETECT_BACKOFF_MS = 750;

/*- Pick the best NFT to manage when no specific tokenId was requested
 *  (full wallet scan).  Prefers the position with the most active
 *  liquidity; falls back to the highest tokenId among drained NFTs so a
 *  freshly-rebalanced wallet still picks the latest mint. */
function _pickBestNft(valid) {
  const active = valid.filter((p) => BigInt(p.liquidity || 0n) > 0n);
  return active.length > 0
    ? active.reduce((best, p) =>
        BigInt(p.liquidity || 0n) > BigInt(best.liquidity || 0n) ? p : best,
      )
    : valid.reduce((best, p) =>
        BigInt(p.tokenId) > BigInt(best.tokenId) ? p : best,
      );
}

/**
 * Detect and select the target NFT position from on-chain data.
 * Retries up to `_DETECT_RETRIES` times with doubling backoff before
 * giving up.  Between attempts, calls `opts.onRpcFailure()` to engage
 * mid-session RPC failover so the next attempt routes through the
 * fallback RPC.
 *
 * @param {object} provider   ethers provider (used when getProvider not supplied).
 * @param {string} address    Wallet address.
 * @param {string} [targetId] Specific NFT token ID to select.
 * @param {object} [opts]
 * @param {() => object} [opts.getProvider]  Per-attempt provider getter
 *   (production wires this to `sendTx.getCurrentRPC` so failover
 *   re-routes reads).  Defaults to the static `provider` arg.
 * @param {() => void} [opts.onRpcFailure]   Called between attempts when
 *   the detector returns no usable result (production wires this to
 *   `sendTx.failoverToNextRPC`).  Defaults to no-op.
 * @returns {Promise<object>} Selected position data.
 */
/**
 * Run the detector with retry + failover.  Extracted from
 * `_detectPosition` to keep cyclomatic complexity under the project cap.
 *
 * @returns {Promise<object>} Final detection result (may still be empty
 *   if all attempts failed — caller decides how to surface that).
 */
async function _detectWithRetry(address, targetId, getProvider, onRpcFailure) {
  let detection;
  for (let attempt = 1; attempt <= _DETECT_RETRIES; attempt++) {
    detection = await detectPositionType(getProvider(), {
      walletAddress: address,
      positionManagerAddress: config.POSITION_MANAGER,
      tokenId: targetId,
      candidateAddress: config.ERC20_POSITION_ADDRESS || undefined,
    });
    if (detection.type === "nft" && detection.nftPositions?.length) break;
    if (attempt < _DETECT_RETRIES) {
      /*- Doubling backoff: 750, 1500, 3000 ms between the 4 attempts
       *  (5.25 s total wait + call time).  Engage RPC failover before
       *  sleeping so the wait isn't wasted re-trying the same dead RPC. */
      const wait = _DETECT_BACKOFF_MS * Math.pow(2, attempt - 1);
      console.warn(
        "[bot] _detectPosition: attempt %d/%d returned %s (target=%s) — engaging RPC failover + retrying in %dms",
        attempt,
        _DETECT_RETRIES,
        detection.type,
        targetId || "scan",
        wait,
      );
      onRpcFailure();
      await new Promise((r) => setTimeout(r, wait));
    }
  }
  return detection;
}

/** Apply the targetId filter and log the choice. */
function _selectTargeted(valid, targetId) {
  const m = valid.find((p) => String(p.tokenId) === String(targetId));
  console.log(
    "[bot] _detectPosition: targetId match=%s",
    m ? `#${m.tokenId}` : "MISS\u2192fallback",
  );
  return m || valid[0];
}

async function _detectPosition(provider, address, targetId, opts) {
  const getProvider = (opts && opts.getProvider) || (() => provider);
  const onRpcFailure = (opts && opts.onRpcFailure) || (() => {});
  const detection = await _detectWithRetry(
    address,
    targetId,
    getProvider,
    onRpcFailure,
  );
  if (detection.type !== "nft" || !detection.nftPositions?.length)
    throw new Error(
      "No V3 NFT position found after " +
        _DETECT_RETRIES +
        " attempts. " +
        "Check server logs for [pos-detect] warnings (likely RPC failure).",
    );
  const valid = detection.nftPositions.filter((p) => p.fee && p.fee > 0);
  if (!valid.length)
    throw new Error("No positions with a valid V3 fee tier found.");
  console.log(
    "[bot] _detectPosition: targetId=%s, found %d valid NFTs: %s",
    targetId || "none",
    valid.length,
    valid
      .map((p) => `#${p.tokenId}(liq=${String(p.liquidity).slice(0, 8)})`)
      .join(", "),
  );
  if (targetId) return _selectTargeted(valid, targetId);
  const picked = _pickBestNft(valid);
  console.log(
    "[bot] _detectPosition: picked #%s (active=%d, total=%d)",
    picked.tokenId,
    valid.filter((p) => BigInt(p.liquidity || 0n) > 0n).length,
    valid.length,
  );
  return picked;
}

/** Initialize or restore the P&L tracker with epoch data. */
function _initPnlTracker(
  ev,
  botState,
  poolState,
  lowerPrice,
  upperPrice,
  price0,
  price1,
  position,
  walletAddress,
) {
  const tracker = createPnlTracker({ initialDeposit: ev });
  const wallet = walletAddress || botState.walletAddress;
  const _epochKey = position
    ? {
        contract: config.POSITION_MANAGER,
        wallet,
        token0: position.token0,
        token1: position.token1,
        fee: position.fee,
      }
    : null;
  const cached = _epochKey ? getCachedEpochs(_epochKey) : null;
  if (cached) {
    tracker.restore(cached);
    console.log(
      "[bot] Restored P&L epochs from cache (%d closed)",
      cached.closedEpochs?.length,
    );
  } else {
    tracker.openEpoch({
      entryValue: ev,
      entryPrice: poolState.price,
      lowerPrice,
      upperPrice,
      token0UsdPrice: price0,
      token1UsdPrice: price1,
    });
  }
  const cachedHodl = _epochKey ? getCachedLifetimeHodl(_epochKey) : null;
  if (cachedHodl) botState.lifetimeHodlAmounts = cachedHodl;
  console.log(
    `[bot] P&L tracker initialized (T0=$${price0.toFixed(6)}, T1=$${price1.toFixed(6)})`,
  );
  return { tracker, epochKey: _epochKey };
}

/** Initialize P&L tracker from token prices. Returns null if prices unavailable. */
async function _tryInitPnlTracker(
  provider,
  ethersLib,
  position,
  botState,
  updateBotState,
  walletAddress,
) {
  try {
    const { price0, price1 } = await _fetchTokenPrices(
      position.token0,
      position.token1,
    );
    if (price0 > 0 || price1 > 0) {
      const ps = await getPoolState(provider, ethersLib, {
        factoryAddress: config.FACTORY,
        token0: position.token0,
        token1: position.token1,
        fee: position.fee,
      });
      // Cache decimals on position so downstream scans don't need pool state
      position.decimals0 = ps.decimals0;
      position.decimals1 = ps.decimals1;
      const lp = rangeMath.tickToPrice(
        position.tickLower,
        ps.decimals0,
        ps.decimals1,
      );
      const up = rangeMath.tickToPrice(
        position.tickUpper,
        ps.decimals0,
        ps.decimals1,
      );
      const { tracker: t, epochKey: ek } = _initPnlTracker(
        _positionValueUsd(position, ps, price0, price1) || 1,
        botState,
        ps,
        lp,
        up,
        price0,
        price1,
        position,
        walletAddress,
      );
      updateBotState({ pnlEpochs: t.serialize() });
      t._epochKey = ek;
      return t;
    }
    console.warn("[bot] Could not fetch token prices — P&L tracking disabled");
  } catch (err) {
    console.warn("[bot] P&L tracker init error:", err.message);
  }
  return null;
}

module.exports = {
  _detectPosition,
  _initPnlTracker,
  _tryInitPnlTracker,
};
