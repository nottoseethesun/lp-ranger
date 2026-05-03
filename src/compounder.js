/**
 * @file src/compounder.js
 * @description Compound execution: collect unclaimed fees from an NFT position
 * and re-deposit them as additional liquidity via `increaseLiquidity`.
 *
 * TX flow (two transactions):
 *   1. multicall [decreaseLiquidity(0), collect] — collects fees to wallet
 *   2. approve + increaseLiquidity — re-deposits collected tokens as liquidity
 *
 * Same NFT is retained.  No swap, no range change.  Uses the shared
 * rebalance lock for nonce safety and the _waitOrSpeedUp pipeline for
 * TX recovery.
 */

"use strict";

const ethers = require("ethers");
const { emojiId } = require("./logger");

const config = require("./config");
const sendTx = require("./send-transaction");
const { swapForCompound } = require("./compounder-swap");

/** Abbreviated address: 0x4e44…61A */
function _abbr(addr) {
  if (!addr || addr.length < 10) return addr || "?";
  return addr.slice(0, 6) + "\u2026" + addr.slice(-3);
}

/** Build a standard log context prefix for compound operations. */
function _ctx(opts) {
  const chain = config.CHAIN_NAME || "PulseChain";
  const wallet = _abbr(opts.recipient);
  const factory = _abbr(opts.positionManagerAddress);
  const nft = "#" + opts.tokenId + " " + emojiId(opts.tokenId);
  const s0 = opts.token0Symbol || "Token0";
  const s1 = opts.token1Symbol || "Token1";
  return chain + " " + wallet + " " + factory + " " + nft + " " + s0 + "/" + s1;
}
const {
  PM_ABI,
  ERC20_ABI,
  _MAX_UINT128,
  _deadline,
  _ensureAllowance,
} = require("./rebalancer-pools");

/*- Cached at module load: parsing PM logs is stateless, so a single Interface
    instance can serve every call in scanNftEvents/classifyCompounds. */
const _IFACE = new ethers.Interface(PM_ABI);

/**
 * Collect unclaimed fees from a position to the wallet.
 * Calls decreaseLiquidity(0) to update fee accounting, then collect(MAX).
 * @param {import('ethers').Signer} signer
 * @param {object} ethersLib  ethers module
 * @param {object} opts
 * @param {string} opts.positionManagerAddress
 * @param {string} opts.tokenId
 * @param {string} opts.recipient   Wallet address
 * @param {string} opts.token0      Token0 address
 * @param {string} opts.token1      Token1 address
 * @returns {Promise<{amount0: bigint, amount1: bigint, txHash: string, gasCostWei: bigint}>}
 */
async function collectFees(signer, ethersLib, opts) {
  const { Contract } = ethersLib;
  const pm = new Contract(opts.positionManagerAddress, PM_ABI, signer);
  const provider = signer.provider ?? signer;

  const t0 = new Contract(opts.token0, ERC20_ABI, provider);
  const t1 = new Contract(opts.token1, ERC20_ABI, provider);
  const [bal0Before, bal1Before] = await Promise.all([
    t0.balanceOf(opts.recipient),
    t1.balanceOf(opts.recipient),
  ]);
  const cx = _ctx(opts);
  console.log(
    "[compound] %s collectFees: walletBefore0=%s walletBefore1=%s",
    cx,
    String(bal0Before),
    String(bal1Before),
  );

  /*- collect() on the NonfungiblePositionManager internally calls
      pool.burn(0) to update fee accounting before collecting.  Routed
      through send-transaction.js so estimateGas, broadcast, and the
      speed-up/cancel pipeline all benefit from RPC failover. */
  const { receipt } = await sendTx.sendTransaction({
    populate: () =>
      pm.collect.populateTransaction({
        tokenId: opts.tokenId,
        recipient: opts.recipient,
        amount0Max: _MAX_UINT128,
        amount1Max: _MAX_UINT128,
      }),
    signer,
    label: "[compound] " + cx + " collect",
  });

  const [bal0After, bal1After] = await Promise.all([
    t0.balanceOf(opts.recipient),
    t1.balanceOf(opts.recipient),
  ]);
  const amount0 = bal0After - bal0Before;
  const amount1 = bal1After - bal1Before;
  const s0 = opts.token0Symbol || "Token0";
  const s1 = opts.token1Symbol || "Token1";
  console.log(
    "[compound] %s collectFees: %s=%s %s=%s",
    cx,
    s0,
    String(amount0),
    s1,
    String(amount1),
  );

  const gasCostWei =
    (receipt.gasUsed ?? 0n) *
    (receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n);
  return { amount0, amount1, txHash: receipt.hash, gasCostWei };
}

