/**
 * @file position-details-quick.js
 * @description Phase 1 (fast) position detail computation for unmanaged positions.
 *   Fetches pool state, token prices, position value, fees, and baseline.
 *   Split from position-details.js for line-count compliance.
 */

"use strict";

const config = require("./config");
const rangeMath = require("./range-math");
const { getPoolState } = require("./rebalancer");
const {
  positionValueUsd,
  fetchTokenPrices,
  readUnclaimedFees,
  addPoolShare,
} = require("./bot-pnl-updater");
const { getPositionBaseline } = require("./hodl-baseline");
const { computeHodlIL } = require("./il-calculator");
const {
  compositeKey,
  getPositionConfig,
  saveConfig,
} = require("./bot-config-v2");

const _ERC20_BAL_ABI = ["function balanceOf(address) view returns (uint256)"];

/**
 * Fetch this position's pro-rata share of wallet token balances.
 * @param {object} provider
 * @param {object} ethersLib
 * @param {object} position   { token0, token1, liquidity, tickLower, tickUpper }
 * @param {object} ps         Pool state with tick, decimals0, decimals1.
 * @param {number} price0
 * @param {number} price1
 * @param {string} walletAddr
 * @param {Function} [getTokenAmounts]  Sum of in-position amounts across all managed positions.
 * @returns {Promise<{ usd: number, amount0: number, amount1: number }>}
 */
async function _walletResiduals(
  provider,
  ethersLib,
  position,
  ps,
  price0,
  price1,
  walletAddr,
  getTokenAmounts,
) {
  const empty = { usd: 0, amount0: 0, amount1: 0 };
  if (!walletAddr) return empty;
  try {
    const t0c = new ethersLib.Contract(
      position.token0,
      _ERC20_BAL_ABI,
      provider,
    );
    const t1c = new ethersLib.Contract(
      position.token1,
      _ERC20_BAL_ABI,
      provider,
    );
    const [wb0, wb1] = await Promise.all([
      t0c.balanceOf(walletAddr),
      t1c.balanceOf(walletAddr),
    ]);
    const wf0 = Number(wb0) / 10 ** ps.decimals0;
    const wf1 = Number(wb1) / 10 ** ps.decimals1;
    const pa = rangeMath.positionAmounts(
      position.liquidity || 0,
      ps.tick,
      position.tickLower,
      position.tickUpper,
      ps.decimals0,
      ps.decimals1,
    );
    const total0 = getTokenAmounts
      ? getTokenAmounts(position.token0)
      : pa.amount0;
    const total1 = getTokenAmounts
      ? getTokenAmounts(position.token1)
      : pa.amount1;
    const share0 = total0 > 0 ? (pa.amount0 / total0) * wf0 : wf0;
    const share1 = total1 > 0 ? (pa.amount1 / total1) * wf1 : wf1;
    return {
      usd: share0 * price0 + share1 * price1,
      amount0: share0,
      amount1: share1,
    };
  } catch (_) {
    return empty;
  }
}

/** Load or fetch + cache the HODL baseline for a position. */
async function _resolveBaseline(
  provider,
  ethersLib,
  position,
  posKey,
  diskConfig,
) {
  const saved = diskConfig.positions[posKey]?.hodlBaseline;
  if (saved && saved.entryValue > 0 && (saved.price0 > 0 || saved.price1 > 0))
    return saved;
  const bl = await getPositionBaseline(provider, ethersLib, position);
  if (bl) {
    const pos = getPositionConfig(diskConfig, posKey);
    pos.hodlBaseline = bl;
    saveConfig(diskConfig);
  }
  return bl;
}

