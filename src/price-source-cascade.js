/**
 * @file price-source-cascade.js
 * @module price-source-cascade
 * @description
 * Generic "try a list of price sources in priority order" runner used by
 * `price-fetcher.js`.  Extracted to keep `price-fetcher.js` under the 500
 * non-comment-line cap while making the cascade behavior easier to read
 * and test in isolation.
 *
 * Each call optionally accepts a context that's woven into log lines so
 * the server log shows what was being fetched (token symbol +
 * abbreviated address + chain) and which source actually filled in the
 * price after a fallback.  Without this context the cascade is silent
 * and a Moralis miss → GeckoTerminal hit looks identical to "Moralis
 * succeeded" in the log.
 */

"use strict";

const { getTokenSymbol } = require("./token-symbol-cache");

/**
 * Render a token for human-readable logs as `SYMBOL (0xAAAA…BBBB)`.
 * Falls back to `0xAAAA…BBBB` when the symbol cache hasn't seen the
 * address yet.  Always include a recognizable name with the raw
 * address — bare 0x… addresses are unreadable at a glance.
 *
 * @param {string|null|undefined} addr  Token contract address.
 * @param {string} [explicitSymbol]  Use this symbol if cache has none.
 * @returns {string}  e.g. "WPLS (0xA1077a…9a27)" or "(unknown)".
 */
function formatToken(addr, explicitSymbol) {
  if (!addr) return "(unknown)";
  const short =
    addr.length > 10 ? `${addr.slice(0, 6)}\u2026${addr.slice(-4)}` : addr;
  const sym = explicitSymbol || getTokenSymbol(addr);
  return sym ? `${sym} (${short})` : short;
}

/** Build the " SYMBOL (0xAAAA…BBBB) chain=…" suffix for cascade logs. */
function _cascadeTarget(ctx) {
  const tokDesc = ctx.token
    ? formatToken(ctx.token, ctx.symbol)
    : ctx.label || "";
  const chainDesc = ctx.chain ? ` chain=${ctx.chain}` : "";
  return tokDesc ? ` ${tokDesc}${chainDesc}` : "";
}

/** Format a USD price for cascade logs (more precision below $0.01). */
function _fmtPrice(price) {
  return price >= 0.01 ? price.toFixed(4) : price.toPrecision(4);
}

/** Run one source attempt and log the outcome. Returns the price (0 = miss). */
async function _runOneSource(src, target, fallbackNote) {
  const { name, fn } = src;
  try {
    const price = await fn();
    if (price > 0) {
      if (target) {
        console.log(
          "[price-fetcher] %s ok%s →$%s%s",
          name,
          target,
          _fmtPrice(price),
          fallbackNote,
        );
      }
      return price;
    }
    if (target) {
      console.warn(
        "[price-fetcher] %s miss%s — no data%s",
        name,
        target,
        fallbackNote,
      );
    }
    return 0;
  } catch (err) {
    console.warn(
      "[price-fetcher] %s error%s — %s%s",
      name,
      target,
      err.message ?? err,
      fallbackNote,
    );
    return 0;
  }
}

/**
 * Try a list of price sources in priority order, returning the first
 * non-zero result.
 *
 * @param {{ name: string, fn: () => Promise<number> }[]} sources
 * @param {{ token?: string, chain?: string, symbol?: string, label?: string }} [ctx={}]
 * @returns {Promise<number>} USD price (0 if all sources fail).
 */
async function tryPriceSources(sources, ctx = {}) {
  const target = _cascadeTarget(ctx);
  for (let i = 0; i < sources.length; i++) {
    const note = i > 0 ? ` (fallback after ${sources[i - 1].name})` : "";
    const price = await _runOneSource(sources[i], target, note);
    if (price > 0) return price;
  }
  if (target) {
    console.warn("[price-fetcher] All sources failed%s", target);
  }
  return 0;
}

module.exports = { tryPriceSources, formatToken };
