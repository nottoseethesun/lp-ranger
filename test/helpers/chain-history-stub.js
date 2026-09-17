"use strict";

/**
 * @file test/helpers/chain-history-stub.js
 * @description Stand-in for the whole-chain Collect/DecreaseLiquidity
 *   read that epoch reconstruction makes before its per-NFT loop.
 *
 *   Tests that replace `getPositionHistory` with a canned answer never
 *   look at the history handed to it, but the read still runs first.
 *   Left real, it reaches for the managed RPC provider and fails only
 *   because no test initialized one. A suite should not depend on that,
 *   so these tests replace the read alongside the history.
 *
 *   The stub answers every id with null: history unknown.
 */

/** The module id `src/epoch-reconstructor.js` requires the read from. */
const CHAIN_HISTORY_MODULE = "./position-history-scan-helpers";

/**
 * A replacement for that module, as a require hook returns it.
 *
 * @returns {{scanChainCollectAndDrain: Function}}
 */
function chainHistoryStub() {
  return {
    scanChainCollectAndDrain: async (ids) =>
      new Map(ids.map((id) => [String(id), null])),
  };
}

module.exports = { CHAIN_HISTORY_MODULE, chainHistoryStub };
