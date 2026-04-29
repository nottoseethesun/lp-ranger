/**
 * @file src/lifetime-hodl.js
 * @description Compute accumulated lifetime HODL amounts across a rebalance
 * chain.  Classifies each IncreaseLiquidity event as original-mint,
 * rebalance-mint, compound, or external-deposit, and accumulates only
 * genuine external deposits.
 *
 * Fresh deposit detection scans ERC20 Transfer events on the wallet between
 * each drain and the next mint/IncreaseLiquidity.  Swaps (TX with one token
 * out, other token in) are excluded.
 *
 * Receives pre-fetched NFT events (from scanNftEvents) + provider for
 * Transfer scanning.
 */

"use strict";

const { _filterRebalances } = require("./compounder");

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
 */
function _classifySubsequentILs(ilEvents, collectEvents, dlEvents) {
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

/** Fetch all Transfer events for a token involving the wallet in a block range. */
async function _scanTransfers(
  provider,
  ethersLib,
  tokenAddr,
  wallet,
  fromBlock,
  toBlock,
) {
  if (fromBlock > toBlock) return [];
  const padded = ethersLib.zeroPadValue(wallet, 32);
  const topic0 = ethersLib.id("Transfer(address,address,uint256)");
  const base = { address: tokenAddr, fromBlock, toBlock };
  const [inLogs, outLogs] = await Promise.all([
    provider
      .getLogs({ ...base, topics: [topic0, null, padded] })
      .catch(() => []),
    provider
      .getLogs({ ...base, topics: [topic0, padded, null] })
      .catch(() => []),
  ]);
  const out = [];
  for (const log of inLogs)
    out.push({
      txHash: log.transactionHash,
      amount: BigInt(log.data),
      dir: "in",
      from: log.topics[1],
    });
  for (const log of outLogs)
    out.push({
      txHash: log.transactionHash,
      amount: BigInt(log.data),
      dir: "out",
    });
  return out;
}

/** Classify a TX group: true if it's a genuine deposit, false if swap or drain. */
function _isDeposit(group) {
  const t0Out = group.t0.some((t) => t.dir === "out");
  const t1Out = group.t1.some((t) => t.dir === "out");
  const t0In = group.t0.some((t) => t.dir === "in");
  const t1In = group.t1.some((t) => t.dir === "in");
  // Swap: one token out, the other in
  if ((t0Out && t1In) || (t1Out && t0In)) return false;
  // Drain/collect: both tokens inbound, nothing outbound
  if (t0In && t1In && !t0Out && !t1Out) return false;
  return true;
}

/*- Tolerance allowance (in basis points) for wrap detection.  Some "gasless"
    wraps deduct the relayer/gas fee from the wrapped-token side of the wrap,
    so the wallet receives slightly less wrapped than it sent native.  We
    accept any wrapped-IN amount in the half-open band
        [tx.value × (1 - _WRAP_TOLERANCE_BPS/10000), tx.value]
    as a wrap.  Per-token-count (raw BigInt) comparison; safe across decimals
    because native and wrapped always share the same decimal scale.  Generic
    across EVM chains: the wrapped-native ERC-20 address is configured per
    chain in `app-config/static-tunables/chains.json` under
    `nativeWrappedToken` (PulseChain: WPLS = 0xA107…0F9a27). */
const _WRAP_TOLERANCE_BPS = 100n;

/*- Detect a native-token wrap inside a TX.
    EVM LPs can only hold the wrapped form of the native token (PLS→wPLS,
    ETH→wETH, …).  A wrap is invisible to the standard ERC-20 deposit
    classifier when the wrap step is bundled inside a swap or rebalance
    multicall — the wPLS arrival at the wallet looks identical to an LP
    return.  But the on-chain TX itself reveals it: the wallet sends native
    PLS as `tx.value`, and the same TX returns approximately the same amount
    of wPLS to the wallet via a Transfer event.  Allows the wrapped amount
    to be up to `_WRAP_TOLERANCE_BPS` basis points (1%) less than `tx.value`
    to accommodate gasless wraps that deduct the gas fee from the wrapped
    side.  The wrapped amount must NEVER exceed `tx.value` (a normal wrap is
    at most 1:1).  When multiple wrapped-IN transfers fall within tolerance,
    the largest is selected (most likely the wrap; smaller amounts are more
    likely fee refunds or LP returns).  Returns the matched wrapped amount
    (positive BigInt) on match, `0n` otherwise.  We credit the actual
    wrapped amount received, not `tx.value`, because the wrapped amount is
    what entered the LP — the gas-fee delta is not capital.

    @param {object} tx                      Result of provider.getTransaction.
    @param {object[]} wrappedInTransfers    Transfers of the wrapped token to wallet
                                            in this TX (filtered to dir==="in").
    @param {string} walletAddress           Lowercase wallet to match against tx.from.
    @returns {bigint}                       Matched wrapped amount, or 0n. */
function _detectNativeWrap(tx, wrappedInTransfers, walletAddress) {
  if (!tx || tx.value === undefined || tx.value === null) return 0n;
  const value = BigInt(tx.value);
  if (value <= 0n) return 0n;
  if (!tx.from || tx.from.toLowerCase() !== walletAddress.toLowerCase())
    return 0n;
  const minAmount = (value * (10000n - _WRAP_TOLERANCE_BPS)) / 10000n;
  let best = 0n;
  for (const t of wrappedInTransfers) {
    if (t.amount > value) continue;
    if (t.amount < minAmount) continue;
    if (t.amount > best) best = t.amount;
  }
  return best;
}

/** Group Transfer events by txHash, returning Map<txHash, { t0:[], t1:[] }>. */
function _groupByTx(xfers0, xfers1) {
  const byTx = new Map();
  for (const t of xfers0) {
    if (!byTx.has(t.txHash)) byTx.set(t.txHash, { t0: [], t1: [] });
    byTx.get(t.txHash).t0.push(t);
  }
  for (const t of xfers1) {
    if (!byTx.has(t.txHash)) byTx.set(t.txHash, { t0: [], t1: [] });
    byTx.get(t.txHash).t1.push(t);
  }
  return byTx;
}

/** Sum inbound transfers in a TX group; collect from-address tags for logging. */
function _sumGroupInbound(group) {
  let tx0 = 0n,
    tx1 = 0n;
  const fromAddrs = [];
  for (const t of group.t0)
    if (t.dir === "in") {
      tx0 += t.amount;
      if (t.from) fromAddrs.push(t.from.slice(24));
    }
  for (const t of group.t1)
    if (t.dir === "in") {
      tx1 += t.amount;
      if (t.from) fromAddrs.push(t.from.slice(24));
    }
  return { tx0, tx1, fromAddrs };
}

/*- Group Transfer events by txHash, then sum genuine deposit inbound amounts.
    @param {object[]} xfers0  token0 Transfer records
    @param {object[]} xfers1  token1 Transfer records
    @param {object}   [wrap]  Optional wrap-detection context.
    @param {object}   [wrap.provider]      ethers provider exposing getTransaction.
    @param {string}   [wrap.walletAddress] EOA whose tx.from we trust as wallet-initiated.
    @param {0|1|null} [wrap.wrappedTokenIdx] 0 if token0 is the wrapped native, 1 if token1.
    Returns { sum0, sum1 } in raw BigInt token units. */
async function _sumNonSwapInbound(xfers0, xfers1, wrap) {
  const byTx = _groupByTx(xfers0, xfers1);
  let sum0 = 0n,
    sum1 = 0n,
    skipped = 0,
    wraps = 0;
  for (const [txHash, group] of byTx) {
    /*- Wrap-detection: a wallet-initiated TX with positive native value where
        the wrapped-token IN amount exactly matches `tx.value` is a native→wrapped
        wrap (PLS→wPLS / ETH→wETH).  Credit tx.value to the wrapped side and skip
        the standard swap/drain classification, which would mis-label this TX. */
    if (
      wrap &&
      wrap.provider &&
      wrap.walletAddress &&
      (wrap.wrappedTokenIdx === 0 || wrap.wrappedTokenIdx === 1)
    ) {
      const wrappedIns = (
        wrap.wrappedTokenIdx === 0 ? group.t0 : group.t1
      ).filter((t) => t.dir === "in");
      let tx;
      try {
        tx = await wrap.provider.getTransaction(txHash);
      } catch {
        tx = null;
      }
      const wrapAmount = _detectNativeWrap(tx, wrappedIns, wrap.walletAddress);
      if (wrapAmount > 0n) {
        if (wrap.wrappedTokenIdx === 0) sum0 += wrapAmount;
        else sum1 += wrapAmount;
        wraps++;
        console.log(
          "[hodl]   WRAP TX %s: native=%s wrapped[%d]=%s",
          txHash.slice(0, 10),
          String(BigInt(tx.value)),
          wrap.wrappedTokenIdx,
          String(wrapAmount),
        );
        continue;
      }
    }
    if (!_isDeposit(group)) {
      skipped++;
      continue;
    }
    const { tx0, tx1, fromAddrs } = _sumGroupInbound(group);
    if (tx0 > 0n || tx1 > 0n)
      console.log(
        "[hodl]   deposit TX %s: t0=%s t1=%s from=[%s]",
        txHash.slice(0, 10),
        String(tx0),
        String(tx1),
        fromAddrs.join(","),
      );
    sum0 += tx0;
    sum1 += tx1;
  }
  if (byTx.size > 0)
    console.log(
      "[hodl]   window: %d TXs, %d skipped (swap/drain), %d wrap, %d deposit",
      byTx.size,
      skipped,
      wraps,
      byTx.size - skipped - wraps,
    );
  return { sum0, sum1 };
}

/**
 * Detect fresh deposits between a previous mint and the next mint/IL.
 *
 * Scans wallet Transfer events across the full window (previous mint block →
 * next mint block).  Filters:
 * 1. Exclude swaps (TX with one token out, other token in)
 * 2. Exclude drains (both tokens inbound, nothing outbound)
 * 3. Exclude transfers FROM known LP infrastructure contracts — cheap
 *    optimisation that eliminates noise from collect/drain/refund/swap
 *    operations routed through the Position Manager or pool contract.
 * 4. Native-wrap detection: wallet-initiated TXs where `tx.value` (native
 *    PLS/ETH) exactly matches a wrapped-token IN amount in the same TX
 *    are credited as fresh wrapped-token deposits, even when other
 *    Transfer-event heuristics would skip the TX.
 * 5. Sum remaining inbound transfers = genuine fresh deposits
 *
 * @param {string[]} [excludeFromAddrs]      Addresses to filter out (PM, pool).
 * @param {string}   [wrappedNativeAddress]  EIP-55 address of the wrapped native
 *                                           token; enables wrap-detection branch.
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
) {
  const scanFrom = prevMintBlock + 1;
  const [xfers0, xfers1] = await Promise.all([
    _scanTransfers(
      provider,
      ethersLib,
      token0,
      wallet,
      scanFrom,
      nextMintBlock,
    ),
    _scanTransfers(
      provider,
      ethersLib,
      token1,
      wallet,
      scanFrom,
      nextMintBlock,
    ),
  ]);
  // Drop inbound transfers from LP infrastructure (PM + pool)
  const validAddrs = (excludeFromAddrs || []).filter(Boolean);
  if (validAddrs.length < 2)
    console.warn(
      "[hodl]   WARN: only %d exclude addrs (need PM + pool)",
      validAddrs.length,
    );
  const excluded = new Set(
    validAddrs.map((a) => ethersLib.zeroPadValue(a, 32).toLowerCase()),
  );
  const keep = (t) => t.dir === "out" || !excluded.has(t.from?.toLowerCase());
  const kept0 = xfers0.filter(keep),
    kept1 = xfers1.filter(keep);
  if (xfers0.length > 0 || xfers1.length > 0)
    console.log(
      "[hodl]   scan %d→%d: raw t0=%d t1=%d, after exclude t0=%d t1=%d",
      scanFrom,
      nextMintBlock,
      xfers0.length,
      xfers1.length,
      kept0.length,
      kept1.length,
    );
  /*- Determine which pool token (if any) is the wrapped native — enables
      wrap-detection inside `_sumNonSwapInbound`. */
  const wn = (wrappedNativeAddress || "").toLowerCase();
  let wrappedTokenIdx = null;
  if (wn) {
    if (token0 && token0.toLowerCase() === wn) wrappedTokenIdx = 0;
    else if (token1 && token1.toLowerCase() === wn) wrappedTokenIdx = 1;
  }
  const wrap =
    wrappedTokenIdx === null
      ? null
      : { provider, walletAddress: wallet, wrappedTokenIdx };
  const { sum0, sum1 } = await _sumNonSwapInbound(kept0, kept1, wrap);
  return { f0: sum0, f1: sum1 };
}