/** Read unclaimed fees for a position. Returns 0 if unavailable. */
async function _readFees(
  provider,
  ethersLib,
  tokenId,
  privateKey,
  decimals0,
  decimals1,
  price0,
  price1,
) {
  if (!privateKey) return 0;
  try {
    const signer = new ethersLib.Wallet(privateKey, provider);
    const f = await readUnclaimedFees(provider, ethersLib, tokenId, signer);
    const usd =
      (Number(f.tokensOwed0) / 10 ** decimals0) * price0 +
      (Number(f.tokensOwed1) / 10 ** decimals1) * price1;
    console.log(
      "[details] fees for #%s: owed0=%s owed1=%s usd=%s",
      tokenId,
      String(f.tokensOwed0),
      String(f.tokensOwed1),
      usd.toFixed(4),
    );
    return usd;
  } catch (e) {
    console.warn("[details] fee read failed for #%s: %s", tokenId, e.message);
    return 0;
  }
}

/** Compute current-epoch P&L from baseline + prices. */
function _currentPnl(
  baseline,
  value,
  entryValue,
  feesUsd,
  price0,
  price1,
  residuals,
) {
  const rUsd = residuals?.usd || 0;
  const pgl = entryValue > 0 ? value - entryValue : null;
  const il = baseline
    ? computeHodlIL({
        lpValue: value,
        hodlAmount0: baseline.hodlAmount0,
        hodlAmount1: baseline.hodlAmount1,
        currentPrice0: price0,
        currentPrice1: price1,
      })
    : null;
  return {
    value,
    priceGainLoss: pgl,
    il,
    netPnl: entryValue > 0 ? (pgl || 0) + feesUsd : null,
    profit: il !== null ? feesUsd + il : null,
    residualValueUsd: rUsd,
  };
}

/** Apply client-provided price overrides. Force mode overrides even valid fetched prices. */
function _applyPriceOverrides(prices, body) {
  const force = body.priceOverrideForce;
  if (body.priceOverride0 > 0 && (force || prices.price0 <= 0))
    prices.price0 = body.priceOverride0;
  if (body.priceOverride1 > 0 && (force || prices.price1 <= 0))
    prices.price1 = body.priceOverride1;
}

/** Fetch pool state, prices, amounts, value — the non-P&L data. */
async function _fetchPoolData(provider, ethersLib, body, privateKey) {
  const position = {
    tokenId: body.tokenId,
    token0: body.token0,
    token1: body.token1,
    fee: body.fee,
    tickLower: body.tickLower,
    tickUpper: body.tickUpper,
    liquidity: body.liquidity,
  };
  const ps = await getPoolState(provider, ethersLib, {
    factoryAddress: config.FACTORY,
    token0: body.token0,
    token1: body.token1,
    fee: body.fee,
  });
  const prices = await fetchTokenPrices(body.token0, body.token1);
  const fetchedPrice0 = prices.price0,
    fetchedPrice1 = prices.price1;
  _applyPriceOverrides(prices, body);
  const { price0, price1 } = prices;
  const value = positionValueUsd(position, ps, price0, price1);
  const amounts = rangeMath.positionAmounts(
    BigInt(body.liquidity || 0),
    ps.tick,
    body.tickLower,
    body.tickUpper,
    ps.decimals0,
    ps.decimals1,
  );
  console.log(
    "[details] tokenId=%s liq=%s tick=%d tL=%d tU=%d amt0=%s amt1=%s p0=%s p1=%s",
    body.tokenId,
    body.liquidity,
    ps.tick,
    body.tickLower,
    body.tickUpper,
    amounts.amount0.toFixed(4),
    amounts.amount1.toFixed(4),
    price0,
    price1,
  );
  const feesUsd = await _readFees(
    provider,
    ethersLib,
    body.tokenId,
    privateKey,
    ps.decimals0,
    ps.decimals1,
    price0,
    price1,
  );
  const total = amounts.amount0 * price0 + amounts.amount1 * price1;
  const poolShare = {};
  await addPoolShare(poolShare, amounts, position, ps, ethersLib, provider);
  return {
    position,
    ps,
    price0,
    price1,
    fetchedPrice0,
    fetchedPrice1,
    value,
    amounts,
    feesUsd,
    composition: total > 0 ? (amounts.amount0 * price0) / total : null,
    poolShare0Pct: poolShare.poolShare0Pct,
    poolShare1Pct: poolShare.poolShare1Pct,
  };
}

