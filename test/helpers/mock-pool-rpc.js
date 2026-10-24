"use strict";

/**
 * @file test/helpers/mock-pool-rpc.js
 * @description A stand-in chain for the real `getPoolState`
 *   (src/lib/rebalancer-pools.js), shared by the tests that run it.
 *
 *   `getPoolState` takes its endpoints from the app's failover, so a test
 *   stands that layer up with a mocked ethers library, as the app does at
 *   boot (`withMockRpc`). The mock's `Contract` answers the calls the read
 *   makes: the factory's pool and tick spacing, each token's decimals and
 *   the pool's slot0 (`makeMockEthers`). Nothing leaves the machine.
 */

/**
 * Run `fn` with the app's failover stood up on the mocked ethers library
 * `lib`, then tear it down. The failover is reset first, since `init`
 * keeps the providers it has when the url list matches and would quietly
 * reuse the previous case's mock. buildProvider accepts the mock: with no
 * `Network.from` it builds a plain `new JsonRpcProvider(url)`, and both
 * of its patches return early on a stub with no `send` or `getFeeData`.
 * @param {object} lib  A library from `makeMockEthers`.
 * @param {Function} fn  The work to run.
 * @returns {Promise<*>}  What `fn` returns.
 */
function withMockRpc(lib, fn) {
  const sendTx = require("../../src/lib/send-transaction");
  const { RPC_URLS } = require("../../src/lib/config");
  sendTx._resetForTests();
  sendTx.init({ urls: [...RPC_URLS] }, lib);
  return (async () => fn())().finally(() => sendTx._resetForTests());
}

const FACTORY = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const TOKEN0 = "0xA0b73E1Ff0B80914AB6fe0444E65848C4C34450b";
const TOKEN1 = "0xAEbcD0F8f69ECF9587e292bdfc4d731c1abedB68";
const POOL = "0x3d3fF0F4FD039f8d94effA935678128072B72f6B";
const ZERO = "0x0000000000000000000000000000000000000000";

/**
 * A mocked ethers library whose `Contract` returns an object with the
 * methods the pool-state read calls. Its defaults give a valid pool state
 * for the (TOKEN0, TOKEN1) pair: TOKEN0 has 8 decimals, TOKEN1 18. Each
 * field in `responses` overrides one default; it is checked with `in`,
 * not `??`, so a test can set a field to `undefined` or `null` and have
 * that value come through.
 * @param {object} [responses]  Overrides by field: poolAddress,
 *   tickSpacing, decimals0, decimals1, sqrtPriceX96, tick.
 * @returns {{lib: object, constructed: string[]}}  The library, and the
 *   url of each provider built from it.
 */
function makeMockEthers(responses = {}) {
  const has = (k) => Object.prototype.hasOwnProperty.call(responses, k);
  const constructed = [];
  function Contract(address) {
    /*-
     *  What each method returns depends on the contract's address: the
     *  factory answers pool and fee questions, each token its decimals,
     *  the pool its slot0.
     */
    return {
      getPool: async () => (has("poolAddress") ? responses.poolAddress : POOL),
      feeAmountTickSpacing: async () =>
        has("tickSpacing") ? responses.tickSpacing : 200,
      decimals: async () => {
        if (address === TOKEN0 && has("decimals0")) return responses.decimals0;
        if (address === TOKEN1 && has("decimals1")) return responses.decimals1;
        if (address === TOKEN0) return 8;
        if (address === TOKEN1) return 18;
        return 18;
      },
      slot0: async () => ({
        sqrtPriceX96: has("sqrtPriceX96")
          ? responses.sqrtPriceX96
          : 79228162514264337593543950336n,
        tick: has("tick") ? responses.tick : 310280,
      }),
    };
  }
  function JsonRpcProvider(url) {
    constructed.push(url);
  }
  return {
    lib: { Contract, JsonRpcProvider, ZeroAddress: ZERO },
    constructed,
  };
}

module.exports = {
  withMockRpc,
  makeMockEthers,
  FACTORY,
  TOKEN0,
  TOKEN1,
  POOL,
  ZERO,
};
