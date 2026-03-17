/**
 * @file src/bot-loop.js
 * @module bot-loop
 * @description
 * Shared reusable bot logic for the 9mm v3 Position Manager.
 * Used by both `server.js` (unified mode) and `bot.js` (headless mode).
 *
 * Exports:
 *   - `resolvePrivateKey(opts)` — resolve a private key from env, key-file, or wallet-manager
 *   - `startBotLoop(opts)` — create provider/signer, detect position, start polling
 *   - `pollCycle(deps)` — single poll iteration
 *   - `appendLog(result)` — write rebalance result to disk log
 *   - `createProviderWithFallback(primary, fallback, ethersLib)` — RPC with fallback
 */

'use strict';

const fs     = require('fs');
const path   = require('path');
const ethers = require('ethers');

const config = require('./config');
const rangeMath = require('./range-math');
const walletManager = require('./wallet-manager');
const { createThrottle } = require('./throttle');
const { loadAndDecrypt } = require('./key-store');
const { detectPositionType } = require('./position-detector');
const { getPoolState, executeRebalance, V3_FEE_TIERS } = require('./rebalancer');
const { createPnlTracker } = require('./pnl-tracker');
const { fetchTokenPriceUsd } = require('./price-fetcher');
const { initHodlBaseline } = require('./hodl-baseline');
const { scanRebalanceHistory } = require('./event-scanner');
const { createCacheStore } = require('./cache-store');
const { createResidualTracker } = require('./residual-tracker');

// ── Log helpers ──────────────────────────────────────────────────────────────

/** JSON-safe replacer that converts BigInt to string. */
function _bigIntReplacer(_key, value) {
  return typeof value === 'bigint' ? value.toString() : value;
}

/**
 * Append a rebalance result to the on-disk JSON log.
 * Creates the file if it does not exist.
 * @param {object} result  The rebalance result object.
 */
function appendLog(result) {
  const logPath = path.resolve(config.LOG_FILE);
  let entries = [];
  try {
    const raw = fs.readFileSync(logPath, 'utf8');
    entries = JSON.parse(raw);
  } catch (_) {
    // File missing or corrupt — start fresh.
  }
  entries.push({ ...result, loggedAt: new Date().toISOString() });
  fs.writeFileSync(logPath, JSON.stringify(entries, _bigIntReplacer, 2));
}

// ── RPC provider with automatic fallback ─────────────────────────────────────

/**
 * Creates a JsonRpcProvider, trying the primary URL first and falling back
 * to the secondary if the primary is unreachable.
 * @param {string} primaryUrl    Primary RPC endpoint.
 * @param {string} fallbackUrl   Fallback RPC endpoint.
 * @param {object} [ethersLib]   Injected ethers library (for testing).
 * @returns {Promise<import('ethers').JsonRpcProvider>}
 */
async function createProviderWithFallback(primaryUrl, fallbackUrl, ethersLib) {
  const lib = ethersLib || ethers;
  try {
    const provider = new lib.JsonRpcProvider(primaryUrl);
    await provider.getBlockNumber();
    console.log(`[bot] RPC:    ${primaryUrl}`);
    return provider;
  } catch (err) {
    console.warn(`[bot] Primary RPC unreachable (${primaryUrl}): ${err.message}`);
    console.log(`[bot] Falling back to ${fallbackUrl}`);
    const provider = new lib.JsonRpcProvider(fallbackUrl);
    await provider.getBlockNumber();
    console.log(`[bot] RPC:    ${fallbackUrl} (fallback)`);
    return provider;
  }
}

// ── Token price + fee helpers ────────────────────────────────────────────────

/** Wrapped PLS address for gas cost USD conversion. */
const _WPLS = '0xA1077a294dDE1B09bB078844df40758a5D0f9a27';

/** ERC-20 balanceOf ABI for wallet residual cap check. */
const _ERC20_BAL_ABI = ['function balanceOf(address) view returns (uint256)'];

/** ABI for PositionManager: positions view + collect for static call. */
const _PM_ABI = [
  'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
  'function collect((uint256 tokenId, address recipient, uint128 amount0Max, uint128 amount1Max)) external returns (uint256 amount0, uint256 amount1)',
];

/** Maximum uint128 for collect() simulation. */
const _MAX_UINT128 = 2n ** 128n - 1n;

