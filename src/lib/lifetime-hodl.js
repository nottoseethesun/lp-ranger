/**
 * @file src/lib/lifetime-hodl.js
 * @description Compute accumulated lifetime HODL amounts across a rebalance
 * chain.  Classifies each IncreaseLiquidity event as original-mint,
 * rebalance-mint, compound, or external-deposit, and accumulates only
 * genuine external deposits.
 *
 * A rebalance mints with the wallet's whole balance, so each mint after
 * the first takes in whatever the wallet received from outside since the
 * mint before it: the fresh deposits, read from the wallet's transfers in
 * that window (`depositsInWindow`, src/lib/wallet-deposits.js). Each is
 * entered on its own, at its transaction's block and naming that
 * transaction, so Total Lifetime Deposit prices it at its own block.
 *
 * The deposit count (src/lib/deposit-count.js) records deposits earlier, as
 * they arrive, the same way, into the same results. A window this scan
 * reads later leaves those transactions out, so each deposit counts once,
 * and a scan that builds the results again from the chain, as Reload
 * Current Position does, enters the same deposits the count recorded, at
 * the same blocks.
 *
 * An addition of liquidity to an NFT after its mint is money put in only
 * when another wallet paid for it, and then all of it, entered at its own
 * block (`_additionsPutIn`). One the wallet paid for took coins already
 * counted: a deposit counted when it reached the wallet, or the
 * position's own coins, which Lifetime Net P&L counts as the Wallet
 * Residual and the Initial Wallet Residual. The addition's receipt says
 * which: whether its transaction moved either of the pool's coins out of
 * the wallet.
 *
 * Receives pre-fetched NFT events (from scanNftEvents) + provider for
 * Transfer scanning.
 */

"use strict";

const { log } = require("./log");
const { coinDecimals } = require("./coin-decimals");
const { _filterRebalances } = require("./compounder");
const { depositsInWindow } = require("./wallet-deposits");
const { isAdditionEntry, isCountedEntry } = require("./counted-deposits");
const { recordedCompounds } = require("./compounded-coins");

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
 * What reading an addition's receipt needs, or null when this scan has
 * no provider, wallet or pool coins to read it with.
 *
 * @param {object} opts  `computeLifetimeHodl`'s options.
 * @param {boolean} canScan  Whether all of them were given.
 * @returns {{provider: object, coins: Set<string>, walletTopic: string,
 *   transferTopic: string}|null}  The coins and topics lower-cased.
 */
function _receiptReader(opts, canScan) {
  if (!canScan) return null;
  const e = opts.ethersLib;
  return {
    provider: opts.provider,
    coins: new Set([
      opts.position.token0.toLowerCase(),
      opts.position.token1.toLowerCase(),
    ]),
    walletTopic: e.zeroPadValue(opts.walletAddress, 32).toLowerCase(),
    transferTopic: e.id("Transfer(address,address,uint256)").toLowerCase(),
  };
}

/**
 * Whether a transaction moved either of the pool's coins out of the
 * wallet. The position manager takes an addition's coins from whoever
 * calls it, so they leave the wallet only when the wallet paid: calling
 * the position manager itself, or through a contract it sent them to.
 *
 * @param {object[]|undefined} logs  The transaction receipt's logs.
 * @param {object} reader  From `_receiptReader`.
 * @returns {boolean}
 */
function _movedFromWallet(logs, reader) {
  return (Array.isArray(logs) ? logs : []).some(
    (l) =>
      reader.coins.has(String(l.address).toLowerCase()) &&
      Array.isArray(l.topics) &&
      String(l.topics[0]).toLowerCase() === reader.transferTopic &&
      String(l.topics[1]).toLowerCase() === reader.walletTopic,
  );
}

