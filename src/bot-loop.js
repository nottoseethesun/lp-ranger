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
const { PM_ABI } = require('./pm-abi');
const rangeMath = require('./range-math');
const walletManager = require('./wallet-manager');
const { createThrottle } = require('./throttle');
const { loadAndDecrypt } = require('./key-store');
const { detectPositionType } = require('./position-detector');
const { getPoolState, executeRebalance, enrichResultUsd, V3_FEE_TIERS } = require('./rebalancer');
const { createPnlTracker } = require('./pnl-tracker');
const { computeHodlIL } = require('./il-calculator');
const { fetchTokenPriceUsd } = require('./price-fetcher');
const { initHodlBaseline } = require('./hodl-baseline');
const { scanRebalanceHistory } = require('./event-scanner');
const { createCacheStore } = require('./cache-store');
const { createResidualTracker } = require('./residual-tracker');
const { reconstructEpochs } = require('./epoch-reconstructor');

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
 * Patch `provider.getFeeData()` to guarantee a non-zero gas price.
 * PulseChain supports EIP-1559 but ethers.js v6's `getFeeData()` intermittently
 * returns null/0 for all fee fields.  When this happens, ethers submits TXs with
 * 0 gas price — they sit pending forever or get mined as failed.  This patch
 * intercepts the call and falls back to raw `eth_gasPrice` RPC when needed.
 * @param {import('ethers').JsonRpcProvider} provider
 */
function _patchFeeData(provider) {
  if (typeof provider.getFeeData !== 'function') return;
  const _orig = provider.getFeeData.bind(provider);
  provider.getFeeData = async () => {
    const fd = await _orig();
    console.log('[bot] feeData: gasPrice=%s maxFee=%s maxPriority=%s', String(fd.gasPrice), String(fd.maxFeePerGas), String(fd.maxPriorityFeePerGas));
    if ((fd.gasPrice && fd.gasPrice > 0n) || (fd.maxFeePerGas && fd.maxFeePerGas > 0n)) return fd;
    console.warn('[bot] getFeeData returned zero/null — falling back to eth_gasPrice RPC');
    try {
      const gp = BigInt(await provider.send('eth_gasPrice', []));
      if (gp > 0n) { console.log('[bot] eth_gasPrice fallback: %s', String(gp)); return new ethers.FeeData(gp, null, null); }
    } catch (e) { console.warn('[bot] eth_gasPrice fallback failed:', e.message); }
    return fd;
  };
}

/**
 * Creates a JsonRpcProvider, trying the primary URL first and falling back
 * to the secondary if the primary is unreachable.  The returned provider's
 * `getFeeData()` is patched to guarantee non-zero gas pricing on PulseChain.
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
    _patchFeeData(provider);
    return provider;
  } catch (err) {
    console.warn(`[bot] Primary RPC unreachable (${primaryUrl}): ${err.message}`);
    console.log(`[bot] Falling back to ${fallbackUrl}`);
    const provider = new lib.JsonRpcProvider(fallbackUrl);
    await provider.getBlockNumber();
    console.log(`[bot] RPC:    ${fallbackUrl} (fallback)`);
    _patchFeeData(provider);
    return provider;
  }
}

/** Wrapped PLS address for gas cost USD conversion. */
const _WPLS = '0xA1077a294dDE1B09bB078844df40758a5D0f9a27';
/** ERC-20 balanceOf ABI for wallet residual cap check. */
const _ERC20_BAL_ABI = ['function balanceOf(address) view returns (uint256)'];
const _MAX_UINT128 = 2n ** 128n - 1n; // max uint128 for collect() simulation

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
  if (signer) { try {
    const pm = new ethersLib.Contract(config.POSITION_MANAGER, PM_ABI, signer);
    const r = await pm.collect.staticCall({ tokenId, recipient: await signer.getAddress(), amount0Max: _MAX_UINT128, amount1Max: _MAX_UINT128 });
    return { tokensOwed0: r.amount0, tokensOwed1: r.amount1 };
  } catch (e) { console.warn('[bot] collect.staticCall failed for #%s: %s', String(tokenId), e.message); } }
  try { const d = await new ethersLib.Contract(config.POSITION_MANAGER, PM_ABI, provider).positions(tokenId); return { tokensOwed0: d.tokensOwed0, tokensOwed1: d.tokensOwed1 };
  } catch { return { tokensOwed0: 0n, tokensOwed1: 0n }; }
}

