"use strict";

/**
 * @file src/pool-key.js
 * @module pool-key
 * @description
 * The single definition of "these two positions are in the same pool".
 *
 * A pool is identified by its token pair and fee tier. Two things make
 * a naive comparison wrong: addresses arrive in either capitalisation
 * (EIP-55 checksummed from one source, lower-case from another), and
 * the pair arrives in either order depending on which side the caller
 * happened to read it from. Normalising both is what stops one pool
 * looking like two.
 *
 * **Deliberately dependency-free**, and that is a constraint, not an
 * accident. Both tiers need this rule: the server decides whether to
 * accept a Manage request, and the dashboard decides whether to offer
 * the button. The dashboard bundle is built by esbuild from
 * `public/dashboard-init.js`, so it can only reach a module that pulls
 * in nothing Node-only — `src/position-manager.js`, which owns the
 * scoped `poolKey` built on this, drags in `async-mutex`, `ethers` and
 * `fs` and cannot cross that line. Keeping this file free of imports is
 * what lets one definition serve both, instead of a copy per tier that
 * drifts.
 *
 * Add no `require` to this file.
 */

/**
 * Canonical key for a token pair and fee tier.
 *
 * Addresses are lower-cased and the pair is sorted before the fee is
 * appended, so neither casing nor the order the caller holds the pair
 * in can change the result.
 *
 * Callers are responsible for rejecting incomplete identities before
 * calling: `String(undefined)` is `"undefined"`, which would make two
 * unknown pools compare equal. `src/pool-already-managed.js` guards on
 * the server side and `_poolKeyOf` in `public/dashboard-manage-ui.js`
 * guards on the client side, each returning null rather than a partial
 * key.
 *
 * @param {string} token0  Either token of the pair, either casing.
 * @param {string} token1  The other token.
 * @param {number|string} fee  Fee tier (e.g. 2500).
 * @returns {string}  `<lowerAddr>-<higherAddr>-<fee>`
 */
function poolPairKey(token0, token1, fee) {
  const a = String(token0).toLowerCase(),
    b = String(token1).toLowerCase();
  const pair = a < b ? a + "-" + b : b + "-" + a;
  return pair + "-" + fee;
}

/**
 * Fully-qualified canonical pool key.
 *
 * `<chain>-<positionManager>-<wallet>-<lowerAddr>-<higherAddr>-<fee>`,
 * every part lower-cased. This is the app's established pool identity:
 * `attachPoolKeys` publishes it on every managed entry in
 * `GET /api/status`, `_poolDailyCounts` counts rebalances against it,
 * and the one-position-per-pool gate compares it.
 *
 * Note the argument order is chain, **contract, wallet** — the reverse
 * of the per-position composite key's `blockchain-wallet-contract-
 * tokenId`. The two are different keys for different things and are
 * not interchangeable.
 *
 * The wallet is part of the identity even though the app manages a
 * single wallet today: a pool is only "already managed" with respect to
 * the wallet holding the position, and leaving it out would make that
 * assumption impossible to lift later.
 *
 * @param {string} chain     Blockchain name (e.g. "pulsechain").
 * @param {string} contract  NonfungiblePositionManager address.
 * @param {string} wallet    Owning wallet address.
 * @param {string} token0
 * @param {string} token1
 * @param {number|string} fee
 * @returns {string}
 */
function poolKey(chain, contract, wallet, token0, token1, fee) {
  return (
    String(chain).toLowerCase() +
    "-" +
    String(contract).toLowerCase() +
    "-" +
    String(wallet).toLowerCase() +
    "-" +
    poolPairKey(token0, token1, fee)
  );
}

module.exports = { poolPairKey, poolKey };