/**
 * Whether the wallet paid for one addition, from its receipt.
 *
 * An addition that cannot be judged stops the scan. Counted one way or
 * the other on a guess, it would be saved as fact; failed, the scan is
 * tried again.
 *
 * @param {object} il  The addition's IncreaseLiquidity event.
 * @param {object|null} reader  From `_receiptReader`.
 * @returns {Promise<boolean>}
 */
async function _walletPaidFor(il, reader) {
  if (reader === null)
    throw new Error(
      `the addition of liquidity in block ${il.blockNumber} needs its receipt, and the Lifetime scan has no provider, wallet or pool coins to read it with`,
    );
  if (typeof il.txHash !== "string" || il.txHash === "")
    throw new Error(
      `the addition of liquidity in block ${il.blockNumber} names no transaction, so who paid for it cannot be read`,
    );
  const receipt = await reader.provider.getTransactionReceipt(il.txHash);
  if (receipt === null || receipt === undefined)
    throw new Error(
      `no receipt came back for the addition of liquidity in transaction ${il.txHash}, so who paid for it is not known`,
    );
  return _movedFromWallet(receipt.logs, reader);
}

/**
 * The additions of liquidity to one NFT after its mint that were money
 * put in: those another wallet paid for, one entry each, at its own
 * block and naming its transaction, so Total Lifetime Deposit prices it
 * at the day it was made.
 *
 * An addition the wallet paid for is never money put in, whoever made
 * it. Its coins were counted already: as a deposit when they reached the
 * wallet, or they are the position's own, a rebalance's leftovers or
 * fees. Its receipt says which (`_walletPaidFor`). A compound LP Ranger
 * recorded as it made it (`recorded`) paid from the wallet, so its
 * receipt is not read. An addition soon after a drain is a rebalance's
 * (`_filterRebalances`), whose mint the fresh deposits cover.
 *
 * @param {{ilEvents: object[], dlEvents: object[]}} events  The NFT's
 *   IncreaseLiquidity events in chain order, the first its mint, and its
 *   DecreaseLiquidity events.
 * @param {Map<string, object>} recorded  The compounds LP Ranger
 *   recorded, from `recordedCompounds`.
 * @param {object|null} reader  From `_receiptReader`.
 * @param {string} tokenId  The NFT, which each entry names, so the
 *   Current panel can add its own to Initial Deposit for This LP
 *   (src/lib/current-lp-deposit.js).
 * @returns {Promise<Array<{raw0: string, raw1: string, block: number,
 *   kind: "external", txHash: string, tokenId: string}>>}
 */
async function _additionsPutIn(events, recorded, reader, tokenId) {
  const { ilEvents, dlEvents } = events;
  if (ilEvents.length <= 1) return [];
  const entries = [];
  for (const il of _filterRebalances(ilEvents.slice(1), dlEvents)) {
    if (recorded.has(String(il.txHash ?? "").toLowerCase())) continue;
    if (await _walletPaidFor(il, reader)) continue;
    entries.push({
      raw0: String(il.amount0),
      raw1: String(il.amount1),
      block: il.blockNumber,
      kind: "external",
      txHash: il.txHash,
      tokenId: String(tokenId),
    });
  }
  return entries;
}

/**
 * An addition's entry with the price an earlier scan gave the same
 * transaction, so Total Lifetime Deposit does not ask for it again.
 *
 * @param {object} entry  From `_additionsPutIn`.
 * @param {Map<string, object>} saved  The saved additions, by lower-cased
 *   transaction.
 * @returns {object}
 */
function _withSavedPrice(entry, saved) {
  const earlier = saved.get(entry.txHash.toLowerCase());
  if (earlier === undefined) return entry;
  if (!(typeof earlier.usd === "number" && earlier.usd > 0)) return entry;
  return { ...entry, usd: earlier.usd, fallback: earlier.fallback === true };
}

/**
 * The saved additions that name their transaction, by lower-cased
 * transaction, for `_withSavedPrice`.
 *
 * @param {object[]} deposits  The saved deposit list.
 * @returns {Map<string, object>}
 */
