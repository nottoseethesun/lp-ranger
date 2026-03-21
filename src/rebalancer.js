/**
 * @file rebalancer.js
 * @description Core rebalance execution for the 9mm v3 Position Manager
 * (Uniswap V3 fork on PulseChain).  Handles: remove liquidity → swap → mint.
 * All functions accept injected signer/provider and ethersLib (v6) for testability.
 */

'use strict';

const rangeMath = require('./range-math');
const { PM_ABI } = require('./pm-abi');

// ── ABI fragments ────────────────────────────────────────────────────────────

const FACTORY_ABI = [
  'function getPool(address tokenA, address tokenB, uint24 fee) external view returns (address pool)',
];

const POOL_ABI = [
  'function slot0() external view returns (uint160 sqrtPriceX96, int24 tick, uint16 observationIndex, uint16 observationCardinality, uint16 observationCardinalityNext, uint8 feeProtocol, bool unlocked)',
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
  if (poolAddress === ZeroAddress) throw new Error(`Pool not found for ${token0}/${token1} fee=${fee}`);
  const pool = new Contract(poolAddress, POOL_ABI, provider);
  const token0Contract = new Contract(token0, ERC20_ABI, provider);
  const token1Contract = new Contract(token1, ERC20_ABI, provider);

  const [slot0, decimals0, decimals1] = await Promise.all([
    pool.slot0(),
    token0Contract.decimals(),
    token1Contract.decimals(),
  ]);

  const sqrtPriceX96 = slot0.sqrtPriceX96, tick = Number(slot0.tick);
  const price = rangeMath.sqrtPriceX96ToPrice(sqrtPriceX96, Number(decimals0), Number(decimals1));
  return { sqrtPriceX96, tick, price, poolAddress, decimals0: Number(decimals0), decimals1: Number(decimals1) };
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
  let bal0Before = 0n, bal1Before = 0n;
  if (token0 && token1) {
    const t0 = new Contract(token0, ERC20_ABI, provider), t1 = new Contract(token1, ERC20_ABI, provider);
    [bal0Before, bal1Before] = await Promise.all([t0.balanceOf(recipient), t1.balanceOf(recipient)]);
  }

  // Bundle decreaseLiquidity + collect into a single atomic multicall,
  // matching the pattern the 9mm Pro UI uses.  This ensures no state can
  // change between the two operations and eliminates rounding dust that
  // can remain when they run as separate transactions.
  const decreaseData = pm.interface.encodeFunctionData('decreaseLiquidity', [{ tokenId, liquidity, amount0Min: 0n, amount1Min: 0n, deadline: dl }]);
  const collectData = pm.interface.encodeFunctionData('collect', [{ tokenId, recipient, amount0Max: _MAX_UINT128, amount1Max: _MAX_UINT128 }]);
  const receipt = await (await pm.multicall([decreaseData, collectData])).wait();

  // Determine collected amounts via balance diff (robust across all ABIs)
  let amount0 = 0n, amount1 = 0n;
  if (token0 && token1) {
    const t0 = new Contract(token0, ERC20_ABI, provider), t1 = new Contract(token1, ERC20_ABI, provider);
    const [bal0After, bal1After] = await Promise.all([t0.balanceOf(recipient), t1.balanceOf(recipient)]);
    amount0 = bal0After - bal0Before; amount1 = bal1After - bal1Before;
  }
  if (amount0 === 0n && amount1 === 0n) {
    throw new Error('Collected 0 tokens after removing liquidity — aborting to prevent empty mint');
  }

  const gasCostWei = (receipt.gasUsed ?? 0n) * (receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n);
  return { amount0, amount1, txHash: receipt.hash, gasCostWei };
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

  if (result.amount0Desired < 0n || result.amount1Desired < 0n) {
    throw new Error(`computeDesiredAmounts: negative desired (a0=${result.amount0Desired}, a1=${result.amount1Desired})`);
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
  const signerAddress = await signer.getAddress();
  await _ensureAllowance(new Contract(tokenIn, ERC20_ABI, signer), signerAddress, swapRouterAddress, amountIn);
  const router = new Contract(swapRouterAddress, SWAP_ROUTER_ABI, signer);
  const dl = deadline || _deadline();
  // Expected output: price = token1/token0. Apply slippage for minimum.
  const floatIn = Number(amountIn);
  const rate = isToken0To1 ? currentPrice : (1 / currentPrice);
  const decimalShift = 10 ** (decimalsOut - decimalsIn);
  const expectedOut = BigInt(Math.floor(floatIn * rate * decimalShift));
  const amountOutMinimum = (expectedOut * BigInt(Math.floor((100 - (slippagePct || 0.5)) * 100))) / 10000n;
  const provider = signer.provider || signer;
  const outContract = new Contract(tokenOut, ERC20_ABI, provider);
  const balBefore = await outContract.balanceOf(recipient);

  const tx = await router.exactInputSingle({ tokenIn, tokenOut, fee, recipient,
    deadline: dl, amountIn, amountOutMinimum, sqrtPriceLimitX96: 0n });
  const receipt = await tx.wait();
  const balAfter = await outContract.balanceOf(recipient);
  const actualOut = balAfter - balBefore;
  const gasCostWei = (receipt.gasUsed ?? 0n) * (receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n);
  return { amountOut: actualOut > 0n ? actualOut : 0n, txHash: receipt.hash, gasCostWei };
}

/** Mint a new V3 liquidity position via the NonfungiblePositionManager. */
async function mintPosition(signer, ethersLib, {
  positionManagerAddress, token0, token1, fee, tickLower, tickUpper,
  amount0Desired, amount1Desired, recipient, deadline,
}) {
  const { Contract } = ethersLib;
  const signerAddress = await signer.getAddress();

  const token0Contract = new Contract(token0, ERC20_ABI, signer);
  const token1Contract = new Contract(token1, ERC20_ABI, signer);

  console.log('[rebalance] Step 7a: ensureAllowance for both tokens…');
  await Promise.all([
    _ensureAllowance(token0Contract, signerAddress, positionManagerAddress, amount0Desired),
    _ensureAllowance(token1Contract, signerAddress, positionManagerAddress, amount1Desired),
  ]);
  console.log('[rebalance] Step 7a done: allowances OK');

  // Mint mins are 0 — adding liquidity doesn't move price (no sandwich
  // risk), undeposited tokens stay in wallet, and narrow ranges make
  // ratio-based mins brittle across even tiny price movements.
  const amount0Min = 0n;
  const amount1Min = 0n;

  const pm = new Contract(positionManagerAddress, PM_ABI, signer);
  const dl = deadline ?? _deadline();

  console.log('[rebalance] Step 7b: submitting mint TX…');
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
  console.log('[rebalance] Step 7b done: mint TX submitted, hash=%s', tx.hash);
  console.log('[rebalance] Step 7c: waiting for confirmation…');
  const receipt = await tx.wait();
  console.log('[rebalance] Step 7c done: mint TX confirmed, block=%s', receipt.blockNumber);

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

  const gasCostWei = (receipt.gasUsed ?? 0n) * (receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n);
  return { tokenId, liquidity, amount0, amount1, txHash: receipt.hash, gasCostWei };
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

/** Perform swap if needed and return adjusted amounts + gas. */
async function _swapAndAdjust(signer, ethersLib, ctx) {
  const { desired, position: p, poolState: ps, swapRouterAddress, slippagePct, signerAddress } = ctx;
  if (!desired.needsSwap || desired.swapAmount < _MIN_SWAP_THRESHOLD) return { txHash: null, extra0: 0n, extra1: 0n, gasCostWei: 0n };
  const is0to1 = desired.swapDirection === 'token0to1';
  const result = await swapIfNeeded(signer, ethersLib, { swapRouterAddress, fee: p.fee, amountIn: desired.swapAmount,
    tokenIn: is0to1 ? p.token0 : p.token1, tokenOut: is0to1 ? p.token1 : p.token0, slippagePct, currentPrice: ps.price,
    decimalsIn: is0to1 ? ps.decimals0 : ps.decimals1, decimalsOut: is0to1 ? ps.decimals1 : ps.decimals0,
    isToken0To1: is0to1, recipient: signerAddress });
  return { txHash: result.txHash, gasCostWei: result.gasCostWei || 0n,
    extra0: is0to1 ? 0n : result.amountOut, extra1: is0to1 ? result.amountOut : 0n };
}

/** Verify wallet owns the NFT. Throws on failure. */
async function _verifyOwnership(ethersLib, provider, pmAddr, tokenId, signer) {
  console.log('[rebalance] Step 2: ownerOf NFT #%s…', tokenId);
  const c = new ethersLib.Contract(pmAddr, ['function ownerOf(uint256 tokenId) view returns (address)'], provider);
  let owner; try { owner = await c.ownerOf(tokenId); } catch (e) { throw new Error(`Cannot verify ownership of NFT #${tokenId}: ${e.message}`, { cause: e }); }
  if (owner.toLowerCase() !== signer.toLowerCase()) throw new Error(`Wallet ${signer} does not own NFT #${tokenId} (owner: ${owner})`);
  console.log('[rebalance] Step 2 done: owner=%s signer=%s', owner, signer);
}

/** Remove liquidity or use wallet balances if already drained. */
async function _removeLiquidityStep(signer, ethersLib, provider, opts) {
  const { positionManagerAddress, position, signerAddress } = opts;
  console.log('[rebalance] Step 3: reading on-chain liquidity…');
  const pmRead = new ethersLib.Contract(positionManagerAddress, PM_ABI, provider);
  const onChainLiquidity = (await pmRead.positions(position.tokenId)).liquidity;
  console.log('[rebalance] Step 3 done: onChainLiquidity=%s', String(onChainLiquidity));
  let removed;
  if (onChainLiquidity > 0n) {
    console.log('[rebalance] Step 3a: removeLiquidity…');
    removed = await removeLiquidity(signer, ethersLib, { positionManagerAddress,
      tokenId: position.tokenId, liquidity: onChainLiquidity,
      recipient: signerAddress, token0: position.token0, token1: position.token1 });
  } else {
    console.log('[rebalance] Step 3a: 0 liquidity — using wallet balances');
    removed = await _walletBalances(ethersLib, provider, position.token0, position.token1, signerAddress);
  }
  console.log('[rebalance] Step 3a done: amount0=%s amount1=%s', String(removed.amount0), String(removed.amount1));
  return removed;
}

/** Sum gas costs from multiple rebalance step results. */
function _sumGas(...steps) { return steps.reduce((sum, s) => sum + (s.gasCostWei || 0n), 0n); }

/** Compute new tick range: custom width or preserve existing spread. */
function _computeRange(ps, pos, crw) {
  return crw ? rangeMath.computeNewRange(ps.price, crw / 2, pos.fee, ps.decimals0, ps.decimals1)
    : rangeMath.preserveRange(ps.tick, pos.tickLower, pos.tickUpper, pos.fee, ps.decimals0, ps.decimals1);
}

/** Execute a complete rebalance: remove → swap → mint at new range. */
async function executeRebalance(signer, ethersLib, opts) {
  const { position, factoryAddress, positionManagerAddress, swapRouterAddress, slippagePct, customRangeWidthPct } = opts;
  if (!position.tokenId || !V3_FEE_TIERS.includes(position.fee)) {
    throw new Error('Only V3 NFT positions are supported. V2 positions use a different contract and cannot be rebalanced by this tool.');
  }
  try {
    const txHashes = [], signerAddress = await signer.getAddress(), provider = signer.provider || signer;

    // 1. Get current pool state
    console.log('[rebalance] Step 1: getPoolState…');
    const poolState = await getPoolState(provider, ethersLib, {
      factoryAddress, token0: position.token0, token1: position.token1, fee: position.fee,
    });
    console.log('[rebalance] Step 1 done: tick=%d price=%s', poolState.tick, poolState.price);

    // 2. Verify ownership
    await _verifyOwnership(ethersLib, provider, positionManagerAddress, position.tokenId, signerAddress);

    // 3. Remove liquidity (or use wallet balances if drained)
    const removed = await _removeLiquidityStep(signer, ethersLib, provider, { positionManagerAddress, position, signerAddress });
    if (removed.txHash) txHashes.push(removed.txHash);

    // 4. Compute new range — custom width if specified, else preserve existing tick spread
    const newRange = _computeRange(poolState, position, customRangeWidthPct);

    // 5. Determine desired amounts and whether a swap is needed
    const desired = computeDesiredAmounts(
      { amount0: removed.amount0, amount1: removed.amount1 },
      { currentPrice: poolState.price, lowerPrice: newRange.lowerPrice, upperPrice: newRange.upperPrice },
      { decimals0: poolState.decimals0, decimals1: poolState.decimals1 },
    );

    // 6. Swap if needed — track amounts from collection, not wallet balance
    console.log('[rebalance] Step 6: swap…');
    const swapped = await _swapAndAdjust(signer, ethersLib, {
      desired, position, poolState, swapRouterAddress, slippagePct, signerAddress,
    });
    if (swapped.txHash) txHashes.push(swapped.txHash);
    console.log('[rebalance] Step 6 done: extra0=%s extra1=%s', String(swapped.extra0), String(swapped.extra1));

    // 7. Mint new position with collected + swapped amounts (NOT full wallet balance)
    console.log('[rebalance] Step 7: mint…');
    const mintResult = await mintPosition(signer, ethersLib, {
      positionManagerAddress, token0: position.token0, token1: position.token1, fee: position.fee,
      tickLower: newRange.lowerTick, tickUpper: newRange.upperTick,
      amount0Desired: desired.amount0Desired + swapped.extra0,
      amount1Desired: desired.amount1Desired + swapped.extra1,
      recipient: signerAddress,
    });
    console.log('[rebalance] Step 7 done: newTokenId=%s txHash=%s', String(mintResult.tokenId), mintResult.txHash);
    txHashes.push(mintResult.txHash);

    return { success: true, txHashes, totalGasCostWei: _sumGas(removed, swapped, mintResult),
      oldTokenId: position.tokenId, newTokenId: mintResult.tokenId,
      oldTickLower: position.tickLower, oldTickUpper: position.tickUpper,
      newTickLower: newRange.lowerTick, newTickUpper: newRange.upperTick,
      currentPrice: poolState.price, poolAddress: poolState.poolAddress,
      decimals0: poolState.decimals0, decimals1: poolState.decimals1,
      amount0Collected: removed.amount0, amount1Collected: removed.amount1,
      liquidity: mintResult.liquidity, amount0Minted: mintResult.amount0, amount1Minted: mintResult.amount1 };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
}

/**
 * Enrich a rebalance result with USD values using current token prices.
 * Uses `result.decimals0/decimals1` from the pool state (not hardcoded 18).
 * @param {object}   result   Rebalance result from executeRebalance().
 * @param {Function} priceFn  Async fn(token0, token1) → {price0, price1}.
 * @param {string}   token0   Token0 address.
 * @param {string}   token1   Token1 address.
 */
async function enrichResultUsd(result, priceFn, token0, token1) {
  const { price0, price1 } = await priceFn(token0, token1);
  const d0 = result.decimals0 ?? 18, d1 = result.decimals1 ?? 18;
  const toFloat = (amt, dec) => Number(amt) / (10 ** dec);
  result.token0UsdPrice = price0; result.token1UsdPrice = price1;
  result.exitValueUsd = toFloat(result.amount0Collected, d0) * price0 + toFloat(result.amount1Collected, d1) * price1;
  result.entryValueUsd = toFloat(result.amount0Minted, d0) * price0 + toFloat(result.amount1Minted, d1) * price1;
}

// ── Module exports ───────────────────────────────────────────────────────────

module.exports = {
  enrichResultUsd,
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
