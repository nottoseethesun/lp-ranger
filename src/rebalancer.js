/**
 * @file rebalancer.js
 * @description Core rebalance execution for the 9mm v3 Position Manager
 * (Uniswap V3 fork on PulseChain).  Handles: remove liquidity → swap → mint.
 * All functions accept injected signer/provider and ethersLib (v6) for testability.
 */

'use strict';

const rangeMath = require('./range-math');

// ── ABI fragments ────────────────────────────────────────────────────────────

const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
];

const POOL_ABI = [
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
];

const PM_ABI = [
  'function decreaseLiquidity(tuple(uint256 tokenId, uint128 liquidity, uint256 amount0Min, uint256 amount1Min, uint256 deadline) params) external payable returns (uint256 amount0, uint256 amount1)',
  'function collect(tuple(uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max) params) external payable returns (uint256 amount0, uint256 amount1)',
  'function mint(tuple(address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint256 amount0Desired, uint256 amount1Desired, uint256 amount0Min, uint256 amount1Min, address recipient, uint256 deadline) params) external payable returns (uint256 tokenId, uint128 liquidity, uint256 amount0, uint256 amount1)',
  'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function multicall(bytes[] calldata data) external payable returns (bytes[] memory results)',
];

const SWAP_ROUTER_ABI = [
  'function exactInputSingle(tuple(address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96) params) external payable returns (uint256 amountOut)',
];

const ERC20_ABI = [
  'function decimals() external view returns (uint8)',
  'function balanceOf(address account) external view returns (uint256)',
  'function approve(address spender, uint256 amount) external returns (bool)',
  'function allowance(address owner, address spender) external view returns (uint256)',
];

// ── Constants ────────────────────────────────────────────────────────────────

/** Maximum uint128 value used for the collect() call. */
const _MAX_UINT128 = 2n ** 128n - 1n;

/** Default transaction deadline offset in seconds. */
const _DEADLINE_SECONDS = 300;

/** Minimum swap amount — skip swap if amountIn is below this threshold. */
const _MIN_SWAP_THRESHOLD = 1000n;

/** Valid V3 fee tiers (basis-point units). */
const V3_FEE_TIERS = [100, 500, 2500, 3000, 10000];

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Return a deadline timestamp (current block time + offset).
 * @param {number} [offsetSeconds=_DEADLINE_SECONDS] Seconds from now.
 * @returns {bigint}
 */
function _deadline(offsetSeconds = _DEADLINE_SECONDS) {
  return BigInt(Math.floor(Date.now() / 1000) + offsetSeconds);
}

/**
 * Ensure an ERC-20 allowance is at least `requiredAmount` for `spender`.
 * If the current allowance is insufficient an unlimited approval is sent.
 *
 * @param {import('ethers').Contract} tokenContract ERC-20 contract instance.
 * @param {string} owner   Owner address.
 * @param {string} spender Spender address.
 * @param {bigint} requiredAmount Minimum required allowance.
 * @returns {Promise<void>}
 */
async function _ensureAllowance(tokenContract, owner, spender, requiredAmount) {
  const current = await tokenContract.allowance(owner, spender);
  if (current >= requiredAmount) return;
  // Approve only the exact amount needed (not unlimited) to limit exposure
  // if the spender contract is compromised.
  const tx = await tokenContract.approve(spender, requiredAmount);
  await tx.wait();
}

// ── Exported functions ───────────────────────────────────────────────────────

/** Fetch current pool state (price, tick, decimals) from on-chain contracts. */
async function getPoolState(provider, ethersLib, { factoryAddress, token0, token1, fee }) {
  const { Contract, ZeroAddress } = ethersLib;

  const factory = new Contract(factoryAddress, FACTORY_ABI, provider);
  const poolAddress = await factory.getPool(token0, token1, fee);

  if (poolAddress === ZeroAddress) {
    throw new Error(`Pool not found for ${token0}/${token1} fee=${fee}`);
  }

  const pool = new Contract(poolAddress, POOL_ABI, provider);
  const token0Contract = new Contract(token0, ERC20_ABI, provider);
  const token1Contract = new Contract(token1, ERC20_ABI, provider);

  const [slot0, decimals0, decimals1] = await Promise.all([
    pool.slot0(),
    token0Contract.decimals(),
    token1Contract.decimals(),
  ]);

  const sqrtPriceX96 = slot0.sqrtPriceX96;
  const tick = Number(slot0.tick);
  const price = rangeMath.sqrtPriceX96ToPrice(sqrtPriceX96, Number(decimals0), Number(decimals1));

  return {
    sqrtPriceX96,
    tick,
    price,
    poolAddress,
    decimals0: Number(decimals0),
    decimals1: Number(decimals1),
  };
}