/**
 * Fetch USD prices for both tokens in a position.
 * @param {string} token0  Token0 address.
 * @param {string} token1  Token1 address.
 * @returns {Promise<{price0: number, price1: number}>}
 */
async function _fetchTokenPrices(token0, token1) {
  const [price0, price1] = await Promise.all([
    fetchTokenPriceUsd(token0, { dextoolsApiKey: config.DEXTOOLS_API_KEY }),
    fetchTokenPriceUsd(token1, { dextoolsApiKey: config.DEXTOOLS_API_KEY }),
  ]);
  return { price0, price1 };
}

/**
 * Read uncollected fees via static collect(MAX_UINT128) call.
 * Falls back to positions() tokensOwed if the static call fails.
 * @param {object} provider  @param {object} ethersLib
 * @param {bigint|string} tokenId  @param {object} [signer]
 * @returns {Promise<{tokensOwed0: bigint, tokensOwed1: bigint}>}
 */
async function _readUnclaimedFees(provider, ethersLib, tokenId, signer) {
  if (signer) {
    try {
      const pm = new ethersLib.Contract(config.POSITION_MANAGER, _PM_ABI, signer);
      const r = await pm.collect.staticCall({ tokenId, recipient: await signer.getAddress(),
        amount0Max: _MAX_UINT128, amount1Max: _MAX_UINT128 });
      return { tokensOwed0: r.amount0, tokensOwed1: r.amount1 };
    } catch { /* fall through to positions() fallback */ }
  }
  try {
    const pm = new ethersLib.Contract(config.POSITION_MANAGER, _PM_ABI, provider);
    const d = await pm.positions(tokenId);
    return { tokensOwed0: d.tokensOwed0, tokensOwed1: d.tokensOwed1 };
  } catch { return { tokensOwed0: 0n, tokensOwed1: 0n }; }
}

/** Compute per-token pool share percentages and attach to posStats. */
async function _addPoolShare(posStats, amounts, position, poolState, ethersLib, provider) {
  try {
    const { Contract } = ethersLib;
    const abi = ['function balanceOf(address) view returns (uint256)'];
    const [pool0, pool1] = await Promise.all([
      new Contract(position.token0, abi, provider).balanceOf(poolState.poolAddress),
      new Contract(position.token1, abi, provider).balanceOf(poolState.poolAddress),
    ]);
    const p0f = _toFloat(pool0, poolState.decimals0), p1f = _toFloat(pool1, poolState.decimals1);
    posStats.poolShare0Pct = p0f > 0 ? (amounts.amount0 / p0f) * 100 : 0;
    posStats.poolShare1Pct = p1f > 0 ? (amounts.amount1 / p1f) * 100 : 0;
  } catch { /* non-critical — pool share is informational only */ }
}

/** Calculate the USD value of a V3 position from on-chain amounts. */
function _positionValueUsd(position, poolState, price0, price1) {
  const amounts = rangeMath.positionAmounts(position.liquidity, poolState.tick,
    position.tickLower, position.tickUpper, poolState.decimals0, poolState.decimals1);
  return amounts.amount0 * price0 + amounts.amount1 * price1;
}

/** Convert a BigInt token amount to a float given its decimals. */
function _toFloat(amount, decimals) {
  return Number(amount) / Math.pow(10, decimals);
}

// ── P&L epoch management ────────────────────────────────────────────────────

/** Compute actual gas cost in USD from total PLS spent (in wei). */
async function _actualGasCostUsd(gasCostWei) {
  try {
    const plsPrice = await fetchTokenPriceUsd(_WPLS, { dextoolsApiKey: config.DEXTOOLS_API_KEY });
    return (Number(gasCostWei) / 1e18) * plsPrice;
  } catch { return 0; }
}

/** Estimate gas cost in USD for a rebalance (≈ 800k gas). Fallback only. */
async function _estimateGasCostUsd(provider) {
  try {
    const feeData = await provider.getFeeData();
    const costWei = (feeData.gasPrice ?? 0n) * 800_000n; // typical rebalance gas
    const plsPrice = await fetchTokenPriceUsd(_WPLS, { dextoolsApiKey: config.DEXTOOLS_API_KEY });
    return (Number(costWei) / 1e18) * plsPrice;
  } catch { return 0; }
}