/** Compute per-token pool share percentages and attach to posStats. */
async function _addPoolShare(posStats, amounts, position, poolState, ethersLib, provider) {
  try {
    const [pool0, pool1] = await Promise.all([
      new ethersLib.Contract(position.token0, _ERC20_BAL_ABI, provider).balanceOf(poolState.poolAddress),
      new ethersLib.Contract(position.token1, _ERC20_BAL_ABI, provider).balanceOf(poolState.poolAddress)]);
    const p0f = _toFloat(pool0, poolState.decimals0), p1f = _toFloat(pool1, poolState.decimals1);
    posStats.poolShare0Pct = p0f > 0 ? (amounts.amount0 / p0f) * 100 : 0;
    posStats.poolShare1Pct = p1f > 0 ? (amounts.amount1 / p1f) * 100 : 0;
  } catch { /* non-critical — pool share is informational only */ }
}
/** Calculate the USD value of a V3 position from on-chain amounts. */
function _positionValueUsd(p, ps, pr0, pr1) {
  const a = rangeMath.positionAmounts(p.liquidity, ps.tick, p.tickLower, p.tickUpper, ps.decimals0, ps.decimals1); return a.amount0 * pr0 + a.amount1 * pr1; }
/** Convert a BigInt token amount to a float given its decimals. */
function _toFloat(amount, decimals) { return Number(amount) / Math.pow(10, decimals); }

/** Compute actual gas cost in USD from total PLS spent (in wei). */
async function _actualGasCostUsd(gasCostWei) { try { const p = await fetchTokenPriceUsd(_WPLS, { dextoolsApiKey: config.DEXTOOLS_API_KEY }); return (Number(gasCostWei) / 1e18) * p; } catch { return 0; } }
/** Estimate gas cost in USD for a rebalance (~800k gas). Fallback only. */
async function _estimateGasCostUsd(provider) { try { const f = await provider.getFeeData(); const c = (f.gasPrice ?? 0n) * 800_000n; const p = await fetchTokenPriceUsd(_WPLS, { dextoolsApiKey: config.DEXTOOLS_API_KEY }); return (Number(c) / 1e18) * p; } catch { return 0; } }

/** Close the current P&L epoch after a rebalance and open a new one. */
async function _closePnlEpoch(deps, result) {
  const tracker = deps._pnlTracker; if (!tracker || tracker.epochCount() === 0) return;
  try {
    let price0 = result.token0UsdPrice, price1 = result.token1UsdPrice;
    if (price0 === undefined || price1 === undefined) { const p = await _fetchTokenPrices(deps.position.token0, deps.position.token1); price0 = p.price0; price1 = p.price1; }
    const rd0 = result.decimals0 ?? 18, rd1 = result.decimals1 ?? 18;
    const exitVal = result.exitValueUsd || (_toFloat(result.amount0Collected, rd0) * price0 + _toFloat(result.amount1Collected, rd1) * price1);
    const gasCost = result.totalGasCostWei ? await _actualGasCostUsd(result.totalGasCostWei) : await _estimateGasCostUsd(deps.provider);
    tracker.closeEpoch({ exitValue: exitVal, gasCost, token0UsdPrice: price0, token1UsdPrice: price1 });
    if (deps.updateBotState) deps.updateBotState({ pnlEpochs: tracker.serialize() });
    if (deps._addCollectedFees && deps._lastUnclaimedFeesUsd) { deps._addCollectedFees(deps._lastUnclaimedFeesUsd); deps._lastUnclaimedFeesUsd = 0; }
    const entryVal = result.entryValueUsd || (_toFloat(result.amount0Minted, rd0) * price0 + _toFloat(result.amount1Minted, rd1) * price1);
    tracker.openEpoch({ entryValue: entryVal || exitVal, entryPrice: result.currentPrice,
      lowerPrice: rangeMath.tickToPrice(result.newTickLower, rd0, rd1), upperPrice: rangeMath.tickToPrice(result.newTickUpper, rd0, rd1), token0UsdPrice: price0, token1UsdPrice: price1 });
  } catch (err) { console.warn('[bot] P&L epoch close error:', err.message); }
}

