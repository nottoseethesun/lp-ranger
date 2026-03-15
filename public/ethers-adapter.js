/**
 * @file ethers-adapter.js
 * @description Thin ES module adapter for ethers.js loaded via UMD CDN script.
 * The UMD bundle sets globalThis.ethers; this module re-exports it so other
 * dashboard modules can use standard ES module imports.
 */

const { ethers } = globalThis;
export { ethers };
