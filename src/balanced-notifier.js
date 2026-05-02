/**
 * @file src/balanced-notifier.js
 * @module balanced-notifier
 * @description
 * Optional Telegram notifier that fires when a managed LP position's USD
 * value split between token0 and token1 falls inside the ±2.5% balanced
 * band (ratio0 ∈ [0.475, 0.525]).  Pure logic module — no module-level
 * mutable state; per-position transient state lives on `botState` (set
 * up in `src/server-positions.js`).
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

const config = require("./config");
const { fetchTokenPriceUsd } = require("./price-fetcher");
const { withFreshPricesAllowed, isPaused } = require("./price-fetcher-gate");
const { notify, getEnabledEvents } = require("./telegram");
const { readNftProviders } = require("./nft-providers");
const { getTokenSymbol } = require("./token-symbol-cache");
const rangeMath = require("./range-math");

/** Max characters per token symbol in the header pair lines (compact). */
const _SYM_TRUNC = 12;

/** Max characters per token symbol in the Holdings section, where the
 *  symbol gets a full line of its own and the amount sits on the next
 *  indented line — a wider budget keeps long names readable. */
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
      blockchainName: args.blockchainName,
      providerName: args.providerName,
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

/**
 * Look up the user-friendly NFT-issuer name from
 * `app-config/static-tunables/nft-providers.json` — the same single
 * source of truth the dashboard NFT panel reads via
 * `GET /api/nft-providers` (see `src/nft-providers.js`).  The map is
 * address-keyed (lowercased) so future v3+v4 coexistence on one chain
 * resolves to the right name per NFT contract.  Returns `undefined`
 * when no match — `formatMessage` then omits the provider header line.
 */
function _lookupNftProviderName() {
  const map = readNftProviders();
  const addr = config.POSITION_MANAGER;
  if (!addr) return undefined;
  return map[addr.toLowerCase()];
}

/** Truncate a token symbol to the given width (defaults to the compact
 *  header width).  Holdings callers pass `_SYM_TRUNC_HOLDINGS` since
 *  that section gives the symbol its own line. */
function _truncSym(s, max = _SYM_TRUNC) {
  const v = s || "?";
  return v.length > max ? v.slice(0, max) : v;
}

/**
 * Render the full position-spec message body.  Format (after the title
 * banner that `notify()` prepends; `notify()` is invoked with
 * `suppressPositionLabel: true` so its auto `Position:` line is
 * skipped — this body owns the entire layout):
 *   <blockchain>
 *   <provider/pool-type, e.g. "9mm v3">
 *   <token0 sym truncated to 12> /
 *       <token1 sym truncated to 12>
 *   Fee Tier: <pct>
 *   Position: #<tokenId>
 *
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
 *
 * @param {object} args
 * @param {string} [args.blockchainName]  e.g. "PulseChain".
 * @param {string} [args.providerName]    e.g. "9mm v3".
 */
function formatMessage({
  position,
  amount0,
  amount1,
  price0,
  price1,
  snap,
  blockchainName,
  providerName,
}) {
  /*- The bot poll cycle passes the on-chain position object (token
   *  addresses only, no symbol fields), so token0Symbol/symbol0 are
   *  usually undefined here.  Fall back to the cached symbol map (the
   *  same one bot-cycle._notifyPos and server-scan already use) before
   *  the literal "T0"/"T1". */
  const sym0Raw =
    position.token0Symbol ||
    position.symbol0 ||
    getTokenSymbol(position.token0) ||
    "T0";
  const sym1Raw =
    position.token1Symbol ||
    position.symbol1 ||
    getTokenSymbol(position.token1) ||
    "T1";
  const sym0 = _truncSym(sym0Raw);
  const sym1 = _truncSym(sym1Raw);
  /*- Holdings section gives each token name its own line, so use the
   *  wider 16-char budget there. */
  const sym0Long = _truncSym(sym0Raw, _SYM_TRUNC_HOLDINGS);
  const sym1Long = _truncSym(sym1Raw, _SYM_TRUNC_HOLDINGS);
  const feeStr = position.fee ? `${(position.fee / 10_000).toFixed(2)}%` : "?";
  const v0 = amount0 * price0;
  const v1 = amount1 * price1;
  const total = v0 + v1;
  const lines = [];
  if (blockchainName) lines.push(blockchainName);
  if (providerName) lines.push(providerName);
  lines.push(`${sym0} /`);
  lines.push(`    ${sym1}`);
  lines.push(`Fee Tier: ${feeStr}`);
  if (position.tokenId) lines.push(`Position: #${position.tokenId}`);
  lines.push("");
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
      console.log(
        "[balanced-notifier] fresh-price probe bypassed pause for #%s",
        position.tokenId,
      );
    }
    return [price0, price1];
  } catch (err) {
    console.warn(
      "[balanced-notifier] price fetch failed: %s",
      err.message || err,
    );
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
    /*- Header strings: chain display name from chains.json (via config),
     *  provider/NFT-issuer name from nft-providers.json — the same
     *  address-keyed map the dashboard NFT panel reads.  Tests can
     *  override by passing args directly to formatMessage /
     *  evaluateBalance. Today we manage NFTs from one position-manager
     *  per chain, so the lookup uses the configured POSITION_MANAGER
     *  address.  When position objects someday carry their own
     *  `contractAddress` through the bot poll cycle, swap that in here
     *  — no nft-providers.json change needed. */
    blockchainName: config.CHAIN?.displayName,
    providerName: _lookupNftProviderName(),
  });
  botState._lastInBand = result.nextLastInBand;
  botState._lastBalancedNotifyTs = result.nextLastNotifyTs;
  if (!result.message) return false;
  console.log(
    "[balanced-notifier] dispatching balanced notification for #%s",
    position.tokenId,
  );
  await notify("positionBalanced", {
    position,
    message: result.message,
    /*- Our `result.message` body places `Position: #<id>` after the Fee
     *  Tier line, so suppress the default auto label to avoid showing
     *  `Position:` twice. */
    suppressPositionLabel: true,
  });
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
