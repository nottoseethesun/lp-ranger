/**
 * @file position-details-compound.js
 * @description Compound figures for the unmanaged-position details flow.
 *   Provides:
 *   - `_detectCurrentNftValues`: a one-NFT scan returning
 *     `{ compoundUsd, gasUsd }` for the Current panel.
 *   - `savedNftCompoundedUsd`: the same figure from the coins already on
 *     disk, with no scan at all.
 *   - `savedWalletCoinsPutIn`: the wallet's coins the NFT's compounds
 *     took in beyond their fees, from the saved compound list, which the
 *     Current IL/G measures against with the NFT's minted coins.
 *   - `savedFeesLeftUsd`: the fees the NFT's compounds collected and
 *     left in the wallet, from the same list, which the Current panel
 *     counts among the NFT's fees.
 *   - `savedDepositAdded`: what Initial Deposit for This LP adds to the
 *     NFT's minted coins for the wallet's coins its compounds took in,
 *     from the same list (src/lib/current-lp-deposit.js).
 *
 *   Nothing here walks the rebalance chain. An unmanaged position shows
 *   no Lifetime panel, so the chain-wide classification that produced its
 *   lifetime compounded total had no reader — see the file header of
 *   `position-details.js`.
 */

"use strict";

const { log } = require("./log");
const config = require("./config");
const { getPositionConfig } = require("./bot-config-v2");
const { detectCompoundsOnChain } = require("./compounder");
const { actualGasCostUsd } = require("./bot-pnl-updater");
const { poolCreationFloor } = require("./pool-creation-block");
const { nftCoinsToUsd, coinsToUsd } = require("./coin-value");
const {
  compoundedCoins,
  recordedCompounds,
  walletCoinsPutIn,
  feesLeftInWallet,
} = require("./compounded-coins");
const { compoundPricesFor } = require("./compound-activity-figures");
const { addedSinceMint } = require("./current-lp-deposit");
const { getCachedLifetimeHodl } = require("./epoch-cache");
const { parseCompositeKey } = require("./composite-key");
const {
  mintBlocksByTokenId,
  scanFloorFor,
  chainScanFloor,
} = require("./nft-mint-blocks");

/**
 * Convert a chain-scan result for a single NFT into Current-panel values:
 * standalone-compound USD (the fees each compound put back, at the prices
 * given; for a compound the bot recorded, only the fees its record names,
 * src/lib/compounded-coins.js) and total NFT gas USD (mint TX + standalone
 * compound TXs, valued at current native-token price). Both metrics match
 * what the managed liveEpoch surfaces while the bot is running.
 */
async function _currentValuesFromScan(r, recorded, prices, ps) {
  const coins = compoundedCoins(
    r.compounds,
    recorded,
    ps.decimals0,
    ps.decimals1,
  );
  const compoundUsd = coinsToUsd(coins, prices.price0, prices.price1);
  const gasUsd = r.totalNftGasWei
    ? await actualGasCostUsd(BigInt(r.totalNftGasWei))
    : 0;
  return { compoundUsd, gasUsd };
}
/**
 * Detect Current-panel values for the current NFT only (one scan):
 * standalone compound USD and total NFT gas USD.  Bounded to the current
 * NFT's own mint block when the rebalance chain supplies it — this is the
 * warm-cache path, so it runs on every lifetime request, and from the
 * pool's creation block it was scanning years of blocks for an NFT that
 * is usually days old. `savedCompounds` is the position's compound list
 * on disk, which names the fees of each compound the bot made while it
 * managed the position.
 */
async function _detectCurrentNftValues(
  position,
  body,
  ps,
  prices,
  events,
  savedCompounds,
  _detect = detectCompoundsOnChain,
) {
  try {
    /*- The pool-creation lookup is only reached when the chain does not
     *  name this NFT's mint.  Written as a branch rather than as an
     *  argument to `scanFloorFor`, because an argument is evaluated
     *  eagerly — which billed this warm path an RPC round-trip on every
     *  lifetime request for a floor it then discarded. */
    const mintBlocks = mintBlocksByTokenId(events);
    let fromBlock = scanFloorFor(mintBlocks, position.tokenId, null);
    if (fromBlock === null) {
      /*- Never-rebalanced position: this NFT IS the chain's first mint,
       *  so lift the pool floor to it rather than scanning from pool
       *  creation. */
      const creationBlock = await poolCreationFloor(ps.poolAddress);
      fromBlock = chainScanFloor(events, creationBlock);
    }
    const opts = {
      positionManagerAddress: config.POSITION_MANAGER,
      token0: position.token0,
      token1: position.token1,
      token0Symbol: position.token0Symbol,
      token1Symbol: position.token1Symbol,
      fee: position.fee,
      wallet: body.walletAddress,
      price0: prices.price0,
      price1: prices.price1,
      decimals0: ps.decimals0,
      decimals1: ps.decimals1,
      fromBlock,
    };
    const r = await _detect(String(position.tokenId), opts);
    const recorded = recordedCompounds(savedCompounds);
    return await _currentValuesFromScan(r, recorded, prices, ps);
  } catch (e) {
    log.warn(
      "[position details] current-NFT values detection failed:",
      e.message,
    );
    return { compoundUsd: 0, gasUsd: 0 };
  }
}
/**
 * What the named NFT has compounded, from the coins already on disk.
 *
 * The cheap answer: no chain read, no scan. Both request phases use it
 * to take fee earnings out of the LP value before comparing against
 * HODL, so the IL/G an unmanaged position reports matches the managed
 * one.
 *
 * A slot with no saved coins answers zero, and stays zero for as long as
 * the position is unmanaged — only the bot's lifetime scan writes them.
 * Removing nothing is the right answer there rather than a guess: the
 * figure is the LP value as it stands, and it corrects itself the first
 * time the position is managed.
 *
 * @param {object} diskConfig  Loaded bot config.
 * @param {string} posKey      Composite key for the position.
 * @param {string|number} tokenId  The NFT to value.
 * @param {number} price0      Token0 USD price.
 * @param {number} price1      Token1 USD price.
 * @returns {number}  USD value of that NFT's compounded coins.
 */