/**
 * Re-deposit collected fees as additional liquidity on the same NFT.
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

async function addLiquidity(signer, ethersLib, opts) {
  const { Contract } = ethersLib;
  const pm = new Contract(opts.positionManagerAddress, PM_ABI, signer);

  const t0 = new Contract(opts.token0, ERC20_ABI, signer);
  const t1 = new Contract(opts.token1, ERC20_ABI, signer);
  const appGas0 = await _ensureAllowance(
    t0,
    opts.recipient,
    opts.positionManagerAddress,
    opts.amount0,
    opts.approvalMultiple,
  );
  const appGas1 = await _ensureAllowance(
    t1,
    opts.recipient,
    opts.positionManagerAddress,
    opts.amount1,
    opts.approvalMultiple,
  );

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
  console.log(
    "[compound] %s addLiquidity: liquidity=%s %s=%s %s=%s",
    cx,
    String(liquidity),
    s0,
    String(amount0Deposited),
    s1,
    String(amount1Deposited),
  );

  const depositGas =
    (receipt.gasUsed ?? 0n) *
    (receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n);
  const gasCostWei = depositGas + (appGas0 || 0n) + (appGas1 || 0n);
  return {
    liquidity,
    amount0Deposited,
    amount1Deposited,
    txHash: receipt.hash,
    gasCostWei,
  };
}

/**
 * Read the current wallet balance of a token.
 * Helper for the post-swap re-read so addLiquidity uses fresh balances.
 */
async function _readBalance(signer, ethersLib, tokenAddr, owner) {
  const provider = signer.provider ?? signer;
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
    };
  }
  const [bal0, bal1] = await Promise.all([
    _readBalance(signer, ethersLib, opts.token0, opts.recipient),
    _readBalance(signer, ethersLib, opts.token1, opts.recipient),
  ]);
  console.log(
    "[compound] %s post-swap deposit amounts: a0=%s a1=%s",
    _ctx(opts),
    String(bal0),
    String(bal1),
  );
  return { depositAmount0: bal0, depositAmount1: bal1 };
}

/**
 * Execute a full compound: collect fees → optional ratio-correcting
 * swap (dust-gate then gas-gate) → re-deposit as liquidity.
 *
 * The intermediate swap minimizes wallet residual: without it, the
 * Position Manager only accepts the side of the collected fees that
 * fits the current tick ratio, leaving the rest in the wallet.  Both
 * swap-gates must pass for the swap to fire — see
 * `src/swap-gates.js` for the gate semantics.
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
 * @param {number} [opts.slippagePct]
 * @returns {Promise<object>}     Compound result with amounts, USD values, TX hashes
 */