/** Resolve pool address and scan on-chain rebalance history (fire-and-forget). */
async function _scanHistory(provider, ethersLib, address, position, cache, events, updateState, throttle) {
  try {
    updateState({ rebalanceScanComplete: false, rebalanceScanProgress: 0 });
    const poolState = await getPoolState(provider, ethersLib, { factoryAddress: config.FACTORY,
      token0: position.token0, token1: position.token1, fee: position.fee });
    console.log(`[bot] Scanning rebalance history for ${address} (pool ${poolState.poolAddress})`);
    updateState({ rebalanceScanProgress: 5 });
    const found = await scanRebalanceHistory(provider, ethersLib, { walletAddress: address,
      positionManagerAddress: config.POSITION_MANAGER, factoryAddress: config.FACTORY,
      poolAddress: poolState.poolAddress || null, maxYears: 5, cache,
      poolToken0: position.token0, poolToken1: position.token1, poolFee: position.fee,
      onProgress: (done, total) => updateState({ rebalanceScanProgress: 5 + Math.round(done / total * 90) }) });
    updateState({ rebalanceScanProgress: 95 }); events.push(...found);
    console.log(`[bot] Found ${found.length} historical rebalance events`);
    if (throttle && found.length > 0) { const cutoff = Math.floor((throttle.getState().dailyResetAt - 86_400_000) / 1000); const recent = found.filter((e) => e.timestamp >= cutoff).length; if (recent > 0) throttle.rehydrate(recent); }
    const _d = (ts) => ts ? new Date(ts * 1000).toISOString().slice(0, 10) : undefined;
    const mintEv = found.find((e) => String(e.newTokenId) === String(position.tokenId));
    const mintTs = mintEv?.timestamp ? new Date(mintEv.timestamp * 1000).toISOString() : undefined;
    const mintDate = mintTs ? mintTs.slice(0, 10) : undefined, poolFirstMintDate = _d(found.firstMintTimestamp);
    if (mintDate) console.log(`[bot] Position #${position.tokenId} minted on ${mintDate}`);
    if (poolFirstMintDate) console.log(`[bot] Pool first LP minted on ${poolFirstMintDate}`);
    const stPatch = { rebalanceEvents: [...events], rebalanceScanProgress: 100 };
    if (mintDate) { stPatch.positionMintDate = mintDate; stPatch.positionMintTimestamp = mintTs; }
    if (poolFirstMintDate) stPatch.poolFirstMintDate = poolFirstMintDate;
    if (throttle) stPatch.throttleState = throttle.getState(); updateState(stPatch);
  } catch (err) {
    console.warn('[bot] Event scan error:', err.message);
    updateState({ rebalanceScanComplete: true }); // error path: mark complete so UI isn't stuck
  }
}

/** Record residual delta and persist. */
function _recordResidual(deps, result) {
  if (!deps._residualTracker || !result.poolAddress) return;
  deps._residualTracker.addDelta(result.poolAddress, result.amount0Collected - result.amount0Minted, result.amount1Collected - result.amount1Minted);
  if (deps.updateBotState) deps.updateBotState({ residuals: deps._residualTracker.serialize() });
}

/** Build a serialisable activePosition snapshot from a position object. */
function _activePosSummary(p) {
  return { tokenId: String(p.tokenId), token0: p.token0, token1: p.token1, fee: p.fee, tickLower: p.tickLower, tickUpper: p.tickUpper, liquidity: String(p.liquidity || 0) };
}
/** Notify the dashboard of a successful rebalance. */
function _notifyRebalance(deps, throttle, position, events) {
  deps.updateBotState({ rebalanceCount: (deps._rebalanceCount || 0) + 1, lastRebalanceAt: new Date().toISOString(),
    throttleState: throttle.getState(), rebalanceEvents: events ? [...events] : undefined,
    activePosition: _activePosSummary(position), activePositionId: String(position.tokenId) });
}

