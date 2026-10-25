/**
 * @file src/lib/compounder.js
 * @description Compound execution: collect unclaimed fees from an NFT position
 * and re-deposit them as additional liquidity via `increaseLiquidity`.
 *
 * TX flow:
 *   1. multicall [decreaseLiquidity(0), collect] — collects fees to wallet
 *   2. an optional swap bringing the fees to the range's ratio
 *      (`src/lib/compounder-swap.js`)
 *   3. approve + increaseLiquidity — re-deposits collected tokens as liquidity
 *
 * Same NFT is retained, with no range change.  Uses the shared
 * rebalance lock for nonce safety and the _waitOrSpeedUp pipeline for
 * TX recovery.
 *
 * When the swap runs, the deposit is offered the wallet's whole balance,
 * so it can take in coins that are no fees. The wallet is read before the
 * collect and just before the deposit, and the result names the fees the
 * deposit put back apart from those coins (src/lib/compounded-coins.js).
 *
 * A deposit the owner sends while the compound runs reaches the wallet
 * between those readings, where they cannot tell it from fees. So what
 * the collect brought in is the amount its own transaction reports,
 * capped at the wallet's rise, and the swap's exchange is read from its
 * own transactions: the deposit is then neither offered to a deposit
 * that takes only the fees nor counted as fees by one that takes the
 * wallet's whole balance.
 */

"use strict";

const { logCtx } = require("./logger");
const { receiptGasWei } = require("./receipt-gas");
const { spentGasOf, addSpentGas } = require("./spent-gas");
const { log } = require("./log");

const config = require("./config");
const sendTx = require("./send-transaction");
const { swapForCompound, compoundLogCtx: _ctx } = require("./compounder-swap");
const { collectFees } = require("./compound-collect");
const { scanChunked } = require("./get-logs-chunked");
const { IFACE, parseLogs } = require("./nft-event-parse");
const { coinsFromUnits, coinsToUsd } = require("./coin-value");
const { compoundedFields } = require("./compounded-coins");
const { topicForTokenId } = require("./nft-token-topic");
const { PM_ABI } = require("./pm-abi");
const {
  ERC20_ABI,
  _deadline,
  _ensureAllowance,
} = require("./rebalancer-pools");

/** Parse IncreaseLiquidity event from a TX receipt. */
function _parseIncreaseLiquidity(pm, receipt) {
  for (const log of receipt.logs || []) {
    if (log.topics?.length >= 2 && log.data?.length >= 130) {
      try {
        const parsed = pm.interface.parseLog({
          topics: log.topics,
          data: log.data,
        });
        if (parsed?.name === "IncreaseLiquidity") {
          return {
            liquidity: parsed.args.liquidity ?? 0n,
            amount0Deposited: parsed.args.amount0 ?? 0n,
            amount1Deposited: parsed.args.amount1 ?? 0n,
          };
        }
      } catch {
        /* skip unparseable logs */
      }
    }
  }
  return { liquidity: 0n, amount0Deposited: 0n, amount1Deposited: 0n };
}

/**
 * Re-deposit collected fees as additional liquidity on the same NFT:
 * approve each coin where its allowance falls short, then deposit. A
 * failure after an approval confirmed carries that approval's gas
 * (src/lib/spent-gas.js).
 *
 * @param {import('ethers').Signer} signer
 * @param {object} ethersLib  ethers module
 * @param {object} opts
 * @param {string} opts.positionManagerAddress
 * @param {string} opts.tokenId
 * @param {bigint} opts.amount0  Token0 amount to deposit
 * @param {bigint} opts.amount1  Token1 amount to deposit
 * @param {string} opts.token0   Token0 address
 * @param {string} opts.token1   Token1 address
 * @param {string} opts.recipient Wallet address (for allowance check)
 * @returns {Promise<{liquidity: bigint, amount0Deposited: bigint, amount1Deposited: bigint, txHash: string, gasCostWei: bigint}>}
 */
