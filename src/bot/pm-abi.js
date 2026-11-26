/**
 * @file pm-abi.js
 * @module pmAbi
 * @description
 * The NonfungiblePositionManager ABI, loaded from the
 * `@uniswap/v3-periphery` npm package, which the modules that read the
 * position manager share for positions(), Transfer, Collect,
 * IncreaseLiquidity, etc.  `resolvePoolAddressForToken`
 * (src/bot/pool-creation-block.js) declares its own `positions()` fragment
 * instead.
 */

"use strict";

const artifact = require("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");

/** Full NonfungiblePositionManager ABI from @uniswap/v3-periphery. */
const PM_ABI = artifact.abi;

module.exports = { PM_ABI };