/** Close the current P&L epoch after a rebalance and open a new one. */
async function _closePnlEpoch(deps, result) {
  const tracker = deps._pnlTracker;
  if (!tracker || tracker.epochCount() === 0) return;
  try {
    let price0 = result.token0UsdPrice, price1 = result.token1UsdPrice;
    if (price0 === undefined || price1 === undefined) {
      const p = await _fetchTokenPrices(deps.position.token0, deps.position.token1);
      price0 = p.price0;  price1 = p.price1;
    }
    const exitValue = result.exitValueUsd || (_toFloat(result.amount0Collected, 18) * price0 + _toFloat(result.amount1Collected, 18) * price1);
    const gasCost = result.totalGasCostWei ? await _actualGasCostUsd(result.totalGasCostWei) : await _estimateGasCostUsd(deps.provider);
    tracker.closeEpoch({ exitValue, gasCost, token0UsdPrice: price0, token1UsdPrice: price1 });
    if (deps.updateBotState) deps.updateBotState({ pnlEpochs: tracker.serialize() });
    if (deps._addCollectedFees && deps._lastUnclaimedFeesUsd) {
      deps._addCollectedFees(deps._lastUnclaimedFeesUsd); deps._lastUnclaimedFeesUsd = 0;
    }
    const entryValue = result.entryValueUsd || (_toFloat(result.amount0Minted, 18) * price0 + _toFloat(result.amount1Minted, 18) * price1);
    tracker.openEpoch({ entryValue: entryValue || exitValue, entryPrice: result.currentPrice,
      lowerPrice: rangeMath.tickToPrice(result.newTickLower, 18, 18),
      upperPrice: rangeMath.tickToPrice(result.newTickUpper, 18, 18),
      token0UsdPrice: price0, token1UsdPrice: price1 });
  } catch (err) { console.warn('[bot] P&L epoch close error:', err.message); }
}

// ── Event history scan ───────────────────────────────────────────────────────

/** Resolve pool address and scan on-chain rebalance history (fire-and-forget). */
async function _scanHistory(provider, ethersLib, address, position, cache, events, updateState, throttle) {
  try {
    updateState({ rebalanceScanComplete: false });
    const poolState = await getPoolState(provider, ethersLib, {
      factoryAddress: config.FACTORY,
      token0: position.token0, token1: position.token1, fee: position.fee,
    });
    console.log(`[bot] Scanning rebalance history for ${address} (pool ${poolState.poolAddress})`);
    const found = await scanRebalanceHistory(provider, ethersLib, {
      walletAddress: address,
      positionManagerAddress: config.POSITION_MANAGER,
      factoryAddress: config.FACTORY,
      poolAddress: poolState.poolAddress || null,
      maxYears: 5,
      cache,
    });
    events.push(...found);
    console.log(`[bot] Found ${found.length} historical rebalance events`);
    if (throttle && found.length > 0) {
      const cutoff = Math.floor((throttle.getState().dailyResetAt - 86_400_000) / 1000);
      const recent = found.filter((e) => e.timestamp >= cutoff).length;
      if (recent > 0) throttle.rehydrate(recent);
    }
    updateState({ rebalanceEvents: [...events], rebalanceScanComplete: true,
      ...(throttle ? { throttleState: throttle.getState() } : {}) });
  } catch (err) {
    console.warn('[bot] Event scan error:', err.message);
    updateState({ rebalanceScanComplete: true });
  }
}

/** Record residual delta and persist. */
function _recordResidual(deps, result) {
  if (!deps._residualTracker || !result.poolAddress) return;
  deps._residualTracker.addDelta(result.poolAddress,
    result.amount0Collected - result.amount0Minted, result.amount1Collected - result.amount1Minted);
  if (deps.updateBotState) deps.updateBotState({ residuals: deps._residualTracker.serialize() });
}

// ── Rebalance execution helper ───────────────────────────────────────────────

/** Build a serialisable activePosition snapshot from a position object. */
function _activePosSummary(p) {
  return { tokenId: String(p.tokenId), token0: p.token0, token1: p.token1,
    fee: p.fee, tickLower: p.tickLower, tickUpper: p.tickUpper,
    liquidity: String(p.liquidity || 0) };
}

/** Notify the dashboard of a successful rebalance. */
function _notifyRebalance(deps, throttle, position, events) {
  deps.updateBotState({ rebalanceCount: (deps._rebalanceCount || 0) + 1,
    lastRebalanceAt: new Date().toISOString(), throttleState: throttle.getState(),
    rebalanceEvents: events ? [...events] : undefined,
    activePosition: _activePosSummary(position) });
}