async function addLiquidity(signer, ethersLib, opts) {
  const { Contract } = ethersLib;
  const t0 = new Contract(opts.token0, ERC20_ABI, signer);
  const t1 = new Contract(opts.token1, ERC20_ABI, signer);
  /*-
   *  An approval that confirmed was paid for, whatever happens after it,
   *  so a failure from here on carries the approvals' gas with it
   *  (src/lib/spent-gas.js).
   */
  let approvalGasWei = 0n;
  try {
    approvalGasWei += await _ensureAllowance(
      t0,
      opts.recipient,
      opts.positionManagerAddress,
      opts.amount0,
      opts.approvalMultiple,
    );
    approvalGasWei += await _ensureAllowance(
      t1,
      opts.recipient,
      opts.positionManagerAddress,
      opts.amount1,
      opts.approvalMultiple,
    );
    return await _depositApproved(signer, ethersLib, opts, approvalGasWei);
  } catch (err) {
    throw addSpentGas(err, approvalGasWei);
  }
}

/**
 * Deposit the coins once both are approved, and read what the deposit
 * added from its receipt.
 *
 * @param {object} signer
 * @param {object} ethersLib
 * @param {object} opts  `addLiquidity`'s options.
 * @param {bigint} approvalGasWei  Gas the approvals before it paid,
 *   counted into the result.
 * @returns {Promise<{liquidity: bigint, amount0Deposited: bigint,
 *   amount1Deposited: bigint, txHash: string, gasCostWei: bigint}>}
 */
async function _depositApproved(signer, ethersLib, opts, approvalGasWei) {
  const { Contract } = ethersLib;
  const pm = new Contract(opts.positionManagerAddress, PM_ABI, signer);
  const dl = _deadline();
  const cx = _ctx(opts);
  /*- increaseLiquidity is the gas-heavy callback path that triggered
      the original out-of-gas failure (TX 0x8F65…) — routing through
      send-transaction.js applies the chain-config gasLimitMultiplier
      and the default 300k floor. */
  const { receipt } = await sendTx.sendTransaction({
    populate: () =>
      pm.increaseLiquidity.populateTransaction({
        tokenId: opts.tokenId,
        amount0Desired: opts.amount0,
        amount1Desired: opts.amount1,
        amount0Min: 0n,
        amount1Min: 0n,
        deadline: dl,
      }),
    signer,
    label: "[compound] " + cx + " addLiquidity",
  });

  const { liquidity, amount0Deposited, amount1Deposited } =
    _parseIncreaseLiquidity(pm, receipt);
  const s0 = opts.token0Symbol || "Token0";
  const s1 = opts.token1Symbol || "Token1";
  log.info(
    "[compound] %s addLiquidity: liquidity=%s %s=%s %s=%s",
    cx,
    String(liquidity),
    s0,
    String(amount0Deposited),
    s1,
    String(amount1Deposited),
  );

  const depositGas = receiptGasWei(receipt);
  const gasCostWei = depositGas + approvalGasWei;
  return {
    liquidity,
    amount0Deposited,
    amount1Deposited,
    txHash: receipt.hash,
    blockNumber: receipt.blockNumber,
    gasCostWei,
  };
}

/**
 * Read the current wallet balance of a token.
 * Helper for the post-swap re-read so addLiquidity uses fresh balances.
 */
async function _readBalance(signer, ethersLib, tokenAddr, owner) {
  const provider = signer.provider;
  const c = new ethersLib.Contract(tokenAddr, ERC20_ABI, provider);
  return c.balanceOf(owner);
}

/*-
 * Resolve the amounts to feed `addLiquidity` after the optional
 * ratio-correcting swap.  When the swap fired, re-read wallet balances
 * so the deposit reflects the post-swap split — that is exactly what
 * the swap was sized to produce in the position-manager's required
 * ratio, so we hand it through unmodified.  When no swap fired, the
 * raw collected amounts are used.
 *
 * Any pre-existing wallet residual for this pool gets incidentally
 * swept back into the position by this path; that's fine — it's better
 * than leaving it stranded, and `residual-tracker` already caps its
 * reported residual to actual `balanceOf`, so accounting self-corrects.
 * None of those coins is a fee, so the wallet just before the deposit is
 * returned too (`beforeDeposit`): the post-swap reading, or, with no
 * swap, the reading after the collect.
 */
