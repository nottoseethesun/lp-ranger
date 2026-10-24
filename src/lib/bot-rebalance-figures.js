"use strict";

/**
 * @file src/lib/bot-rebalance-figures.js
 * @module bot-rebalance-figures
 * @description
 * At the end of a scan pass, finish the Activity Log figures of the
 * position's Rebalance events that are still waiting for them.
 *
 * A Rebalance event waits for its figures, marked `figuresDue`, from the
 * moment the bot makes the rebalance, and from the moment the event
 * scanner first reads one from the chain. Its four coin figures need the
 * deposit the Lifetime accounting counted at its mint, and the Lifetime
 * scan counts a mint's deposits in the pass that follows the rebalance;
 * so the pass finishes its waiting events last, once that scan is done.
 * The rules for the figures themselves are in
 * src/lib/rebalance-activity-figures.js. This module gathers what they need
 * from what the pass and `app-data/` already hold, and writes the result
 * back:
 *
 * - the deposits, from the epoch cache's `lifetimeHodlAmounts` for the
 *   pool, which the Lifetime scan has just written;
 * - this install's own records of its rebalances, from the rebalance log
 *   (`readLog`, handed in by the caller that owns it);
 * - the NFT events the pass read for its Lifetime scan (the pass's shared
 *   chain read), in which a rebalance rebuilt from the chain finds its
 *   drain;
 * - the wallet's balances as of past blocks, and historical prices,
 *   read only for a rebalance this install has no record of.
 *
 * The finished records go into the pool's event cache
 * (`updateCachedEvents`), into the bot's own list of the position's
 * events, and out to the dashboard as `rebalanceEvents`. Nothing here may
 * stop the pass: a failure is logged, and the events stay due for the
 * next pass to try again.
 */

const config = require("./config");
const { log } = require("./log");
const { emojiId } = require("./logger");
const _epochCache = require("./epoch-cache");
const { updateCachedEvents } = require("./pool-scanner");
const { fetchHistoricalPriceGecko } = require("./price-fetcher");
const { readBalanceAt } = require("./liquidity-pair-details");
const { scanLogCtx } = require("./bot-recorder-lifetime");
const {
  finishRebalanceFigures,
  loggedRebalanceFigures,
} = require("./rebalance-activity-figures");

/**
 * The wallet's balance of the pool's two coins at the end of a block.
 * @returns {Promise<{amount0: number, amount1: number}>}
 */
async function _walletCoinsAt(block, o) {
  const read = (tokenAddress, decimals) =>
    readBalanceAt({
      tokenAddress,
      wallet: o.address,
      blockTag: block,
      provider: o.provider,
      ethersLib: o.ethersLib,
      decimals,
    });
  const [amount0, amount1] = await Promise.all([
    read(o.position.token0, o.position.decimals0),
    read(o.position.token1, o.position.decimals1),
  ]);
  return { amount0, amount1 };
}

/**
 * The pass's NFT events, asked of its shared chain read once for all the
 * waiting events. `shareRead` forgets a read that failed, so that a later
 * step of the pass can try again; here every asker is this one step,
 * moments apart, and asking again would start a full read of the chain
 * for each waiting event. A read that fails therefore answers null to
 * them all: every event that needs it stays waiting for the next pass.
 *
 * @param {object|null|undefined} sharedRead  The pass's chain read.
 * @returns {() => Promise<Map<string, object>|null>}
 */
function _nftEventsOnce(sharedRead) {
  let answer = null;
  return () => {
    if (answer !== null) return answer;
    answer =
      sharedRead === null || sharedRead === undefined
        ? Promise.resolve(null)
        : sharedRead.read().catch(() => null);
    return answer;
  };
}

/** The position's two coins, as its log lines name them. */
function _label(position) {
  const ctx = scanLogCtx(position);
  return ctx.t0Sym + "/" + ctx.t1Sym;
}