async function executeCompound(signer, ethersLib, opts) {
  const collected = await collectFees(signer, ethersLib, opts);
  if (collected.amount0 === 0n && collected.amount1 === 0n) {
    console.log(
      "[compound] %s No fees to compound — skipping addLiquidity",
      _ctx(opts),
    );
    return {
      compounded: false,
      reason: "no_fees",
      collectTxHash: collected.txHash,
    };
  }

  /*- Optional ratio-correcting swap.  Fires only when a swap is
   *  actually needed AND both swap-gates pass (dust first, gas
   *  second).  See src/swap-gates.js. */
  const swap = await swapForCompound(
    signer,
    ethersLib,
    opts,
    collected.amount0,
    collected.amount1,
  );
  const { depositAmount0, depositAmount1 } = await _resolveDepositAmounts(
    signer,
    ethersLib,
    opts,
    collected,
    swap,
  );

  const deposited = await addLiquidity(signer, ethersLib, {
    ...opts,
    amount0: depositAmount0,
    amount1: depositAmount1,
  });

  const d0 = opts.decimals0 ?? 8;
  const d1 = opts.decimals1 ?? 8;
  const usdValue =
    (Number(deposited.amount0Deposited) / 10 ** d0) * (opts.price0 || 0) +
    (Number(deposited.amount1Deposited) / 10 ** d1) * (opts.price1 || 0);
  /*-
   *  USD value of the full Collect — typically larger than usdValue
   *  because increaseLiquidity requires tokens in the current tick's
   *  exact ratio, so one side usually has leftover that stays in the
   *  wallet as residual (tracked by residual-tracker.js).  Surfaced so
   *  the compound log can show users both numbers.
   */
  const collectedUsd =
    (Number(collected.amount0) / 10 ** d0) * (opts.price0 || 0) +
    (Number(collected.amount1) / 10 ** d1) * (opts.price1 || 0);

  const totalGasWei =
    collected.gasCostWei + (swap.gasCostWei || 0n) + deposited.gasCostWei;

  return {
    compounded: true,
    trigger: opts.trigger || "manual",
    collectTxHash: collected.txHash,
    depositTxHash: deposited.txHash,
    swapTxHash: swap.txHash,
    swapGateReason: swap.gateReason,
    amount0Deposited: String(deposited.amount0Deposited),
    amount1Deposited: String(deposited.amount1Deposited),
    liquidity: String(deposited.liquidity),
    usdValue,
    collectedUsd,
    price0: opts.price0,
    price1: opts.price1,
    gasCostWei: String(totalGasWei),
    timestamp: new Date().toISOString(),
  };
}

/**
 * Detect historical compound events for a given NFT by querying on-chain
 * IncreaseLiquidity, Collect, and DecreaseLiquidity events.  First
 * IncreaseLiquidity = mint deposit (skipped); subsequent ones are compound
 * candidates.  An IncreaseLiquidity that follows a DecreaseLiquidity within
 * 50k blocks is a rebalance (drain → re-deposit), not a compound, and is
 * excluded.  Compound amounts are capped per-token by total Collect amounts
 * (fees can't exceed collections).
 * Uses THREE getLogs calls (IL + Collect + DL), run in parallel.
 *
 * @param {string} tokenId
 * @param {object} [opts]  { decimals0, decimals1, price0, price1 }
 * @returns {Promise<{compounds: object[], totalCompoundedUsd: number}>}
 */
/** Parse event logs into structured objects. */
function _parseLogs(iface, logs) {
  const out = [];
  for (const log of logs) {
    try {
      const p = iface.parseLog({ topics: log.topics, data: log.data });
      out.push({
        amount0: p.args.amount0,
        amount1: p.args.amount1,
        liquidity: p.args.liquidity,
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
      });
    } catch {
      /* skip unparseable */
    }
  }
  return out;
}

/**
 * Filter IncreaseLiquidity candidates: remove any that follow a
 * DecreaseLiquidity (drain) within a block window. A drain followed by
 * re-deposit is a rebalance, not a compound.
 */
const _DRAIN_WINDOW = 50_000; // ~14 hours on PulseChain (1s blocks)
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

