/**
 * @file hodl-baseline.js
 * @module hodlBaseline
 * @description
 * Initializes the HODL baseline for impermanent loss calculation.
 * Looks up historical token prices from GeckoTerminal at the position's
 * first mint timestamp to compute an accurate IL benchmark.
 */

'use strict';

const config = require('./config');
const { fetchHistoricalPriceGecko } = require('./price-fetcher');
const { getPoolState } = require('./rebalancer');

/** ABI fragment for ERC-721 Transfer events. */
const _TRANSFER_ABI = [
  'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
];

/**
 * Compute token amounts for a V3 position at a given tick.
 * Duplicated from bot-loop to avoid circular dependency.
 * @param {bigint|number} liquidity  Position liquidity.
 * @param {number} currentTick       Current pool tick.
 * @param {number} tickLower         Lower tick bound.
 * @param {number} tickUpper         Upper tick bound.
 * @param {number} decimals0         Token0 decimals.
 * @param {number} decimals1         Token1 decimals.
 * @returns {{amount0: number, amount1: number}} Human-readable token amounts.
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
 * Compute USD value of a V3 position given token prices.
 * Duplicated from bot-loop to avoid circular dependency.
 * @param {object} position  V3 position with liquidity + tick range.
 * @param {object} poolState Pool state with tick + decimals.
 * @param {number} price0    Token0 USD price.
 * @param {number} price1    Token1 USD price.
 * @returns {number} USD value.
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
 * Look up historical token prices from GeckoTerminal and set the HODL baseline.
 * Queries the NFT mint Transfer event to find the position creation timestamp,
 * then fetches OHLCV candle data from GeckoTerminal at that timestamp.
 *
 * @param {object} provider   Ethers provider.
 * @param {object} ethersLib  Ethers library (for Contract).
 * @param {object} position   Active V3 position.
 * @param {object} botState   Shared bot state.
 * @param {Function} updateBotState  State update callback.
 */
async function initHodlBaseline(provider, ethersLib, position, botState, updateBotState) {
  if (botState.hodlBaseline) return;
  try {
    // Find pool address via Factory
    const factoryAbi = ['function getPool(address,address,uint24) view returns (address)'];
    const factory = new ethersLib.Contract(config.FACTORY, factoryAbi, provider);
    const poolAddress = await factory.getPool(position.token0, position.token1, position.fee);
    if (!poolAddress || poolAddress === ethersLib.ZeroAddress) return;
    // Find NFT mint timestamp via Transfer(from=0x0)
    const iface = new ethersLib.Interface(_TRANSFER_ABI);
    const mintFilter = {
      address: config.POSITION_MANAGER,
      topics: [
        iface.getEvent('Transfer').topicHash,
        ethersLib.zeroPadValue?.('0x' + '0'.repeat(40), 32)
          || '0x' + '0'.repeat(64),
        null,
        '0x' + BigInt(position.tokenId).toString(16).padStart(64, '0'),
      ],
    };
    const logs = await provider.getLogs(mintFilter);
    if (!logs.length) return;
    const block = await provider.getBlock(logs[0].blockNumber);
    if (!block) return;
    const mintTimestamp = block.timestamp;
    // Fetch historical prices from GeckoTerminal
    const { price0, price1 } = await fetchHistoricalPriceGecko(poolAddress, mintTimestamp);
    if (price0 <= 0 || price1 <= 0) {
      console.warn('[bot] GeckoTerminal returned no historical prices — using live prices for IL baseline');
      botState.hodlBaselineFallback = true;
      updateBotState({ hodlBaselineFallback: true });
      return;
    }
    // Compute entry value at historical prices
    const poolState = await getPoolState(provider, ethersLib, {
      factoryAddress: config.FACTORY,
      token0: position.token0, token1: position.token1, fee: position.fee,
    });
    const entryValue = _positionValueUsd(position, poolState, price0, price1);
    const mintDate = new Date(mintTimestamp * 1000).toISOString().slice(0, 10);
    const baseline = { entryValue, token0UsdPrice: price0, token1UsdPrice: price1, mintDate };
    botState.hodlBaseline = baseline;
    botState.hodlBaselineNew = true;
    updateBotState({ hodlBaseline: baseline, hodlBaselineNew: true });
    console.log(`[bot] HODL baseline set from GeckoTerminal: $${entryValue.toFixed(2)} on ${mintDate}`);
  } catch (err) {
    console.warn('[bot] HODL baseline init error:', err.message);
  }
}

module.exports = { initHodlBaseline, _positionValueUsd };