/** Update HODL baseline from rebalance result. */
function _updateHodlBaseline(botState, result, mintNow) {
  const d0 = result.decimals0 ?? 18, d1 = result.decimals1 ?? 18;
  const a0 = _toFloat(result.amount0Minted, d0), a1 = _toFloat(result.amount1Minted, d1), p0 = result.token0UsdPrice || 0, p1 = result.token1UsdPrice || 0;
  botState.hodlBaseline = { mintDate: mintNow.slice(0, 10), mintTimestamp: mintNow, entryValue: a0 * p0 + a1 * p1, hodlAmount0: a0, hodlAmount1: a1, token0UsdPrice: p0, token1UsdPrice: p1 };
}
/** Update in-memory position + events after a successful rebalance. */
function _applyRebalanceResult(deps, result) {
  const { position } = deps;
  if (result.newTokenId && result.newTokenId !== 0n) position.tokenId = String(result.newTokenId);
  position.tickLower = result.newTickLower; position.tickUpper = result.newTickUpper; if (result.liquidity !== undefined) position.liquidity = String(result.liquidity);
  const events = deps._rebalanceEvents; if (events) {
    const ts = Math.floor(Date.now() / 1000);
    events.push({ index: events.length + 1, timestamp: ts, dateStr: new Date(ts * 1000).toISOString(),
      oldTokenId: String(result.oldTokenId || '?'), newTokenId: String(result.newTokenId || '?'),
      txHash: (result.txHashes && result.txHashes[result.txHashes.length - 1]) || '', blockNumber: 0 });
  }
  const mintNow = new Date().toISOString();
  if (deps._botState) { deps._botState.oorSince = null; _updateHodlBaseline(deps._botState, result, mintNow); }
  console.log('[bot] Post-rebalance: position.tokenId=%s (was old, now new)', String(position.tokenId));
  if (!deps.updateBotState) return;
  _notifyRebalance(deps, deps.throttle || deps._throttle, position, events);
  const patch = { oorSince: null, positionMintDate: mintNow.slice(0, 10), positionMintTimestamp: mintNow };
  if (result.requestedRangePct && result.effectiveRangePct && Math.abs(result.effectiveRangePct - result.requestedRangePct) > 0.01) patch.rangeRounded = { requested: result.requestedRangePct, effective: result.effectiveRangePct };
  deps.updateBotState(patch);
}

