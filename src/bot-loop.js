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

const config             = require('./config');
const { createThrottle } = require('./throttle');
const { loadAndDecrypt } = require('./key-store');
const { detectPositionType }    = require('./position-detector');
const { getPoolState, executeRebalance, V3_FEE_TIERS } = require('./rebalancer');
const rangeMath          = require('./range-math');
const walletManager      = require('./wallet-manager');
const { createPnlTracker }      = require('./pnl-tracker');
const { fetchTokenPriceUsd }   = require('./price-fetcher');
const { initHodlBaseline }    = require('./hodl-baseline');
const { scanRebalanceHistory } = require('./event-scanner');
const { createCacheStore }     = require('./cache-store');

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

/** ABI fragment to read uncollected fees from PositionManager. */
const _PM_POSITIONS_ABI = [
  'function positions(uint256 tokenId) external view returns (uint96 nonce, address operator, address token0, address token1, uint24 fee, int24 tickLower, int24 tickUpper, uint128 liquidity, uint256 feeGrowthInside0LastX128, uint256 feeGrowthInside1LastX128, uint128 tokensOwed0, uint128 tokensOwed1)',
];

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
 * Read uncollected fees (tokensOwed0/1) from the position manager.
 * @param {import('ethers').JsonRpcProvider} provider
 * @param {object} ethersLib
 * @param {bigint|string} tokenId
 * @returns {Promise<{tokensOwed0: bigint, tokensOwed1: bigint}>}
 */
async function _readUnclaimedFees(provider, ethersLib, tokenId) {
  try {
    const pm = new ethersLib.Contract(config.POSITION_MANAGER, _PM_POSITIONS_ABI, provider);
    const data = await pm.positions(tokenId);
    return { tokensOwed0: data.tokensOwed0, tokensOwed1: data.tokensOwed1 };
  } catch {
    return { tokensOwed0: 0n, tokensOwed1: 0n };
  }
}

/**
 * Calculate the token amounts in a V3 position from liquidity and tick range.
 * Uses the standard Uniswap V3 formulas.
 * @param {bigint}  liquidity    Position liquidity.
 * @param {number}  currentTick  Current pool tick.
 * @param {number}  tickLower    Position lower tick.
 * @param {number}  tickUpper    Position upper tick.
 * @param {number}  decimals0    Token0 decimals.
 * @param {number}  decimals1    Token1 decimals.
 * @returns {{amount0: number, amount1: number}}  Human-readable token amounts.
 */
function _positionAmounts(liquidity, currentTick, tickLower, tickUpper, decimals0, decimals1) {
  const liq = Number(liquidity);
  const sqrtP  = Math.pow(1.0001, currentTick / 2);
  const sqrtPl = Math.pow(1.0001, tickLower / 2);
  const sqrtPu = Math.pow(1.0001, tickUpper / 2);
  let a0 = 0;
  let a1 = 0;
  if (currentTick < tickLower) {
    a0 = liq * (1 / sqrtPl - 1 / sqrtPu);
  } else if (currentTick >= tickUpper) {
    a1 = liq * (sqrtPu - sqrtPl);
  } else {
    a0 = liq * (1 / sqrtP - 1 / sqrtPu);
    a1 = liq * (sqrtP - sqrtPl);
  }
  return {
    amount0: a0 / Math.pow(10, decimals0),
    amount1: a1 / Math.pow(10, decimals1),
  };
}

/**
 * Calculate the USD value of a V3 position.
 * @param {object}  position   Position with liquidity, tickLower, tickUpper, token0, token1.
 * @param {object}  poolState  Pool state with tick, decimals0, decimals1.
 * @param {number}  price0     Token0 USD price.
 * @param {number}  price1     Token1 USD price.
 * @returns {number}  Position value in USD.
 */
function _positionValueUsd(position, poolState, price0, price1) {
  const amounts = _positionAmounts(
    position.liquidity, poolState.tick,
    position.tickLower, position.tickUpper,
    poolState.decimals0, poolState.decimals1,
  );
  return amounts.amount0 * price0 + amounts.amount1 * price1;
}

