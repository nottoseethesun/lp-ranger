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
 *   response therefore lands in whichever stored figure was being
 *   computed — a compound total, the lifetime deposit, the entry value
 *   the Impermanent Loss Guard measures against — and the lifetime scan
 *   deliberately refuses to rebuild a figure that is already saved, so
 *   the bad one is permanent. Reload Current Position fixes it, but wipes every
 *   on-chain-derived figure and re-scans the pool's whole 5-year
 *   Transfer history, which can take hours.
 *
 *   This route fixes only the prices. It asks the position's next
 *   lifetime scan to rebuild every stored dollar figure at freshly
 *   fetched prices, from token amounts it re-reads from the chain:
 *   Fees Compounded, the lifetime deposit, and the HODL baseline's entry
 *   value.
 *
 *   It deletes nothing. Each figure is overwritten once its replacement
 *   exists, so a scan that fails, or a price source that answers with
 *   nothing, leaves the old figure in place.
 *
 *   Clearing a figure to make that guard rebuild it is the thing to
 *   avoid: while it is missing, a rebalance's fee credit lands in the
 *   gap (`_bumpRebalanceFees`), and the guard then reads that partial
 *   number as settled for every scan after it.
 *
 * What it deliberately does NOT touch:
 *   - The token amounts behind every figure. They come from chain and do
 *     not need re-deriving, which is the whole cost advantage over
 *     Reload.
 *   - The pool rebalance-history scan (the expensive part of Reload).
 *   - Epoch P&L history.
 *
 * Cost: one batched read of the chain's three event histories
 * (`src/nft-events-batch.js`), from each NFT's mint
 * (`prepareLifetimeRead`), plus one price lookup per deposit. On a long
 * chain that takes minutes.
 */

"use strict";

const config = require("./config");
const { log } = require("./log");
const { logCtx } = require("./logger");
const { getPositionConfig } = require("./bot-config-v2");
const { getTokenSymbol } = require("./server-scan");
const {
  _validateKey,
  _resolveStateAndPosition,
  _checkInProgress,
} = require("./server-reload-position");

/**
 * Ask this position's next lifetime scan to re-value every stored dollar
 * figure at freshly fetched prices.
 *
 * Nothing is cleared. `_needsPriceRevalue` is read by `lifetimeScanPlan`
 * (`src/bot-recorder-lifetime.js`), which runs each valuation step even
 * though the figures are saved, and only a scan that finishes clears it
 * — so a scan that fails is retried on the next pass. The request lives
 * in memory, so a server restart drops it; the saved figures are
 * untouched either way, and the user can ask again.
 *
 * `_needsFullRescan` is deliberately NOT set: it also re-derives token
 * amounts from the pool's history, which is the expensive part of
 * Reload and is not what a bad price calls for.
 *
 * `lifetimeScanComplete` goes false because the Lifetime panel and the
 * dialog both read it: it is how "Syncing…" appears and how the dialog
 * learns the re-scan has finished.
 *
 * @param {object} state  Per-position bot state.
 */
function requestPriceRevalue(state) {
  if (!state) return;
  state._needsPriceRevalue = true;
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
  } = deps;

  return async function _handleRescanPrices(req, res) {
    const body = await readJsonBody(req);
    const v = _validateKey(body);
    if (v.error) return jsonResponse(res, v.error.code, v.error.body);

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

    log.info(
      "[server] [rescan-prices] %s: re-valuing every stored figure at fresh prices",
      cx,
    );

    requestPriceRevalue(r.state);

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
    });
  };
}

module.exports = {
  createRescanPricesHandler,
  requestPriceRevalue,
};