async function _executeAndRecord(deps, ethersLib) {
  const { signer, position, throttle } = deps; console.log('[bot] Position out of range — rebalancing…');
  const state = deps._botState || {};
  state.rebalanceInProgress = true;
  const crw = state.customRangeWidthPct;
  const result = await executeRebalance(signer, ethersLib, { position,
    factoryAddress: config.FACTORY, positionManagerAddress: config.POSITION_MANAGER,
    swapRouterAddress: config.SWAP_ROUTER, slippagePct: state.slippagePct ?? config.SLIPPAGE_PCT,
    ...(crw ? { customRangeWidthPct: crw } : {}) });
  if (result.success) {
    if (crw) delete state.customRangeWidthPct;
    throttle.recordRebalance();
    try { await enrichResultUsd(result, () => _fetchTokenPrices(position.token0, position.token1), position.token0, position.token1); } catch (_) { /* prices unavailable */ }
    _recordResidual(deps, result); appendLog(result);
    console.log('[bot] Rebalance OK — new tokenId:', String(result.newTokenId));
    await _closePnlEpoch(deps, result);
    _applyRebalanceResult(deps, result);
  } else {
    console.error('[bot] Rebalance failed:', result.error);
  }
  state.rebalanceInProgress = false;
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
/** Compute lifetime fees: max of runtime-collected vs tracker's closed-epoch total, plus current unclaimed. */
function _computeLifetimeFees(snap, deps, feesUsd) { const cf = snap.totalFees - (snap.liveEpoch?.fees ?? 0); return Math.max(deps._collectedFeesUsd || 0, cf) + feesUsd; }

/** Resolve HODL amounts: prefer source, fall back to baseline. */
function _hodlAmounts(source, bl) { return { a0: source?.hodlAmount0 || bl?.hodlAmount0 || 0, a1: source?.hodlAmount1 || bl?.hodlAmount1 || 0 }; }
/** Compute current-position and lifetime IL using actual deposited token amounts. */
function _computeIL(snap, deps, realValue, _entryVal, price0, price1) {
  const bl = deps._botState?.hodlBaseline;
  const _il = (a0, a1) => (a0 > 0 || a1 > 0) ? computeHodlIL({ lpValue: realValue, hodlAmount0: a0, hodlAmount1: a1, currentPrice0: price0, currentPrice1: price1 }) : undefined;
  const curA0 = bl?.hodlAmount0 || 0, curA1 = bl?.hodlAmount1 || 0;
  snap.totalIL = _il(curA0, curA1);
  const first = Array.isArray(snap.closedEpochs) ? snap.closedEpochs[0] : null;
  const { a0, a1 } = _hodlAmounts(first, bl);
  snap.lifetimeIL = _il(a0, a1);
  snap.ilInputs = { lpValue: realValue, price0, price1, cur: { hodlAmount0: curA0, hodlAmount1: curA1 }, lt: { hodlAmount0: a0, hodlAmount1: a1 } };
}

function _overridePnlWithRealValues(snap, deps, position, poolState, price0, price1, feesUsd, residualUsd) {
  const realValue = _positionValueUsd(position, poolState, price0, price1);
  const lifetimeFees = _computeLifetimeFees(snap, deps, feesUsd);
  snap.residualValueUsd = residualUsd || 0;
  snap.currentValue = realValue;
  snap.totalFees = lifetimeFees;
  const entryVal = snap.liveEpoch ? snap.liveEpoch.entryValue : snap.initialDeposit;
  snap.priceChangePnl = realValue - entryVal;
  snap.cumulativePnl = snap.priceChangePnl + lifetimeFees - snap.totalGas;
  snap.netReturn = lifetimeFees - snap.totalGas + snap.priceChangePnl;
  _computeIL(snap, deps, realValue, entryVal, price0, price1);
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

/** Check whether the OOR timeout has expired (position continuously OOR). */
function _isTimeoutExpired(bs) { const t = bs.rebalanceTimeoutMin ?? config.REBALANCE_TIMEOUT_MIN; return t > 0 && bs.oorSince && Date.now() - bs.oorSince >= t * 60_000; }

/** Check whether the price has moved beyond the OOR threshold. */
function _isBeyondThreshold(poolState, position, botState) {
  const threshPct = (botState.rebalanceOutOfRangeThresholdPercent ?? config.REBALANCE_OOR_THRESHOLD_PCT ?? 5) / 100;
  if (threshPct <= 0) return true;
  const lp = rangeMath.tickToPrice(position.tickLower, poolState.decimals0, poolState.decimals1), up = rangeMath.tickToPrice(position.tickUpper, poolState.decimals0, poolState.decimals1);
  if (poolState.price < lp - (up - lp) * threshPct || poolState.price > up + (up - lp) * threshPct) return true;
  console.log(`[bot] OOR but within ${threshPct * 100}% threshold`); return false;
}

/** Fetch P&L snapshot and publish position stats to the dashboard. */
async function _updatePnlAndStats(deps, poolState, ethersLib) {
  const { provider, position, updateBotState } = deps;
  const lp = rangeMath.tickToPrice(position.tickLower, poolState.decimals0, poolState.decimals1);
  const up = rangeMath.tickToPrice(position.tickUpper, poolState.decimals0, poolState.decimals1);
  const ratio = rangeMath.compositionRatio(poolState.price, lp, up);
  const pnlTracker = deps._pnlTracker; let pnlSnapshot = null;
  if (pnlTracker) {
    try {
      const { price0, price1 } = await _fetchTokenPrices(position.token0, position.token1);
      if (!pnlTracker.getLiveEpoch()) { const ev = _positionValueUsd(position, poolState, price0, price1) || 1; // Auto-open if missing (failed rebalance / corrupt saved state)
        pnlTracker.openEpoch({ entryValue: ev, entryPrice: poolState.price, lowerPrice: lp, upperPrice: up, token0UsdPrice: price0, token1UsdPrice: price1 });
        console.log('[bot] Auto-opened missing live epoch (entryValue=$%s)', ev.toFixed(2)); }
      const fees = await _readUnclaimedFees(provider, ethersLib, position.tokenId, deps.signer);
      const feesUsd = _toFloat(fees.tokensOwed0, poolState.decimals0) * price0 + _toFloat(fees.tokensOwed1, poolState.decimals1) * price1;
      console.log('[bot] fees: owed0=%s owed1=%s dec0=%d dec1=%d p0=%s p1=%s usd=%s', String(fees.tokensOwed0), String(fees.tokensOwed1), poolState.decimals0, poolState.decimals1, price0, price1, feesUsd.toFixed(6));
      deps._lastUnclaimedFeesUsd = feesUsd;
      const residualUsd = await _residualValueUsd(deps, ethersLib, provider, position, poolState, price0, price1);
      pnlTracker.updateLiveEpoch({ currentPrice: poolState.price, feesAccrued: feesUsd });
      const _posMint = deps._botState?.positionMintDate || deps._botState?.hodlBaseline?.mintDate || deps._botState?.poolFirstMintDate;
      pnlSnapshot = pnlTracker.snapshot(poolState.price, deps._botState?.poolFirstMintDate, _posMint);
      _overridePnlWithRealValues(pnlSnapshot, deps, position, poolState, price0, price1, feesUsd, residualUsd);
    } catch (err) { console.warn('[bot] P&L update error:', err.message); }
  }
  if (updateBotState) {
    const amounts = rangeMath.positionAmounts(position.liquidity, poolState.tick, position.tickLower, position.tickUpper, poolState.decimals0, poolState.decimals1);
    const posStats = { compositionRatio: ratio, balance0: amounts.amount0.toFixed(6), balance1: amounts.amount1.toFixed(6) };
    await _addPoolShare(posStats, amounts, position, poolState, ethersLib, provider);
    const su = { poolState: { price: poolState.price, tick: poolState.tick, decimals0: poolState.decimals0, decimals1: poolState.decimals1 }, positionStats: posStats, ...(pnlSnapshot ? { pnlSnapshot } : {}) };
    updateBotState(su);
  }
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
      return true; }
  } catch (_) { /* proceed if gas check fails */ } return false;
}

