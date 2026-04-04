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

const config = require("./config");
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
  const dl = _deadline();

  const t0 = new Contract(opts.token0, ERC20_ABI, provider);
  const t1 = new Contract(opts.token1, ERC20_ABI, provider);
  const [bal0Before, bal1Before] = await Promise.all([
    t0.balanceOf(opts.recipient),
    t1.balanceOf(opts.recipient),
  ]);
  console.log(
    "[compound] collectFees: walletBefore0=%s walletBefore1=%s",
    String(bal0Before),
    String(bal1Before),
  );

  const decreaseData = pm.interface.encodeFunctionData("decreaseLiquidity", [
    {
      tokenId: opts.tokenId,
      liquidity: 0n,
      amount0Min: 0n,
      amount1Min: 0n,
      deadline: dl,
    },
  ]);
  const collectData = pm.interface.encodeFunctionData("collect", [
    {
      tokenId: opts.tokenId,
      recipient: opts.recipient,
      amount0Max: _MAX_UINT128,
      amount1Max: _MAX_UINT128,
    },
  ]);
  const tx = await pm.multicall([decreaseData, collectData], {
    type: config.TX_TYPE,
  });
  console.log(
    "[compound] collectFees: TX submitted, hash= %s nonce=%d",
    tx.hash,
    tx.nonce,
  );
  const receipt = await _waitOrSpeedUp(tx, signer, "compound-collect");
  console.log(
    "[compound] collectFees: confirmed, gasUsed=%s block=%s",
    String(receipt.gasUsed),
    receipt.blockNumber,
  );

  const [bal0After, bal1After] = await Promise.all([
    t0.balanceOf(opts.recipient),
    t1.balanceOf(opts.recipient),
  ]);
  const amount0 = bal0After - bal0Before;
  const amount1 = bal1After - bal1Before;
  console.log(
    "[compound] collectFees: collected0=%s collected1=%s",
    String(amount0),
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
async function addLiquidity(signer, ethersLib, opts) {
  const { Contract } = ethersLib;
  const pm = new Contract(opts.positionManagerAddress, PM_ABI, signer);

  const t0 = new Contract(opts.token0, ERC20_ABI, signer);
  const t1 = new Contract(opts.token1, ERC20_ABI, signer);
  await _ensureAllowance(
    t0,
    opts.recipient,
    opts.positionManagerAddress,
    opts.amount0,
  );
  await _ensureAllowance(
    t1,
    opts.recipient,
    opts.positionManagerAddress,
    opts.amount1,
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
  console.log(
    "[compound] addLiquidity: TX submitted, hash= %s nonce=%d",
    tx.hash,
    tx.nonce,
  );
  const receipt = await _waitOrSpeedUp(tx, signer, "compound-addLiq");
  console.log(
    "[compound] addLiquidity: confirmed, gasUsed=%s block=%s",
    String(receipt.gasUsed),
    receipt.blockNumber,
  );

  // Parse IncreaseLiquidity event for actual deposited amounts
  let liquidity = 0n,
    amount0Deposited = 0n,
    amount1Deposited = 0n;
  for (const log of receipt.logs || []) {
    if (log.topics?.length >= 2 && log.data?.length >= 130) {
      try {
        const parsed = pm.interface.parseLog({
          topics: log.topics,
          data: log.data,
        });
        if (parsed?.name === "IncreaseLiquidity") {
          liquidity = parsed.args.liquidity ?? 0n;
          amount0Deposited = parsed.args.amount0 ?? 0n;
          amount1Deposited = parsed.args.amount1 ?? 0n;
          break;
        }
      } catch {
        /* skip unparseable logs */
      }
    }
  }
  console.log(
    "[compound] addLiquidity: liquidity=%s deposited0=%s deposited1=%s",
    String(liquidity),
    String(amount0Deposited),
    String(amount1Deposited),
  );

  const gasCostWei =
    (receipt.gasUsed ?? 0n) *
    (receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n);
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
    console.log("[compound] No fees to compound — skipping addLiquidity");
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

module.exports = { collectFees, addLiquidity, executeCompound };
