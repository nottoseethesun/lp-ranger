"use strict";

/**
 * @file src/lib/composite-key.js
 * @module composite-key
 * @description
 * The one rule for reading a position's composite key,
 * `<chain>-<wallet>-<contract>-<tokenId>`, back into its parts.
 * `compositeKey()` in `src/lib/bot-config-v2.js` builds the key; this reads it.
 *
 * **Deliberately dependency-free**, as `src/lib/pool-key.js` and
 * `src/lib/range-check.js` are. The server reads keys with it, and so do the
 * offline tools in `util/`, some of which must not load the app's modules:
 * loading them reads the operator's config, and reading it has side
 * effects. Keeping this file free of imports is what lets one rule serve
 * both; a copy kept by the tools would drift from it.
 *
 * Add no `require` to this file.
 */

/**
 * Parse a composite key back into its components.
 *
 * Read from the right: the last three segments are always the wallet, the
 * contract and the tokenId, none of which can contain a dash, and
 * everything before them is the chain. A chain name may contain dashes of
 * its own — `pulsechain-testnet` does — so counting segments from the
 * left would misread every key on such a chain.
 *
 * A chain part holding an address-like segment is refused. That is the
 * shape of a pool key (`chain-contract-wallet-token0-token1-fee`), whose
 * last three segments would otherwise pass for a position.
 *
 * Returns null if the key format is invalid.
 * @param {string} key
 * @returns {{ blockchain: string, wallet: string, contract: string, tokenId: string }|null}
 */
function parseCompositeKey(key) {
  if (typeof key !== "string" || key === "") return null;
  const parts = key.split("-");
  if (parts.length < 4) return null;
  const [wallet, contract, tokenId] = parts.slice(-3);
  const chainParts = parts.slice(0, -3);
  const blockchain = chainParts.join("-");
  if (
    blockchain.length === 0 ||
    chainParts.some((p) => p.startsWith("0x")) ||
    !wallet.startsWith("0x") ||
    !contract.startsWith("0x")
  )
    return null;
  return { blockchain, wallet, contract, tokenId };
}

module.exports = { parseCompositeKey };
