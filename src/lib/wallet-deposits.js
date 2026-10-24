/**
 * @file src/lib/wallet-deposits.js
 * @module wallet-deposits
 * @description
 * The deposits a wallet received of a pool's two coins within a range of
 * blocks: coins that came in from outside the position, one entry per
 * transaction.
 *
 * Two parts of the bot ask this question. The Lifetime scan asks it for
 * each gap between one mint and the next, since a rebalance mints with
 * the wallet's whole balance and so takes in whatever arrived meanwhile
 * (src/lib/lifetime-hodl.js). The deposit count asks it from the last block
 * counted up to the chain's head, before each rebalance and compound
 * and when a poll sees the wallet's coins rise (src/lib/deposit-count.js).
 * Both get the same answer from the same rules, here.
 *
 * The answer comes from the two coins' `Transfer` events to and from the
 * wallet, grouped by transaction. A transaction is a deposit unless it
 * is a swap (one coin out, the other in) or a drain or collect (both
 * coins in, nothing out). Transfers from the position manager or the
 * pool are dropped before that, since the bot's own collects, drains and
 * refunds come from them. A wrap of the chain's native coin is credited
 * from the wrapped coin's `Deposit` event instead, as explained above
 * `_scanWrapDeposits`.
 *
 * And a transaction the wallet sent itself is no deposit, whatever came
 * in (`_sentByOthers`). Every rebalance and compound the bot makes, for
 * any position, is a transaction the wallet sends, while a deposit is
 * sent to the wallet by someone else. So another managed pool's drain,
 * fee collection or swap, which brings in a coin this pool shares, does
 * not count as this pool's deposit. A wrap counts though the wallet sends
 * it, since the native coins it wrapped were never counted.
 *
 * Every read is chunked to the endpoints' block-range cap
 * (src/lib/get-logs-chunked.js), and a failed read fails the whole answer:
 * "no transfers" read off a refused query would be counted as "no
 * deposits", which no later check can tell from the truth.
 */

"use strict";

const { log } = require("./log");
const { scanChunked } = require("./get-logs-chunked");

/**
 * The wallet's transfers of one coin within a block range, in both
 * directions, each with its transaction and block.
 *
 * @param {object} provider  ethers provider with `getLogs`.
 * @param {object} ethersLib  ethers, for `id` and `zeroPadValue`.
 * @param {string} tokenAddr  The coin's contract.
 * @param {string} wallet  The wallet.
 * @param {number} fromBlock  First block read.
 * @param {number} toBlock  Last block read.
 * @param {string} label  Names the reader in the scan's progress lines.
 * @returns {Promise<Array<{txHash: string, block: number, amount: bigint,
 *   dir: "in"|"out", from?: string}>>}
 */
async function _scanTransfers(
  provider,
  ethersLib,
  tokenAddr,
  wallet,
  fromBlock,
  toBlock,
  label,
) {
  if (fromBlock > toBlock) return [];
  const padded = ethersLib.zeroPadValue(wallet, 32);
  const topic0 = ethersLib.id("Transfer(address,address,uint256)");
  /*-
   *  Both directions of both coins run at once, and more than one
   *  position scans at a time, so each progress line names its coin.
   */
  const [inLogs, outLogs] = await Promise.all([
    scanChunked({
      provider,
      fromBlock,
      toBlock,
      label: `${label} transfers-in for Token i.d. ${tokenAddr}`,
      query: (from, to) =>
        provider.getLogs({
          address: tokenAddr,
          fromBlock: from,
          toBlock: to,
          topics: [topic0, null, padded],
        }),
    }),
    scanChunked({
      provider,
      fromBlock,
      toBlock,
      label: `${label} transfers-out for Token i.d. ${tokenAddr}`,
      query: (from, to) =>
        provider.getLogs({
          address: tokenAddr,
          fromBlock: from,
          toBlock: to,
          topics: [topic0, padded, null],
        }),
    }),
  ]);
  const out = [];
  for (const l of inLogs)
    out.push({
      txHash: l.transactionHash,
      block: l.blockNumber,
      amount: BigInt(l.data),
      dir: "in",
      from: l.topics[1],
    });
  for (const l of outLogs)
    out.push({
      txHash: l.transactionHash,
      block: l.blockNumber,
      amount: BigInt(l.data),
      dir: "out",
    });
  return out;
}

