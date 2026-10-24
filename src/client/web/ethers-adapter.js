/**
 * @file ethers-adapter.js
 * @description Thin ES module adapter that re-exports ethers.js from the npm
 * package.  esbuild resolves this import from node_modules at bundle time.
 */

import { ethers } from 'ethers';
export { ethers };