async function _executeAndRecord(deps, ethersLib) {
  const { signer, position, throttle, updateBotState } = deps;
  console.log('[bot] Position out of range — rebalancing…');
  const state = deps._botState || {};
  const result = await executeRebalance(signer, ethersLib, { position,
    factoryAddress: config.FACTORY, positionManagerAddress: config.POSITION_MANAGER,
    swapRouterAddress: config.SWAP_ROUTER, rangeWidthPct: state.rangeWidthPct ?? config.RANGE_WIDTH_PCT,
    slippagePct: state.slippagePct ?? config.SLIPPAGE_PCT });
  if (result.success) {
    throttle.recordRebalance();
    try { // Enrich log with USD values before writing
      const { price0, price1 } = await _fetchTokenPrices(deps.position.token0, deps.position.token1);
      result.token0UsdPrice = price0;  result.token1UsdPrice = price1;
      result.exitValueUsd  = _toFloat(result.amount0Collected, 18) * price0 + _toFloat(result.amount1Collected, 18) * price1;
      result.entryValueUsd = _toFloat(result.amount0Minted, 18) * price0 + _toFloat(result.amount1Minted, 18) * price1;
    } catch (_) { /* prices unavailable */ }
    _recordResidual(deps, result);
    appendLog(result);
    console.log('[bot] Rebalance OK — new tokenId:', String(result.newTokenId));
    await _closePnlEpoch(deps, result);
    if (result.newTokenId && result.newTokenId !== 0n) position.tokenId = result.newTokenId;
    position.tickLower = result.newTickLower;  position.tickUpper = result.newTickUpper;
    if (result.liquidity !== undefined) position.liquidity = result.liquidity;
    const events = deps._rebalanceEvents; // Append to runtime rebalance events list
    if (events) {
      const ts = Math.floor(Date.now() / 1000);
      events.push({ index: events.length + 1, timestamp: ts, dateStr: new Date(ts * 1000).toISOString(),
        oldTokenId: String(result.oldTokenId || '?'), newTokenId: String(result.newTokenId || '?'),
        txHash: (result.txHashes && result.txHashes[result.txHashes.length - 1]) || '', blockNumber: 0 });
    }

    if (updateBotState) _notifyRebalance(deps, throttle, position, events);
  } else {
    console.error('[bot] Rebalance failed:', result.error);
  }

  return { rebalanced: result.success, error: result.error };
}

/**
 * Override the pnl snapshot with real on-chain values and compute HODL-based IL.
 * @param {object} snap      PnL snapshot to mutate.
 * @param {object} deps      Poll cycle dependencies.
 * @param {object} position  Active V3 position.
 * @param {object} poolState Current pool state.
 * @param {number} price0    Current token0 USD price.
 * @param {number} price1    Current token1 USD price.
 * @param {number} feesUsd   Unclaimed fees in USD.
 */
function _overridePnlWithRealValues(snap, deps, position, poolState, price0, price1, feesUsd, residualUsd) {
  const realValue = _positionValueUsd(position, poolState, price0, price1);
  const priorFees = deps._collectedFeesUsd || 0;
  const lifetimeFees = priorFees + feesUsd;
  snap.residualValueUsd = residualUsd || 0;
  snap.currentValue = realValue + feesUsd + snap.residualValueUsd;
  snap.totalFees = lifetimeFees;
  const entryVal = snap.liveEpoch
    ? snap.liveEpoch.entryValue : snap.initialDeposit;
  snap.priceChangePnl = realValue - entryVal;
  snap.cumulativePnl = snap.priceChangePnl + lifetimeFees - snap.totalGas;
  snap.netReturn = lifetimeFees - snap.totalGas + snap.priceChangePnl;
  // Real IL: LP value vs HODL benchmark (negative = loss vs holding)
  const bl = deps._botState?.hodlBaseline;
  const t0E = bl?.token0UsdPrice || snap.liveEpoch?.token0UsdEntry;
  const t1E = bl?.token1UsdPrice || snap.liveEpoch?.token1UsdEntry;
  const hodlEntry = bl?.entryValue || entryVal;
  if (t0E > 0 && t1E > 0) {
    const hodlValue = (hodlEntry / 2 / t0E) * price0
                    + (hodlEntry / 2 / t1E) * price1;
    snap.totalIL = realValue - hodlValue;
    if (!bl) {
      snap._setHodlBaseline = {
        entryValue: entryVal, token0UsdPrice: t0E, token1UsdPrice: t1E,
      };
    }
  }
}

