/**
 * @file src/lifetime-hodl.js
 * @description Compute accumulated lifetime HODL amounts across a rebalance
 * chain.  Classifies each IncreaseLiquidity event as original-mint,
 * rebalance-mint, compound, or external-deposit, and accumulates only
 * genuine external deposits.
 *
 * A rebalance mints with the wallet's whole balance, so each mint after
 * the first takes in whatever the wallet received from outside since the
 * mint before it: a fresh deposit, read from the wallet's transfers in
 * that window (`depositsInWindow`, src/wallet-deposits.js).
 *
 * The deposit count (src/deposit-count.js) records deposits earlier, as
 * they arrive, one entry per transaction, into the same results. A
 * window this scan reads later leaves those transactions out, so each
 * deposit counts once.
 *
 * An addition of liquidity to an NFT after its mint is a compound or money
 * put in. A compound this install made is never money put in, however much
 * its deposit took from the wallet: those coins were counted when they
 * reached it, or are what a rebalance or the first mint left there, which
 * Lifetime Net P&L counts as the Wallet Residual and the Initial Wallet
 * Residual.
 *
 * Receives pre-fetched NFT events (from scanNftEvents) + provider for
 * Transfer scanning.
 */

"use strict";

const { log } = require("./log");
const { coinDecimals } = require("./coin-decimals");
const { _filterRebalances } = require("./compounder");
const { depositsInWindow } = require("./wallet-deposits");
const { isCountedEntry } = require("./counted-deposits");
const { compoundedUnits, recordedCompounds } = require("./compounded-coins");

/**
 * Build an ordered list of tokenIds from rebalance events (oldest → newest).
 * @param {string|number} currentTokenId
 * @param {object[]} rebalanceEvents  Array of { oldTokenId, newTokenId }.
 * @returns {string[]} Ordered tokenIds.
 */
function _buildChainOrder(currentTokenId, rebalanceEvents) {
  const ids = new Set([String(currentTokenId)]);
  for (const ev of rebalanceEvents || []) {
    if (ev.oldTokenId) ids.add(String(ev.oldTokenId));
    if (ev.newTokenId) ids.add(String(ev.newTokenId));
  }
  // Sort by first appearance in rebalance chain (oldest first).
  // Rebalance events are chronological: ev[0].old is the oldest NFT.
  const ordered = [];
  const remaining = new Set(ids);
  for (const ev of rebalanceEvents || []) {
    const old = String(ev.oldTokenId);
    if (remaining.has(old)) {
      ordered.push(old);
      remaining.delete(old);
    }
  }
  // Whatever is left (current tokenId, or single-NFT positions)
  for (const id of remaining) ordered.push(id);
  return ordered;
}

/**
 * Classify subsequent ILs on one NFT as compound or external deposit.
 * Returns the accumulated external deposit amounts (raw BigInt).
 *
 * A compound this install made (`recorded`, by transaction) is a compound
 * whatever its size. Its deposit took only the wallet's coins: the fees
 * its collect brought in, and, when its swap ran, coins the wallet
 * already held, which were counted when they reached the wallet or are
 * what a rebalance or the first mint left there (src/compounded-coins.js).
 * It uses up as much of the NFT's fees as it put back. Any other addition
 * is a compound while the additions so far stay within the NFT's fees, and
 * otherwise money put in.
 *
 * @param {object[]} ilEvents  The NFT's IncreaseLiquidity events, in
 *   chain order; the first is its mint.
 * @param {object[]} collectEvents  Its Collect events.
 * @param {object[]} dlEvents  Its DecreaseLiquidity events.
 * @param {Map<string, object>} recorded  The compounds this install made,
 *   from `recordedCompounds`.
 * @returns {{ext0: bigint, ext1: bigint}}
 */