/**
 * Compute lifetime HODL amounts from pre-fetched NFT events.
 *
 * Classification per IncreaseLiquidity event:
 * - 1st IL on first NFT  → original mint  → full amounts
 * - 1st IL on Nth NFT    → rebalance mint → fresh deposits via Transfer scan
 * - Subsequent IL that is a compound (within fee cap) → 0
 * - Subsequent IL that is an external deposit → full amounts
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
 *                                                (e.g. WPLS).  Enables native→wrapped
 *                                                wrap detection in the Transfer scan.
 * @param {object}   [opts.cachedFreshDeposits]  { raw0: string, raw1: string, lastBlock: number }
 * @returns {Promise<{ amount0: number, amount1: number, raw0: string, raw1: string, lastBlock: number }>}
 */
/** Scan for fresh deposits between previous mint and current mint. */
async function _rebalanceFresh(opts, allNftEvents, ordered, i, mintIl) {
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
  );
}

/** Record a deposit entry for USD computation (skip if block already cached). */
function _addDeposit(ctx, raw0, raw1, block) {
  if (raw0 <= 0n && raw1 <= 0n) return;
  if (ctx._cachedBlocks && ctx._cachedBlocks.has(block)) return;
  ctx.deposits.push({ raw0: String(raw0), raw1: String(raw1), block });
}

