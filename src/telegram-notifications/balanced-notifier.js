/**
 * @file src/telegram-notifications/balanced-notifier.js
 * @module balanced-notifier
 * @description
 * Optional Telegram notifier that fires when a managed LP position's USD
 * value split between token0 and token1 falls inside the ±2.5% balanced
 * band (ratio0 ∈ [0.475, 0.525]).  Pure logic module — no module-level
 * mutable state; per-position transient state lives on `botState` (set
 * up in `src/server-positions.js`).  Lives under `src/telegram-notifications/`
 * alongside the rest of the Telegram surface.
 *
 * Trigger semantics:
 *   - Edge-trigger: notify only on FALSE→TRUE entry into the band.
 *   - Cooldown: 30 min between notifications (suppresses oscillation).
 *   - Per-poll cadence guard: callers must throttle the fresh-price
 *     fetch via the `pricePauseExceptionPollWindowMultiple` global
 *     (read in `bot-pnl-updater.js`); this module only deals with the
 *     band/cooldown logic given an evaluated `(v0, v1)` pair.
 *
 * Cost trade-off: when this notifier is enabled the per-position price
 * lookups bypass the idle-driven price-lookup pause, so price-source
 * quota is consumed even when the dashboard is closed.  The dashboard
 * UI surfaces a warning + the dynamically-computed fetch cadence; see
 * `public/dashboard-telegram.js`.
 */

"use strict";

const { log } = require("../log");
const { fetchTokenPriceUsd } = require("../price-fetcher");
const { withFreshPricesAllowed, isPaused } = require("../price-fetcher-gate");
const { notify, getEnabledEvents } = require("./telegram");
const { getTokenSymbol } = require("../token-symbol-cache");
const rangeMath = require("../range-math");

/** Max characters per token symbol in the Holdings section, where the
 *  symbol gets a full line of its own and the amount sits on the next
 *  indented line — a wider budget keeps long names readable.  The header
 *  pair (sym0 / sym1) is rendered by `buildHeader` in `telegram.js` and
 *  uses its own compact 12-char width. */
const _SYM_TRUNC_HOLDINGS = 16;

/** Half-width of the balanced band around 0.5 (2.5% → ratio0 ∈ [0.475, 0.525]).
 *  Easily changed in code (no config knob — see CLAUDE.md). */
const BALANCED_THRESHOLD = 0.025;

/** Minimum gap between successive notifications for the same position.
 *  30 min suppresses oscillation across the band edge.  Easily changed
 *  in code (no config knob — see CLAUDE.md). */
const BALANCED_COOLDOWN_MS = 30 * 60_000;

/**
 * Compute the USD value ratio.
 * @param {number} v0  USD value of token0 holdings (price0 × amount0).
 * @param {number} v1  USD value of token1 holdings (price1 × amount1).
 * @returns {{ ratio0: number, inBand: boolean }|null}
 *   `null` when the total is non-positive (no prices yet).
 */
function isBalanced(v0, v1) {
  const total = v0 + v1;
  if (!(total > 0)) return null;
  const ratio0 = v0 / total;
  return {
    ratio0,
    inBand: Math.abs(ratio0 - 0.5) <= BALANCED_THRESHOLD,
  };
}

/**
 * Evaluate band entry + cooldown given the current state.  Pure: returns
 * the next state plus an optional message; the caller decides whether to
 * dispatch.
 *
 * @param {object}   args
 * @param {object}   args.position    Position object.
 * @param {object}   args.poolState   Pool-state snapshot.
 * @param {number}   args.amount0     Token0 amount (human float).
 * @param {number}   args.amount1     Token1 amount (human float).
 * @param {number}   args.price0      Token0 price (USD).
 * @param {number}   args.price1      Token1 price (USD).
 * @param {object}   [args.snap]      P&L snapshot (for fee/lifetime fields).
 * @param {boolean}  args.lastInBand
 * @param {number}   args.lastNotifyTs
 * @param {number}   args.nowMs
 * @returns {{ nextLastInBand: boolean, nextLastNotifyTs: number, message: string|null }}
 */