function _classifySubsequentILs(ilEvents, collectEvents, dlEvents, recorded) {
  if (ilEvents.length <= 1) return { ext0: 0n, ext1: 0n };
  const nonRebalance = _filterRebalances(ilEvents.slice(1), dlEvents);
  // Fee cap = total Collected − total DecreasedLiquidity = net fees only.
  // Collects include drain amounts from rebalances, which are NOT fees.
  let totCol0 = 0n,
    totCol1 = 0n,
    totDl0 = 0n,
    totDl1 = 0n;
  for (const e of collectEvents) {
    totCol0 += e.amount0 ?? 0n;
    totCol1 += e.amount1 ?? 0n;
  }
  for (const e of dlEvents) {
    totDl0 += e.amount0 ?? 0n;
    totDl1 += e.amount1 ?? 0n;
  }
  const feeCap0 = totCol0 > totDl0 ? totCol0 - totDl0 : 0n;
  const feeCap1 = totCol1 > totDl1 ? totCol1 - totDl1 : 0n;
  let compSum0 = 0n,
    compSum1 = 0n,
    ext0 = 0n,
    ext1 = 0n;
  for (const il of nonRebalance) {
    const record = recorded.get(String(il.txHash ?? "").toLowerCase());
    if (record !== undefined) {
      const fees = compoundedUnits(
        { raw0: il.amount0, raw1: il.amount1 },
        record,
      );
      compSum0 += fees.raw0;
      compSum1 += fees.raw1;
      continue;
    }
    const w0 = compSum0 + il.amount0,
      w1 = compSum1 + il.amount1;
    if (w0 <= feeCap0 && w1 <= feeCap1) {
      compSum0 = w0;
      compSum1 = w1;
    } else {
      ext0 += il.amount0;
      ext1 += il.amount1;
    }
  }
  return { ext0, ext1 };
}

/**
 * The fresh deposit one mint took in: what the wallet received from
 * outside between the mint before it and this one.
 *
 * The window's deposits come from `depositsInWindow`, one per
 * transaction. Those the deposit count has already recorded are left
 * out, since the count put them in the results when they arrived, at
 * their own blocks; counting them again here would count them twice.
 *
 * @param {object} provider  ethers provider with `getLogs`.
 * @param {object} ethersLib  ethers library.
 * @param {string} token0  The pool's token0.
 * @param {string} token1  The pool's token1.
 * @param {string} wallet  The wallet.
 * @param {number} prevMintBlock  The mint before this one.
 * @param {number} nextMintBlock  This mint.
 * @param {string[]} [excludeFromAddrs]  Senders whose transfers are the
 *   bot's own (the position manager and the pool).
 * @param {string} [wrappedNativeAddress]  The wrapped native coin, whose
 *   wraps count as deposits.
 * @param {Set<string>} [countedTx]  Transactions the deposit count has
 *   recorded, lower-cased.
 * @returns {Promise<{ f0: bigint, f1: bigint }>}
 */
async function _freshDeposits(
  provider,
  ethersLib,
  token0,
  token1,
  wallet,
  prevMintBlock,
  nextMintBlock,
  excludeFromAddrs,
  wrappedNativeAddress,
  countedTx,
) {
  const entries = await depositsInWindow({
    provider,
    ethersLib,
    token0,
    token1,
    wallet,
    fromBlock: prevMintBlock + 1,
    toBlock: nextMintBlock,
    excludeFromAddrs,
    wrappedNativeAddress,
  });
  let f0 = 0n;
  let f1 = 0n;
  let already = 0;
  for (const e of entries) {
    if (countedTx instanceof Set && countedTx.has(e.txHash.toLowerCase())) {
      already++;
      continue;
    }
    f0 += e.raw0;
    f1 += e.raw1;
  }
  if (already > 0)
    log.info(
      "[hodl]   %d deposit TX(s) in %d→%d already counted as they arrived, left out",
      already,
      prevMintBlock + 1,
      nextMintBlock,
    );
  return { f0, f1 };
}

/**
 * Scan for fresh deposits between the previous NFT's mint and this one's.
 *
 * @param {object} opts  `computeLifetimeHodl`'s options.
 * @param {Map} allNftEvents  The chain's NFT events, by tokenId.
 * @param {string[]} ordered  The chain's tokenIds, oldest first.
 * @param {number} i  This NFT's place in `ordered`.
 * @param {object} mintIl  This NFT's first IncreaseLiquidity: its mint.
 * @param {Set<string>} countedTx  Transactions the deposit count has
 *   recorded.
 * @returns {Promise<{ f0: bigint, f1: bigint }>}
 */