/** Compute the USD value of wallet residuals, capped to actual balances. */
async function _residualValueUsd(deps, ethersLib, provider, position, poolState, price0, price1) {
  const rt = deps._residualTracker;
  if (!rt || !poolState.poolAddress) return 0;
  try {
    const addr = await deps.signer.getAddress();
    const t0 = new ethersLib.Contract(position.token0, _ERC20_BAL_ABI, provider);
    const t1 = new ethersLib.Contract(position.token1, _ERC20_BAL_ABI, provider);
    const [wb0, wb1] = await Promise.all([t0.balanceOf(addr), t1.balanceOf(addr)]);
    return rt.cappedValueUsd(poolState.poolAddress, wb0, wb1, price0, price1, poolState.decimals0, poolState.decimals1);
  } catch (_) { return 0; }
}

// ── Poll cycle ───────────────────────────────────────────────────────────────

/**
 * Check if estimated gas cost exceeds 0.5% of position value.
 * @param {import('ethers').JsonRpcProvider} provider
 * @param {object} position  Active V3 NFT position data.
 * @param {object} poolState Pool state from getPoolState().
 * @returns {Promise<boolean>} True if gas is too expensive and rebalance should be deferred.
 */
async function _isGasTooHigh(provider, position, poolState) {
  try {
    const gasCost = await _estimateGasCostUsd(provider);
    const prices = await _fetchTokenPrices(position.token0, position.token1);
    const posValue = _positionValueUsd(position, poolState, prices.price0, prices.price1);
    if (posValue > 0 && gasCost > 0 && gasCost / posValue > 0.005) {
      console.warn(`[bot] Gas too high: $${gasCost.toFixed(4)} is ${(gasCost / posValue * 100).toFixed(2)}% of position ($${posValue.toFixed(2)}) — deferring`);
      return true;
    }
  } catch (_) { /* proceed if gas check fails */ }
  return false;
}

/**
 * Single poll iteration.  Checks position range, throttle, and rebalances
 * if allowed and needed.
 *
 * @param {object} deps Injected dependencies.
 * @param {import('ethers').Wallet} deps.signer
 * @param {import('ethers').JsonRpcProvider} deps.provider
 * @param {object} deps.position  Active V3 NFT position data.
 * @param {object} deps.throttle  Throttle handle from createThrottle().
 * @param {boolean} [deps.dryRun] If true, log but do not execute.
 * @param {Function} deps.updateBotState  State update callback.
 * @param {object} deps._botState  Runtime-adjustable bot params.
 * @returns {Promise<{rebalanced: boolean, error?: string}>}
 */