/** Check range, threshold, and OOR timeout.  Returns early result or null. */
function _checkRangeAndThreshold(deps, poolState, emit) {
  const { position } = deps; const forced = !!deps._botState?.forceRebalance;
  const botSt = deps._botState || {};
  const inRange = poolState.tick >= position.tickLower && poolState.tick < position.tickUpper;
  if (inRange && !forced) {
    if (botSt.oorSince) { botSt.oorSince = null; emit({ oorSince: null }); }
    return { rebalanced: false, inRange: true };
  }
  const beyondThreshold = forced || _isBeyondThreshold(poolState, position, botSt);
  if (!beyondThreshold) {
    if (!botSt.oorSince) { botSt.oorSince = Date.now(); emit({ oorSince: botSt.oorSince }); }
    if (!_isTimeoutExpired(botSt)) {
      emit({ withinThreshold: true });
      return { rebalanced: false, withinThreshold: true };
    }
    console.log('[bot] OOR timeout expired — triggering rebalance');
  } else if (!forced && !botSt.oorSince) {
    botSt.oorSince = Date.now(); emit({ oorSince: botSt.oorSince });
  }
  emit({ withinThreshold: false });
  return null;
}

/** Single poll iteration: check range, threshold, throttle, then rebalance if needed. */
async function pollCycle(deps) {
  const { provider, position, throttle, dryRun } = deps;
  const ethersLib = deps._ethersLib || ethers;
  const emit = deps.updateBotState || (() => {});
  throttle.tick();
  let poolState;
  try {
    poolState = await getPoolState(provider, ethersLib, {
      factoryAddress: config.FACTORY, token0: position.token0,
      token1: position.token1, fee: position.fee });
  } catch (err) {
    console.error('[bot] Pool state error:', err.message);
    return { rebalanced: false, error: err.message };
  }
  await _updatePnlAndStats(deps, poolState, ethersLib);
  if (BigInt(position.liquidity) === 0n && !deps._botState?.forceRebalance) {
    console.log('[bot] Position closed (0 liquidity, force=%s) — skipping', !!deps._botState?.forceRebalance);
    return { rebalanced: false };
  }
  const rangeCheck = _checkRangeAndThreshold(deps, poolState, emit);
  if (rangeCheck) return rangeCheck;
  const forced = !!deps._botState?.forceRebalance;
  console.log('[bot] pollCycle: OOR on #%s, forced=%s, tick=%d range=[%d,%d]', position.tokenId, forced, poolState.tick, position.tickLower, position.tickUpper);
  const can = !forced && throttle.canRebalance();
  if (can && !can.allowed) {
    console.log(`[bot] OOR but throttled (${can.reason}), wait ${Math.ceil(can.msUntilAllowed / 1000)}s`);
    emit({ throttleState: throttle.getState() });
    return { rebalanced: false };
  }
  if (dryRun) {
    console.log(`[bot] DRY RUN — OOR, price=${poolState.price} tick=${poolState.tick} range=[${position.tickLower},${position.tickUpper}]`);
    return { rebalanced: false };
  }
  if (await _isGasTooHigh(provider, position, poolState)) return { rebalanced: false, gasDeferred: true };
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
    const password = config.KEY_PASSWORD || (askPassword && await askPassword('[bot] Enter key-file password: '));
    if (!password) return null;
    console.log(`[bot] Loading private key from encrypted file: ${config.KEY_FILE}`);
    return loadAndDecrypt(password, config.KEY_FILE);
  }
  // 3. Wallet manager (dashboard-imported wallet)
  if (walletManager.hasWallet()) {
    const password = config.WALLET_PASSWORD || (askPassword && await askPassword('[bot] Enter wallet password: '));
    if (!password) return null;
    console.log('[bot] Loading private key from imported wallet');
    return (await walletManager.revealWallet(password)).privateKey;
  }
  return null;
}

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
  if (detection.type !== 'nft' || !detection.nftPositions?.length) throw new Error('No V3 NFT position found. This tool only supports V3 positions.');
  const valid = detection.nftPositions.filter((p) => V3_FEE_TIERS.includes(p.fee));
  if (!valid.length) throw new Error(`No positions with supported fee tiers. V3 tiers: ${V3_FEE_TIERS.join(', ')}`);
  console.log('[bot] _detectPosition: targetId=%s, found %d valid NFTs: %s', targetId || 'none',
    valid.length, valid.map(p => `#${p.tokenId}(liq=${String(p.liquidity).slice(0, 8)})`).join(', '));
  if (targetId) { const m = valid.find((p) => String(p.tokenId) === String(targetId)); console.log('[bot] _detectPosition: targetId match=%s', m ? `#${m.tokenId}` : 'MISS→fallback'); return m || valid[0]; }
  const active = valid.filter((p) => BigInt(p.liquidity || 0n) > 0n);
  const picked = active.length > 0 ? active.reduce((best, p) => BigInt(p.liquidity || 0n) > BigInt(best.liquidity || 0n) ? p : best)
    : valid.reduce((best, p) => BigInt(p.tokenId) > BigInt(best.tokenId) ? p : best);
  console.log('[bot] _detectPosition: picked #%s (active=%d, total=%d)', picked.tokenId, active.length, valid.length);
  return picked;
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
  const dryRun = opts.dryRun ?? config.DRY_RUN, ethersLib = opts.ethersLib || ethers;
  if (dryRun) console.log('\n  ┌──────────────────────────────────────────────┐\n  │  DRY RUN MODE — no transactions will be sent │\n  └──────────────────────────────────────────────┘\n');
  const provider = await createProviderWithFallback(config.RPC_URL, config.RPC_URL_FALLBACK, ethersLib);
  const signer = dryRun && !privateKey ? ethersLib.Wallet.createRandom().connect(provider) : new ethersLib.Wallet(privateKey, provider);
  const address = await signer.getAddress();
  if (dryRun && !privateKey) console.log(`[bot] DRY RUN — using random address: ${address}`);
  console.log(`[bot] Wallet: ${address}`);
  const position = await _detectPosition(provider, address, opts.positionId || config.POSITION_ID || undefined);
  console.log(`[bot] Managing NFT #${position.tokenId} (${position.token0}/${position.token1} fee=${position.fee})`);

  let pnlTracker = null; // Initialize P&L tracker with token prices
  try {
    const { price0, price1 } = await _fetchTokenPrices(position.token0, position.token1);
    if (price0 > 0 || price1 > 0) {
      const poolState = await getPoolState(provider, ethersLib, { factoryAddress: config.FACTORY, token0: position.token0, token1: position.token1, fee: position.fee });
      const lp = rangeMath.tickToPrice(position.tickLower, poolState.decimals0, poolState.decimals1);
      const up = rangeMath.tickToPrice(position.tickUpper, poolState.decimals0, poolState.decimals1);
      pnlTracker = _initPnlTracker(_positionValueUsd(position, poolState, price0, price1) || 1, botState, poolState, lp, up, price0, price1);
      if (!botState.pnlEpochs) updateBotState({ pnlEpochs: pnlTracker.serialize() });
    } else { console.warn('[bot] Could not fetch token prices — P&L tracking disabled'); }
  } catch (err) { console.warn('[bot] P&L tracker init error:', err.message); }

  const residualTracker = createResidualTracker(); if (botState.residuals) residualTracker.deserialize(botState.residuals);
  initHodlBaseline(provider, ethersLib, position, botState, updateBotState).catch((err) => console.warn('[bot] HODL baseline background error:', err.message));
  const throttle = createThrottle({ minIntervalMs: config.MIN_REBALANCE_INTERVAL_MIN * 60_000, dailyMax: config.MAX_REBALANCES_PER_DAY });
  const rebalanceEvents = [], cache = createCacheStore({ filePath: path.join(process.cwd(), 'tmp', 'event-cache.json') });
  updateBotState({ running: true, dryRun, startedAt: new Date().toISOString(),
    throttleState: throttle.getState(), rebalanceEvents, walletAddress: address,
    activePosition: _activePosSummary(position) });

  let collectedFeesUsd = botState.collectedFeesUsd || 0, rebalanceCount = 0, firstFailureAt = null, polling = false, _stopped = false;
  const GAS_DEFER_MS = 3600_000;
  let currentIntervalMs = config.CHECK_INTERVAL_SEC * 1000, timer = null;
  function _scheduleNext(ms) { clearTimeout(timer); timer = setTimeout(poll, ms ?? currentIntervalMs); }

  const poll = async () => {
    if (polling) return;
    polling = true;
    // Hot-reload settings from dashboard (POST /api/config → botState)
    if (botState.checkIntervalSec) currentIntervalMs = botState.checkIntervalSec * 1000;
    throttle.configure({ minIntervalMs: (botState.minRebalanceIntervalMin || 10) * 60_000, dailyMax: botState.maxRebalancesPerDay || 20 });
    try {
      const result = await pollCycle({
        signer, provider, position, throttle, dryRun, updateBotState,
        _rebalanceCount: rebalanceCount, _botState: botState, _pnlTracker: pnlTracker,
        _rebalanceEvents: rebalanceEvents, _collectedFeesUsd: collectedFeesUsd,
        _addCollectedFees: (usd) => { collectedFeesUsd += usd; updateBotState({ collectedFeesUsd }); },
        _residualTracker: residualTracker,
      });
      if (result.rebalanced) {
        rebalanceCount++; firstFailureAt = null; currentIntervalMs = (botState.checkIntervalSec || config.CHECK_INTERVAL_SEC) * 1000;
        cache.clear().catch(() => {}); // Invalidate event cache so next scan finds the new NFT
        updateBotState({ rebalanceError: null, rebalancePaused: false, forceRebalance: false });
        if (botState.rangeRounded) setTimeout(() => updateBotState({ rangeRounded: null }), 5000);
      } else if (result.gasDeferred) {
        currentIntervalMs = GAS_DEFER_MS; console.log(`[bot] Next retry in ${GAS_DEFER_MS / 60_000}m (gas deferral)`);
      } else if (result.error) {
        if (!firstFailureAt) firstFailureAt = Date.now();
        console.error(`[bot] Rebalance failed: ${result.error} (${Math.round((Date.now() - firstFailureAt) / 60_000)}m of failures)`);
        updateBotState({ rebalanceError: result.error, rebalancePaused: true });
      } else if (firstFailureAt) {
        const oorMin = Math.round((Date.now() - firstFailureAt) / 60_000);
        console.log(`[bot] Price returned to range after ~${oorMin}m of failures — clearing`);
        firstFailureAt = null; currentIntervalMs = (botState.checkIntervalSec || config.CHECK_INTERVAL_SEC) * 1000;
        updateBotState({ rebalanceError: null, rebalancePaused: false, oorRecoveredMin: oorMin });
        // Clear after one poll so the dashboard doesn't re-show on refresh
        setTimeout(() => updateBotState({ oorRecoveredMin: 0 }), 5000);
      }
    } catch (err) {
      if (!firstFailureAt) firstFailureAt = Date.now();
      console.error(`[bot] Poll error: ${err.message} (${Math.round((Date.now() - firstFailureAt) / 60_000)}m of failures)`);
    } finally { polling = false; }
    // Honor queued position switch (requested while rebalance was in progress)
    if (botState.pendingSwitch) {
      console.log('[bot] Honoring queued switch to #%s', botState.pendingSwitch);
      _stopped = true; clearTimeout(timer); updateBotState({ running: false }); return;
    }
    _scheduleNext();
  };

  await poll(); // First poll — gives the dashboard current position data
  console.log(`[bot] Polling every ${config.CHECK_INTERVAL_SEC}s`);
  clearTimeout(timer); // Scan history + reconstruct epochs (sequential, no concurrent rebalance)
  await _scanHistory(provider, ethersLib, address, position, cache, rebalanceEvents, updateBotState, throttle);
  const _fb = await _fetchTokenPrices(position.token0, position.token1).catch(() => ({ price0: 0, price1: 0 }));
  await reconstructEpochs({ pnlTracker, rebalanceEvents, botState, updateBotState, fallbackPrices: _fb }).catch(e => console.warn('[pnl] Epoch reconstruction error:', e.message));
  updateBotState({ rebalanceScanComplete: true });
  await poll(); // Resume normal polling
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
