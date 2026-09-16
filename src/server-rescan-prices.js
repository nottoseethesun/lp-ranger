/**
 * @file src/server-rescan-prices.js
 * @description
 * Handler for `POST /api/position/rescan-prices` — the narrow
 * counterpart to Reload Current Position.
 *
 * Why it exists:
 *   Every USD figure the app records is `amount x price`. The amounts
 *   come from chain and are reliable; the prices come from a cascade
 *   (`src/price-source-cascade.js`) that accepts the first source
 *   returning any positive number, with no plausibility check. One bad
 *   response therefore lands in `compoundHistory[].usdValue` and
 *   `totalCompoundedUsd` — and `_resolveDiskState` in
 *   `bot-recorder-lifetime.js` deliberately refuses to rebuild those
 *   from chain once disk holds a non-zero value, so the bad figure is
 *   permanent. Reload Current Position fixes it, but wipes every
 *   on-chain-derived figure and re-scans the pool's whole 5-year
 *   Transfer history, which can take hours.
 *
 *   This route fixes only the prices. It clears the USD-derived keys,
 *   rewinds the NFT event watermark to the start of the chosen window,
 *   and lets the existing lifetime scan recompute — at freshly fetched
 *   prices, from amounts it re-reads over a bounded block range.
 *
 * What it deliberately does NOT touch:
 *   - `hodlBaseline` — its amounts are the mint-time deposit, and its
 *     stored prices are historical by design.
 *   - The pool rebalance-history scan (the expensive part of Reload).
 *   - Epoch P&L history.
 *
 * Cost: three `getLogs` per NFT in the chain over the chosen window.
 * With the default 60-day window that is seconds, not hours.
 */

"use strict";

const config = require("./config");
const { log } = require("./log");
const { logCtx } = require("./logger");
const _epochCache = require("./epoch-cache");
const { getPositionConfig, saveConfig } = require("./bot-config-v2");
const { getTokenSymbol } = require("./server-scan");
const {
  resolvePoolCreationBlockForPosition,
} = require("./pool-creation-block");
const {
  _validateKey,
  _resolveStateAndPosition,
  _checkInProgress,
  _cacheKeyOpts,
} = require("./server-reload-position");

/*- Only the price-derived keys.  Compare with
 *  `bot-config-v2.CHAIN_DERIVED_POSITION_KEYS`, which Reload clears and
 *  which also holds `hodlBaseline`, `lifetimeHodlAmounts` and
 *  `totalLifetimeDepositUsd`
 *  — those are amount-derived, and re-deriving them is what makes
 *  Reload slow.  Keeping them is the whole point of this route. */
const _PRICE_DERIVED_KEYS = [
  "compoundHistory",
  "totalCompoundedUsd",
  /*- `nftCompoundedUsdByTokenId` is a per-NFT CACHE that
   *  `bot-pnl-current-nft.js` rebuilds on the next poll when absent,
   *  so clearing it is free.
   *
   *  `collectedFeesUsd` is deliberately NOT here even though it is
   *  price-derived: `bot-loop.js` seeds it from disk and then only
   *  ever adds to it (`collectedFeesUsd += usd`).  Nothing recomputes
   *  it, so clearing would zero a running total with no way back —
   *  a stale figure is strictly better than a destroyed one. */
  "nftCompoundedUsdByTokenId",
];

/** Seconds per PulseChain block — used to turn a day window into blocks. */
const _BLOCK_TIME_SEC = 10;

/**
 * Translate a day window into the block to rewind the NFT event
 * watermark to.
 *
 * A null/absent `days` means "from the beginning", which resolves to
 * the pool's creation block — never zero, per the project's
 * no-genesis-scan rule.
 *
 * @param {number|null} days   Window in days, or null for all history.
 * @param {number} head        Current block height.
 * @param {object} position    Live position (token0/token1/fee).
 * @returns {Promise<number>}  Block number to scan from (>= 1).
 */
async function resolveFromBlock(days, head, position) {
  if (days === null || days === undefined) {
    const created = await resolvePoolCreationBlockForPosition(position).catch(
      () => 0,
    );
    return Math.max(1, created || 1);
  }
  const back = Math.round((days * 24 * 3600) / _BLOCK_TIME_SEC);
  return Math.max(1, head - back);
}

/**
 * Validate the `days` field of the request body.
 *
 * Absent means "whole history" (the checkbox was unchecked). A present
 * value must be a positive finite number — a malformed one is rejected
 * rather than silently coerced, so a client bug cannot quietly turn a
 * bounded rescan into a full-history one or vice versa.
 *
 * @param {object} body
 * @returns {{days: number|null}|{error: {code: number, body: object}}}
 */
function parseDays(body) {
  const raw = body ? body.days : undefined;
  if (raw === undefined || raw === null) return { days: null };
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) {
    return {
      error: {
        code: 400,
        body: { ok: false, error: "days must be a positive number or omitted" },
      },
    };
  }
  return { days: n };
}

/**
 * Clear the price-derived keys for one position in the SHARED
 * in-memory disk config.
 *
 * Mutating the shared reference (rather than reloading from disk) is
 * required for the same reason `server-reload-position` documents: the
 * bot loop reads through that object, and `_resolveDiskState` gates the
 * recompute off whenever it still sees a non-zero `totalCompoundedUsd`.
 *
 * @param {object} diskConfig
 * @param {string} positionKey
 * @returns {boolean} true when a config slot was found and cleared.
 */
function clearPriceDerivedConfig(diskConfig, positionKey) {
  const posCfg = getPositionConfig(diskConfig, positionKey);
  if (!posCfg) return false;
  for (const k of _PRICE_DERIVED_KEYS) delete posCfg[k];
  return true;
}