async function _rebalanceFresh(
  opts,
  allNftEvents,
  ordered,
  i,
  mintIl,
  countedTx,
) {
  const { provider, ethersLib, position, walletAddress } = opts;
  // Use the previous NFT's first IL (mint) block as the scan start
  const prevEvents = allNftEvents.get(ordered[i - 1]);
  const prevMint = prevEvents?.ilEvents?.[0];
  if (!prevMint) return { f0: 0n, f1: 0n };
  return _freshDeposits(
    provider,
    ethersLib,
    position.token0,
    position.token1,
    walletAddress,
    prevMint.blockNumber,
    mintIl.blockNumber,
    opts.excludeFromAddrs,
    opts.wrappedNativeAddress,
    countedTx,
  );
}

/**
 * Record a deposit entry for USD computation (skip if block already
 * cached).
 *
 * Every deposit an NFT took in is recorded at that NFT's mint block, so
 * one block can hold two kinds, told apart by `kind`: `fresh`, the
 * wallet's own coins that went into a mint, and `external`, liquidity
 * added to the NFT directly afterwards. A rebalance's Activity Log
 * figures set aside the fresh deposits it took in
 * (src/rebalance-activity-figures.js).
 *
 * The blocks already cached are those of this scan's own earlier
 * entries. The deposit count's entries, each at its transaction's own
 * block and naming that transaction, are not among them: one landing in
 * a mint's block is not that mint's deposit.
 *
 * @param {object} ctx  The tally under way.
 * @param {bigint} raw0  Token0 deposited, in its smallest unit.
 * @param {bigint} raw1  Token1 deposited, in its smallest unit.
 * @param {number} block  The NFT's mint block.
 * @param {"fresh"|"external"} kind  What the deposit was.
 */
function _addDeposit(ctx, raw0, raw1, block, kind) {
  if (raw0 <= 0n && raw1 <= 0n) return;
  if (ctx._cachedBlocks && ctx._cachedBlocks.has(block)) return;
  ctx.deposits.push({ raw0: String(raw0), raw1: String(raw1), block, kind });
}

/** Process one NFT in the rebalance chain, returning deposit + external amounts. */
async function _processNft(i, tid, allNftEvents, ordered, opts, ctx) {
  const events = allNftEvents.get(tid);
  if (!events || events.ilEvents.length === 0) {
    log.info("[hodl] #%s (idx=%d): no IL events, skip", tid, i);
    return;
  }
  const { ilEvents, collectEvents, dlEvents } = events;
  const mintIl = ilEvents[0];
  if (i === 0) {
    log.info(
      "[hodl] #%s FIRST: mint0=%s mint1=%s",
      tid,
      String(mintIl.amount0),
      String(mintIl.amount1),
    );
    ctx.total0 += mintIl.amount0;
    ctx.total1 += mintIl.amount1;
    _addDeposit(
      ctx,
      mintIl.amount0,
      mintIl.amount1,
      mintIl.blockNumber,
      "fresh",
    );
  } else if (ctx.canScan && mintIl.blockNumber > ctx.cachedBlock) {
    const { f0, f1 } = await _rebalanceFresh(
      opts,
      allNftEvents,
      ordered,
      i,
      mintIl,
      ctx.countedTx,
    );
    if (f0 > 0n || f1 > 0n)
      log.info("[hodl] #%s FRESH: f0=%s f1=%s", tid, String(f0), String(f1));
    ctx.fresh0 += f0;
    ctx.fresh1 += f1;
    _addDeposit(ctx, f0, f1, mintIl.blockNumber, "fresh");
    if (mintIl.blockNumber > ctx.maxBlock) ctx.maxBlock = mintIl.blockNumber;
  }
  const { ext0, ext1 } = _classifySubsequentILs(
    ilEvents,
    collectEvents,
    dlEvents,
    ctx.recorded,
  );
  if (ext0 > 0n || ext1 > 0n) {
    log.info(
      "[hodl] #%s external: ext0=%s ext1=%s",
      tid,
      String(ext0),
      String(ext1),
    );
    _addDeposit(ctx, ext0, ext1, mintIl.blockNumber, "external");
  }
  ctx.total0 += ext0;
  ctx.total1 += ext1;
}

