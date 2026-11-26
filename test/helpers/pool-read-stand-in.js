"use strict";

/**
 * @file test/helpers/pool-read-stand-in.js
 * @description The chain as Manage's pool check reads it: each NFT open,
 *   unless a test says it holds no liquidity, alone in a pool of its own.
 *   Manage refuses a position whose pool it cannot read
 *   (src/bot/pool-already-managed.js), so a test that drives a Manage
 *   past that check passes these as the bot's `ethersLib` and
 *   `readProvider` (src/bot/position-lifecycle.js), which the test's
 *   position routes hand it (test/_bot-route-adapters.js).
 */

/**
 * The route dependencies that answer the pool check.
 * @param {{liquidity?: bigint}} [opts]  The liquidity every NFT reads
 *   with: 5000 unless given, an open position; 0n for a closed one.
 * @returns {{ethersLib: object, readProvider: Function}}
 */
function poolReadStandIn(opts = {}) {
  const liquidity = opts.liquidity === undefined ? 5000n : opts.liquidity;
  return {
    ethersLib: {
      Contract: class {
        async positions(id) {
          return {
            token0: "0x" + "a1".repeat(20),
            token1: "0x" + String(id).padStart(40, "0"),
            fee: 2500n,
            liquidity,
          };
        }
      },
    },
    readProvider: () => ({}),
  };
}

module.exports = { poolReadStandIn };