function evaluateBalance(args) {
  const {
    position,
    poolState,
    amount0,
    amount1,
    price0,
    price1,
    snap,
    lastInBand,
    lastNotifyTs,
    nowMs,
  } = args;
  const result = isBalanced(amount0 * price0, amount1 * price1);
  if (result === null) {
    /*- Unknown balance (no prices yet).  Don't transition state — wait
     *  for a real reading. */
    return {
      nextLastInBand: lastInBand,
      nextLastNotifyTs: lastNotifyTs,
      message: null,
    };
  }
  const { ratio0, inBand } = result;
  const isEntry = inBand && !lastInBand;
  const cooled = nowMs - lastNotifyTs >= BALANCED_COOLDOWN_MS;
  if (isEntry && cooled) {
    const message = formatMessage({
      position,
      poolState,
      amount0,
      amount1,
      price0,
      price1,
      snap,
      ratio0,
    });
    return {
      nextLastInBand: inBand,
      nextLastNotifyTs: nowMs,
      message,
    };
  }
  return {
    nextLastInBand: inBand,
    nextLastNotifyTs: lastNotifyTs,
    message: null,
  };
}

/** Format USD with thousands separators and 2 decimals.  Uses
 *  `toLocaleString` (not a regex) so security-lint stays clean. */
function _fmtUsd(n) {
  if (!Number.isFinite(n)) return "$?";
  const sign = n < 0 ? "-" : "";
  const abs = Math.abs(n);
  return (
    sign +
    "$" +
    abs.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    })
  );
}

/** Format a token amount with sensible precision (max 6 sig figs). */
function _fmtAmt(n) {
  if (!Number.isFinite(n)) return "?";
  if (n === 0) return "0";
  const abs = Math.abs(n);
  if (abs >= 1)
    return n.toLocaleString("en-US", {
      minimumFractionDigits: 2,
      maximumFractionDigits: 2,
    });
  if (abs >= 0.01) return n.toFixed(4);
  return n.toPrecision(4);
}

/** Truncate a token symbol to the Holdings-section width (own line, so
 *  wider budget is fine).  The compact header pair lives in
 *  `telegram.js:buildHeader`. */
function _truncHoldingsSym(s) {
  const v = s || "?";
  return v.length > _SYM_TRUNC_HOLDINGS ? v.slice(0, _SYM_TRUNC_HOLDINGS) : v;
}

/**
 * Render the balanced-band message body — Holdings, Total, fees, P&L.
 *
 * The chain / provider / `sym0` / `sym1` / Fee Tier / Position lines are
 * **NOT** rendered here: `notify()` builds them via the unified
 * `buildHeader()` helper in `telegram.js` so every Telegram notification
 * type uses the same header.
 *
 * Format (after the header that `notify()` prepends, separated by a
 * blank line):
 *   Holdings:
 *     <sym0 truncated to 16>:
 *       <amount>  ($<usd>)
 *     <sym1 truncated to 16>:
 *       <amount>  ($<usd>)
 *   Total value: $<total>
 *   Unclaimed fees: $<fees>     (when snap present)
 *   Lifetime P&L: $<pnl>        (when snap present)
 *
 * Range info and current price are intentionally omitted — the
 * notification is about the value-balance state, not the range.
 */
function formatMessage({ position, amount0, amount1, price0, price1, snap }) {
  /*- Symbol fallback: pre-attached fields → cached symbol map → "?".
   *  The poll cycle passes the on-chain position object (addresses
   *  only), so the cache lookup is the usual path. */
  const sym0Raw =
    position.token0Symbol ||
    position.symbol0 ||
    (position.token0 ? getTokenSymbol(position.token0) : "");
  const sym1Raw =
    position.token1Symbol ||
    position.symbol1 ||
    (position.token1 ? getTokenSymbol(position.token1) : "");
  const sym0Long = _truncHoldingsSym(sym0Raw);
  const sym1Long = _truncHoldingsSym(sym1Raw);
  const v0 = amount0 * price0;
  const v1 = amount1 * price1;
  const total = v0 + v1;
  const lines = [];
  lines.push("Holdings:");
  lines.push(`  ${sym0Long}:`);
  lines.push(`    ${_fmtAmt(amount0)}  (${_fmtUsd(v0)})`);
  lines.push(`  ${sym1Long}:`);
  lines.push(`    ${_fmtAmt(amount1)}  (${_fmtUsd(v1)})`);
  lines.push(`Total value: ${_fmtUsd(total)}`);
  if (snap) {
    if (Number.isFinite(snap.currentFeesUsd))
      lines.push(`Unclaimed fees: ${_fmtUsd(snap.currentFeesUsd)}`);
    if (Number.isFinite(snap.cumulativePnl))
      lines.push(`Lifetime P&L: ${_fmtUsd(snap.cumulativePnl)}`);
  }
  return lines.join("\n");
}