async function pollCycle(deps) {
  const { provider, position, throttle, dryRun, updateBotState } = deps;
  const ethersLib = deps._ethersLib || ethers;

  throttle.tick();

  // 1. Read pool state
  let poolState;
  try {
    poolState = await getPoolState(provider, ethersLib, {
      factoryAddress: config.FACTORY, token0: position.token0,
      token1: position.token1, fee: position.fee,
    });
  } catch (err) {
    console.error('[bot] Pool state error:', err.message);
    return { rebalanced: false, error: err.message };
  }

  const lowerPrice = rangeMath.tickToPrice(position.tickLower, poolState.decimals0, poolState.decimals1);
  const upperPrice = rangeMath.tickToPrice(position.tickUpper, poolState.decimals0, poolState.decimals1);
  const ratio = rangeMath.compositionRatio(poolState.price, lowerPrice, upperPrice);

  // Fetch USD prices + uncollected fees for P&L tracking
  const pnlTracker = deps._pnlTracker;
  let pnlSnapshot = null;
  if (pnlTracker) {
    try {
      const { price0, price1 } = await _fetchTokenPrices(position.token0, position.token1);
      const fees = await _readUnclaimedFees(provider, ethersLib, position.tokenId, deps.signer);
      const feesUsd = _toFloat(fees.tokensOwed0, poolState.decimals0) * price0
                    + _toFloat(fees.tokensOwed1, poolState.decimals1) * price1;
      deps._lastUnclaimedFeesUsd = feesUsd;
      const residualUsd = await _residualValueUsd(deps, ethersLib, provider, position, poolState, price0, price1);
      pnlTracker.updateLiveEpoch({ currentPrice: poolState.price, feesAccrued: feesUsd });
      pnlSnapshot = pnlTracker.snapshot(poolState.price);
      _overridePnlWithRealValues(pnlSnapshot, deps, position, poolState, price0, price1, feesUsd, residualUsd);
    } catch (err) {
      console.warn('[bot] P&L update error:', err.message);
    }
  }

  if (updateBotState) {
    const amounts = rangeMath.positionAmounts(position.liquidity, poolState.tick,
      position.tickLower, position.tickUpper, poolState.decimals0, poolState.decimals1);
    const posStats = { compositionRatio: ratio,
      balance0: amounts.amount0.toFixed(6), balance1: amounts.amount1.toFixed(6) };
    await _addPoolShare(posStats, amounts, position, poolState, ethersLib, provider);
    const stateUpdate = { poolState: { price: poolState.price, tick: poolState.tick }, positionStats: posStats };
    if (pnlSnapshot) stateUpdate.pnlSnapshot = pnlSnapshot;
    updateBotState(stateUpdate);
  }

  // 2. Skip rebalance for closed positions (liquidity=0) — still publish stats above
  if (BigInt(position.liquidity) === 0n) {
    console.log('[bot] Position closed (0 liquidity) — skipping rebalance');
    return { rebalanced: false };
  }

  // 3. Check if in range (V3: upper tick is exclusive); skip on forced rebalance
  const forced = deps._botState?.forceRebalance;
  const inRange = poolState.tick >= position.tickLower && poolState.tick < position.tickUpper;
  if (inRange && !forced) return { rebalanced: false, inRange: true };

  // 4. Throttle check (skip on forced rebalance)
  if (!forced) {
    const can = throttle.canRebalance();
    if (!can.allowed) {
      console.log(`[bot] OOR but throttled (${can.reason}), wait ${Math.ceil(can.msUntilAllowed / 1000)}s`);
      if (updateBotState) updateBotState({ throttleState: throttle.getState() });
      return { rebalanced: false };
    }
  }

  // 5. Dry-run: log and skip
  if (dryRun) {
    console.log(`[bot] DRY RUN — OOR, price=${poolState.price} tick=${poolState.tick} range=[${position.tickLower},${position.tickUpper}]`);
    return { rebalanced: false };
  }

  // 6. Gas cost check — defer if gas > 0.5% of position value
  if (await _isGasTooHigh(provider, position, poolState)) return { rebalanced: false, gasDeferred: true };

  // 7. Execute rebalance
  return _executeAndRecord(deps, ethersLib);
}

// ── Private key resolution ───────────────────────────────────────────────────

/**
 * Resolve a private key from available sources, in priority order:
 *   1. config.PRIVATE_KEY (env var)
 *   2. config.KEY_FILE + password → loadAndDecrypt()
 *   3. walletManager.hasWallet() + password → walletManager.revealWallet()
 *   4. Returns null if none available.
 *
 * @param {object} opts
 * @param {Function|null} [opts.askPassword]  Interactive password prompt (null = non-interactive).
 * @returns {Promise<string|null>}  Hex private key, or null.
 */
async function resolvePrivateKey(opts = {}) {
  const { askPassword } = opts;

  // 1. PRIVATE_KEY env var
  if (config.PRIVATE_KEY) return config.PRIVATE_KEY;

  // 2. Encrypted key file
  if (config.KEY_FILE) {
    let password = config.KEY_PASSWORD;
    if (!password && askPassword) {
      password = await askPassword('[bot] Enter key-file password: ');
    }
    if (password) {
      console.log(`[bot] Loading private key from encrypted file: ${config.KEY_FILE}`);
      return loadAndDecrypt(password, config.KEY_FILE);
    }
    return null;
  }

  // 3. Wallet manager (dashboard-imported wallet)
  if (walletManager.hasWallet()) {
    let password = config.WALLET_PASSWORD;
    if (!password && askPassword) {
      password = await askPassword('[bot] Enter wallet password: ');
    }
    if (password) {
      console.log('[bot] Loading private key from imported wallet');
      const secrets = await walletManager.revealWallet(password);
      return secrets.privateKey;
    }
    return null;
  }

  return null;
}

// ── Bot loop lifecycle ───────────────────────────────────────────────────────