/** Process one NFT in the rebalance chain, returning deposit + external amounts. */
async function _processNft(i, tid, allNftEvents, ordered, opts, ctx) {
  const events = allNftEvents.get(tid);
  if (!events || events.ilEvents.length === 0) {
    console.log("[hodl] #%s (idx=%d): no IL events, skip", tid, i);
    return;
  }
  const { ilEvents, collectEvents, dlEvents } = events;
  const mintIl = ilEvents[0];
  if (i === 0) {
    console.log(
      "[hodl] #%s FIRST: mint0=%s mint1=%s",
      tid,
      String(mintIl.amount0),
      String(mintIl.amount1),
    );
    ctx.total0 += mintIl.amount0;
    ctx.total1 += mintIl.amount1;
    _addDeposit(ctx, mintIl.amount0, mintIl.amount1, mintIl.blockNumber);
  } else if (ctx.canScan && mintIl.blockNumber > ctx.cachedBlock) {
    const { f0, f1 } = await _rebalanceFresh(
      opts,
      allNftEvents,
      ordered,
      i,
      mintIl,
    );
    if (f0 > 0n || f1 > 0n)
      console.log("[hodl] #%s FRESH: f0=%s f1=%s", tid, String(f0), String(f1));
    ctx.fresh0 += f0;
    ctx.fresh1 += f1;
    _addDeposit(ctx, f0, f1, mintIl.blockNumber);
    if (mintIl.blockNumber > ctx.maxBlock) ctx.maxBlock = mintIl.blockNumber;
  }
  const { ext0, ext1 } = _classifySubsequentILs(
    ilEvents,
    collectEvents,
    dlEvents,
  );
  if (ext0 > 0n || ext1 > 0n) {
    console.log(
      "[hodl] #%s external: ext0=%s ext1=%s",
      tid,
      String(ext0),
      String(ext1),
    );
    _addDeposit(ctx, ext0, ext1, mintIl.blockNumber);
  }
  ctx.total0 += ext0;
  ctx.total1 += ext1;
}

async function computeLifetimeHodl(allNftEvents, opts) {
  const { rebalanceEvents, position, provider, ethersLib, walletAddress } =
    opts;
  const ordered = _buildChainOrder(position.tokenId, rebalanceEvents);
  const d0 = position.decimals0 ?? 18;
  const d1 = position.decimals1 ?? 18;
  const cached = opts.cachedFreshDeposits;
  const cachedDeps = cached?.deposits ? [...cached.deposits] : [];
  const cachedBlocks = new Set(cachedDeps.map((d) => d.block));
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
    _cachedBlocks: cachedBlocks,
  };

  for (let i = 0; i < ordered.length; i++)
    await _processNft(i, ordered[i], allNftEvents, ordered, opts, ctx);

  ctx.total0 += ctx.fresh0;
  ctx.total1 += ctx.fresh1;

  return {
    amount0: Number(ctx.total0) / 10 ** d0,
    amount1: Number(ctx.total1) / 10 ** d1,
    raw0: String(ctx.fresh0),
    raw1: String(ctx.fresh1),
    lastBlock: ctx.maxBlock,
    deposits: ctx.deposits,
  };
}

module.exports = {
  computeLifetimeHodl,
  _buildChainOrder,
  _freshDeposits,
  _scanTransfers,
};