async function _resolveDepositAmounts(
  signer,
  ethersLib,
  opts,
  collected,
  swap,
) {
  if (!swap.swapped) {
    return {
      depositAmount0: collected.amount0,
      depositAmount1: collected.amount1,
      beforeDeposit: collected.walletAfter,
    };
  }
  const [bal0, bal1] = await Promise.all([
    _readBalance(signer, ethersLib, opts.token0, opts.recipient),
    _readBalance(signer, ethersLib, opts.token1, opts.recipient),
  ]);
  log.info(
    "[compound] %s post-swap deposit amounts: a0=%s a1=%s",
    _ctx(opts),
    String(bal0),
    String(bal1),
  );
  const beforeDeposit = { raw0: bal0, raw1: bal1 };
  return { depositAmount0: bal0, depositAmount1: bal1, beforeDeposit };
}

/**
 * Execute a full compound: collect fees → optional ratio-correcting
 * swap (dust-gate then gas-gate) → re-deposit as liquidity.
 *
 * The intermediate swap minimizes wallet residual: without it, the
 * Position Manager only accepts the side of the collected fees that
 * fits the current tick ratio, leaving the rest in the wallet.  Both
 * swap-gates must pass for the swap to fire — see
 * `src/lib/swap-gates.js` for the gate semantics.
 *
 * @param {import('ethers').Signer} signer
 * @param {object} ethersLib
 * @param {object} opts
 * @param {string} opts.positionManagerAddress
 * @param {string} opts.tokenId
 * @param {string} opts.token0
 * @param {string} opts.token1
 * @param {number} opts.fee
 * @param {string} opts.recipient
 * @param {number} opts.decimals0
 * @param {number} opts.decimals1
 * @param {number} opts.price0    Current token0 USD price
 * @param {number} opts.price1    Current token1 USD price
 * @param {string} opts.trigger   "manual" or "auto"
 * @param {object} [opts.poolState]   { price, tick, decimals0, decimals1 } — enables ratio-swap
 * @param {number} [opts.tickLower]   Position tick lower — enables ratio-swap
 * @param {number} [opts.tickUpper]   Position tick upper — enables ratio-swap
 * @param {string} [opts.swapRouterAddress]
 * @param {number} [opts.slippagePctToken0]  Slippage for swaps INTO token0.
 * @param {number} [opts.slippagePctToken1]  Slippage for swaps INTO token1.
 * @returns {Promise<object>}     Compound result with amounts, USD values, TX hashes
 */
async function executeCompound(signer, ethersLib, opts) {
  const collected = await collectFees(signer, ethersLib, opts);
  if (collected.amount0 === 0n && collected.amount1 === 0n) {
    log.info(
      "[compound] %s No fees to compound — skipping addLiquidity",
      _ctx(opts),
    );
    /*-
     *  The collect was sent and paid for though it found nothing; the
     *  caller records its gas.
     */
    return {
      compounded: false,
      reason: "no_fees",
      collectTxHash: collected.txHash,
      gasCostWei: collected.gasCostWei,
    };
  }

  /*-
   *  The collect has confirmed and been paid for, and so, once it has
   *  run, has the swap: a failure after either carries their gas
   *  (src/lib/spent-gas.js).
   */
  let paidWei = collected.gasCostWei;
  try {
    /*-
     *  Optional ratio-correcting swap.  Fires only when a swap is
     *  actually needed AND both swap-gates pass (dust first, gas
     *  second).  See src/lib/swap-gates.js.
     */
    const swap = await swapForCompound(
      signer,
      ethersLib,
      opts,
      collected.amount0,
      collected.amount1,
    );
    paidWei += spentGasOf(swap);
    const { depositAmount0, depositAmount1, beforeDeposit } =
      await _resolveDepositAmounts(signer, ethersLib, opts, collected, swap);
    const deposited = await addLiquidity(signer, ethersLib, {
      ...opts,
      amount0: depositAmount0,
      amount1: depositAmount1,
    });
    return _compoundedResult(opts, collected, swap, deposited, beforeDeposit);
  } catch (err) {
    throw addSpentGas(err, paidWei);
  }
}

/**
 * The fee coins as the compound's own transactions moved them, after its
 * swap: what the collect brought in, less what the swap sent of the token
 * sold, plus what it received of the token bought. With no swap, what the
 * collect brought in.
 *
 * @param {{amount0: bigint, amount1: bigint}} collected  The collect's
 *   result.
 * @param {object} swap  The ratio swap's result (src/lib/compounder-swap.js).
 * @returns {{raw0: bigint, raw1: bigint}|null}  Null when the swap ran and
 *   its exchange is unknown.
 */
