"use strict";

/**
 * @file src/price-overrides.js
 * @module price-overrides
 * @description
 * Apply the operator's token price overrides to a pair of fetched
 * prices.
 *
 * A price service sometimes has no price for a token, and answers zero.
 * For that case the operator can save a price of their own for each of a
 * position's two tokens (`priceOverride0`, `priceOverride1`, set from the
 * dashboard's Edit Prices). An override stands in for a fetched price of
 * zero or less, and for any fetched price at all when the operator has
 * also set `priceOverrideForce`. The Current and Lifetime panels value a
 * position at the prices this returns.
 *
 * Kept apart from the fetch so that a caller holding prices it has
 * already fetched can apply the same rule without fetching again: the
 * poll's own pricing (`_fetchWithOverrides` in src/bot-pnl-updater.js)
 * fetches and then applies it, and a rebalance applies it to the prices
 * it fetched right after the mint, for its Activity Log entry's
 * Historical figure, so that figure is priced as the panels are. The
 * Lifetime scan applies it to the prices it values a rebuilt compound
 * list at (`_readCurrentPrices`, src/bot-recorder-lifetime.js), so a
 * Compound entry's dollar amount after a rebuild is priced as one the
 * bot recorded live.
 */

const { log } = require("./log");

/**
 * The pair of prices with the position's overrides applied.
 *
 * @param {{price0: number, price1: number}} prices  The fetched prices,
 *   USD per whole token.
 * @param {Function} [getConfig]  Reads one of the position's saved
 *   settings by key; with none, no override applies.
 * @returns {{price0: number, price1: number}}  The prices to use.
 */
function applyPriceOverrides(prices, getConfig) {
  let { price0, price1 } = prices;
  const gc = getConfig || (() => undefined);
  const ov0 = gc("priceOverride0"),
    ov1 = gc("priceOverride1");
  const force = gc("priceOverrideForce");
  if (ov0 > 0 && (force || price0 <= 0)) {
    log.info(
      "[pnl] using priceOverride0=%s (fetched=%s force=%s)",
      ov0,
      price0,
      !!force,
    );
    price0 = ov0;
  }
  if (ov1 > 0 && (force || price1 <= 0)) {
    log.info(
      "[pnl] using priceOverride1=%s (fetched=%s force=%s)",
      ov1,
      price1,
      !!force,
    );
    price1 = ov1;
  }
  return { price0, price1 };
}

/**
 * A pair of prices with anything that is not a finite number read as
 * zero, the fetched value that means "no price".
 *
 * The poll's fetch always answers numbers, but a price kept on a record,
 * such as a rebalance log entry written before its fetch succeeded, may
 * be absent. An absent price compared with zero is neither above nor
 * below it, so the override that stands in for a missing price would not
 * apply; read as zero, it does.
 *
 * @param {{price0: *, price1: *}|null|undefined} prices
 * @returns {{price0: number, price1: number}}
 */
function pricesOrZero(prices) {
  const finite = (p) => (typeof p === "number" && Number.isFinite(p) ? p : 0);
  return { price0: finite(prices?.price0), price1: finite(prices?.price1) };
}

module.exports = { applyPriceOverrides, pricesOrZero };