function _savedAdditions(deposits) {
  const out = new Map();
  for (const d of deposits) {
    if (!isAdditionEntry(d)) continue;
    if (typeof d.txHash !== "string" || d.txHash === "") continue;
    out.set(d.txHash.toLowerCase(), d);
  }
  return out;
}

/**
 * The fresh deposits one mint took in: what the wallet received from
 * outside between the mint before it and this one, one entry per
 * transaction, at its own block and naming it, as the deposit count
 * records them.
 *
 * The window's deposits come from `depositsInWindow`. Those the results
 * hold already are left out: the deposit count put them in when they
 * arrived, and counting them again here would count them twice.
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
 * @param {Set<string>} [countedTx]  Transactions the results hold
 *   already, lower-cased.
 * @returns {Promise<{f0: bigint, f1: bigint, entries: Array<{raw0: string,
 *   raw1: string, block: number, kind: "fresh", txHash: string}>}>}  The
 *   window's totals and its entries, in block order.
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
  const kept = [];
  for (const e of entries) {
    if (countedTx instanceof Set && countedTx.has(e.txHash.toLowerCase())) {
      already++;
      continue;
    }
    f0 += e.raw0;
    f1 += e.raw1;
    kept.push({
      raw0: String(e.raw0),
      raw1: String(e.raw1),
      block: e.block,
      kind: "fresh",
      txHash: e.txHash,
    });
  }
  if (already > 0)
    log.info(
      "[hodl]   %d deposit TX(s) in %d→%d already counted as they arrived, left out",
      already,
      prevMintBlock + 1,
      nextMintBlock,
    );
  return { f0, f1, entries: kept };
}

/**
 * Scan for fresh deposits between the previous NFT's mint and this one's.
 *
 * @param {object} opts  `computeLifetimeHodl`'s options.
 * @param {Map} allNftEvents  The chain's NFT events, by tokenId.
 * @param {string[]} ordered  The chain's tokenIds, oldest first.
 * @param {number} i  This NFT's place in `ordered`.
 * @param {object} mintIl  This NFT's first IncreaseLiquidity: its mint.
 * @param {Set<string>} countedTx  Transactions the results hold already.
 * @returns {Promise<{f0: bigint, f1: bigint, entries: object[]}>}  From
 *   `_freshDeposits`.
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
  if (!prevMint) return { f0: 0n, f1: 0n, entries: [] };
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
 * Record the first NFT's minted coins, the money the position began
 * with, as the list's first deposit: at the mint block, tagged `fresh`,
 * unless the saved list holds it already. Every later deposit names its
 * transaction (`_freshDeposits`, `_additionsPutIn`); this one is known by
 * its block.
 *
 * The blocks the saved list holds are those of its entries that name no
 * transaction: this one, and a window an earlier version summed into one
 * entry at its mint's block. An entry naming its transaction is not
 * among them, since one landing in the mint's block is not the mint.
 *
 * @param {object} ctx  The tally under way.
 * @param {object} mintIl  The first NFT's mint: its first
 *   IncreaseLiquidity, amounts in the coins' smallest units.
 */
function _addFirstMint(ctx, mintIl) {
  const { amount0, amount1, blockNumber } = mintIl;
  if (amount0 <= 0n && amount1 <= 0n) return;
  if (ctx._cachedBlocks.has(blockNumber)) return;
  ctx.deposits.push({
    raw0: String(amount0),
    raw1: String(amount1),
    block: blockNumber,
    kind: "fresh",
  });
}

/**
 * Process one NFT in the rebalance chain: the deposits its mint took in,
 * and the additions to it another wallet paid for.
 */