/**
 * Remove all liquidity from a V3 NFT position and collect tokens.
 *
 * Uses balance-diff to determine collected amounts (more robust than
 * parsing logs, which can fail if the ABI event signature doesn't match
 * the on-chain contract exactly).
 */
async function removeLiquidity(signer, ethersLib, {
  positionManagerAddress, tokenId, liquidity, recipient, deadline,
  token0, token1,
}) {
  const { Contract } = ethersLib;
  const pm = new Contract(positionManagerAddress, PM_ABI, signer);
  const provider = signer.provider ?? signer;
  const dl = deadline ?? _deadline();

  // Snapshot balances before collect so we can diff
  let bal0Before = 0n;
  let bal1Before = 0n;
  if (token0 && token1) {
    const t0 = new Contract(token0, ERC20_ABI, provider);
    const t1 = new Contract(token1, ERC20_ABI, provider);
    [bal0Before, bal1Before] = await Promise.all([
      t0.balanceOf(recipient),
      t1.balanceOf(recipient),
    ]);
  }

  // Bundle decreaseLiquidity + collect into a single atomic multicall,
  // matching the pattern the 9mm Pro UI uses.  This ensures no state can
  // change between the two operations and eliminates rounding dust that
  // can remain when they run as separate transactions.
  const decreaseData = pm.interface.encodeFunctionData('decreaseLiquidity', [{
    tokenId,
    liquidity,
    amount0Min: 0n,
    amount1Min: 0n,
    deadline: dl,
  }]);
  const collectData = pm.interface.encodeFunctionData('collect', [{
    tokenId,
    recipient,
    amount0Max: _MAX_UINT128,
    amount1Max: _MAX_UINT128,
  }]);

  const multicallTx = await pm.multicall([decreaseData, collectData]);
  const receipt = await multicallTx.wait();

  // Determine collected amounts via balance diff (robust across all ABIs)
  let amount0 = 0n;
  let amount1 = 0n;
  if (token0 && token1) {
    const t0 = new Contract(token0, ERC20_ABI, provider);
    const t1 = new Contract(token1, ERC20_ABI, provider);
    const [bal0After, bal1After] = await Promise.all([
      t0.balanceOf(recipient),
      t1.balanceOf(recipient),
    ]);
    amount0 = bal0After - bal0Before;
    amount1 = bal1After - bal1Before;
  }

  if (amount0 === 0n && amount1 === 0n) {
    throw new Error(
      'Collected 0 tokens after removing liquidity — aborting to prevent empty mint',
    );
  }

  return { amount0, amount1, txHash: receipt.hash };
}

/** Compute desired token amounts and swap needs for the new range. */
function computeDesiredAmounts(available, range, tokens) {
  const { amount0, amount1 } = available;
  const { currentPrice, lowerPrice, upperPrice } = range;
  const { decimals0, decimals1 } = tokens;

  const targetRatio0 = rangeMath.compositionRatio(currentPrice, lowerPrice, upperPrice);

  const float0 = Number(amount0) / 10 ** decimals0;
  const float1 = Number(amount1) / 10 ** decimals1;
  const totalValue = float0 * currentPrice + float1;

  if (totalValue === 0) {
    return {
      amount0Desired: 0n,
      amount1Desired: 0n,
      needsSwap: false,
      swapDirection: null,
      swapAmount: 0n,
    };
  }

  const actualRatio0 = (float0 * currentPrice) / totalValue;
  const ratioDiff = Math.abs(actualRatio0 - targetRatio0);

  if (ratioDiff <= 0.01) {
    return {
      amount0Desired: amount0,
      amount1Desired: amount1,
      needsSwap: false,
      swapDirection: null,
      swapAmount: 0n,
    };
  }

  // Need to swap — determine direction and amount.
  // Clamp swapAmount to available balance to prevent BigInt underflow.
  if (actualRatio0 > targetRatio0) {
    // Too much token0, sell some for token1
    const excessValue = (actualRatio0 - targetRatio0) * totalValue;
    const excessToken0 = excessValue / currentPrice;
    const rawSwap = BigInt(Math.floor(excessToken0 * 10 ** decimals0));
    const swapAmount = rawSwap > amount0 ? amount0 : rawSwap;
    const a0d = amount0 - swapAmount;
    if (a0d < 0n) {
      throw new Error(`computeDesiredAmounts: negative amount0Desired (${a0d})`);
    }
    return {
      amount0Desired: a0d,
      amount1Desired: amount1,
      needsSwap: true,
      swapDirection: 'token0to1',
      swapAmount,
    };
  }

  // Too much token1, sell some for token0
  const excessValue = (targetRatio0 - actualRatio0) * totalValue;
  const rawSwap = BigInt(Math.floor(excessValue * 10 ** decimals1));
  const swapAmount = rawSwap > amount1 ? amount1 : rawSwap;
  const result = {
    amount0Desired: amount0,
    amount1Desired: amount1 - swapAmount,
    needsSwap: true,
    swapDirection: 'token1to0',
    swapAmount,
  };

  // ── Postcondition: desired amounts must never be negative ────────────────
  if (result.amount0Desired < 0n || result.amount1Desired < 0n) {
    throw new Error(
      `computeDesiredAmounts: negative desired amount `
      + `(a0=${result.amount0Desired}, a1=${result.amount1Desired})`,
    );
  }
  return result;
}