/**
/** Initialize or restore the P&L tracker with epoch data. */
function _initPnlTracker(ev, botState, poolState, lowerPrice, upperPrice, price0, price1) {
  const tracker = createPnlTracker({ initialDeposit: ev });
  if (botState.pnlEpochs) {
    tracker.restore(botState.pnlEpochs);
    console.log('[bot] Restored P&L epochs from saved config');
  } else {
    tracker.openEpoch({ entryValue: ev, entryPrice: poolState.price,
      lowerPrice, upperPrice, token0UsdPrice: price0, token1UsdPrice: price1 });
  }
  console.log(`[bot] P&L tracker initialized (T0=$${price0.toFixed(6)}, T1=$${price1.toFixed(6)})`);
  return tracker;
}

/**
 * Detect and select the target NFT position from on-chain data.
 * @param {object} provider   ethers provider.
 * @param {string} address    Wallet address.
 * @param {string} [targetId] Specific NFT token ID to select.
 * @returns {Promise<object>}  Selected position data.
 */
async function _detectPosition(provider, address, targetId) {
  const detection = await detectPositionType(provider, {
    walletAddress: address, positionManagerAddress: config.POSITION_MANAGER,
    tokenId: targetId, candidateAddress: config.ERC20_POSITION_ADDRESS || undefined,
  });
  if (detection.type !== 'nft' || !detection.nftPositions?.length) {
    throw new Error('No V3 NFT position found. This tool only supports V3 positions.');
  }
  const valid = detection.nftPositions.filter((p) => V3_FEE_TIERS.includes(p.fee));
  if (!valid.length) throw new Error(`No positions with supported fee tiers. V3 tiers: ${V3_FEE_TIERS.join(', ')}`);
  if (targetId) return valid.find((p) => String(p.tokenId) === String(targetId)) || valid[0];
  return valid.reduce((best, p) => BigInt(p.liquidity || 0n) > BigInt(best.liquidity || 0n) ? p : best);
}

/**
 * Start the bot polling loop.  Creates provider, signer, detects position,
 * and begins periodic polling.
 *
 * @param {object} opts
 * @param {string}   opts.privateKey       Hex private key.
 * @param {boolean}  [opts.dryRun]         Dry-run mode (default: config.DRY_RUN).
 * @param {Function} opts.updateBotState   Callback to update shared bot state.
 * @param {object}   opts.botState         Shared bot state object for runtime params.
 * @param {object}   [opts.ethersLib]      Injected ethers (for testing).
 * @param {string}   [opts.positionId]     NFT token ID to manage (overrides config).
 * @returns {Promise<{ stop: Function }>}  Handle with stop() method.
 */