/**
 * Convert a BigInt token amount to a float given its decimals.
 * @param {bigint} amount
 * @param {number} decimals
 * @returns {number}
 */
function _toFloat(amount, decimals) {
  return Number(amount) / Math.pow(10, decimals);
}

// ── P&L epoch management ────────────────────────────────────────────────────

/**
 * Estimate gas cost in USD for a rebalance (remove+swap+mint ≈ 800k gas).
 * @param {import('ethers').JsonRpcProvider} provider
 * @returns {Promise<number>}
 */
async function _estimateGasCostUsd(provider) {
  try {
    const feeData = await provider.getFeeData();
    const gasPrice = feeData.gasPrice ?? 0n;
    const gasUsed = 800_000n; // typical rebalance gas
    const costWei = gasPrice * gasUsed;
    const costPls = Number(costWei) / 1e18;
    const plsPrice = await fetchTokenPriceUsd(_WPLS, { dextoolsApiKey: config.DEXTOOLS_API_KEY });
    return costPls * plsPrice;
  } catch {
    return 0;
  }
}

/**
 * Close the current P&L epoch after a rebalance and open a new one.
 * @param {object} deps    pollCycle dependency bag (needs _pnlTracker, position, provider).
 * @param {object} result  executeRebalance result.
 */
async function _closePnlEpoch(deps, result) {
  const tracker = deps._pnlTracker;
  if (!tracker || tracker.epochCount() === 0) return;

  try {
    // Reuse prices from result if already fetched, otherwise fetch fresh
    let price0 = result.token0UsdPrice;
    let price1 = result.token1UsdPrice;
    if (price0 === undefined || price1 === undefined) {
      const prices = await _fetchTokenPrices(deps.position.token0, deps.position.token1);
      price0 = prices.price0;  price1 = prices.price1;
    }
    const exitValue = result.exitValueUsd || (_toFloat(result.amount0Collected, 18) * price0 + _toFloat(result.amount1Collected, 18) * price1);
    const gasCost = await _estimateGasCostUsd(deps.provider);
    tracker.closeEpoch({ exitValue, gasCost, token0UsdPrice: price0, token1UsdPrice: price1 });

    // Accumulate the fees that were showing as uncollected (now collected)
    if (deps._addCollectedFees && deps._lastUnclaimedFeesUsd) {
      deps._addCollectedFees(deps._lastUnclaimedFeesUsd);
      deps._lastUnclaimedFeesUsd = 0;
    }

    // Open new epoch for the freshly minted position
    const newLower = rangeMath.tickToPrice(result.newTickLower, 18, 18);
    const newUpper = rangeMath.tickToPrice(result.newTickUpper, 18, 18);
    const entryValue = result.entryValueUsd || (_toFloat(result.amount0Minted, 18) * price0 + _toFloat(result.amount1Minted, 18) * price1);
    tracker.openEpoch({
      entryValue: entryValue || exitValue,
      entryPrice: result.currentPrice,
      lowerPrice: newLower,
      upperPrice: newUpper,
      token0UsdPrice: price0,
      token1UsdPrice: price1,
    });
  } catch (err) {
    console.warn('[bot] P&L epoch close error:', err.message);
  }
}

// ── Event history scan ───────────────────────────────────────────────────────

/**
 * Resolve pool address and scan on-chain rebalance history (fire-and-forget).
 * @param {object} provider      ethers provider.
 * @param {object} ethersLib     ethers library.
 * @param {string} address       Wallet address.
 * @param {object} position      Active position (token0, token1, fee).
 * @param {object} cache         CacheStore instance.
 * @param {object[]} events      Mutable array to push results into.
 * @param {Function} updateState updateBotState callback.
 */
async function _scanHistory(provider, ethersLib, address, position, cache, events, updateState) {
  try {
    updateState({ rebalanceScanComplete: false });
    const poolState = await getPoolState(provider, ethersLib, {
      factoryAddress: config.FACTORY,
      token0: position.token0, token1: position.token1, fee: position.fee,
    });
    console.log(`[bot] Scanning rebalance history for ${address} on pool ${poolState.poolAddress}`);
    console.log(`[bot] Position Manager: ${config.POSITION_MANAGER}`);
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
    updateState({ rebalanceEvents: [...events], rebalanceScanComplete: true });
  } catch (err) {
    console.warn('[bot] Event scan error:', err.message);
    updateState({ rebalanceScanComplete: true });
  }
}