/** What `finishRebalanceFigures` reads, from the pass and `app-data/`. */
function _context(o, lifetimeHodl, label) {
  const { position, address, sharedRead } = o;
  const logEntries = o.readLog();
  const logged = loggedRebalanceFigures(logEntries, {
    chain: config.CHAIN_NAME,
    contract: config.POSITION_MANAGER,
    wallet: address,
  });
  const poolAddress = lifetimeHodl?.poolAddress ?? o.botState?.poolAddress;
  return {
    decimals0: position.decimals0,
    decimals1: position.decimals1,
    lifetimeHodl,
    chainEvents: o.events,
    logged,
    readNftEvents: _nftEventsOnce(sharedRead),
    readBalances: (block) => _walletCoinsAt(block, o),
    historicalPrices: (ev) =>
      fetchHistoricalPriceGecko(poolAddress, ev.timestamp, {
        token0Address: position.token0,
        token1Address: position.token1,
        blockNumber: ev.blockNumber,
      }),
    getConfig: o.botState?._getConfig,
    onReadFailure: (ev, err) =>
      log.warn(
        "[bot] %s NFT #%s → #%s %s: could not read the wallet around this rebalance, so its Activity Log figures stay unknown: %s",
        label,
        ev.oldTokenId,
        ev.newTokenId,
        emojiId(String(ev.newTokenId)),
        err.message,
      ),
    onFinishFailure: (ev, err) =>
      log.warn(
        "[bot] %s NFT #%s → #%s %s: Activity Log figures not finished this pass, left for the next: %s",
        label,
        ev.oldTokenId,
        ev.newTokenId,
        emojiId(String(ev.newTokenId)),
        err.message,
      ),
  };
}

/** One log line for each finished event, with its figures. */
function _logFinished(finished, label) {
  for (const done of finished.values()) {
    const pct = done.historical?.impermanentLossGainPct;
    log.info(
      "[bot] %s NFT #%s → #%s %s: Activity Log figures finished: before %s, after %s, Historical %s",
      label,
      done.oldTokenId,
      done.newTokenId,
      emojiId(String(done.newTokenId)),
      JSON.stringify(done.beforeRebalance),
      JSON.stringify(done.afterRebalance),
      typeof pct === "number" ? pct.toFixed(4) + "%" : "unknown",
    );
  }
}

/**
 * Finish this pass's waiting Rebalance events, and publish the result.
 *
 * @param {object} o
 * @param {object[]} o.events  The bot's own list of the position's
 *   rebalance events; finished records replace the waiting ones in it.
 * @param {object} o.position  The live position: tokens and decimals.
 * @param {string} o.address  The wallet.
 * @param {object} o.provider  For balances as of past blocks.
 * @param {object} o.ethersLib
 * @param {object|null} o.sharedRead  The pass's chain read, if any.
 * @param {object|null} o.epochKey  The pool's epoch-cache key.
 * @param {object} [o.botState]  For the position's price overrides, and
 *   the pool's address when the epoch cache lacks it.
 * @param {Function} o.updateState  Publishes a bot-state patch.
 * @param {Function} o.readLog  Reads the rebalance log.
 * @returns {Promise<void>}
 */
async function finishPassRebalanceFigures(o) {
  const label = _label(o.position);
  try {
    const due = o.events.filter((e) => e?.figuresDue === true);
    if (due.length === 0) return;
    const known = o.epochKey !== null && o.epochKey !== undefined;
    const lifetimeHodl = known
      ? _epochCache.getCachedLifetimeHodl(o.epochKey)
      : null;
    const ctx = _context(o, lifetimeHodl, label);
    const finished = await finishRebalanceFigures(due, ctx);
    if (finished.size === 0) return;
    await updateCachedEvents(o.position, o.address, finished);
    o.events.forEach((e, i) => {
      const done = finished.get(e.txHash);
      if (done !== undefined) o.events[i] = done;
    });
    o.updateState({ rebalanceEvents: [...o.events] });
    _logFinished(finished, label);
  } catch (err) {
    log.warn(
      "[bot] %s: Activity Log figures not finished this pass, left for the next: %s",
      label,
      err.message,
    );
  }
}

module.exports = { finishPassRebalanceFigures };
