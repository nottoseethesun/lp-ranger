"use strict";

/**
 * @file test/helpers/pool-read-stand-in.js
 * @description The chain as the Manage route's pool check reads it: each
 *   NFT open, alone in a pool of its own. The route refuses a position
 *   whose pool it cannot read (src/pool-already-managed.js), so a test
 *   that drives a Manage past that check passes these as the route's
 *   `ethersLib` and `readProvider`.
 */

/**
 * The route dependencies that answer the pool check.
 * @returns {{ethersLib: object, readProvider: Function}}
 */
function poolReadStandIn() {
  return {
    ethersLib: {
      Contract: class {
        async positions(id) {
          return {
            token0: "0x" + "a1".repeat(20),
            token1: "0x" + String(id).padStart(40, "0"),
            fee: 2500n,
            liquidity: 5000n,
          };
        }
      },
    },
    readProvider: () => ({}),
  };
}

module.exports = { poolReadStandIn };
