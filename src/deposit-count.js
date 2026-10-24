/**
 * @file src/deposit-count.js
 * @module deposit-count
 * @description
 * Counts the deposits the owner makes to the wallet, as they arrive, so
 * no figure reads a deposit as the position's gain.
 *
 * Coins the owner sends to the wallet sit beside the position until a
 * rebalance mints them into it. Every poll credits the wallet's coins to
 * the position (the Wallet Residual) in the Lifetime figures, so until
 * those coins are counted as money put in, they read as a gain there: in
 * Lifetime Net P&L and the Lifetime IL/G. The Current IL/G and the
 * Impermanent Loss Guard count no coin in the wallet, so a deposit moves
 * them only once a compound takes it into the NFT (src/bot-pnl-il.js).
 * The Lifetime scan counts deposits, but only after the next rebalance
 * has minted them (src/lifetime-hodl.js).
 *
 * This module counts them earlier, from the block the last count read up
 * to the chain's head, by the same rules the Lifetime scan uses
 * (`depositsInWindow`, src/wallet-deposits.js). A count runs at two
 * moments:
 *
 * - as the first step of every rebalance and compound (src/bot-cycle.js,
 *   src/bot-cycle-compound.js). This is a move's count: its deposits go
 *   into the pool's Lifetime results in the epoch cache
 *   (`lifetimeHodlAmounts`), at their own blocks and each naming its
 *   transaction, and Total Lifetime Deposit prices them there. The
 *   Lifetime scan then leaves those transactions out of the window it
 *   reads after the next rebalance, so each deposit counts once;
 * - when a poll sees the wallet's coins rise above what the last poll
 *   saw, and on the first poll after a move's count, since the move
 *   takes coins from the wallet and a deposit arriving after its count
 *   could hide inside them. This is a poll's count: what it finds is
 *   held on the bot state (`_depositOverlay`), in memory, and the
 *   Lifetime figures add it. The next
 *   move's count reads the same blocks again and records its own answer
 *   in its place, so the moves' counts are the record and a poll's only
 *   brings the figures up to date between them.
 *
 * A count starts after the latest of three blocks: the last one a move's
 * count read (`countedThrough`), the newest mint the Lifetime results
 * cover (`lastBlock`), and the current NFT's mint, before which deposits
 * went into that mint. It waits while the Lifetime results do not exist
 * yet, and while the current NFT's mint block is unknown. It never stops
 * a move: a count that fails is logged, and the move goes on with the
 * figures as they stood.
 *
 * src/counted-deposits.js turns the records into the figures' coins.
 */

"use strict";

const ethers = require("ethers");
const { log } = require("./log");
const config = require("./config");
const sendTx = require("./send-transaction");
const _epochCache = require("./epoch-cache");
const { depositsInWindow } = require("./wallet-deposits");
const {
  computeDepositUsd,
  freshDepositsOf,
  priceDepositEntries,
} = require("./bot-hodl-scan");
const {
  nftMintBlock,
  isCountedEntry,
  withDepositsAdded,
} = require("./counted-deposits");
const { isPlainObject } = require("./plain-object");
const { isTokenDecimals } = require("./pool-state-validate");
const { logCtx } = require("./logger");
const { getTokenSymbol } = require("./token-symbol-cache");

/** What a count that did not run answers. */
const _NOT_COUNTED = Object.freeze({ counted: false, added: false });