/** Resolve entry value from user deposit, disk config, or chain baseline (historical prices). */
async function _resolveEntryValue(
  provider,
  ethersLib,
  position,
  posKey,
  diskConfig,
) {
  const baseline = await _resolveBaseline(
    provider,
    ethersLib,
    position,
    posKey,
    diskConfig,
  );
  const deposit = diskConfig.positions[posKey]?.initialDepositUsd || 0;
  const entryValue = deposit > 0 ? deposit : baseline?.entryValue || 0;
  console.log(
    "[details] entryValue for %s: deposit=%s baseline.entry=%s → %s",
    posKey,
    deposit,
    baseline?.entryValue,
    entryValue,
  );
  return { baseline, entryValue };
}

/** Summarize baseline for client consumption. */
function _baselineSummary(bl) {
  if (!bl)
    return {
      hodlBaseline: null,
      baselineEntryValue: 0,
      hodlBaselineNew: false,
      hodlBaselineFallback: false,
      mintDate: null,
      mintTimestamp: null,
      hodlAmount0: null,
      hodlAmount1: null,
    };
  const hasAmounts = bl.hodlAmount0 > 0 || bl.hodlAmount1 > 0;
  return {
    hodlBaseline: bl,
    baselineEntryValue: bl.entryValue || 0,
    hodlBaselineNew: bl.entryValue > 0,
    hodlBaselineFallback: !bl.entryValue && hasAmounts,
    mintDate: bl.mintDate || null,
    mintTimestamp: bl.mintTimestamp || null,
    hodlAmount0: bl.hodlAmount0 ?? null,
    hodlAmount1: bl.hodlAmount1 ?? null,
  };
}

/** Phase 1: fast data (pool state, prices, value, composition, current P&L). */
async function computeQuickDetails(
  provider,
  ethersLib,
  body,
  diskConfig,
  privateKey,
) {
  const {
    position,
    ps,
    price0,
    price1,
    fetchedPrice0,
    fetchedPrice1,
    value,
    amounts,
    feesUsd,
    composition,
    poolShare0Pct,
    poolShare1Pct,
  } = await _fetchPoolData(provider, ethersLib, body, privateKey);
  const posKey = compositeKey(
    "pulsechain",
    body.walletAddress || "",
    body.contractAddress || config.POSITION_MANAGER,
    body.tokenId,
  );
  const { baseline, entryValue } = await _resolveEntryValue(
    provider,
    ethersLib,
    position,
    posKey,
    diskConfig,
  );
  const residuals = await _walletResiduals(
    provider,
    ethersLib,
    position,
    ps,
    price0,
    price1,
    body.walletAddress || "",
  );
  const cur = _currentPnl(
    baseline,
    value,
    entryValue,
    feesUsd,
    price0,
    price1,
    residuals,
  );
  const poolState = {
    tick: ps.tick,
    price: ps.price,
    decimals0: ps.decimals0,
    decimals1: ps.decimals1,
    poolAddress: ps.poolAddress,
  };
  return {
    ok: true,
    poolState,
    price0,
    price1,
    fetchedPrice0,
    fetchedPrice1,
    value: cur.value,
    amounts,
    feesUsd,
    composition,
    poolShare0Pct,
    poolShare1Pct,
    inRange: ps.tick >= body.tickLower && ps.tick < body.tickUpper,
    lowerPrice: rangeMath.tickToPrice(
      body.tickLower,
      ps.decimals0,
      ps.decimals1,
    ),
    upperPrice: rangeMath.tickToPrice(
      body.tickUpper,
      ps.decimals0,
      ps.decimals1,
    ),
    entryValue,
    ...cur,
    ..._baselineSummary(baseline),
  };
}

module.exports = {
  computeQuickDetails,
  // Shared helpers used by position-details.js (lifetime path)
  _currentPnl,
  _applyPriceOverrides,
  _baselineSummary,
  _walletResiduals,
};