function _feeCoinsAfterSwap(collected, swap) {
  if (swap?.swapped !== true)
    return { raw0: collected.amount0, raw1: collected.amount1 };
  const ex = swap.exchange;
  if (ex === null || ex === undefined) return null;
  const less = (a, b) => (a > b ? a - b : 0n);
  return swap.isToken0To1 === true
    ? {
        raw0: less(collected.amount0, ex.sent),
        raw1: collected.amount1 + ex.received,
      }
    : {
        raw0: collected.amount0 + ex.received,
        raw1: less(collected.amount1, ex.sent),
      };
}

/**
 * The wallet's two coins before a compound's collect, as its record keeps
 * them: digits of each coin's smallest unit, or nothing when not read.
 *
 * @param {{raw0: bigint, raw1: bigint}|undefined} walletBefore
 * @returns {{amount0WalletBefore?: string, amount1WalletBefore?: string}}
 */
function _walletBeforeFields(walletBefore) {
  const r0 = walletBefore?.raw0;
  const r1 = walletBefore?.raw1;
  if (typeof r0 !== "bigint" || typeof r1 !== "bigint") return {};
  return { amount0WalletBefore: String(r0), amount1WalletBefore: String(r1) };
}

/**
 * What a completed compound reports: the transactions it sent, the coins
 * it put back into the position and their dollar value at this moment,
 * the fees among those coins, and the gas of every transaction it sent.
 *
 * @param {object} opts  `executeCompound`'s options.
 * @param {object} collected  The collect's result.
 * @param {object} swap  The ratio-correcting swap's result.
 * @param {object} deposited  The deposit's result.
 * @param {{raw0: bigint, raw1: bigint}} beforeDeposit  The wallet's two
 *   coins just before the deposit.
 * @returns {object} The compound's result.
 */
