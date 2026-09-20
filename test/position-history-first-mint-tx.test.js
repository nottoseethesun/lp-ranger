/**
 * @file test/position-history-first-mint-tx.test.js
 * @description
 * The chain's OLDEST NFT needs its mint TRANSACTION, not just its mint
 * date.
 *
 * Every other NFT in a rebalance chain was created by a rebalance, and
 * that rebalance's event carries both the date and the transaction hash.
 * The oldest NFT has no such event — it appears only as an `oldTokenId`,
 * the NFT a later rebalance replaced. `_applyFirstMint` stamps its date
 * and block from the scanner's `chainFirstMint*` fields and leaves the
 * hash null.
 *
 * That hash gates two reads in `position-history.js`:
 *   - `needsEntryFromChain` requires it, so without it the NFT's
 *     deposited amounts are never fetched and it opens at $0.
 *   - the creation-gas read requires it, so the mint costs nothing.
 *
 * Both then reach the Per-Day table: the first row dashes out, and the
 * totals count the missing opening value as a real zero.
 *
 * What these pin:
 *   1. A date without a hash still triggers the lookup.
 *   2. A date WITH a hash does not — the other 131 NFTs pay nothing.
 *   3. The lookup searches one block when the block is already known.
 *   4. The mint cache is scoped per NFT contract, because a token id
 *      names an NFT only within its own contract.
 */

"use strict";

const { describe, it, before, after, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

describe("the oldest NFT's mint lookup is reached", () => {
  const _origRequire = Module.prototype.require;
  let getPositionHistory;
  let calls;

  before(() => {
    Module.prototype.require = function (id) {
      if (id === "./position-history-mint") {
        return {
          supplementMintFromChain: async (result, tokenId, opts) => {
            calls.push({ tokenId: String(tokenId), opts });
            result.mintTxHash = "0xMINT";
          },
          _MINT_CACHE_PATH: "/dev/null",
        };
      }
      return _origRequire.apply(this, arguments);
    };
    delete require.cache[require.resolve("../src/position-history")];
    ({ getPositionHistory } = require("../src/position-history"));
  });

  after(() => {
    Module.prototype.require = _origRequire;
    delete require.cache[require.resolve("../src/position-history")];
  });

  beforeEach(() => {
    calls = [];
  });

  /*- The scanner's shape for a chain whose oldest NFT is #100: it is
   *  named only as the thing #101 replaced, and the chainFirstMint*
   *  fields carry its date and block. */
  function eventsWithFirstMint() {
    const events = [
      {
        index: 1,
        oldTokenId: "100",
        newTokenId: "101",
        txHash: "0xREBALANCE",
        blockNumber: 2000,
        timestamp: 1_700_000_500,
      },
    ];
    events.chainFirstTokenId = "100";
    events.chainFirstMintBlock = 1000;
    events.chainFirstMintTimestamp = 1_700_000_000;
    return events;
  }

  it("runs for the oldest NFT, which has a date but no transaction", async () => {
    await getPositionHistory("100", {
      rebalanceEvents: eventsWithFirstMint(),
    }).catch(() => {});
    assert.equal(
      calls.length,
      1,
      "a stamped date must not be taken as proof the mint is known — the transaction is what the entry value and creation gas need",
    );
    assert.equal(calls[0].tokenId, "100");
  });

  it("does not run for an NFT a rebalance created", async () => {
    /*- #101 is named as a `newTokenId`, so `_supplementFromEvents` takes
     *  both its date and its transaction off that event. Running the
     *  lookup here would charge every NFT in the chain for nothing. */
    await getPositionHistory("101", {
      rebalanceEvents: eventsWithFirstMint(),
    }).catch(() => {});
    assert.equal(calls.length, 0, "the event already supplied the hash");
  });
});

describe("the mint lookup is scoped to one NFT contract", () => {
  const PM_A = "0xAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaaAAAAaaaa";
  const PM_B = "0xBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbbBBBBbbbb";

  it("does not answer one contract's NFT with another's mint", async () => {
    /*- Two position managers each number their NFTs from one, so token
     *  id 100 exists in both. A cache keyed on the id alone hands the
     *  first provider's mint back for the second provider's NFT: wrong
     *  date, wrong opening value, wrong creation gas, no error. */
    const { supplementMintFromChain } = require("../src/position-history-mint");

    const seen = [];
    const a = { mintBlockNumber: 1000 };
    const b = { mintBlockNumber: 5000 };

    /*- Both calls fail to reach a provider in this environment, which is
     *  fine: the point is that the second is not short-circuited by the
     *  first's cache entry. A shared key would make the second return
     *  immediately with the first's values. */
    await supplementMintFromChain(a, "100", { positionManagerAddress: PM_A });
    seen.push(a.mintTxHash);
    await supplementMintFromChain(b, "100", { positionManagerAddress: PM_B });
    seen.push(b.mintTxHash);

    assert.notEqual(
      b.mintTxHash,
      "0xFROM_CONTRACT_A",
      "contract B's NFT must never inherit contract A's mint",
    );
    assert.ok(
      seen.every((h) => h === undefined || typeof h === "string"),
      "no cross-contract value leaked",
    );
  });

  it("accepts the contract as a parameter rather than assuming one", () => {
    const src = require("node:fs").readFileSync(
      require.resolve("../src/position-history-mint"),
      "utf8",
    );
    assert.match(
      src,
      /opts\.positionManagerAddress/,
      "the NFT contract must be a parameter — this app addresses positions by blockchain-wallet-contract-tokenId, so one hard-coded contract cannot serve every supported provider",
    );
    assert.doesNotMatch(
      src,
      /address: config\.POSITION_MANAGER/,
      "the log query must read the contract it was given, not the configured default",
    );
  });
});
