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

const { emojiId } = require("./logger");

const config = require("./config");

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
  _waitOrSpeedUp,
  _ensureAllowance,
} = require("./rebalancer-pools");

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

  // collect() on the NonfungiblePositionManager internally calls
  // pool.burn(0) to update fee accounting before collecting.
  const tx = await pm.collect(
    {
      tokenId: opts.tokenId,
      recipient: opts.recipient,
      amount0Max: _MAX_UINT128,
      amount1Max: _MAX_UINT128,
    },
    { type: config.TX_TYPE },
  );
  console.log(
    "[compound] %s collectFees: TX submitted, hash= %s nonce=%d",
    cx,
    tx.hash,
    tx.nonce,
  );
  const receipt = await _waitOrSpeedUp(tx, signer, "compound-collect");
  console.log(
    "[compound] %s collectFees: confirmed, gasUsed=%s block=%s",
    cx,
    String(receipt.gasUsed),
    receipt.blockNumber,
  );

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
  const tx = await pm.increaseLiquidity(
    {
      tokenId: opts.tokenId,
      amount0Desired: opts.amount0,
      amount1Desired: opts.amount1,
      amount0Min: 0n,
      amount1Min: 0n,
      deadline: dl,
    },
    { type: config.TX_TYPE },
  );
  const cx = _ctx(opts);
  console.log(
    "[compound] %s addLiquidity: TX submitted, hash= %s nonce=%d",
    cx,
    tx.hash,
    tx.nonce,
  );
  const receipt = await _waitOrSpeedUp(tx, signer, "compound-addLiq");
  console.log(
    "[compound] %s addLiquidity: confirmed, gasUsed=%s block=%s",
    cx,
    String(receipt.gasUsed),
    receipt.blockNumber,
  );

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
 * Execute a full compound: collect fees → re-deposit as liquidity.
 * @param {import('ethers').Signer} signer
 * @param {object} ethersLib
 * @param {object} opts
 * @param {string} opts.positionManagerAddress
 * @param {string} opts.tokenId
 * @param {string} opts.token0
 * @param {string} opts.token1
 * @param {string} opts.recipient
 * @param {number} opts.decimals0
 * @param {number} opts.decimals1
 * @param {number} opts.price0    Current token0 USD price
 * @param {number} opts.price1    Current token1 USD price
 * @param {string} opts.trigger   "manual" or "auto"
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

  const deposited = await addLiquidity(signer, ethersLib, {
    ...opts,
    amount0: collected.amount0,
    amount1: collected.amount1,
  });

  const d0 = opts.decimals0 ?? 8;
  const d1 = opts.decimals1 ?? 8;
  const usdValue =
    (Number(deposited.amount0Deposited) / 10 ** d0) * (opts.price0 || 0) +
    (Number(deposited.amount1Deposited) / 10 ** d1) * (opts.price1 || 0);

  const totalGasWei = collected.gasCostWei + deposited.gasCostWei;

  return {
    compounded: true,
    trigger: opts.trigger || "manual",
    collectTxHash: collected.txHash,
    depositTxHash: deposited.txHash,
    amount0Deposited: String(deposited.amount0Deposited),
    amount1Deposited: String(deposited.amount1Deposited),
    liquidity: String(deposited.liquidity),
    usdValue,
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
  const ethers = require("ethers");
  const iface = new ethers.Interface(PM_ABI);
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
        topics: [iface.getEvent("IncreaseLiquidity").topicHash, tidHex],
      })
      .catch(() => []),
    prov
      .getLogs({
        address: addr,
        fromBlock: from,
        toBlock: "latest",
        topics: [iface.getEvent("Collect").topicHash, tidHex],
      })
      .catch(() => []),
    prov
      .getLogs({
        address: addr,
        fromBlock: from,
        toBlock: "latest",
        topics: [iface.getEvent("DecreaseLiquidity").topicHash, tidHex],
      })
      .catch(() => []),
  ]);
  return {
    ilEvents: _parseLogs(iface, ilLogs),
    collectEvents: _parseLogs(iface, colLogs),
    dlEvents: _parseLogs(iface, dlLogs),
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
async function classifyCompounds(nftEvents, opts = {}) {
  const ethers = require("ethers");
  const prov = new ethers.JsonRpcProvider(config.RPC_URL);
  const { ilEvents, collectEvents, dlEvents, ilLogsCount } = nftEvents;
  const candidateILs = ilEvents.slice(1); // skip first = mint
  const compoundEvents = _filterRebalances(candidateILs, dlEvents);
  let totalCollected0 = 0n,
    totalCollected1 = 0n;
  for (const e of collectEvents) {
    totalCollected0 += e.amount0 ?? 0n;
    totalCollected1 += e.amount1 ?? 0n;
  }
  let sum0 = 0n,
    sum1 = 0n;
  for (const e of compoundEvents) {
    sum0 += e.amount0;
    sum1 += e.amount1;
  }
  const cap0 = sum0 > totalCollected0 ? totalCollected0 : sum0;
  const cap1 = sum1 > totalCollected1 ? totalCollected1 : sum1;
  const d0 = opts.decimals0 ?? 8,
    d1 = opts.decimals1 ?? 8;
  const totalCompoundedUsd =
    (Number(cap0) / 10 ** d0) * (opts.price0 || 0) +
    (Number(cap1) / 10 ** d1) * (opts.price1 || 0);
  const { compounds, totalGasWei } = await _fetchCompoundGas(
    prov,
    compoundEvents,
  );
  const s0 = opts.token0Symbol || "Token0";
  const s1 = opts.token1Symbol || "Token1";
  if (compounds.length > 0) {
    const chain = config.CHAIN_NAME || "PulseChain";
    const nft = "#" + (opts.tokenId || "?") + " " + emojiId(opts.tokenId);
    console.log(
      "[compound] %s %s %s %s/%s: %d IncreaseLiquidity (%d compounds), %d Collect",
      chain,
      _abbr(opts.wallet),
      nft,
      s0,
      s1,
      ilLogsCount,
      compounds.length,
      collectEvents.length,
    );
    console.log(
      "[compound]   compounded: %s=%s %s=%s (capped: %s=%s %s=%s) → $%s",
      s0,
      String(sum0),
      s1,
      String(sum1),
      s0,
      String(cap0),
      s1,
      String(cap1),
      totalCompoundedUsd.toFixed(2),
    );
  }
  return { compounds, totalCompoundedUsd, totalGasWei: String(totalGasWei) };
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