function _compoundedResult(opts, collected, swap, deposited, beforeDeposit) {
  const d0 = opts.decimals0;
  const d1 = opts.decimals1;
  /*-
   *  The coins this compound put back into the position, and below their
   *  dollars at this moment, for this moment's log line and the Activity
   *  Log entry.
   */
  const depositedAmount0 = Number(deposited.amount0Deposited) / 10 ** d0;
  const depositedAmount1 = Number(deposited.amount1Deposited) / 10 ** d1;
  const usdValue =
    depositedAmount0 * (opts.price0 || 0) +
    depositedAmount1 * (opts.price1 || 0);
  /*-
   *  The fee coins the collect brought in, and their USD value — typically
   *  larger than usdValue because increaseLiquidity requires tokens in the
   *  current tick's exact ratio, so one side usually has leftover that
   *  stays in the wallet as residual (tracked by residual-tracker.js).
   *  Surfaced so the compound log can show users both numbers, and kept
   *  on the compound's record for its Activity Log figure
   *  (src/lib/compound-activity-figures.js).
   */
  const feesCollected = coinsFromUnits(
    collected.amount0,
    collected.amount1,
    d0,
    d1,
  );
  const collectedUsd = coinsToUsd(feesCollected, opts.price0, opts.price1);
  /*-
   *  The fees among the coins the deposit put back: what the caller keeps
   *  on the compound's record. The rest came from the wallet's earlier
   *  balance, or reached the wallet while the compound ran
   *  (src/lib/compounded-coins.js). The lifetime running total takes
   *  `feesCollected` above instead (src/lib/bot-cycle-compound.js).
   */
  const compounded = compoundedFields(
    collected.walletBefore,
    beforeDeposit,
    deposited,
    d0,
    d1,
    _feeCoinsAfterSwap(collected, swap),
  );

  const totalGasWei =
    collected.gasCostWei + spentGasOf(swap) + deposited.gasCostWei;

  return {
    compounded: true,
    trigger: opts.trigger || "manual",
    collectTxHash: collected.txHash,
    depositTxHash: deposited.txHash,
    swapTxHash: swap.txHash,
    swapGateReason: swap.gateReason,
    amount0Deposited: String(deposited.amount0Deposited),
    amount1Deposited: String(deposited.amount1Deposited),
    depositedAmount0,
    depositedAmount1,
    ...compounded,
    /*-
     *  Where in the chain the deposit landed, and the wallet's two coins
     *  before the collect: a deposit to the wallet still waiting there
     *  is taken by this compound in proportion to its share of that
     *  balance (src/lib/deposit-attribution.js).
     */
    depositBlock: deposited.blockNumber,
    ..._walletBeforeFields(collected.walletBefore),
    liquidity: String(deposited.liquidity),
    usdValue,
    collectedUsd,
    feesCollected,
    price0: opts.price0,
    price1: opts.price1,
    gasCostWei: String(totalGasWei),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Filter IncreaseLiquidity candidates: remove any that follow a
 * DecreaseLiquidity (drain) within a block window. A drain followed by
 * re-deposit is a rebalance, not a compound. The window is
 * `compound.repositionWindowSec` (app-runtime.json) counted in the active
 * chain's blocks: 50,000 at PulseChain's ten seconds.
 */
const _DRAIN_WINDOW = Math.round(
  config.COMPOUND_REPOSITION_WINDOW_SEC / config.CHAIN.blockTimeSec,
);
function _filterRebalances(candidates, dlEvents) {
  const drainBlocks = [];
  for (const e of dlEvents) {
    if ((e.liquidity ?? 0n) > 0n) drainBlocks.push(e.blockNumber);
  }
  return candidates.filter((il) => {
    for (const db of drainBlocks) {
      if (il.blockNumber >= db && il.blockNumber - db <= _DRAIN_WINDOW)
        return false;
    }
    return true;
  });
}

/**
 * Fetch TX receipts for compound events and compute gas costs.
 *
 * What a transaction cost is on its receipt, so a receipt that does not
 * come back leaves that charge unknown — and unknown is not the same as
 * nothing. The running total is therefore reported alongside
 * `gasComplete`, which is false the moment any one receipt is missing.
 * A caller that persists the total needs that flag: a short total saved
 * as fact understates the NFT's gas for good, and the shortfall is
 * invisible because a plausible number looks exactly like a correct one.
 *
 * `gasCostWei` on an individual compound stays `"0"` when its receipt
 * was unreadable. That figure is per-event display detail rather than
 * something summed and saved, and the aggregate already carries the
 * warning.
 *
 * @param {object} prov            Read provider.
 * @param {object[]} compoundEvents Classified compound events.
 * @returns {Promise<{compounds: object[], totalGasWei: bigint,
 *   gasComplete: boolean}>}
 */
async function _fetchCompoundGas(prov, compoundEvents) {
  let totalGasWei = 0n;
  let gasComplete = true;
  const compounds = [];
  /*- Cache block timestamps so we don't re-fetch the same block when
      multiple events sit in it (rare but possible for batched txs). */
  const blockTsCache = new Map();
  for (const e of compoundEvents) {
    let gasWei = 0n;
    if (e.txHash) {
      try {
        const rcpt = await prov.getTransactionReceipt(e.txHash);
        /*- Null is an answer, not an error: the endpoint does not have
         *  this transaction. Either way the charge is unknown. Checked
         *  explicitly, matching `_fetchMintGasWei` below — this decides
         *  whether a charge is counted or the whole total is flagged. */
        if (rcpt === null || rcpt === undefined) gasComplete = false;
        else gasWei = receiptGasWei(rcpt);
      } catch {
        gasComplete = false;
      }
    }
    let ts = null;
    if (e.blockNumber !== null && e.blockNumber !== undefined) {
      try {
        if (!blockTsCache.has(e.blockNumber)) {
          const blk = await prov.getBlock(e.blockNumber);
          blockTsCache.set(e.blockNumber, blk?.timestamp ?? null);
        }
        ts = blockTsCache.get(e.blockNumber);
      } catch {
        /* block fetch failed — ts stays null */
      }
    }
    totalGasWei += gasWei;
    compounds.push({
      amount0Deposited: String(e.amount0),
      amount1Deposited: String(e.amount1),
      blockNumber: e.blockNumber,
      txHash: e.txHash || null,
      /*- ISO string to match the live-compound shape written by
          executeCompound (timestamp: new Date().toISOString()). */
      timestamp: ts ? new Date(ts * 1000).toISOString() : null,
      gasCostWei: String(gasWei),
    });
  }
  return { compounds, totalGasWei, gasComplete };
}

/**
 * Fetch IncreaseLiquidity, Collect, and DecreaseLiquidity logs for one NFT.
 * Single RPC round-trip (3 parallel getLogs).  Pure data — no classification.
 * @param {string|number} tokenId
 * @param {{ fromBlock?: number, toBlock?: number|string }} [scanOpts]
 * @returns {Promise<{ilEvents: object[], collectEvents: object[], dlEvents: object[], ilLogsCount: number}>}
 */
async function scanNftEvents(tokenId, scanOpts = {}) {
  const prov = sendTx.getManagedReadProvider();
  const tidHex = topicForTokenId(tokenId);
  const addr = config.POSITION_MANAGER;
  const from = scanOpts.fromBlock ?? 0;
  /*-
   *  To the chain head unless the caller bounds it, and no caller does:
   *  an NFT that looks retired can still be funded and drain later, so
   *  no sound upper bound exists — see `src/lib/nft-mint-blocks.js`.
   */
  const to = scanOpts.toBlock ?? "latest";
  /*- Chunked, and resolved to a concrete head once per event type
   *  rather than per window, so all three cover the same range.
   *
   *  Errors propagate.  `.catch(() => [])` here would turn a range-cap
   *  rejection into "no compounds ever", resetting the compounded-fee
   *  total to zero with nothing logged. */
  const scanEvent = (name) =>
    scanChunked({
      provider: prov,
      fromBlock: from,
      toBlock: to,
      label: `compounder ${name} #${tokenId}`,
      query: (f, t) =>
        prov.getLogs({
          address: addr,
          fromBlock: f,
          toBlock: t,
          topics: [IFACE.getEvent(name).topicHash, tidHex],
        }),
    });
  const [ilLogs, colLogs, dlLogs] = await Promise.all([
    scanEvent("IncreaseLiquidity"),
    scanEvent("Collect"),
    scanEvent("DecreaseLiquidity"),
  ]);
  return {
    ilEvents: parseLogs(IFACE, ilLogs),
    collectEvents: parseLogs(IFACE, colLogs),
    dlEvents: parseLogs(IFACE, dlLogs),
    ilLogsCount: ilLogs.length,
  };
}

/** Sum amounts across an event list, optionally filtering by liquidity > 0. */
function _sumAmounts(events, requireLiquidity) {
  let s0 = 0n,
    s1 = 0n;
  for (const e of events) {
    if (requireLiquidity && !((e.liquidity ?? 0n) > 0n)) continue;
    s0 += e.amount0 ?? 0n;
    s1 += e.amount1 ?? 0n;
  }
  return { s0, s1 };
}

/**
 * Fees an NFT earned over its whole life, as raw token amounts.
 *
 * `Σ(Collect) − Σ(drained principal)`.  Every Collect after a drain
 * extracts principal plus accrued fees; a standalone compound's Collect
 * extracts fees only.  Subtracting the principal that DecreaseLiquidity
 * reports therefore leaves exactly the fees, however they were later
 * re-deposited — by a compound or by the rebalance that closed the NFT.
 *
 * This is the single definition of "fees this NFT earned".  Two callers
 * share it: `classifyCompounds` below, for the Lifetime panel's Fees
 * Compounded row, and `_supplementFeesFromChain` in
 * position-history.js, for the per-epoch figure behind the Per-Day P&L
 * table.  Both must come from here: measuring instead from the fees
 * left unclaimed at the final drain omits everything auto-compound
 * already swept back into liquidity, which on a compounding position is
 * most of the total.
 *
 * @param {Array<{amount0: bigint, amount1: bigint}>} collectEvents
 * @param {Array<{amount0: bigint, amount1: bigint, liquidity: bigint}>} dlEvents
 * @returns {{fees0: bigint, fees1: bigint}}  Clamped at zero.
 */
function lifetimeFeeAmounts(collectEvents, dlEvents) {
  const c = _sumAmounts(collectEvents, false);
  const d = _sumAmounts(dlEvents, true);
  return {
    fees0: c.s0 > d.s0 ? c.s0 - d.s0 : 0n,
    fees1: c.s1 > d.s1 ? c.s1 - d.s1 : 0n,
  };
}

/** Log compound classification summary for a single NFT. */
function _logCompoundSummary(opts, parts) {
  const {
    compounds,
    fees0,
    fees1,
    totalCompoundedUsd,
    ilLogsCount,
    collectCount,
    drainCount,
  } = parts;
  const s0 = opts.token0Symbol || "Token0";
  const s1 = opts.token1Symbol || "Token1";
  /*-
   *  Full context per feedback-log-full-context: chain + wallet + NFT
   *  factory + tokenId + emoji + both token symbols. Every caller passes
   *  `opts.positionManagerAddress`, the NFT factory.
   */
  const cx = logCtx({
    chain: config.CHAIN_NAME,
    wallet: opts.wallet,
    factory: opts.positionManagerAddress,
    tokenId: opts.tokenId,
    symbol0: s0,
    symbol1: s1,
  });
  log.info(
    "[compound] %s: %d IncreaseLiquidity (%d standalone), %d Collect, %d drain",
    cx,
    ilLogsCount,
    compounds.length,
    collectCount,
    drainCount,
  );
  log.info(
    "[compound]   fees collected (standalone + rebalance): %s=%s %s=%s → $%s",
    s0,
    String(fees0),
    s1,
    String(fees1),
    totalCompoundedUsd.toFixed(2),
  );
}

/*- Mint TX gas: ilEvents[0] is always the mint (subsequent ILs are
 *  compounds or rebalance re-deposits, which already have their gas
 *  fetched in _fetchCompoundGas). One extra receipt fetch lets the
 *  unmanaged Current panel show "total gas spent on this NFT" =
 *  mint + standalone compounds, matching the live-epoch gas the bot
 *  accumulates while managing. */
async function _fetchMintGasWei(prov, mintTxHash) {
  /*- No hash to ask about is a different answer from a hash we could not
   *  resolve: there is no transaction here to have cost anything, so
   *  zero is the honest figure. Only a read that failed returns null. */
  if (!mintTxHash) return 0n;
  try {
    const rcpt = await prov.getTransactionReceipt(mintTxHash);
    if (rcpt === null || rcpt === undefined) return null;
    return receiptGasWei(rcpt);
  } catch {
    return null;
  }
}

/**
 * Classify one NFT's compounds from its pre-fetched events.
 *
 * The events must be in chain order: the first IncreaseLiquidity is the
 * mint deposit and is skipped. Each later one is a standalone compound
 * unless it follows a drain within `_DRAIN_WINDOW` blocks, which makes it
 * a rebalance re-deposit. `totalCompoundedUsd` is the NFT's lifetime fees
 * (`lifetimeFeeAmounts`) at current prices, so it counts fees re-deposited
 * by a rebalance as well as standalone compounds.
 *
 * @param {{ilEvents: object[], collectEvents: object[],
 *   dlEvents: object[], ilLogsCount: number}} nftEvents
 * @param {object} [opts]  { decimals0, decimals1, price0, price1,
 *   token0Symbol, token1Symbol, wallet, tokenId, positionManagerAddress }
 * @returns {Promise<{compounds: object[], totalCompoundedUsd: number,
 *   totalGasWei: string, totalNftGasWei: string}>}
 */
async function classifyCompounds(nftEvents, opts = {}) {
  const prov = sendTx.getManagedReadProvider();
  const { ilEvents, collectEvents, dlEvents, ilLogsCount } = nftEvents;
  const candidateILs = ilEvents.slice(1); // skip first = mint
  /*-
   *  compoundEvents (filtered) feeds the per-event compound history that
   *  shows in the Activity Log — exclude rebalance-window ILs because
   *  rebalances have their own dedicated rebalance entries.  The total
   *  compounded USD is computed separately below from Collect/DL deltas
   *  so it correctly captures BOTH standalone compounds AND fees that
   *  were re-deposited as part of a rebalance drain → mint cycle.
   */
  const compoundEvents = _filterRebalances(candidateILs, dlEvents);
  /*-
   *  Each Collect after a drain extracts (drainedPrincipal + accumulatedFees).
   *  Standalone-compound Collects extract only fees (no paired DL).  So
   *  totalFees = totalCollected − totalDrainedPrincipal across the whole
   *  NFT lifetime, regardless of how the fees were re-deposited.
   */
  const { fees0, fees1 } = lifetimeFeeAmounts(collectEvents, dlEvents);
  const d0 = opts.decimals0,
    d1 = opts.decimals1;
  /*- The coins, in token units. Callers store these rather than the
   *  dollars below: a dollar total is only true at the price it was
   *  computed with, and it drifts further from the truth the longer the
   *  position runs, with nothing short of a chain re-read to correct
   *  it. The coins never change. */
  const feeAmount0 = Number(fees0) / 10 ** d0;
  const feeAmount1 = Number(fees1) / 10 ** d1;
  const totalCompoundedUsd =
    feeAmount0 * (opts.price0 || 0) + feeAmount1 * (opts.price1 || 0);
  const { compounds, totalGasWei, gasComplete } = await _fetchCompoundGas(
    prov,
    compoundEvents,
  );
  /*- Per-event USD = the event's own deposit value at current prices.
   *  Same formula bot-recorder-lifetime._eventUsd uses inline. Attached
   *  here so unmanaged callers can sum standalone compounds for the
   *  Current panel's "Fees Compounded" row without re-implementing it. */
  for (const c of compounds) {
    c.usdValue =
      (Number(c.amount0Deposited) / 10 ** d0) * (opts.price0 || 0) +
      (Number(c.amount1Deposited) / 10 ** d1) * (opts.price1 || 0);
  }
  const mintGasWei = await _fetchMintGasWei(prov, ilEvents[0]?.txHash);
  /*- The NFT's whole gas is the mint plus every later charge, so one
   *  unreadable receipt anywhere in that set leaves the total unknown
   *  rather than smaller. Null says so, and the callers that persist it
   *  write nothing — the mint is an NFT's largest single charge, and a
   *  total quietly missing it reads as a profitable position. */
  const gasKnown = mintGasWei !== null && gasComplete;
  const totalNftGasWei = gasKnown ? mintGasWei + totalGasWei : null;
  if (compounds.length > 0 || fees0 > 0n || fees1 > 0n) {
    _logCompoundSummary(opts, {
      compounds,
      fees0,
      fees1,
      totalCompoundedUsd,
      ilLogsCount,
      collectCount: collectEvents.length,
      drainCount: dlEvents.filter((e) => (e.liquidity ?? 0n) > 0n).length,
    });
  }
  return {
    compounds,
    totalCompoundedUsd,
    feeAmount0,
    feeAmount1,
    totalGasWei: String(totalGasWei),
    /*- Null, not "0", when any receipt in the set was unreadable — the
     *  callers that save this branch on it. */
    totalNftGasWei: totalNftGasWei === null ? null : String(totalNftGasWei),
  };
}

/**
 * Detect historical compounds for a single NFT.
 *
 * Reads the NFT's IncreaseLiquidity, Collect and DecreaseLiquidity
 * events (`scanNftEvents`, three chunked scans run in parallel), then
 * classifies them (`classifyCompounds`).
 *
 * @param {string} tokenId
 * @param {object} [opts]  `classifyCompounds` options, plus `fromBlock`
 *   and `toBlock` to bound the read.
 * @returns {Promise<{compounds: object[], totalCompoundedUsd: number,
 *   totalGasWei: string, totalNftGasWei: string}>}
 */
async function detectCompoundsOnChain(tokenId, opts = {}) {
  /*- Pass the caller's lower bound through.  Calling scanNftEvents with
   *  no options starts every lookup at block 0 — the whole chain, three
   *  event types, for one NFT.  Chunked and paced, that range is
   *  thousands of requests holding the global queue for the better part
   *  of an hour, stalling every other position's polling behind it.
   *
   *  See feedback_no_genesis_chain_scans: every log scan needs a tight
   *  lower bound. Callers that know the pool pass its creation block. */
  const nftEvents = await scanNftEvents(tokenId, {
    fromBlock: opts.fromBlock,
    toBlock: opts.toBlock,
  });
  return classifyCompounds(nftEvents, { ...opts, tokenId });
}

module.exports = {
  addLiquidity,
  executeCompound,
  detectCompoundsOnChain,
  scanNftEvents,
  classifyCompounds,
  lifetimeFeeAmounts,
  _filterRebalances,
  _fetchCompoundGas,
};