/**
 * Swap via the V3 SwapRouter if amount exceeds the minimum threshold.
 *
 * @param {object} signer
 * @param {object} ethersLib
 * @param {object} params
 * @param {string} params.swapRouterAddress
 * @param {string} params.tokenIn
 * @param {string} params.tokenOut
 * @param {number} params.fee
 * @param {bigint} params.amountIn
 * @param {number} params.slippagePct
 * @param {number} params.currentPrice      Current pool price (token1 per token0).
 * @param {number} params.decimalsIn        Decimals of the input token.
 * @param {number} params.decimalsOut       Decimals of the output token.
 * @param {boolean} params.isToken0To1      True when selling token0 for token1.
 * @param {string} params.recipient
 * @param {bigint} [params.deadline]
 * @returns {Promise<{amountOut: bigint, txHash: string|null}>}
 */
async function swapIfNeeded(signer, ethersLib, {
  swapRouterAddress, tokenIn, tokenOut, fee, amountIn,
  slippagePct, currentPrice, decimalsIn, decimalsOut, isToken0To1,
  recipient, deadline,
}) {
  if (amountIn < _MIN_SWAP_THRESHOLD) {
    return { amountOut: 0n, txHash: null };
  }

  const { Contract } = ethersLib;
  const tokenContract = new Contract(tokenIn, ERC20_ABI, signer);
  const signerAddress = await signer.getAddress();

  await _ensureAllowance(tokenContract, signerAddress, swapRouterAddress, amountIn);

  const router = new Contract(swapRouterAddress, SWAP_ROUTER_ABI, signer);
  const dl = deadline ?? _deadline();

  // Compute expected output using pool price, then apply slippage.
  // price = token1 per token0.
  //   token0→token1: expectedOut = amountIn × price × 10^(decimalsOut−decimalsIn)
  //   token1→token0: expectedOut = amountIn / price × 10^(decimalsOut−decimalsIn)
  const floatIn = Number(amountIn);
  const rate = isToken0To1 ? currentPrice : (1 / currentPrice);
  const decimalShift = 10 ** (decimalsOut - decimalsIn);
  const expectedOut = BigInt(Math.floor(floatIn * rate * decimalShift));

  const slipMul = BigInt(Math.floor((100 - (slippagePct ?? 0.5)) * 100));
  const amountOutMinimum = (expectedOut * slipMul) / 10000n;

  // Snapshot output token balance before swap for balance-diff
  const provider = signer.provider ?? signer;
  const outContract = new Contract(tokenOut, ERC20_ABI, provider);
  const balBefore = await outContract.balanceOf(recipient);

  const tx = await router.exactInputSingle({
    tokenIn,
    tokenOut,
    fee,
    recipient,
    deadline: dl,
    amountIn,
    amountOutMinimum,
    sqrtPriceLimitX96: 0n,
  });
  const receipt = await tx.wait();

  // Use actual balance diff (not estimate) so mint uses correct amounts
  const balAfter = await outContract.balanceOf(recipient);
  const actualOut = balAfter - balBefore;
  return { amountOut: actualOut > 0n ? actualOut : 0n, txHash: receipt.hash };
}