/** Fetch TX receipts for compound events and compute gas costs. */
async function _fetchCompoundGas(prov, compoundEvents) {
  let totalGasWei = 0n;
  const compounds = [];
  /*- Cache block timestamps so we don't re-fetch the same block when
      multiple events sit in it (rare but possible for batched txs). */
  const blockTsCache = new Map();
  for (const e of compoundEvents) {
    let gasWei = 0n;
    if (e.txHash) {
      try {
        const rcpt = await prov.getTransactionReceipt(e.txHash);
        if (rcpt)
          gasWei =
            (rcpt.gasUsed ?? 0n) *
            (rcpt.gasPrice ?? rcpt.effectiveGasPrice ?? 0n);
      } catch {
        /* receipt fetch failed — gas stays 0 */
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
  return { compounds, totalGasWei };
}

/**
 * Fetch IncreaseLiquidity, Collect, and DecreaseLiquidity logs for one NFT.
 * Single RPC round-trip (3 parallel getLogs).  Pure data — no classification.
 * @param {string|number} tokenId
 * @param {{ fromBlock?: number }} [scanOpts]
 * @returns {Promise<{ilEvents: object[], collectEvents: object[], dlEvents: object[], ilLogsCount: number}>}
 */
async function scanNftEvents(tokenId, scanOpts = {}) {
  const prov = new ethers.JsonRpcProvider(config.RPC_URL);
  const tidHex = "0x" + BigInt(tokenId).toString(16).padStart(64, "0");
  const addr = config.POSITION_MANAGER;
  const from = scanOpts.fromBlock ?? 0;
  const [ilLogs, colLogs, dlLogs] = await Promise.all([
    prov
      .getLogs({
        address: addr,
        fromBlock: from,
        toBlock: "latest",
        topics: [_IFACE.getEvent("IncreaseLiquidity").topicHash, tidHex],
      })
      .catch(() => []),
    prov
      .getLogs({
        address: addr,
        fromBlock: from,
        toBlock: "latest",
        topics: [_IFACE.getEvent("Collect").topicHash, tidHex],
      })
      .catch(() => []),
    prov
      .getLogs({
        address: addr,
        fromBlock: from,
        toBlock: "latest",
        topics: [_IFACE.getEvent("DecreaseLiquidity").topicHash, tidHex],
      })
      .catch(() => []),
  ]);
  return {
    ilEvents: _parseLogs(_IFACE, ilLogs),
    collectEvents: _parseLogs(_IFACE, colLogs),
    dlEvents: _parseLogs(_IFACE, dlLogs),
    ilLogsCount: ilLogs.length,
  };
}

/**
 * Classify compound events from pre-fetched NFT events.
 * First IL = mint (skipped); subsequent non-rebalance ILs = compounds,
 * capped per-token by total Collect amounts.
 * @param {{ ilEvents, collectEvents, dlEvents, ilLogsCount }} nftEvents
 * @param {object} opts  { decimals0, decimals1, price0, price1, token0Symbol, token1Symbol, wallet, tokenId }
 * @returns {Promise<{compounds: object[], totalCompoundedUsd: number, totalGasWei: string}>}
 */
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

/** Compute lifetime fees = total Collect − total drained principal (clamped ≥ 0). */
function _lifetimeFees(collectEvents, dlEvents) {
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
  const chain = config.CHAIN_NAME || "PulseChain";
  const nft = "#" + (opts.tokenId || "?") + " " + emojiId(opts.tokenId);
  console.log(
    "[compound] %s %s %s %s/%s: %d IncreaseLiquidity (%d standalone), %d Collect, %d drain",
    chain,
    _abbr(opts.wallet),
    nft,
    s0,
    s1,
    ilLogsCount,
    compounds.length,
    collectCount,
    drainCount,
  );
  console.log(
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
  if (!mintTxHash) return 0n;
  try {
    const rcpt = await prov.getTransactionReceipt(mintTxHash);
    if (!rcpt) return 0n;
    return (
      (rcpt.gasUsed ?? 0n) * (rcpt.gasPrice ?? rcpt.effectiveGasPrice ?? 0n)
    );
  } catch {
    return 0n;
  }
}

async function classifyCompounds(nftEvents, opts = {}) {
  const prov = new ethers.JsonRpcProvider(config.RPC_URL);
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
  const { fees0, fees1 } = _lifetimeFees(collectEvents, dlEvents);
  const d0 = opts.decimals0 ?? 8,
    d1 = opts.decimals1 ?? 8;
  const totalCompoundedUsd =
    (Number(fees0) / 10 ** d0) * (opts.price0 || 0) +
    (Number(fees1) / 10 ** d1) * (opts.price1 || 0);
  const { compounds, totalGasWei } = await _fetchCompoundGas(
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
  const totalNftGasWei = mintGasWei + totalGasWei;
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
    totalGasWei: String(totalGasWei),
    totalNftGasWei: String(totalNftGasWei),
  };
}

/**
 * Detect historical compounds for a single NFT (backward-compat wrapper).
 * Fetches events via scanNftEvents, then classifies via classifyCompounds.
 */
async function detectCompoundsOnChain(tokenId, opts = {}) {
  const nftEvents = await scanNftEvents(tokenId);
  return classifyCompounds(nftEvents, { ...opts, tokenId });
}

module.exports = {
  collectFees,
  addLiquidity,
  executeCompound,
  detectCompoundsOnChain,
  scanNftEvents,
  classifyCompounds,
  _filterRebalances,
  _parseLogs,
  _fetchCompoundGas,
};