async function startBotLoop(opts) {
  const { privateKey, updateBotState, botState } = opts;
  const dryRun    = opts.dryRun ?? config.DRY_RUN;
  const ethersLib = opts.ethersLib || ethers;

  if (dryRun) console.log('\n  ┌──────────────────────────────────────────────┐\n  │  DRY RUN MODE — no transactions will be sent │\n  └──────────────────────────────────────────────┘\n');
  const provider = await createProviderWithFallback(config.RPC_URL, config.RPC_URL_FALLBACK, ethersLib);
  let signer, address;
  if (dryRun && !privateKey) {
    const randomWallet = ethersLib.Wallet.createRandom();
    signer = randomWallet.connect(provider);
    address = await randomWallet.getAddress();
    console.log(`[bot] DRY RUN — using random address: ${address}`);
  } else {
    signer  = new ethersLib.Wallet(privateKey, provider);
    address = await signer.getAddress();
  }

  console.log(`[bot] Wallet: ${address}`);
  const position = await _detectPosition(provider, address, opts.positionId || config.POSITION_ID || undefined);
  console.log(`[bot] Managing NFT #${position.tokenId} (${position.token0}/${position.token1} fee=${position.fee})`);

  // Initialize P&L tracker with token prices
  let pnlTracker = null;
  try {
    const { price0, price1 } = await _fetchTokenPrices(position.token0, position.token1);
    if (price0 > 0 || price1 > 0) {
      const poolState = await getPoolState(provider, ethersLib, {
        factoryAddress: config.FACTORY,
        token0: position.token0, token1: position.token1, fee: position.fee,
      });
      const lowerPrice = rangeMath.tickToPrice(position.tickLower, poolState.decimals0, poolState.decimals1);
      const upperPrice = rangeMath.tickToPrice(position.tickUpper, poolState.decimals0, poolState.decimals1);
      const entryValue = _positionValueUsd(position, poolState, price0, price1);
      const ev = entryValue || 1;
      pnlTracker = _initPnlTracker(ev, botState, poolState, lowerPrice, upperPrice, price0, price1);
    } else {
      console.warn('[bot] Could not fetch token prices — P&L tracking disabled');
    }
  } catch (err) {
    console.warn('[bot] P&L tracker init error:', err.message);
  }

  const residualTracker = createResidualTracker();
  if (botState.residuals) residualTracker.deserialize(botState.residuals);
  initHodlBaseline(provider, ethersLib, position, botState, updateBotState)
    .catch((err) => console.warn('[bot] HODL baseline background error:', err.message));
  const throttle = createThrottle({ minIntervalMs: config.MIN_REBALANCE_INTERVAL_MIN * 60_000, dailyMax: config.MAX_REBALANCES_PER_DAY });
  const rebalanceEvents = [];
  _scanHistory(provider, ethersLib, address, position,
    createCacheStore({ filePath: path.join(process.cwd(), 'tmp', 'event-cache.json') }),
    rebalanceEvents, updateBotState, throttle);

  updateBotState({ running: true, dryRun, startedAt: new Date().toISOString(),
    throttleState: throttle.getState(), rebalanceEvents,
    activePosition: _activePosSummary(position) });

  let collectedFeesUsd = 0, rebalanceCount = 0, firstFailureAt = null, polling = false;
  const baseIntervalMs = config.CHECK_INTERVAL_SEC * 1000, GAS_DEFER_MS = 3600_000;
  let currentIntervalMs = baseIntervalMs, timer = null;
  function _scheduleNext() { timer = setTimeout(poll, currentIntervalMs); }

  const poll = async () => {
    if (polling) return;
    polling = true;
    try {
      const result = await pollCycle({
        signer, provider, position, throttle, dryRun, updateBotState,
        _rebalanceCount: rebalanceCount, _botState: botState, _pnlTracker: pnlTracker,
        _rebalanceEvents: rebalanceEvents, _collectedFeesUsd: collectedFeesUsd,
        _addCollectedFees: (usd) => { collectedFeesUsd += usd; },
        _residualTracker: residualTracker,
      });
      if (result.rebalanced) {
        rebalanceCount++;
        firstFailureAt = null;
        currentIntervalMs = baseIntervalMs;
        updateBotState({ rebalanceError: null, rebalancePaused: false, forceRebalance: false });
      } else if (result.gasDeferred) {
        currentIntervalMs = GAS_DEFER_MS;
        console.log(`[bot] Next retry in ${GAS_DEFER_MS / 60_000}m (gas deferral)`);
      } else if (result.error) {
        if (!firstFailureAt) firstFailureAt = Date.now();
        const elapsed = Math.round((Date.now() - firstFailureAt) / 60_000);
        console.error(`[bot] Rebalance failed: ${result.error} (${elapsed}m of failures)`);
        updateBotState({ rebalanceError: result.error, rebalancePaused: true });
      } else if (firstFailureAt) {
        const oorMin = Math.round((Date.now() - firstFailureAt) / 60_000);
        console.log(`[bot] Price returned to range after ~${oorMin}m of failures — clearing`);
        firstFailureAt = null;  currentIntervalMs = baseIntervalMs;
        updateBotState({ rebalanceError: null, rebalancePaused: false, oorRecoveredMin: oorMin });
      }
    } catch (err) {
      if (!firstFailureAt) firstFailureAt = Date.now();
      const elapsed = Math.round((Date.now() - firstFailureAt) / 60_000);
      console.error(`[bot] Poll error: ${err.message} (${elapsed}m of failures)`);
    } finally { polling = false; _scheduleNext(); }
  };

  await poll();
  console.log(`[bot] Polling every ${config.CHECK_INTERVAL_SEC}s`);
  let _stopped = false;
  return {
    stop() {
      if (_stopped) return Promise.resolve();
      _stopped = true; clearTimeout(timer);
      updateBotState({ running: false });
      console.log('[bot] Bot loop stopped');
      if (!polling) return Promise.resolve();
      return new Promise((resolve) => {
        const check = setInterval(() => { if (!polling) { clearInterval(check); resolve(); } }, 50);
      });
    },
  };
}

module.exports = {
  pollCycle,
  appendLog,
  createProviderWithFallback,
  resolvePrivateKey,
  startBotLoop,
  _overridePnlWithRealValues,
};