// ── Rebalance execution helper ───────────────────────────────────────────────

/**
 * Execute a rebalance and record the result.  Extracted from pollCycle to
 * keep cyclomatic complexity within limits.
 * @param {object} deps       pollCycle dependency bag.
 * @param {object} ethersLib  ethers library (real or mock).
 * @returns {Promise<{rebalanced: boolean, error?: string}>}
 */
async function _executeAndRecord(deps, ethersLib) {
  const { signer, position, throttle, updateBotState } = deps;

  console.log('[bot] Position out of range — rebalancing…');
  const state = deps._botState || {};
  const result = await executeRebalance(signer, ethersLib, {
    position,
    factoryAddress: config.FACTORY,
    positionManagerAddress: config.POSITION_MANAGER,
    swapRouterAddress: config.SWAP_ROUTER,
    rangeWidthPct: state.rangeWidthPct ?? config.RANGE_WIDTH_PCT,
    slippagePct: state.slippagePct ?? config.SLIPPAGE_PCT,
  });

  if (result.success) {
    throttle.recordRebalance();

    try { // Enrich log with USD values before writing
      const { price0, price1 } = await _fetchTokenPrices(deps.position.token0, deps.position.token1);
      result.token0UsdPrice = price0;  result.token1UsdPrice = price1;
      result.exitValueUsd  = _toFloat(result.amount0Collected, 18) * price0 + _toFloat(result.amount1Collected, 18) * price1;
      result.entryValueUsd = _toFloat(result.amount0Minted, 18) * price0 + _toFloat(result.amount1Minted, 18) * price1;
    } catch (_) { /* prices unavailable */ }

    appendLog(result);
    console.log('[bot] Rebalance OK — new tokenId:', String(result.newTokenId));

    // Close P&L epoch (old range) and open new one (new range)
    await _closePnlEpoch(deps, result);

    if (result.newTokenId && result.newTokenId !== 0n) {
      position.tokenId = result.newTokenId;
    }
    position.tickLower = result.newTickLower;
    position.tickUpper = result.newTickUpper;
    if (result.liquidity !== undefined) position.liquidity = result.liquidity;

    // Append to runtime rebalance events list
    const events = deps._rebalanceEvents;
    if (events) {
      const now = Math.floor(Date.now() / 1000);
      events.push({
        index: events.length + 1,
        timestamp: now,
        dateStr: new Date(now * 1000).toISOString(),
        oldTokenId: String(result.oldTokenId || '?'),
        newTokenId: String(result.newTokenId || '?'),
        txHash: (result.txHashes && result.txHashes[result.txHashes.length - 1]) || '',
        blockNumber: 0,
      });
    }

    if (updateBotState) {
      updateBotState({
        rebalanceCount: (deps._rebalanceCount || 0) + 1,
        lastRebalanceAt: new Date().toISOString(),
        throttleState: throttle.getState(),
        rebalanceEvents: events ? [...events] : undefined,
        activePosition: {
          tokenId: String(position.tokenId),
          token0: position.token0,
          token1: position.token1,
          fee: position.fee,
          tickLower: position.tickLower,
          tickUpper: position.tickUpper,
        },
      });
    }
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
function _overridePnlWithRealValues(snap, deps, position, poolState, price0, price1, feesUsd) {
  const realValue = _positionValueUsd(position, poolState, price0, price1);
  const priorFees = deps._collectedFeesUsd || 0;
  const lifetimeFees = priorFees + feesUsd;
  snap.currentValue = realValue + feesUsd;
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

// ── Poll cycle ───────────────────────────────────────────────────────────────

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
      factoryAddress: config.FACTORY,
      token0: position.token0,
      token1: position.token1,
      fee: position.fee,
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
      const fees = await _readUnclaimedFees(provider, ethersLib, position.tokenId);
      const feesUsd = _toFloat(fees.tokensOwed0, poolState.decimals0) * price0
                    + _toFloat(fees.tokensOwed1, poolState.decimals1) * price1;
      deps._lastUnclaimedFeesUsd = feesUsd;
      pnlTracker.updateLiveEpoch({ currentPrice: poolState.price, feesAccrued: feesUsd });
      pnlSnapshot = pnlTracker.snapshot(poolState.price);
      _overridePnlWithRealValues(pnlSnapshot, deps, position, poolState, price0, price1, feesUsd);
    } catch (err) {
      console.warn('[bot] P&L update error:', err.message);
    }
  }

  if (updateBotState) {
    const stateUpdate = {
      poolState: { price: poolState.price, tick: poolState.tick },
      positionStats: { compositionRatio: ratio },
    };
    if (pnlSnapshot) stateUpdate.pnlSnapshot = pnlSnapshot;
    updateBotState(stateUpdate);
  }

  // 2. Check if in range (V3: upper tick is exclusive)
  const inRange = poolState.tick >= position.tickLower &&
                  poolState.tick < position.tickUpper;

  if (inRange) return { rebalanced: false };

  // 3. Throttle check
  const can = throttle.canRebalance();
  if (!can.allowed) {
    console.log(`[bot] OOR but throttled (${can.reason}), wait ${Math.ceil(can.msUntilAllowed / 1000)}s`);
    if (updateBotState) updateBotState({ throttleState: throttle.getState() });
    return { rebalanced: false };
  }

  // 4. Dry-run: log and skip
  if (dryRun) {
    console.log('[bot] DRY RUN — position out of range, would rebalance but skipping');
    console.log(`[bot]   price=${poolState.price}  tick=${poolState.tick}`);
    console.log(`[bot]   range=[${position.tickLower}, ${position.tickUpper}]`);
    return { rebalanced: false };
  }

  // 5. Execute rebalance
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
 * Start the bot polling loop.  Creates provider, signer, detects position,
 * and begins periodic polling.
 *
 * @param {object} opts
 * @param {string}   opts.privateKey       Hex private key.
 * @param {boolean}  [opts.dryRun]         Dry-run mode (default: config.DRY_RUN).
 * @param {Function} opts.updateBotState   Callback to update shared bot state.
 * @param {object}   opts.botState         Shared bot state object for runtime params.
 * @param {object}   [opts.ethersLib]      Injected ethers (for testing).
 * @returns {Promise<{ stop: Function }>}  Handle with stop() method.
 */
async function startBotLoop(opts) {
  const { privateKey, updateBotState, botState } = opts;
  const dryRun    = opts.dryRun ?? config.DRY_RUN;
  const ethersLib = opts.ethersLib || ethers;

  if (dryRun) {
    console.log('');
    console.log('  ┌──────────────────────────────────────────────┐');
    console.log('  │  DRY RUN MODE — no transactions will be sent │');
    console.log('  └──────────────────────────────────────────────┘');
    console.log('');
  }

  const provider = await createProviderWithFallback(
    config.RPC_URL, config.RPC_URL_FALLBACK, ethersLib,
  );

  // Create signer
  let signer;
  let address;
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

  // Detect position
  const detection = await detectPositionType(provider, {
    walletAddress: address,
    positionManagerAddress: config.POSITION_MANAGER,
    tokenId: config.POSITION_ID || undefined,
    candidateAddress: config.ERC20_POSITION_ADDRESS || undefined,
  });

  if (detection.type !== 'nft' || !detection.nftPositions?.length) {
    throw new Error('No V3 NFT position found. This tool only supports V3 positions.');
  }

  // Pick the position with the highest liquidity (skip drained old positions)
  const validPositions = detection.nftPositions.filter(
    (p) => V3_FEE_TIERS.includes(p.fee),
  );
  if (!validPositions.length) {
    throw new Error(`No positions with supported fee tiers. V3 tiers: ${V3_FEE_TIERS.join(', ')}`);
  }
  const position = validPositions.reduce((best, p) => {
    const bestLiq = BigInt(best.liquidity || 0n);
    const pLiq    = BigInt(p.liquidity || 0n);
    return pLiq > bestLiq ? p : best;
  });

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
      pnlTracker = createPnlTracker({ initialDeposit: entryValue || 1 });
      pnlTracker.openEpoch({
        entryValue: entryValue || 1,
        entryPrice: poolState.price,
        lowerPrice, upperPrice,
        token0UsdPrice: price0, token1UsdPrice: price1,
      });
      console.log(`[bot] P&L tracker initialized (T0=$${price0.toFixed(6)}, T1=$${price1.toFixed(6)})`);
    } else {
      console.warn('[bot] Could not fetch token prices — P&L tracking disabled');
    }
  } catch (err) {
    console.warn('[bot] P&L tracker init error:', err.message);
  }

  // Initialize HODL baseline from historical prices (non-blocking)
  initHodlBaseline(provider, ethersLib, position, botState, updateBotState)
    .catch((err) => console.warn('[bot] HODL baseline background error:', err.message));

  // Create throttle
  const throttle = createThrottle({
    minIntervalMs: config.MIN_REBALANCE_INTERVAL_MIN * 60 * 1000,
    dailyMax: config.MAX_REBALANCES_PER_DAY,
  });

  // Scan on-chain rebalance history (non-blocking)
  const rebalanceEvents = [];
  const cache = createCacheStore({ filePath: path.join(process.cwd(), 'tmp', 'event-cache.json') });
  _scanHistory(provider, ethersLib, address, position, cache, rebalanceEvents, updateBotState);

  updateBotState({
    running: true,
    dryRun,
    startedAt: new Date().toISOString(),
    rebalanceEvents,
    activePosition: {
      tokenId: String(position.tokenId),
      token0: position.token0,
      token1: position.token1,
      fee: position.fee,
      tickLower: position.tickLower,
      tickUpper: position.tickUpper,
    },
  });

  // Accumulated fees from past rebalances (USD) — current uncollected fees added on top
  let collectedFeesUsd = 0;

  // Poll loop with concurrency guard and failure tracking
  let rebalanceCount = 0;
  let firstFailureAt = null;
  let polling = false;
  const intervalMs = config.CHECK_INTERVAL_SEC * 1000;
  const FAILURE_WINDOW_MS = 60 * 60 * 1000; // 1 hour

  const poll = async () => {
    if (polling) return;

    // If failures are older than 1 hour, stop auto-retrying
    if (firstFailureAt && (Date.now() - firstFailureAt) > FAILURE_WINDOW_MS) {
      updateBotState({
        rebalanceError: 'Rebalance has been failing for over 1 hour. Manual intervention required.',
        rebalancePaused: true,
      });
      return;
    }

    polling = true;
    try {
      const result = await pollCycle({
        signer, provider, position, throttle, dryRun,
        updateBotState,
        _rebalanceCount: rebalanceCount,
        _botState: botState,
        _pnlTracker: pnlTracker,
        _rebalanceEvents: rebalanceEvents,
        _collectedFeesUsd: collectedFeesUsd,
        _addCollectedFees: (usd) => { collectedFeesUsd += usd; },
      });
      if (result.rebalanced) {
        rebalanceCount++;
        firstFailureAt = null;
        updateBotState({ rebalanceError: null, rebalancePaused: false });
      } else if (result.error) {
        if (!firstFailureAt) firstFailureAt = Date.now();
        console.error(`[bot] Rebalance failed (retrying within 1h window)`);
      }
    } catch (err) {
      if (!firstFailureAt) firstFailureAt = Date.now();
      console.error('[bot] Poll error:', err.message);
    } finally {
      polling = false;
    }
  };

  // Run first poll immediately, then on interval
  await poll();
  const timer = setInterval(poll, intervalMs);
  console.log(`[bot] Polling every ${config.CHECK_INTERVAL_SEC}s`);

  return {
    stop() {
      clearInterval(timer);
      updateBotState({ running: false });
      console.log('[bot] Bot loop stopped');
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