/**
 * Whether one transaction's transfers make a deposit: anything but a
 * swap (one coin out, the other in) or a drain or collect (both coins
 * in, nothing out).
 *
 * @param {{t0: object[], t1: object[]}} group  The transaction's
 *   transfers of each coin.
 * @returns {boolean}
 */
function _isDeposit(group) {
  const t0Out = group.t0.some((t) => t.dir === "out");
  const t1Out = group.t1.some((t) => t.dir === "out");
  const t0In = group.t0.some((t) => t.dir === "in");
  const t1In = group.t1.some((t) => t.dir === "in");
  if ((t0Out && t1In) || (t1Out && t0In)) return false;
  if (t0In && t1In && !t0Out && !t1Out) return false;
  return true;
}

/*-
 *  Wraps of the chain's native coin.
 *
 *  An LP holds the wrapped form of the native coin (WPLS on PulseChain,
 *  as WETH is on Ethereum), never the native coin itself. So when the
 *  owner wraps native coins in the wallet, the wrapped coins that result
 *  are a deposit, and only one address per chain needs this treatment:
 *  `nativeWrappedToken` in chains.json. A pool holding neither coin at
 *  that address skips it.
 *
 *  The wrap is read from the wrapped coin's `Deposit(dst, wad)` event,
 *  not from a `Transfer`. PulseChain's WPLS emits only the `Deposit`
 *  event when it wraps, where Ethereum's WETH9 also emits a `Transfer`
 *  from the zero address. And a wrap bundled into a swap or a rebalance
 *  multicall would look, as a transfer, like coins coming back from the
 *  position. The event gives the exact amount wrapped, so a wrap that
 *  paid its gas from the wrapped side needs no tolerance either.
 *
 *  PulseChain's contracts often run a version or two behind Ethereum's,
 *  so a rule ported from canonical WETH9 behaviour needs checking
 *  against the chain's own contract first.
 */

/**
 * The wallet's wraps of the native coin within a block range, by
 * transaction: what each wrapped, summed when one transaction wraps more
 * than once, and its block.
 *
 * @param {object} provider  ethers provider with `getLogs`.
 * @param {object} ethersLib  ethers, for `id` and `zeroPadValue`.
 * @param {string} wrappedAddr  The wrapped native coin's contract.
 * @param {string} wallet  The wallet.
 * @param {number} fromBlock  First block read.
 * @param {number} toBlock  Last block read.
 * @param {string} label  Names the reader in the scan's progress lines.
 * @returns {Promise<Map<string, {wad: bigint, block: number}>>}
 */
async function _scanWrapDeposits(
  provider,
  ethersLib,
  wrappedAddr,
  wallet,
  fromBlock,
  toBlock,
  label,
) {
  if (fromBlock > toBlock) return new Map();
  const padded = ethersLib.zeroPadValue(wallet, 32);
  const topic0 = ethersLib.id("Deposit(address,uint256)");
  const logs = await scanChunked({
    provider,
    fromBlock,
    toBlock,
    label: `${label} wrap-deposits for Token i.d. ${wrappedAddr}`,
    query: (from, to) =>
      provider.getLogs({
        address: wrappedAddr,
        fromBlock: from,
        toBlock: to,
        topics: [topic0, padded],
      }),
  });
  const m = new Map();
  for (const l of logs) {
    const held = m.get(l.transactionHash);
    const wad = BigInt(l.data) + (held ? held.wad : 0n);
    m.set(l.transactionHash, { wad, block: l.blockNumber });
  }
  return m;
}

/**
 * Group the two coins' transfers by transaction.
 *
 * @param {object[]} xfers0  Token0's transfers.
 * @param {object[]} xfers1  Token1's transfers.
 * @returns {Map<string, {t0: object[], t1: object[], block: number}>}
 */
function _groupByTx(xfers0, xfers1) {
  const byTx = new Map();
  const groupOf = (t) => {
    if (!byTx.has(t.txHash))
      byTx.set(t.txHash, { t0: [], t1: [], block: t.block });
    return byTx.get(t.txHash);
  };
  for (const t of xfers0) groupOf(t).t0.push(t);
  for (const t of xfers1) groupOf(t).t1.push(t);
  return byTx;
}

