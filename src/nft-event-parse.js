"use strict";

/**
 * @file src/nft-event-parse.js
 * @module nft-event-parse
 * @description
 * The position manager's event interface, and the decoder for the three
 * NFT history events (`IncreaseLiquidity`, `Collect`,
 * `DecreaseLiquidity`).
 *
 * Shared by the single-NFT scanner in `src/compounder.js` and the
 * whole-chain batch fetch in `src/nft-events-batch.js`, so both decode
 * logs with the same code. A **leaf module**: nothing in `src/` but the
 * ABI is required here, so both can depend on it without `src/` gaining
 * a dependency cycle.
 */

/*-
 *  The package itself, not its `ethers` namespace export. Both work
 *  against the real package, but tests that replace `ethers` supply only
 *  the top-level shape, and a destructured `{ ethers }` reads
 *  `undefined` from those stubs.
 */
const ethers = require("ethers");
const { PM_ABI } = require("./pm-abi");

/**
 * Interface over the position-manager ABI.
 *
 * One instance, shared. Building an `ethers.Interface` parses the whole
 * ABI, so a per-call instance would repeat that work on every scan.
 */
const IFACE = new ethers.Interface(PM_ABI);

/**
 * Decode raw logs into the shape the compound and P&L code consumes.
 *
 * Skips anything that fails to parse rather than throwing: a log the
 * ABI cannot decode is not one of ours, and one unexpected entry must
 * not lose the rest of an NFT's history.
 *
 * @param {object} iface   ethers Interface (injected so callers can pass
 *   a narrower one in tests).
 * @param {object[]} logs  Raw logs as an RPC returns them.
 * @returns {Array<{amount0: *, amount1: *, liquidity: *, blockNumber: number, txHash: string}>}
 */
function parseLogs(iface, logs) {
  const out = [];
  for (const log of logs) {
    try {
      const p = iface.parseLog({ topics: log.topics, data: log.data });
      out.push({
        amount0: p.args.amount0,
        amount1: p.args.amount1,
        liquidity: p.args.liquidity,
        blockNumber: log.blockNumber,
        txHash: log.transactionHash,
      });
    } catch {
      // Not one of ours.
    }
  }
  return out;
}

module.exports = { IFACE, parseLogs };
