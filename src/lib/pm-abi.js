/**
 * @file pm-abi.js
 * @module pmAbi
 * @description
 * Single source of truth for the NonfungiblePositionManager ABI.  Loaded from
 * the `@uniswap/v3-periphery` npm package so every module shares the same
 * canonical definitions for positions(), Transfer, Collect,
 * IncreaseLiquidity, etc.
 */

"use strict";

const artifact = require("@uniswap/v3-periphery/artifacts/contracts/NonfungiblePositionManager.sol/NonfungiblePositionManager.json");

/** Full NonfungiblePositionManager ABI from @uniswap/v3-periphery. */
const PM_ABI = artifact.abi;

module.exports = { PM_ABI };