/**
 * What one transaction brought into the wallet, and where it came from,
 * for the log.
 *
 * @param {{t0: object[], t1: object[]}} group
 * @returns {{raw0: bigint, raw1: bigint, fromAddrs: string[]}}
 */
function _sumGroupInbound(group) {
  let raw0 = 0n;
  let raw1 = 0n;
  const fromAddrs = [];
  for (const t of group.t0)
    if (t.dir === "in") {
      raw0 += t.amount;
      if (t.from) fromAddrs.push(t.from.slice(24));
    }
  for (const t of group.t1)
    if (t.dir === "in") {
      raw1 += t.amount;
      if (t.from) fromAddrs.push(t.from.slice(24));
    }
  return { raw0, raw1, fromAddrs };
}

/**
 * Which of the pool's coins, if either, is the native coin's wrapped
 * form.
 *
 * @param {string} token0
 * @param {string} token1
 * @param {string} [wrappedNativeAddress]
 * @returns {0|1|null}
 */
function _wrappedIndex(token0, token1, wrappedNativeAddress) {
  const wn = (wrappedNativeAddress || "").toLowerCase();
  if (!wn) return null;
  if (token0 && token0.toLowerCase() === wn) return 0;
  if (token1 && token1.toLowerCase() === wn) return 1;
  return null;
}

/**
 * Sort the window's transactions into wraps and possible deposits, one
 * entry each.
 *
 * A wrap is credited at what it wrapped, to the wrapped coin, and
 * nothing else in that transaction is counted: a wrap inside a swap
 * would otherwise be counted twice, once from the event and once from
 * the transfer. Every other transaction is a possible deposit by
 * `_isDeposit`, at what came into the wallet, which `_sentByOthers` then
 * holds to who sent it. One that brought nothing in makes no entry.
 *
 * @param {Map} byTx  From `_groupByTx`.
 * @param {Map} wraps  From `_scanWrapDeposits`, empty when the pool
 *   holds no wrapped native coin.
 * @param {0|1|null} wrappedIdx  From `_wrappedIndex`.
 * @returns {{wrapped: object[], candidates: object[]}}  Entries
 *   `{txHash, block, raw0, raw1}`.
 */
function _classify(byTx, wraps, wrappedIdx) {
  const allTx = new Set([...byTx.keys(), ...wraps.keys()]);
  const wrapped = [];
  const candidates = [];
  let skipped = 0;
  for (const txHash of allTx) {
    const wrap = wraps.get(txHash);
    if (wrap !== undefined && wrap.wad > 0n && wrappedIdx !== null) {
      log.info(
        "[hodl]   WRAP TX %s: wrapped[%d]=%s",
        txHash.slice(0, 10),
        wrappedIdx,
        String(wrap.wad),
      );
      wrapped.push({
        txHash,
        block: wrap.block,
        raw0: wrappedIdx === 0 ? wrap.wad : 0n,
        raw1: wrappedIdx === 1 ? wrap.wad : 0n,
      });
      continue;
    }
    const group = byTx.get(txHash);
    if (group === undefined) continue;
    if (!_isDeposit(group)) {
      skipped++;
      continue;
    }
    const { raw0, raw1, fromAddrs } = _sumGroupInbound(group);
    if (raw0 === 0n && raw1 === 0n) continue;
    log.info(
      "[hodl]   possible deposit TX %s: t0=%s t1=%s from=[%s]",
      txHash.slice(0, 10),
      String(raw0),
      String(raw1),
      fromAddrs.join(","),
    );
    candidates.push({ txHash, block: group.block, raw0, raw1 });
  }
  if (allTx.size > 0)
    log.info(
      "[hodl]   window: %d TXs, %d skipped (swap/drain), %d wrap, %d to check for their sender",
      allTx.size,
      skipped,
      wrapped.length,
      candidates.length,
    );
  return { wrapped, candidates };
}