/** Mint a new V3 liquidity position via the NonfungiblePositionManager. */
async function mintPosition(signer, ethersLib, {
  positionManagerAddress, token0, token1, fee, tickLower, tickUpper,
  amount0Desired, amount1Desired, slippagePct, recipient, deadline,
}) {
  const { Contract } = ethersLib;
  const signerAddress = await signer.getAddress();

  const token0Contract = new Contract(token0, ERC20_ABI, signer);
  const token1Contract = new Contract(token1, ERC20_ABI, signer);

  await Promise.all([
    _ensureAllowance(token0Contract, signerAddress, positionManagerAddress, amount0Desired),
    _ensureAllowance(token1Contract, signerAddress, positionManagerAddress, amount1Desired),
  ]);

  const slippageMultiplier = BigInt(Math.floor((100 - slippagePct) * 100));
  const amount0Min = (amount0Desired * slippageMultiplier) / 10000n;
  const amount1Min = (amount1Desired * slippageMultiplier) / 10000n;

  const pm = new Contract(positionManagerAddress, PM_ABI, signer);
  const dl = deadline ?? _deadline();

  const tx = await pm.mint({
    token0,
    token1,
    fee,
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    amount0Min,
    amount1Min,
    recipient,
    deadline: dl,
  });
  const receipt = await tx.wait();

  // Try to parse the IncreaseLiquidity event for actual values.
  // Topic0 = keccak256('IncreaseLiquidity(uint256,uint128,uint256,uint256)')
  const INC_TOPIC = '0x3067048beee31b25b2f1681f88dac838c8bba36af25bfb2b7cf7473a5847e35f';
  let tokenId = 0n;
  let liquidity = 0n;
  let amount0 = amount0Desired;
  let amount1 = amount1Desired;

  if (receipt.logs) {
    for (const log of receipt.logs) {
      if (log.topics && log.topics[0] === INC_TOPIC && log.data) {
        try {
          tokenId   = BigInt(log.topics[1]);
          // data contains: liquidity (uint128), amount0 (uint256), amount1 (uint256)
          const data = log.data.replace(/^0x/, '');
          liquidity = BigInt('0x' + data.slice(0, 64));
          amount0   = BigInt('0x' + data.slice(64, 128));
          amount1   = BigInt('0x' + data.slice(128, 192));
        } catch (_) { /* fall through to defaults */ }
        break;
      }
    }
  }

  if (tokenId === 0n) {
    throw new Error('Mint succeeded but no tokenId was returned — check IncreaseLiquidity event parsing');
  }
  if (liquidity === 0n) {
    throw new Error('Mint returned zero liquidity — position would be empty');
  }

  return { tokenId, liquidity, amount0, amount1, txHash: receipt.hash };
}

/**
 * Read wallet balances for both position tokens (recovery mode).
 * Used when on-chain liquidity is 0 (prior partial failure).
 */
async function _walletBalances(ethersLib, provider, token0, token1, owner) {
  const t0 = new ethersLib.Contract(token0, ERC20_ABI, provider);
  const t1 = new ethersLib.Contract(token1, ERC20_ABI, provider);
  const [bal0, bal1] = await Promise.all([t0.balanceOf(owner), t1.balanceOf(owner)]);
  if (bal0 === 0n && bal1 === 0n) {
    throw new Error('Position drained and wallet has 0 balance of both tokens');
  }
  return { amount0: bal0, amount1: bal1, txHash: null };
}