/** A block number, or 0 for one not recorded. */
function _block(n) {
  return typeof n === "number" && Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * The position as every line about a count names it: chain, wallet,
 * position manager, NFT and the pair.
 */
function _ctx(deps) {
  const p = deps.position;
  return logCtx({
    chain: config.CHAIN_NAME,
    wallet: deps.address,
    factory: config.POSITION_MANAGER,
    tokenId: p.tokenId,
    symbol0: getTokenSymbol(p.token0),
    symbol1: getTokenSymbol(p.token1),
  });
}

/**
 * One deposit as the record keeps it: its amounts as strings of the
 * coin's smallest unit, its block, its kind, and its transaction. A
 * deposit a poll already priced keeps that price, so a move's count of
 * the same blocks does not ask for it again.
 */
function _record(e, overlay) {
  const r = {
    raw0: String(e.raw0),
    raw1: String(e.raw1),
    block: e.block,
    kind: "fresh",
    txHash: e.txHash,
  };
  const tx = e.txHash.toLowerCase();
  const seen = (overlay?.entries ?? []).find(
    (o) => isCountedEntry(o) && o.txHash.toLowerCase() === tx,
  );
  if (seen !== undefined && typeof seen.usd === "number" && seen.usd > 0) {
    r.usd = seen.usd;
    r.fallback = seen.fallback === true;
  }
  return r;
}

/**
 * Save a move's count into the pool's Lifetime results: its deposits'
 * coins into the lifetime holding, their entries into the deposit list,
 * and how far it read, then price the new entries into Total Lifetime
 * Deposit. The poll's interim count is dropped, since this one read the
 * same blocks.
 *
 * The results are the ones standing when the count saves, not the ones
 * it read when it started, since reading the chain takes a while. A
 * Lifetime scan may have written newer ones meanwhile, during a
 * Rebalance Now or Compound Now, which the deposits join; the scan read
 * the chain before this count's blocks, so it counted none of them. And
 * Reload Current Position may have cleared them, to rebuild them from
 * the chain: the count is then dropped, and the first poll after the
 * rebuild counts again. A deposit already in the results, saved by
 * another count, is not added twice.
 *
 * The epoch cache gets the results at once, with the copy in memory,
 * before the deposits are priced. A Lifetime scan that finishes while
 * they are priced takes the counts saved during it from the cache
 * (`withLaterCounts`), so one held in memory alone would be lost when
 * the scan writes its own results. Once priced, the results are saved
 * again as they then stand, unless Reload cleared them meanwhile.
 *
 * A price that cannot be had leaves the deposit in the record unpriced,
 * for the next pricing of the list.
 *
 * @param {object} deps  The poll's deps.
 * @param {object[]} records  The deposits found, from `_record`.
 * @param {number} head  The last block read.
 * @param {object} epochKey  The pool's epoch-cache key.
 * @returns {Promise<boolean>}  False when Reload cleared the results.
 */
async function _saveMoveCount(deps, records, head, epochKey) {
  const st = deps._botState;
  const now = st.lifetimeHodlAmounts;
  if (!isPlainObject(now)) return false;
  const { decimals0: d0, decimals1: d1 } = deps.position;
  const saved = new Set(
    (Array.isArray(now.deposits) ? now.deposits : [])
      .filter(isCountedEntry)
      .map((d) => d.txHash.toLowerCase()),
  );
  const fresh = records.filter((r) => !saved.has(r.txHash.toLowerCase()));
  st.lifetimeHodlAmounts = {
    ...withDepositsAdded(now, fresh, d0, d1),
    countedThrough: Math.max(head, _block(now.countedThrough)),
  };
  st._depositOverlay = null;
  _cacheResults(epochKey, st.lifetimeHodlAmounts);
  const emit = deps.updateBotState || (() => {});
  if (fresh.length > 0)
    await computeDepositUsd(
      st,
      emit,
      deps.position,
      { decimals0: d0, decimals1: d1 },
      epochKey,
    ).catch((err) => _pricingFailed(deps, err));
  if (!isPlainObject(st.lifetimeHodlAmounts)) return false;
  _cacheResults(epochKey, st.lifetimeHodlAmounts);
  emit({ lifetimeHodlAmounts: st.lifetimeHodlAmounts });
  return true;
}

/** Save the pool's Lifetime results to both epoch-cache records. */
function _cacheResults(epochKey, hodl) {
  _epochCache.setCachedLifetimeHodl(epochKey, hodl);
  _epochCache.setCachedFreshDeposits(epochKey, freshDepositsOf(hodl));
}

/** Log a pricing that failed; the deposits stay recorded, unpriced. */
function _pricingFailed(deps, err) {
  log.warn(
    "[deposits] %s: the deposits counted could not be priced yet, so Total Lifetime Deposit leaves them out until they are: %s",
    _ctx(deps),
    err.message,
  );
}

/**
 * Hold a poll's count on the bot state, after what earlier polls found,
 * each deposit priced at its own block for Total Lifetime Deposit.
 *
 * Dropped, as a move's count is, when Reload Current Position cleared
 * the Lifetime results while the count read the chain. A price that
 * cannot be had leaves the deposit held unpriced: its coins still count
 * in the IL/G figures, and the next move's count prices it.
 *
 * @param {object} deps  The poll's deps.
 * @param {object|null} overlay  What earlier polls found.
 * @param {object[]} records  The deposits found, from `_record`.
 * @param {number} head  The last block read.
 * @param {object} epochKey  The pool's epoch-cache key.
 * @returns {Promise<boolean>}  False when Reload cleared the results.
 */
async function _holdPollCount(deps, overlay, records, head, epochKey) {
  const st = deps._botState;
  if (!isPlainObject(st.lifetimeHodlAmounts)) return false;
  const { decimals0, decimals1 } = deps.position;
  if (records.length > 0)
    await priceDepositEntries(
      st,
      deps.position,
      records,
      { decimals0, decimals1 },
      epochKey,
    ).catch((err) => _pricingFailed(deps, err));
  st._depositOverlay = {
    through: Math.max(head, _block(overlay?.through)),
    entries: [...(overlay?.entries ?? []), ...records],
  };
  return true;
}

/**
 * Whether a move's count found a deposit the figures did not hold
 * already through a poll's count.
 */
function _foundNew(records, overlay) {
  const held = new Set(
    (overlay?.entries ?? [])
      .filter(isCountedEntry)
      .map((o) => o.txHash.toLowerCase()),
  );
  return records.some((r) => !held.has(r.txHash.toLowerCase()));
}

/**
 * What a count needs before it reads the chain, or null when it cannot
 * run yet: the pool's Lifetime results and epoch-cache key, the poll's
 * interim count, and the block after which it reads.
 *
 * A move's count starts after the latest of the last block a move's
 * count read, the newest mint the Lifetime results cover, and the
 * current NFT's mint. A poll's count goes on from the end of the polls'
 * interim count, which a move's count reads again.
 *
 * @param {object} deps  The poll's deps.
 * @param {"move"|"poll"} kind  Which count.
 * @returns {{lt: object, epochKey: object, overlay: object|null,
 *   from: number}|null}
 */
function _countPlan(deps, kind) {
  const st = deps._botState;
  const position = deps.position;
  const lt = st?.lifetimeHodlAmounts;
  const epochKey = deps._pnlTracker?._epochKey ?? null;
  if (!isPlainObject(lt) || epochKey === null) return null;
  if (!isTokenDecimals(position.decimals0)) return null;
  if (!isTokenDecimals(position.decimals1)) return null;
  const mint = nftMintBlock(position.tokenId, deps._rebalanceEvents);
  if (mint === null) return null;
  const overlay = isPlainObject(st._depositOverlay) ? st._depositOverlay : null;
  const base = Math.max(_block(lt.countedThrough), _block(lt.lastBlock), mint);
  const from =
    kind === "poll" ? Math.max(base, _block(overlay?.through)) : base;
  return { lt, epochKey, overlay, from };
}

/**
 * The count, uncaught. See `countDeposits`.
 *
 * @param {object} deps  The poll's deps.
 * @param {"move"|"poll"} kind  Which count.
 * @returns {Promise<{counted: boolean, added: boolean}>}
 */
async function _count(deps, kind) {
  const plan = _countPlan(deps, kind);
  if (plan === null) return _NOT_COUNTED;
  const { lt, epochKey, overlay, from } = plan;
  const st = deps._botState;
  const position = deps.position;
  const provider = sendTx.getManagedReadProvider();
  const head = await provider.getBlockNumber();
  const found =
    from < head
      ? await depositsInWindow({
          provider,
          ethersLib: deps._ethersLib || ethers,
          token0: position.token0,
          token1: position.token1,
          wallet: deps.address,
          fromBlock: from + 1,
          toBlock: head,
          excludeFromAddrs: [
            config.POSITION_MANAGER,
            lt.poolAddress ?? st.poolAddress,
          ],
          wrappedNativeAddress: config.CHAIN.nativeWrappedToken,
          label: "deposit-count",
        })
      : [];
  const records = found.map((e) => _record(e, overlay));
  log.info(
    "[deposits] %s: %s's count of blocks %d→%d found %d deposit(s)",
    _ctx(deps),
    kind === "poll" ? "a poll" : "a move",
    from + 1,
    head,
    records.length,
  );
  if (kind === "poll") {
    const held = await _holdPollCount(deps, overlay, records, head, epochKey);
    return held ? { counted: true, added: records.length > 0 } : _NOT_COUNTED;
  }
  const saved = await _saveMoveCount(deps, records, head, epochKey);
  return saved
    ? { counted: true, added: _foundNew(records, overlay) }
    : _NOT_COUNTED;
}

/**
 * Count the deposits made since the last count.
 *
 * Never throws. A count that fails is logged and answered as not
 * counted, so the caller goes on as before.
 *
 * @param {object} deps  The poll's deps: `_botState`, `position`
 *   (tokens, decimals, NFT), `address`, `_rebalanceEvents`,
 *   `_pnlTracker` (for the pool's epoch-cache key) and `updateBotState`.
 * @param {"move"|"poll"} kind  A move's count, saved into the Lifetime
 *   results, or a poll's, held in memory until the next move's.
 * @returns {Promise<{counted: boolean, added: boolean}>}  `added` when
 *   the count changed what the figures hold, so a caller holding figures
 *   worked out before it knows to work them out again.
 */
async function countDeposits(deps, kind) {
  /*-
   *  A move takes coins from the wallet, so the reading a poll's count
   *  compares against stops describing it: a deposit landing after this
   *  count could hide inside what the move takes, and no later poll
   *  would see the wallet rise. With the reading forgotten, the next
   *  poll counts whatever the wallet then holds.
   */
  if (kind === "move" && isPlainObject(deps._botState))
    deps._botState._depositWalletSeen = null;
  try {
    return await _count(deps, kind);
  } catch (err) {
    log.warn(
      "[deposits] %s: the deposit count failed, so the figures stand as they were until the next count: %s",
      _ctx(deps),
      err.message,
    );
    return _NOT_COUNTED;
  }
}

/** Whether a reading is the wallet's two coins in their smallest units. */
function _isWallet(w) {
  return (
    isPlainObject(w) && typeof w.raw0 === "bigint" && typeof w.raw1 === "bigint"
  );
}

/**
 * A poll's count, made when the wallet's coins have risen since the last
 * poll saw them, or when no poll has seen them since the bot started,
 * the position was reloaded, or a move's count ran.
 *
 * The reading is kept once a count has answered for it, or when it shows
 * no rise. A count that did not run keeps nothing, so the next poll asks
 * again.
 *
 * @param {object} deps  The poll's deps; see `countDeposits`.
 * @param {{raw0: bigint, raw1: bigint}} wallet  The wallet's two coins,
 *   as this poll read them.
 * @returns {Promise<{counted: boolean, added: boolean}>}
 */
async function countDepositsOnRise(deps, wallet) {
  const st = deps._botState;
  if (!isPlainObject(st) || !_isWallet(wallet)) return _NOT_COUNTED;
  const seen = st._depositWalletSeen;
  const rose =
    !_isWallet(seen) || wallet.raw0 > seen.raw0 || wallet.raw1 > seen.raw1;
  if (!rose) {
    st._depositWalletSeen = wallet;
    return _NOT_COUNTED;
  }
  const r = await countDeposits(deps, "poll");
  if (r.counted) st._depositWalletSeen = wallet;
  return r;
}

module.exports = { countDeposits, countDepositsOnRise };