/**
 * The possible deposits someone other than the wallet sent: the
 * deposits. A transaction the wallet sent is a move of the bot's, for
 * this pool or another, or the owner's own from the wallet, and brings
 * in no money from outside.
 *
 * One read per possible deposit, of its transaction's sender. A sender
 * that cannot be read fails the whole answer, as a refused read of the
 * transfers does.
 *
 * @param {object[]} candidates  From `_classify`.
 * @param {object} o  `depositsInWindow`'s options: `provider`, `wallet`.
 * @returns {Promise<object[]>}
 */
async function _sentByOthers(candidates, o) {
  const wallet = o.wallet.toLowerCase();
  const out = [];
  for (const e of candidates) {
    const tx = await o.provider.getTransaction(e.txHash);
    if (tx === null || tx === undefined || typeof tx.from !== "string")
      throw new Error(
        `no sender came back for transaction ${e.txHash}, so whether it brought the wallet a deposit is not known`,
      );
    if (tx.from.toLowerCase() === wallet) {
      log.info(
        "[hodl]   TX %s: the wallet sent it itself, so it is no deposit",
        e.txHash.slice(0, 10),
      );
      continue;
    }
    out.push(e);
  }
  return out;
}

/**
 * The wallet's deposits of the pool's two coins within a block range,
 * one entry per transaction, in block order.
 *
 * @param {object} o
 * @param {object} o.provider  ethers provider with `getLogs`, and
 *   `getTransaction` for each possible deposit's sender.
 * @param {object} o.ethersLib  ethers, for `id` and `zeroPadValue`.
 * @param {string} o.token0  The pool's token0.
 * @param {string} o.token1  The pool's token1.
 * @param {string} o.wallet  The wallet.
 * @param {number} o.fromBlock  First block read.
 * @param {number} o.toBlock  Last block read.
 * @param {string[]} [o.excludeFromAddrs]  Senders whose transfers are
 *   the bot's own (the position manager and the pool).
 * @param {string} [o.wrappedNativeAddress]  The wrapped native coin.
 * @param {string} [o.label]  Names the reader in the scan's progress
 *   lines.
 * @returns {Promise<Array<{txHash: string, block: number, raw0: bigint,
 *   raw1: bigint}>>}  Amounts in each coin's smallest unit.
 */
async function depositsInWindow(o) {
  const label = o.label || "lifetime-hodl";
  const scan = (token) =>
    _scanTransfers(
      o.provider,
      o.ethersLib,
      token,
      o.wallet,
      o.fromBlock,
      o.toBlock,
      label,
    );
  const [xfers0, xfers1] = await Promise.all([scan(o.token0), scan(o.token1)]);
  const validAddrs = (o.excludeFromAddrs || []).filter(Boolean);
  if (validAddrs.length < 2)
    log.warn(
      "[hodl]   WARN: only %d exclude addrs (need PM + pool)",
      validAddrs.length,
    );
  const excluded = new Set(
    validAddrs.map((a) => o.ethersLib.zeroPadValue(a, 32).toLowerCase()),
  );
  const keep = (t) => t.dir === "out" || !excluded.has(t.from?.toLowerCase());
  const kept0 = xfers0.filter(keep);
  const kept1 = xfers1.filter(keep);
  if (xfers0.length > 0 || xfers1.length > 0)
    log.info(
      "[hodl]   scan %d→%d: raw t0=%d t1=%d, after exclude t0=%d t1=%d",
      o.fromBlock,
      o.toBlock,
      xfers0.length,
      xfers1.length,
      kept0.length,
      kept1.length,
    );
  const wrappedIdx = _wrappedIndex(o.token0, o.token1, o.wrappedNativeAddress);
  let wraps = new Map();
  if (wrappedIdx !== null) {
    wraps = await _scanWrapDeposits(
      o.provider,
      o.ethersLib,
      o.wrappedNativeAddress,
      o.wallet,
      o.fromBlock,
      o.toBlock,
      label,
    );
    if (wraps.size > 0)
      log.info(
        "[hodl]   wrap-deposit scan: %d Deposit events on %s",
        wraps.size,
        o.wrappedNativeAddress,
      );
  }
  const { wrapped, candidates } = _classify(
    _groupByTx(kept0, kept1),
    wraps,
    wrappedIdx,
  );
  const sentByOthers = await _sentByOthers(candidates, o);
  return [...wrapped, ...sentByOthers].sort((a, b) => a.block - b.block);
}

module.exports = { depositsInWindow };
