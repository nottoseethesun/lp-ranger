/**
 * @file test/nft-gas-unknown.test.js
 * @description
 * What an NFT's gas total reports when a receipt does not come back.
 *
 * What a transaction cost is on its receipt — gas used times gas price —
 * so an NFT's whole gas is its mint receipt plus the receipt of every
 * later charge against it. The mint is the largest single one.
 *
 * A receipt that cannot be read therefore leaves the total **unknown**,
 * and unknown is not the same as smaller. The distinction matters here
 * more than in most places because of what the callers do with the
 * figure: they save it per NFT, and they read that saved value back by
 * presence alone. A short total written once is accepted as fact on every
 * later poll, so the position's gas stays understated and its profit
 * overstated for good — and nothing looks wrong, because a plausible
 * number is indistinguishable from a correct one.
 *
 * Two failure shapes reach the same place and both must report unknown: a
 * read that throws, and a read that returns `null`, which is what an
 * endpoint says about a transaction it does not have.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

const { classifyCompounds, _fetchCompoundGas } = require("../src/compounder");
const { applyCurrentNftFigures } = require("../src/bot-pnl-current-nft");
const sendTx = require("../src/send-transaction");
const rpcQueue = require("../src/rpc-request-manager");
const outOfService = require("../src/rpc-out-of-service");
const logModule = require("../src/log");

const MINT_TX = "0xmint";
const COMPOUND_TX = "0xcompound";

/** A receipt whose gas is unmistakable in a total. */
const RECEIPT = { gasUsed: 100_000n, gasPrice: 1_000_000_000n };
const RECEIPT_WEI = 100_000n * 1_000_000_000n;

let restoreLog;

beforeEach(() => {
  sendTx._resetForTests();
  rpcQueue._resetForTests();
  outOfService._resetForTests();
  restoreLog = logModule._setSinkForTests({
    log: () => {},
    warn: () => {},
    error: () => {},
  });
});

afterEach(() => {
  if (restoreLog) restoreLog();
  sendTx._resetForTests();
  rpcQueue._resetForTests();
  outOfService._resetForTests();
});

/**
 * Register a stub library whose receipts come from `byHash`.
 *
 * `classifyCompounds` reads receipts through the endpoint gateway rather
 * than a provider it is handed, so the stub is installed there.
 *
 * @param {object} byHash  hash → receipt, or a function to throw from.
 * @returns {void}
 */
function useReceipts(byHash) {
  const lib = {
    JsonRpcProvider: class {
      constructor(url) {
        this._url = url;
        this.pollingInterval = 1;
      }
      async getTransactionReceipt(hash) {
        const answer = byHash[hash];
        if (typeof answer === "function") return answer();
        /*- Absent from the map means the endpoint does not have it, which
         *  it reports as null rather than as an error. */
        return answer ?? null;
      }
      async getBlock() {
        return { timestamp: 1700000000 };
      }
      send() {
        return Promise.resolve(null);
      }
    },
  };
  sendTx.init({ urls: ["http://nft-gas.test"] }, lib);
}

/**
 * The event set `classifyCompounds` expects.
 *
 * `ilEvents[0]` is always the mint; anything after it is a candidate
 * compound. No DecreaseLiquidity events, so nothing is filtered out as
 * belonging to a rebalance window.
 *
 * @param {boolean} withCompound  Include one standalone compound.
 * @returns {object} nftEvents
 */
function events(withCompound) {
  const mint = {
    txHash: MINT_TX,
    blockNumber: 10,
    amount0: 1000n,
    amount1: 2000n,
  };
  const compound = {
    txHash: COMPOUND_TX,
    blockNumber: 20,
    amount0: 10n,
    amount1: 20n,
  };
  return {
    ilEvents: withCompound ? [mint, compound] : [mint],
    collectEvents: [],
    dlEvents: [],
    ilLogsCount: withCompound ? 2 : 1,
  };
}