/** Execute a complete rebalance: remove → swap → mint at new range. */
async function executeRebalance(signer, ethersLib, opts) {
  const {
    position, factoryAddress, positionManagerAddress,
    swapRouterAddress, rangeWidthPct, slippagePct,
  } = opts;

  // V3-only guard
  if (!position.tokenId || !V3_FEE_TIERS.includes(position.fee)) {
    throw new Error(
      'Only V3 NFT positions are supported. V2 positions use a different '
      + 'contract and cannot be rebalanced by this tool.',
    );
  }

  try {
    const txHashes = [];
    const signerAddress = await signer.getAddress();
    const provider = signer.provider ?? signer;

    // 1. Get current pool state
    const poolState = await getPoolState(provider, ethersLib, {
      factoryAddress,
      token0: position.token0,
      token1: position.token1,
      fee: position.fee,
    });

    // 2. Verify position ownership before removing liquidity
    const pmContract = new ethersLib.Contract(
      positionManagerAddress,
      ['function ownerOf(uint256 tokenId) view returns (address)'],
      provider,
    );
    let owner;
    try {
      owner = await pmContract.ownerOf(position.tokenId);
    } catch (err) {
      throw new Error(`Cannot verify ownership of NFT #${position.tokenId}: ${err.message}`, { cause: err });
    }
    if (owner.toLowerCase() !== signerAddress.toLowerCase()) {
      throw new Error(
        `Wallet ${signerAddress} does not own NFT #${position.tokenId} (owner: ${owner})`,
      );
    }

    // 3. Read on-chain liquidity (may differ from in-memory after partial failure)
    const pmRead = new ethersLib.Contract(positionManagerAddress, PM_ABI, provider);
    const posData = await pmRead.positions(position.tokenId);
    const onChainLiquidity = posData.liquidity;

    // 3a. Remove existing liquidity (skip if already drained — e.g. prior failed mint)
    let removed;
    if (onChainLiquidity > 0n) {
      removed = await removeLiquidity(signer, ethersLib, {
        positionManagerAddress,
        tokenId: position.tokenId,
        liquidity: onChainLiquidity,
        recipient: signerAddress,
        token0: position.token0,
        token1: position.token1,
      });
      txHashes.push(removed.txHash);
    } else {
      // Position already drained — use wallet balances directly (recovery mode)
      console.log('[bot] Position has 0 liquidity on-chain — using wallet balances for mint');
      removed = await _walletBalances(ethersLib, provider, position.token0, position.token1, signerAddress);
    }

    // 4. Compute new range
    const newRange = rangeMath.computeNewRange(
      poolState.price,
      rangeWidthPct,
      position.fee,
      poolState.decimals0,
      poolState.decimals1,
    );

    // 5. Determine desired amounts and whether a swap is needed
    const desired = computeDesiredAmounts(
      { amount0: removed.amount0, amount1: removed.amount1 },
      { currentPrice: poolState.price, lowerPrice: newRange.lowerPrice, upperPrice: newRange.upperPrice },
      { decimals0: poolState.decimals0, decimals1: poolState.decimals1 },
    );

    // 6. Swap if needed — track amounts from collection, not wallet balance
    let mintAmount0 = desired.amount0Desired;
    let mintAmount1 = desired.amount1Desired;

    if (desired.needsSwap && desired.swapAmount >= _MIN_SWAP_THRESHOLD) {
      const isToken0To1 = desired.swapDirection === 'token0to1';
      const swapResult = await swapIfNeeded(signer, ethersLib, {
        swapRouterAddress,
        tokenIn: isToken0To1 ? position.token0 : position.token1,
        tokenOut: isToken0To1 ? position.token1 : position.token0,
        fee: position.fee,
        amountIn: desired.swapAmount,
        slippagePct,
        currentPrice: poolState.price,
        decimalsIn: isToken0To1 ? poolState.decimals0 : poolState.decimals1,
        decimalsOut: isToken0To1 ? poolState.decimals1 : poolState.decimals0,
        isToken0To1,
        recipient: signerAddress,
      });
      if (swapResult.txHash) txHashes.push(swapResult.txHash);

      // Adjust mint amounts to reflect the swap output
      if (isToken0To1) {
        mintAmount1 = mintAmount1 + swapResult.amountOut;
      } else {
        mintAmount0 = mintAmount0 + swapResult.amountOut;
      }
    }

    // 7. Mint new position with collected + swapped amounts (NOT full wallet balance)
    const mintResult = await mintPosition(signer, ethersLib, {
      positionManagerAddress,
      token0: position.token0,
      token1: position.token1,
      fee: position.fee,
      tickLower: newRange.lowerTick,
      tickUpper: newRange.upperTick,
      amount0Desired: mintAmount0,
      amount1Desired: mintAmount1,
      slippagePct,
      recipient: signerAddress,
    });
    txHashes.push(mintResult.txHash);

    return {
      success: true,
      oldTokenId: position.tokenId,
      newTokenId: mintResult.tokenId,
      oldTickLower: position.tickLower,
      oldTickUpper: position.tickUpper,
      newTickLower: newRange.lowerTick,
      newTickUpper: newRange.upperTick,
      currentPrice: poolState.price,
      amount0Collected: removed.amount0,
      amount1Collected: removed.amount1,
      liquidity: mintResult.liquidity,
      amount0Minted: mintResult.amount0,
      amount1Minted: mintResult.amount1,
      txHashes,
    };
  } catch (err) {
    return {
      success: false,
      error: err.message || String(err),
    };
  }
}

// ── Module exports ───────────────────────────────────────────────────────────

module.exports = {
  executeRebalance,
  getPoolState,
  removeLiquidity,
  computeDesiredAmounts,
  swapIfNeeded,
  mintPosition,
  _MAX_UINT128,
  _DEADLINE_SECONDS,
  _MIN_SWAP_THRESHOLD,
  V3_FEE_TIERS,
};