/**
 * Compute lifetime HODL amounts from pre-fetched NFT events.
 *
 * Classification per IncreaseLiquidity event:
 * - 1st IL on first NFT  → original mint  → full amounts
 * - 1st IL on Nth NFT    → rebalance mint → fresh deposits via Transfer scan
 * - Subsequent IL that is a compound this install made → 0, whatever its
 *   size
 * - Subsequent IL that is another compound (within fee cap) → 0
 * - Subsequent IL that is an external deposit → full amounts
 *
 * The saved results (`cachedFreshDeposits`) carry the deposits counted
 * so far, the deposit count's among them, and how far the count has
 * read (`countedThrough`), which the new results keep.
 *
 * @param {Map<string, {ilEvents, collectEvents, dlEvents}>} allNftEvents
 * @param {object} opts
 * @param {object[]} opts.rebalanceEvents
 * @param {object}   opts.position  { tokenId, decimals0, decimals1, token0, token1 }
 * @param {string}   opts.walletAddress
 * @param {object}   [opts.provider]   ethers provider (required for Transfer scan)
 * @param {object}   [opts.ethersLib]  ethers library (required for Transfer scan)
 * @param {string[]} [opts.excludeFromAddrs]  Addresses to exclude (PM, pool contract)
 * @param {string}   [opts.wrappedNativeAddress]  Wrapped-native ERC-20 address
 *                                                (e.g. WPLS).  Enables Deposit-event
 *                                                scan for native→wrapped wraps.
 * @param {object}   [opts.cachedFreshDeposits]  { raw0: string, raw1: string,
 *   lastBlock: number, deposits: object[], countedThrough?: number }
 * @param {object[]} [opts.compoundHistory]  The position's compound list,
 *   which names the compounds this install made.
 * @returns {Promise<{ amount0: number, amount1: number, raw0: string,
 *   raw1: string, lastBlock: number, deposits: object[],
 *   countedThrough?: number }>}
 */
async function computeLifetimeHodl(allNftEvents, opts) {
  const { rebalanceEvents, position, provider, ethersLib, walletAddress } =
    opts;
  const ordered = _buildChainOrder(position.tokenId, rebalanceEvents);
  const { d0, d1 } = coinDecimals(
    position,
    "the position",
    "the lifetime deposit count",
  );
  const cached = opts.cachedFreshDeposits;
  const cachedDeps = cached?.deposits ? [...cached.deposits] : [];
  const scanned = cachedDeps.filter((d) => !isCountedEntry(d));
  const counted = cachedDeps.filter(isCountedEntry);
  const ctx = {
    canScan: !!(
      provider &&
      ethersLib &&
      walletAddress &&
      position.token0 &&
      position.token1
    ),
    cachedBlock: cached?.lastBlock || 0,
    fresh0: cached ? BigInt(cached.raw0) : 0n,
    fresh1: cached ? BigInt(cached.raw1) : 0n,
    maxBlock: cached?.lastBlock || 0,
    total0: 0n,
    total1: 0n,
    deposits: cachedDeps,
    _cachedBlocks: new Set(scanned.map((d) => d.block)),
    countedTx: new Set(counted.map((d) => d.txHash.toLowerCase())),
    recorded: recordedCompounds(opts.compoundHistory),
  };

  for (let i = 0; i < ordered.length; i++)
    await _processNft(i, ordered[i], allNftEvents, ordered, opts, ctx);

  ctx.total0 += ctx.fresh0;
  ctx.total1 += ctx.fresh1;

  const result = {
    amount0: Number(ctx.total0) / 10 ** d0,
    amount1: Number(ctx.total1) / 10 ** d1,
    raw0: String(ctx.fresh0),
    raw1: String(ctx.fresh1),
    lastBlock: ctx.maxBlock,
    deposits: ctx.deposits,
  };
  if (typeof cached?.countedThrough === "number")
    result.countedThrough = cached.countedThrough;
  return result;
}

module.exports = {
  computeLifetimeHodl,
  _buildChainOrder,
  _freshDeposits,
};