describe("an NFT's gas total when a receipt will not come back", () => {
  it("reports a real total when every receipt reads", async () => {
    /*- The baseline the other cases are measured against: both receipts
     *  answer, so the total is their sum and is safe to save. */
    useReceipts({ [MINT_TX]: RECEIPT, [COMPOUND_TX]: RECEIPT });

    const r = await classifyCompounds(events(true), { decimals0: 8 });

    assert.strictEqual(
      r.totalNftGasWei,
      String(RECEIPT_WEI * 2n),
      "mint plus the one compound",
    );
  });

  it("reports unknown when the mint's receipt is absent", async () => {
    /*- The common case and the costly one. The mint is an NFT's largest
     *  charge, so a total that silently drops it reads as a cheaper
     *  position than it was. */
    useReceipts({ [COMPOUND_TX]: RECEIPT });

    const r = await classifyCompounds(events(true), { decimals0: 8 });

    assert.strictEqual(
      r.totalNftGasWei,
      null,
      "an unread mint receipt leaves the total unknown, not short",
    );
  });

  it("reports unknown when the mint's receipt read throws", async () => {
    useReceipts({
      [MINT_TX]: () => {
        throw new Error("server response 502 Bad Gateway");
      },
      [COMPOUND_TX]: RECEIPT,
    });

    const r = await classifyCompounds(events(true), { decimals0: 8 });

    assert.strictEqual(r.totalNftGasWei, null);
  });

  it("reports unknown when one compound's receipt is absent", async () => {
    /*- The partial. Everything else read fine, so the total is a
     *  plausible number that happens to be missing one charge — the
     *  shape least likely to be noticed and so the one most worth
     *  refusing to save. */
    useReceipts({ [MINT_TX]: RECEIPT });

    const r = await classifyCompounds(events(true), { decimals0: 8 });

    assert.strictEqual(
      r.totalNftGasWei,
      null,
      "one missing charge makes the whole total unknown",
    );
  });

  it("still reports zero when there is no transaction to price", async () => {
    /*- Not a failure. An absent hash means there is no transaction here
     *  to have cost anything, so zero is the honest answer and must stay
     *  distinguishable from a read that did not come back. */
    useReceipts({});
    const noHash = events(false);
    noHash.ilEvents[0].txHash = null;

    const r = await classifyCompounds(noHash, { decimals0: 8 });

    assert.strictEqual(r.totalNftGasWei, "0");
  });

  it("leaves the displayed gas unset rather than zero when it is unknown", async () => {
    /*- What the operator sees. A zero here is a claim that the NFT cost
     *  nothing to run, which is the false figure this whole change exists
     *  to stop showing. Left unset, the dashboard reads it as "not
     *  computed" and shows the running epoch's gas instead — the
     *  behaviour the code has described in a comment all along without
     *  ever doing it.
     *
     *  Driven through the scan's own refusal path: with no signer there
     *  is nothing to scan with, so the gas is unknown for the plainest
     *  possible reason. */
    const snap = {};
    await applyCurrentNftFigures(
      snap,
      { _lastPrice0: 1, _lastPrice1: 1 },
      { tokenId: 42 },
      { decimals0: 8, decimals1: 8 },
    );

    assert.strictEqual(
      snap.currentGasUsd,
      undefined,
      "an unknown gas figure must stay absent, not become $0",
    );
  });

  it("flags an incomplete set at the point the receipts are read", async () => {
    /*- The flag the aggregate is built from, asserted on its own so a
     *  future caller of this helper inherits the warning rather than
     *  having to rediscover it. */
    useReceipts({});
    const prov = sendTx.getManagedReadProvider();

    const complete = await _fetchCompoundGas(prov, []);
    assert.strictEqual(
      complete.gasComplete,
      true,
      "nothing asked, nothing missing",
    );

    const missing = await _fetchCompoundGas(prov, [
      { txHash: COMPOUND_TX, blockNumber: 20, amount0: 1n, amount1: 2n },
    ]);
    assert.strictEqual(missing.gasComplete, false);
    assert.strictEqual(missing.totalGasWei, 0n, "the total is what was read");
  });
});