function savedNftCompoundedUsd(diskConfig, posKey, tokenId, price0, price1) {
  const pos = getPositionConfig(diskConfig, posKey);
  return nftCoinsToUsd(
    pos?.nftCompoundedAmountsByTokenId,
    tokenId,
    price0,
    price1,
  );
}

/**
 * The wallet's coins the NFT's compounds took in beyond their fees, from
 * the compound list the bot saved while it managed the position: coins
 * put into the NFT after its mint, which the Current IL/G measures
 * against with its minted coins, as the bot does (src/lib/bot-pnl-il.js).
 * None for a position the bot never managed.
 *
 * @param {object} diskConfig  Loaded bot config.
 * @param {string} posKey      Composite key for the position.
 * @param {string|number} tokenId  The NFT.
 * @param {{decimals0: number, decimals1: number}} ps  The pool's decimals.
 * @returns {{amount0: number, amount1: number}}
 */
function savedWalletCoinsPutIn(diskConfig, posKey, tokenId, ps) {
  const pos = getPositionConfig(diskConfig, posKey);
  return walletCoinsPutIn(
    pos?.compoundHistory,
    tokenId,
    ps.decimals0,
    ps.decimals1,
  );
}

/**
 * The fees the NFT's compounds collected and could not put back, waiting
 * in the wallet, from the compound list the bot saved while it managed
 * the position, at the caller's prices: the figure the bot shows for the
 * same NFT (src/lib/bot-pnl-current-nft.js). None for a position the bot
 * never managed.
 *
 * @param {object} diskConfig  Loaded bot config.
 * @param {string} posKey      Composite key for the position.
 * @param {string|number} tokenId  The NFT.
 * @param {{decimals0: number, decimals1: number}} ps  The pool's decimals.
 * @param {number} price0  Token0's USD price.
 * @param {number} price1  Token1's USD price.
 * @returns {number}
 */
function savedFeesLeftUsd(diskConfig, posKey, tokenId, ps, price0, price1) {
  const pos = getPositionConfig(diskConfig, posKey);
  const left = feesLeftInWallet(
    pos?.compoundHistory,
    tokenId,
    ps.decimals0,
    ps.decimals1,
  );
  return coinsToUsd(left, price0, price1);
}

/**
 * What Initial Deposit for This LP adds to the NFT's minted coins: the
 * wallet's coins its compounds took in beyond their fees, from the
 * compound list the bot saved while it managed the position, each at its
 * compound's prices, and the liquidity other wallets added to it, from
 * the pool's deposit list the bot's scans saved in the epoch cache
 * (src/lib/current-lp-deposit.js). The figure the bot shows for the same
 * NFT (src/lib/bot-pnl-current-nft.js); none for a position the bot never
 * managed.
 *
 * @param {object} diskConfig  Loaded bot config.
 * @param {string} posKey      Composite key for the position.
 * @param {object} position    The position: `tokenId`, `token0`,
 *   `token1`, `fee`.
 * @param {{decimals0: number, decimals1: number, poolAddress: string}} ps
 *   The pool's state.
 * @param {{price0: number, price1: number}} today  This answer's prices.
 * @returns {Promise<{usd: number, fallback: boolean}>}
 */
function savedDepositAdded(diskConfig, posKey, position, ps, today) {
  const pos = getPositionConfig(diskConfig, posKey);
  const key = parseCompositeKey(posKey);
  const poolKnown =
    key !== null &&
    typeof position.token0 === "string" &&
    typeof position.token1 === "string";
  const saved = poolKnown
    ? getCachedLifetimeHodl({
        contract: key.contract,
        wallet: key.wallet,
        token0: position.token0,
        token1: position.token1,
        fee: position.fee,
      })
    : null;
  const lists = {
    compoundHistory: pos?.compoundHistory,
    deposits: saved?.deposits,
  };
  const pricesAt = compoundPricesFor(
    position,
    null,
    { poolAddress: ps.poolAddress },
    false,
  );
  return addedSinceMint(lists, position.tokenId, ps, pricesAt, today);
}

module.exports = {
  _detectCurrentNftValues,
  savedNftCompoundedUsd,
  savedWalletCoinsPutIn,
  savedFeesLeftUsd,
  savedDepositAdded,
};