/**
 * Caller-side helper: gate on the multiplier window, fetch fresh prices,
 * compute amounts, evaluate the band, and dispatch via `notify()`.  Safe
 * to call every poll cycle — the multiplier gate keeps real fetches
 * sparse.  Updates `botState._lastInBand`, `botState._lastBalancedNotifyTs`,
 * and `botState._lastBalancedPriceFetchTs` in place.
 *
 * @param {object} args
 * @param {object} args.position     Active position.
 * @param {object} args.poolState    Latest pool state.
 * @param {object} args.botState     Per-position bot state (mutated).
 * @param {object} [args.snap]       P&L snapshot (for message body).
 * @param {number} args.checkIntervalSec   Base poll interval (config.CHECK_INTERVAL_SEC).
 * @param {number} args.multiplier         Multiplier (global config).
 * @param {number} [args.nowMs]      Override clock (tests).
 * @returns {Promise<boolean>}  True if a notification was dispatched.
 */
/**
 * Fetch fresh USD prices for both tokens, bypassing the idle pause.
 * Returns `[price0, price1]`, or `null` on any failure.
 * Extracted from `maybeNotifyBalanced` to keep that function under
 * the complexity ceiling.
 */
async function _fetchFreshPricesForPair(position) {
  try {
    const pausedBefore = isPaused();
    let price0 = 0;
    let price1 = 0;
    await withFreshPricesAllowed(async () => {
      [price0, price1] = await Promise.all([
        fetchTokenPriceUsd(position.token0),
        fetchTokenPriceUsd(position.token1),
      ]);
    });
    if (pausedBefore) {
      log.info(
        "[balanced-notifier] fresh-price probe bypassed pause for #%s",
        position.tokenId,
      );
    }
    return [price0, price1];
  } catch (err) {
    log.warn("[balanced-notifier] price fetch failed: %s", err.message || err);
    return null;
  }
}

async function maybeNotifyBalanced(args) {
  const {
    position,
    poolState,
    botState,
    snap,
    checkIntervalSec,
    multiplier,
    nowMs = Date.now(),
  } = args;
  if (!getEnabledEvents().positionBalanced) return false;
  if (!position || !poolState) return false;
  const fetchWindowMs =
    Math.max(1, checkIntervalSec) * Math.max(1, multiplier) * 1000;
  const lastFetch = botState._lastBalancedPriceFetchTs || 0;
  if (nowMs - lastFetch < fetchWindowMs) return false;
  botState._lastBalancedPriceFetchTs = nowMs;
  const prices = await _fetchFreshPricesForPair(position);
  if (!prices) return false;
  const [price0, price1] = prices;
  if (!(price0 > 0) || !(price1 > 0)) return false;
  const amounts = rangeMath.positionAmounts(
    position.liquidity || 0,
    poolState.tick,
    position.tickLower,
    position.tickUpper,
    poolState.decimals0,
    poolState.decimals1,
  );
  const result = evaluateBalance({
    position,
    poolState,
    amount0: amounts.amount0,
    amount1: amounts.amount1,
    price0,
    price1,
    snap,
    lastInBand: !!botState._lastInBand,
    lastNotifyTs: botState._lastBalancedNotifyTs || 0,
    nowMs,
  });
  botState._lastInBand = result.nextLastInBand;
  botState._lastBalancedNotifyTs = result.nextLastNotifyTs;
  if (!result.message) return false;
  log.info(
    "[balanced-notifier] dispatching balanced notification for #%s",
    position.tokenId,
  );
  /*- `notify()` builds the standard header (chain / provider / sym0 /
   *  sym1 / Fee Tier / Position) from `position`; our `result.message`
   *  body owns only the Holdings / Total / fees / P&L lines. */
  await notify("positionBalanced", { position, message: result.message });
  return true;
}

module.exports = {
  isBalanced,
  evaluateBalance,
  formatMessage,
  maybeNotifyBalanced,
  BALANCED_THRESHOLD,
  BALANCED_COOLDOWN_MS,
};
