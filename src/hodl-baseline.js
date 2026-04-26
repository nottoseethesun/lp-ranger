/**
 * @file hodl-baseline.js
 * @module hodlBaseline
 * @description
 * Initializes the HODL baseline for impermanent loss calculation.
 * Looks up historical token prices from GeckoTerminal at the position's
 * first mint timestamp to compute an accurate IL benchmark.
 */

"use strict";

const config = require("./config");
const { PM_ABI } = require("./pm-abi");
const { fetchHistoricalPriceGecko } = require("./price-fetcher");
const { getPoolState } = require("./rebalancer");

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
function _positionAmounts(
  liquidity,
  currentTick,
  tickLower,
  tickUpper,
  decimals0,
  decimals1,
) {
  // eslint-disable-next-line 9mm/no-number-from-bigint -- Safe: approximate float math for sqrtPrice
  const liq = Number(liquidity);
  const sqrtP = Math.pow(1.0001, currentTick / 2);
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
    position.liquidity || 0,
    poolState.tick,
    position.tickLower,
    position.tickUpper,
    poolState.decimals0,
    poolState.decimals1,
  );
  return amounts.amount0 * price0 + amounts.amount1 * price1;
}

/**
 * Read actual deposited token amounts from the IncreaseLiquidity event in a mint TX.
 * @param {object} provider   Ethers provider.
 * @param {object} ethersLib  Ethers library.
 * @param {object} iface      PM interface for event parsing.
 * @param {object} position   V3 position (tokenId, token0, token1, fee).
 * @param {string} txHash     Mint transaction hash.
 * @returns {Promise<{hodlAmount0: number, hodlAmount1: number, mintGasWei: string}>}
 */
async function _readMintedAmounts(
  provider,
  ethersLib,
  iface,
  position,
  txHash,
) {
  try {
    const receipt = await provider.getTransactionReceipt(txHash);
    if (!receipt) return { hodlAmount0: 0, hodlAmount1: 0, mintGasWei: "0" };
    const mintGasWei =
      (receipt.gasUsed ?? 0n) *
      (receipt.gasPrice ?? receipt.effectiveGasPrice ?? 0n);
    for (const log of receipt.logs) {
      if (log.address.toLowerCase() !== config.POSITION_MANAGER.toLowerCase())
        continue;
      try {
        const p = iface.parseLog({ topics: log.topics, data: log.data });
        if (
          p.name === "IncreaseLiquidity" &&
          BigInt(p.args.tokenId) === BigInt(position.tokenId)
        ) {
          const ps = await getPoolState(provider, ethersLib, {
            factoryAddress: config.FACTORY,
            token0: position.token0,
            token1: position.token1,
            fee: position.fee,
          });
          return {
            hodlAmount0: Number(p.args.amount0) / 10 ** ps.decimals0,
            hodlAmount1: Number(p.args.amount1) / 10 ** ps.decimals1,
            mintGasWei: String(mintGasWei),
          };
        }
      } catch {
        /* not our event */
      }
    }
    // Event not found but receipt was readable — still return gas
    return { hodlAmount0: 0, hodlAmount1: 0, mintGasWei: String(mintGasWei) };
  } catch {
    /* receipt unavailable */
  }
  return { hodlAmount0: 0, hodlAmount1: 0, mintGasWei: "0" };
}

/** Find the NFT mint Transfer(from=0x0) event and its block timestamp. */
async function _findMintEvent(provider, ethersLib, iface, tokenId) {
  const tokenIdHex = "0x" + BigInt(tokenId).toString(16).padStart(64, "0");
  const zeroAddr = ethersLib.zeroPadValue
    ? ethersLib.zeroPadValue("0x" + "0".repeat(40), 32)
    : "0x" + "0".repeat(64);
  const logs = await provider.getLogs({
    address: config.POSITION_MANAGER,
    fromBlock: 0,
    toBlock: "latest",
    topics: [iface.getEvent("Transfer").topicHash, zeroAddr, null, tokenIdHex],
  });
  if (!logs.length) {
    console.log("[bot] No mint logs found for tokenId", tokenId);
    return {};
  }
  const block = await provider.getBlock(logs[0].blockNumber);
  if (!block) {
    console.log("[bot] Block not found for mint log");
    return {};
  }
  return { mintTimestamp: block.timestamp, mintLog: logs[0] };
}