/**
 * Reset the in-memory bot state's price-derived fields so the scan's
 * persist-conditions re-evaluate as "nothing on disk".
 *
 * `_needsFullRescan` is deliberately NOT set — that flag forces the
 * scan back to the pool creation block, which is exactly the expensive
 * behaviour this route avoids.
 *
 * @param {object} state
 */
function resetPriceState(state) {
  if (!state) return;
  state.compoundHistory = [];
  state.totalCompoundedUsd = 0;
  /*- collectedFeesUsd is intentionally untouched — see the note on
   *  _PRICE_DERIVED_KEYS.  Zeroing it would destroy an accumulator
   *  that nothing rebuilds. */
  state.nftCompoundedUsdByTokenId = {};
  state.lifetimeScanComplete = false;
}

/**
 * Create the `POST /api/position/rescan-prices` handler.
 *
 * @param {object} deps
 * @param {Function} deps.jsonResponse
 * @param {Function} deps.readJsonBody
 * @param {Function} deps.getAllPositionBotStates
 * @param {object} deps.positionMgr
 * @param {object} deps.walletManager
 * @param {object} deps.diskConfig  Shared in-memory config reference.
 * @param {object} [deps.epochCache] Injectable for tests.
 * @returns {Function}
 */
function createRescanPricesHandler(deps) {
  const {
    jsonResponse,
    readJsonBody,
    getAllPositionBotStates,
    positionMgr,
    walletManager,
    diskConfig,
    epochCache = _epochCache,
  } = deps;

  return async function _handleRescanPrices(req, res) {
    const body = await readJsonBody(req);
    const v = _validateKey(body);
    if (v.error) return jsonResponse(res, v.error.code, v.error.body);
    const d = parseDays(body);
    if (d.error) return jsonResponse(res, d.error.code, d.error.body);

    const states = getAllPositionBotStates();
    const r = _resolveStateAndPosition(v.rawKey, states, positionMgr);
    if (r.error) return jsonResponse(res, r.error.code, r.error.body);

    /*- Only a managed position has a running bot loop to pick the
     *  rescan up.  The dashboard already gates the button, but a
     *  direct POST must not silently no-op.
     *
     *  `status` lives on the DISK CONFIG, not the bot-state object —
     *  `build-status-positions.js` merges `{ ...state, ...posConfig }`,
     *  which is why the dashboard sees it. Reading `state.status` here
     *  yields undefined and rejects every managed position. */
    if (getPositionConfig(diskConfig, r.liveKey)?.status !== "running") {
      return jsonResponse(res, 409, {
        ok: false,
        error: "not-managed",
        message:
          "Re-scan Prices only applies to a managed position. Click Manage first, then try again.",
      });
    }
    /*- Feature-correct copy: the shared helper defaults to Reload's
     *  wording ("Reload Current Position", "up to four hours"), which
     *  is the wrong feature and the wrong duration for this route. */
    const guard = _checkInProgress(r.state, {
      action: "Re-scan Prices",
      verb: "re-scan prices for",
      scanExtra: "",
    });
    if (guard) return jsonResponse(res, guard.code, guard.body);

    const wallet = v.parsed.wallet || walletManager.getAddress() || "";
    const cx = logCtx({
      chain: config.CHAIN_NAME,
      wallet,
      factory: config.POSITION_MANAGER,
      tokenId: r.position.tokenId,
      symbol0: getTokenSymbol(r.position.token0),
      symbol1: getTokenSymbol(r.position.token1),
    });

    const head = await deps.getBlockNumber();
    const fromBlock = await resolveFromBlock(d.days, head, r.position);
    log.info(
      "[server] [rescan-prices] %s: window=%s fromBlock=%d (head %d)",
      cx,
      d.days === null ? "all history" : d.days + "d",
      fromBlock,
      head,
    );

    clearPriceDerivedConfig(diskConfig, r.liveKey);
    resetPriceState(r.state);
    /*- Rewind the watermark so the scan re-reads the window's
     *  IncreaseLiquidity / Collect / DecreaseLiquidity logs and
     *  re-values them at freshly fetched prices.
     *
     *  `setLastNftScanBlock` takes the epoch-cache key OPTIONS OBJECT
     *  (blockchain/contract/wallet/token0/token1/fee), not a string —
     *  and the bot state has no `epochKey` field, so passing one threw
     *  a TypeError before this ever reached the cache. */
    epochCache.setLastNftScanBlock(
      _cacheKeyOpts(r.position, wallet),
      fromBlock,
    );
    saveConfig(diskConfig);

    /*- Trigger the scan NOW, exactly as Reload does.  Clearing state
     *  alone is not enough: bot-loop.js only re-scans off a 30-minute
     *  timer (LIFETIME_RESCAN_CHECK_MS), so without this the button
     *  would report success and then appear to do nothing for up to
     *  half an hour.  `_triggerScan` sets `_scanRunning` synchronously,
     *  engaging the in-flight guards, and the promise is deliberately
     *  not awaited so the HTTP response does not block on the scan. */
    if (typeof r.state._triggerScan === "function") {
      r.state._triggerScan().catch((err) => {
        log.warn(
          "[server] [rescan-prices] scan trigger failed: %s",
          err.message ?? err,
        );
      });
    }

    return jsonResponse(res, 200, {
      ok: true,
      message: "Price re-scan started",
      liveKey: r.liveKey,
      fromBlock,
      days: d.days,
    });
  };
}

module.exports = {
  createRescanPricesHandler,
  resolveFromBlock,
  parseDays,
  clearPriceDerivedConfig,
  resetPriceState,
  _PRICE_DERIVED_KEYS,
  _BLOCK_TIME_SEC,
};