async function _processNft(i, tid, allNftEvents, ordered, opts, ctx) {
  const events = allNftEvents.get(tid);
  if (!events || events.ilEvents.length === 0) {
    log.info("[hodl] #%s (idx=%d): no IL events, skip", tid, i);
    return;
  }
  const mintIl = events.ilEvents[0];
  if (i === 0) {
    log.info(
      "[hodl] #%s FIRST: mint0=%s mint1=%s",
      tid,
      String(mintIl.amount0),
      String(mintIl.amount1),
    );
    ctx.total0 += mintIl.amount0;
    ctx.total1 += mintIl.amount1;
    _addFirstMint(ctx, mintIl);
  } else if (ctx.canScan && mintIl.blockNumber > ctx.cachedBlock) {
    const { f0, f1, entries } = await _rebalanceFresh(
      opts,
      allNftEvents,
      ordered,
      i,
      mintIl,
      ctx.countedTx,
    );
    if (f0 > 0n || f1 > 0n)
      log.info(
        "[hodl] #%s FRESH: f0=%s f1=%s in %d deposit TX(s), each at its own block",
        tid,
        String(f0),
        String(f1),
        entries.length,
      );
    ctx.fresh0 += f0;
    ctx.fresh1 += f1;
    ctx.deposits.push(...entries);
    if (mintIl.blockNumber > ctx.maxBlock) ctx.maxBlock = mintIl.blockNumber;
  }
  const additions = await _additionsPutIn(
    events,
    ctx.recorded,
    ctx.reader,
    tid,
  );
  for (const a of additions) {
    log.info(
      "[hodl] #%s addition another wallet paid for, block %d, TX %s: raw0=%s raw1=%s",
      tid,
      a.block,
      a.txHash.slice(0, 10),
      a.raw0,
      a.raw1,
    );
    ctx.deposits.push(_withSavedPrice(a, ctx.savedAdditions));
    ctx.total0 += BigInt(a.raw0);
    ctx.total1 += BigInt(a.raw1);
  }
}

/**
 * Compute lifetime HODL amounts from pre-fetched NFT events.
 *
 * Classification per IncreaseLiquidity event:
 * - 1st IL on first NFT  → original mint  → full amounts
 * - 1st IL on Nth NFT    → rebalance mint → fresh deposits via Transfer
 *   scan, an entry for each at its own block
 * - Later IL the wallet paid for → 0, whoever made it
 * - Later IL another wallet paid for → full amounts, an entry of its own
 *
 * The saved results (`cachedFreshDeposits`) carry the deposits counted
 * so far, the deposit count's among them, and how far the count has
 * read (`countedThrough`), which the new results keep. Their additions
 * are worked out again from the receipts, keeping only each one's
 * price. A list an earlier version saved keeps its windows as that
 * version summed them, one entry at each mint's block, until it is built
 * again from the chain.
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
  /*- Each scan works the additions out again from their receipts, so the
   *  saved ones are set aside, kept only for the price each was given. */
  const others = cachedDeps.filter((d) => !isAdditionEntry(d));
  /*- A saved deposit naming its transaction, the deposit count's or this
   *  scan's own, is left out of a window that holds it; the first mint,
   *  and a window an earlier version summed at its mint's block, are
   *  known by their block. */
  const byBlock = others.filter((d) => !isCountedEntry(d));
  const byTx = others.filter(isCountedEntry);
  const canScan = !!(
    provider &&
    ethersLib &&
    walletAddress &&
    position.token0 &&
    position.token1
  );
  const ctx = {
    canScan,
    cachedBlock: cached?.lastBlock || 0,
    fresh0: cached ? BigInt(cached.raw0) : 0n,
    fresh1: cached ? BigInt(cached.raw1) : 0n,
    maxBlock: cached?.lastBlock || 0,
    total0: 0n,
    total1: 0n,
    deposits: others,
    _cachedBlocks: new Set(byBlock.map((d) => d.block)),
    countedTx: new Set(byTx.map((d) => d.txHash.toLowerCase())),
    recorded: recordedCompounds(opts.compoundHistory),
    reader: _receiptReader(opts, canScan),
    savedAdditions: _savedAdditions(cachedDeps),
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