/** Patch an existing baseline with missing mint timestamp. */
function _patchMintTimestamp(botState, updateBotState, mintTimestamp) {
  /*- Canonical storage shape is Unix seconds (number).  ISO strings were
      written here historically and remain in older .bot-config.json files;
      consumers normalize on read.  Don't reintroduce ISO writes. */
  const iso = new Date(mintTimestamp * 1000).toISOString();
  botState.hodlBaseline.mintDate = iso.slice(0, 10);
  botState.hodlBaseline.mintTimestamp = mintTimestamp;
  updateBotState({ hodlBaseline: botState.hodlBaseline });
  console.log(`[bot] Patched mint timestamp on existing baseline: ${iso}`);
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
/** Assemble and publish the HODL baseline from minted amounts and historical prices. */
function _publishBaseline(d, botState, updateBotState) {
  const entryValue =
    d.price0 > 0 || d.price1 > 0
      ? d.hodlAmount0 * d.price0 + d.hodlAmount1 * d.price1
      : 0;
  if (entryValue <= 0 && (d.hodlAmount0 > 0 || d.hodlAmount1 > 0))
    console.warn(
      "[bot] GeckoTerminal prices unavailable — entry value auto-detection deferred",
    );
  const baseline = {
    entryValue,
    token0UsdPrice: d.price0,
    token1UsdPrice: d.price1,
    hodlAmount0: d.hodlAmount0,
    hodlAmount1: d.hodlAmount1,
    mintDate: d.mintDate,
    /*- Unix seconds (number) — the canonical shape.  See
        public/dashboard-date-utils.js#toMintTsSeconds for read-side
        normalization that still tolerates legacy ISO strings. */
    mintTimestamp: d.mintTimestamp,
    mintGasWei: d.mintGasWei || "0",
  };
  botState.hodlBaseline = baseline;
  updateBotState({
    hodlBaseline: baseline,
    hodlBaselineNew: entryValue > 0,
    hodlBaselineFallback:
      entryValue <= 0 && (d.hodlAmount0 > 0 || d.hodlAmount1 > 0),
  });
  console.log(
    `[bot] HODL baseline set: $${entryValue.toFixed(2)} on ${d.mintDate} (amounts: ${d.hodlAmount0.toFixed(4)} / ${d.hodlAmount1.toFixed(4)})`,
  );
}

async function initHodlBaseline(
  provider,
  ethersLib,
  position,
  botState,
  updateBotState,
) {
  const needsMintTs =
    botState.hodlBaseline &&
    (!botState.hodlBaseline.mintDate || !botState.hodlBaseline.mintTimestamp);
  // Retry on restart if historical price fetch previously failed (entryValue=0
  // despite real amounts). Lets the popover's "restart to retry" be honest.
  const needsPrice =
    botState.hodlBaseline &&
    !(botState.hodlBaseline.entryValue > 0) &&
    (botState.hodlBaseline.hodlAmount0 > 0 ||
      botState.hodlBaseline.hodlAmount1 > 0);
  if (botState.hodlBaseline && !needsMintTs && !needsPrice) return;
  try {
    // Find pool address via Factory
    const factoryAbi = [
      "function getPool(address,address,uint24) view returns (address)",
    ];
    const factory = new ethersLib.Contract(
      config.FACTORY,
      factoryAbi,
      provider,
    );
    const poolAddress = await factory.getPool(
      position.token0,
      position.token1,
      position.fee,
    );
    if (!poolAddress || poolAddress === ethersLib.ZeroAddress) return;
    const iface = new ethersLib.Interface(PM_ABI);
    const { mintTimestamp, mintLog } = await _findMintEvent(
      provider,
      ethersLib,
      iface,
      position.tokenId,
    );
    if (!mintTimestamp) return;
    if (needsMintTs) {
      _patchMintTimestamp(botState, updateBotState, mintTimestamp);
      return;
    }
    const { hodlAmount0, hodlAmount1, mintGasWei } = await _readMintedAmounts(
      provider,
      ethersLib,
      iface,
      position,
      mintLog.transactionHash,
    );
    // Fetch historical prices for entry value auto-detection (initial deposit)
    const { price0, price1 } = await fetchHistoricalPriceGecko(
      poolAddress,
      mintTimestamp,
      "pulsechain",
      {
        token0Address: position.token0,
        token1Address: position.token1,
        blockNumber: mintLog.blockNumber,
      },
    );
    const mintDate = new Date(mintTimestamp * 1000).toISOString().slice(0, 10);
    _publishBaseline(
      {
        hodlAmount0,
        hodlAmount1,
        price0,
        price1,
        mintDate,
        mintTimestamp,
        mintGasWei,
      },
      botState,
      updateBotState,
    );
  } catch (err) {
    console.warn("[bot] HODL baseline init error:", err.message);
  }
}

/**
 * Compute position baseline (entry amounts, entry value, mint date) from chain data.
 * Standalone version of initHodlBaseline — no bot state needed.
 * @returns {Promise<{entryValue, hodlAmount0, hodlAmount1, mintDate, price0, price1}|null>}
 */
async function getPositionBaseline(provider, ethersLib, position) {
  try {
    const factoryAbi = [
      "function getPool(address,address,uint24) view returns (address)",
    ];
    const factory = new ethersLib.Contract(
      config.FACTORY,
      factoryAbi,
      provider,
    );
    const poolAddress = await factory.getPool(
      position.token0,
      position.token1,
      position.fee,
    );
    if (!poolAddress || poolAddress === ethersLib.ZeroAddress) return null;
    const iface = new ethersLib.Interface(PM_ABI);
    const { mintTimestamp, mintLog } = await _findMintEvent(
      provider,
      ethersLib,
      iface,
      position.tokenId,
    );
    if (!mintTimestamp || !mintLog) return null;
    const { hodlAmount0, hodlAmount1, mintGasWei } = await _readMintedAmounts(
      provider,
      ethersLib,
      iface,
      position,
      mintLog.transactionHash,
    );
    const { price0, price1 } = await fetchHistoricalPriceGecko(
      poolAddress,
      mintTimestamp,
      "pulsechain",
      {
        token0Address: position.token0,
        token1Address: position.token1,
        blockNumber: mintLog.blockNumber,
      },
    );
    const entryValue =
      price0 > 0 || price1 > 0
        ? hodlAmount0 * price0 + hodlAmount1 * price1
        : 0;
    return {
      entryValue,
      hodlAmount0,
      hodlAmount1,
      mintDate: new Date(mintTimestamp * 1000).toISOString().slice(0, 10),
      mintTimestamp,
      mintGasWei: mintGasWei || "0",
      price0,
      price1,
    };
  } catch {
    return null;
  }
}

module.exports = {
  initHodlBaseline,
  getPositionBaseline,
  _positionValueUsd,
};
