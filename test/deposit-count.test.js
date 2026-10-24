/**
 * @file test/deposit-count.test.js
 * @description The deposit count (src/deposit-count.js): the deposits the
 *   owner made to the wallet since the last count, counted before each
 *   rebalance and compound, and when a poll sees the wallet's coins rise.
 *
 *   A move's count is the record: its deposits go into the pool's
 *   Lifetime results at their own blocks, each naming its transaction,
 *   with how far it read, and are priced into Total Lifetime Deposit. A
 *   poll's count only brings the figures up to date between moves: it is
 *   held in memory, and the next move's count reads the same blocks again
 *   and records its own answer in its place. A count starts after the
 *   latest of the last read, the newest mint the results cover and the
 *   current NFT's mint, and never stops the move it runs for.
 *
 *   The chain, the epoch cache and the price services are stand-ins, so
 *   nothing here reads the network or writes the operator's caches.
 */

"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");
const {
  TRANSFER_TOPIC0,
  mockProvider,
  mockEthers,
} = require("./helpers/lifetime-hodl-fixtures");

const E = mockEthers();
const WALLET = "0xW";
const T0 = "0xT0";
const T1 = "0xT1";

let provider = null;
let windows = [];
let lookups = 0;
// Set to make every price lookup fail, as a price service that is down.
let pricesDown = false;
// Runs at each price lookup, standing in for what else happens meanwhile.
let onLookup = () => {};
const writes = { lifetime: [], fresh: [] };

const _origRequire = Module.prototype.require;
Module.prototype.require = function (id) {
  if (id === "./send-transaction")
    return { getManagedReadProvider: () => provider };
  if (id === "./epoch-cache")
    return {
      getCachedLifetimeHodl: () => null,
      getCachedFreshDeposits: () => null,
      setCachedLifetimeHodl: (_k, v) =>
        writes.lifetime.push(JSON.parse(JSON.stringify(v))),
      setCachedFreshDeposits: (_k, v) =>
        writes.fresh.push(JSON.parse(JSON.stringify(v))),
    };
  // Each deposit's own block is priced at two dollars and three dollars.
  if (id === "./price-fetcher")
    return {
      fetchHistoricalPriceGecko: async () => {
        lookups += 1;
        onLookup();
        if (pricesDown) throw new Error("price service down");
        return { price0: 2, price1: 3 };
      },
      fetchTokenPriceUsd: async () => 0,
    };
  if (id === "./block-time-cache")
    return {
      getBlockTimestamp: async () => 1_700_000_000,
      flushBlockTimeCache: () => {},
    };
  if (id === "./rebalancer-pools")
    return { getPoolState: async () => ({ poolAddress: "0xPOOL" }) };
  return _origRequire.apply(this, arguments);
};
const { countDeposits, countDepositsOnRise } = require("../src/deposit-count");
Module.prototype.require = _origRequire;

/** A token0 or token1 arrival in the wallet from outside. */
function arrival(token, amount, block, tx) {
  return {
    address: token,
    topics: [
      TRANSFER_TOPIC0,
      E.zeroPadValue("0xFriend", 32),
      E.zeroPadValue(WALLET, 32),
    ],
    data: "0x" + BigInt(amount).toString(16).padStart(64, "0"),
    blockNumber: block,
    transactionHash: tx,
  };
}

/**
 * A chain whose head is `head`, holding `logs`, noting each window read.
 * `whileReading` runs at the first read, standing in for whatever else
 * the bot does while a count waits on the chain.
 */
function chain(head, logs, whileReading = () => {}) {
  const inner = mockProvider({ logs });
  let first = true;
  provider = {
    getBlockNumber: async () => head,
    getLogs: (f) => {
      if (first) whileReading();
      first = false;
      windows.push(f.fromBlock);
      return inner.getLogs(f);
    },
  };
}

/*-
 *  NFT #100, minted at block 210 by the rebalance from #50. Five of token0
 *  arrived at block 300 and six of token1 at 400; one more of token0 at
 *  block 200 went into the mint.
 */
const LOGS = [
  arrival(T0, 100, 200, "0xold"),
  arrival(T0, 500, 300, "0xa"),
  arrival(T1, 600, 400, "0xb"),
];

/** The bot's deps for #100, with its Lifetime results as the scan left them. */
function deps(lifetime = {}) {
  const emitted = [];
  return {
    emitted,
    _botState: {
      lifetimeHodlAmounts: {
        amount0: 10,
        amount1: 20,
        raw0: "0",
        raw1: "0",
        lastBlock: 210,
        deposits: [
          { raw0: "1000", raw1: "2000", block: 10, kind: "fresh", usd: 80 },
        ],
        poolAddress: "0xPOOL",
        ...lifetime,
      },
      totalLifetimeDepositUsd: 80,
    },
    position: {
      tokenId: "100",
      token0: T0,
      token1: T1,
      fee: 3000,
      decimals0: 2,
      decimals1: 2,
    },
    address: WALLET,
    _rebalanceEvents: [
      { oldTokenId: "50", newTokenId: "100", blockNumber: 210 },
    ],
    _pnlTracker: { _epochKey: { wallet: WALLET } },
    _ethersLib: E,
    updateBotState: (p) => emitted.push(p),
  };
}

beforeEach(() => {
  windows = [];
  lookups = 0;
  pricesDown = false;
  onLookup = () => {};
  writes.lifetime = [];
  writes.fresh = [];
});

describe("a move's count", () => {
  it("records each deposit since the current NFT's mint into the Lifetime results", async () => {
    chain(500, LOGS);
    const d = deps();
    const r = await countDeposits(d, "move");
    assert.deepEqual(r, { counted: true, added: true });
    const lt = d._botState.lifetimeHodlAmounts;
    assert.equal(lt.amount0, 15, "the five of token0 are put in");
    assert.equal(lt.amount1, 26, "the six of token1 are put in");
    assert.equal(lt.raw0, "500");
    assert.equal(lt.raw1, "600");
    assert.deepEqual(
      lt.deposits.slice(1).map((e) => [e.txHash, e.block, e.kind, e.usd]),
      [
        ["0xa", 300, "fresh", 10],
        ["0xb", 400, "fresh", 18],
      ],
      "each at its own block's price; the one before the mint is not counted",
    );
    assert.equal(lt.countedThrough, 500);
    assert.equal(d._botState.totalLifetimeDepositUsd, 108);
  });

  it("saves the record to both caches, with how far it read, and again once priced", async () => {
    chain(500, LOGS);
    await countDeposits(deps(), "move");
    assert.equal(writes.lifetime.length, 2);
    assert.equal(writes.fresh.length, 2);
    for (const saved of writes.fresh) {
      assert.equal(saved.countedThrough, 500);
      assert.equal(saved.lastBlock, 210);
      assert.equal(saved.raw0, "500");
      assert.equal(saved.deposits.length, 3);
    }
    assert.deepEqual(
      writes.fresh[1].deposits.slice(1).map((e) => e.usd),
      [10, 18],
      "the second save carries the prices",
    );
  });

  it("starts after the last read, the newest mint covered, or the mint, whichever is latest", async () => {
    for (const lifetime of [{ countedThrough: 350 }, { lastBlock: 350 }]) {
      chain(500, LOGS);
      windows = [];
      const d = deps(lifetime);
      await countDeposits(d, "move");
      assert.deepEqual([...new Set(windows)], [351]);
      assert.deepEqual(
        d._botState.lifetimeHodlAmounts.deposits.slice(1).map((e) => e.txHash),
        ["0xb"],
      );
    }
    chain(500, LOGS);
    windows = [];
    const later = deps();
    later._rebalanceEvents = [
      { oldTokenId: "50", newTokenId: "100", blockNumber: 350 },
    ];
    await countDeposits(later, "move");
    assert.deepEqual([...new Set(windows)], [351], "the mint at 350");
  });

  it("records nothing new and still saves how far it read when nothing arrived", async () => {
    chain(500, []);
    const d = deps();
    const r = await countDeposits(d, "move");
    assert.deepEqual(r, { counted: true, added: false });
    assert.equal(d._botState.lifetimeHodlAmounts.deposits.length, 1);
    assert.equal(d._botState.lifetimeHodlAmounts.countedThrough, 500);
    assert.equal(writes.fresh[0].countedThrough, 500);
  });
});

describe("a poll's count", () => {
  it("holds what it finds in memory, outside the Lifetime results", async () => {
    chain(500, LOGS);
    const d = deps();
    const r = await countDeposits(d, "poll");
    assert.deepEqual(r, { counted: true, added: true });
    assert.equal(d._botState.lifetimeHodlAmounts.deposits.length, 1);
    assert.equal(writes.lifetime.length + writes.fresh.length, 0, "no write");
    const held = d._botState._depositOverlay;
    assert.equal(held.through, 500);
    assert.deepEqual(
      held.entries.map((e) => [e.txHash, e.usd]),
      [
        ["0xa", 10],
        ["0xb", 18],
      ],
    );
  });

  it("goes on from where the last poll's ended", async () => {
    chain(500, LOGS);
    const d = deps();
    d._botState._depositOverlay = {
      through: 350,
      entries: [
        { raw0: "500", raw1: "0", block: 300, kind: "fresh", txHash: "0xa" },
      ],
    };
    await countDeposits(d, "poll");
    assert.deepEqual([...new Set(windows)], [351]);
    assert.deepEqual(
      d._botState._depositOverlay.entries.map((e) => e.txHash),
      ["0xa", "0xb"],
    );
  });

  it("is replaced by the next move's count, which keeps the prices it fetched", async () => {
    chain(500, LOGS);
    const d = deps();
    await countDeposits(d, "poll");
    assert.equal(lookups, 2);
    chain(600, [...LOGS, arrival(T0, 300, 550, "0xc")]);
    windows = [];
    const r = await countDeposits(d, "move");
    assert.deepEqual([...new Set(windows)], [211], "the same blocks again");
    assert.equal(d._botState._depositOverlay, null);
    assert.deepEqual(
      d._botState.lifetimeHodlAmounts.deposits.slice(1).map((e) => e.txHash),
      ["0xa", "0xb", "0xc"],
    );
    assert.equal(lookups, 3, "only the new deposit's price is looked up");
    assert.deepEqual(r, { counted: true, added: true });
  });

  it("leaves a move's count nothing to add when it had found everything", async () => {
    chain(500, LOGS);
    const d = deps();
    await countDeposits(d, "poll");
    const r = await countDeposits(d, "move");
    assert.deepEqual(r, { counted: true, added: false });
  });
});

describe("what changed while a count read the chain", () => {
  it("a Reload that cleared the Lifetime results drops the move's count", async () => {
    const d = deps();
    chain(500, LOGS, () => {
      d._botState.lifetimeHodlAmounts = null;
    });
    assert.deepEqual(await countDeposits(d, "move"), {
      counted: false,
      added: false,
    });
    assert.equal(d._botState.lifetimeHodlAmounts, null, "the rebuild's to do");
    assert.equal(writes.lifetime.length + writes.fresh.length, 0);
  });

  it("a Reload that cleared them drops a poll's count too", async () => {
    const d = deps();
    chain(500, LOGS, () => {
      d._botState.lifetimeHodlAmounts = null;
    });
    assert.equal((await countDeposits(d, "poll")).counted, false);
    assert.equal(d._botState._depositOverlay, undefined);
  });

  it("newer results a scan wrote take the deposits, once", async () => {
    /*-
     *  A Rebalance Now during a Lifetime scan: the scan wrote its results
     *  while the count read, one of the two deposits among them already,
     *  saved by an earlier count.
     */
    const d = deps();
    const newer = {
      amount0: 15,
      amount1: 20,
      raw0: "500",
      raw1: "0",
      lastBlock: 210,
      deposits: [
        { raw0: "500", raw1: "0", block: 300, kind: "fresh", txHash: "0xA" },
      ],
      poolAddress: "0xPOOL",
      countedThrough: 320,
    };
    chain(500, LOGS, () => {
      d._botState.lifetimeHodlAmounts = newer;
    });
    await countDeposits(d, "move");
    const lt = d._botState.lifetimeHodlAmounts;
    assert.deepEqual(
      lt.deposits.map((e) => e.txHash),
      ["0xA", "0xb"],
    );
    assert.equal(lt.amount0, 15, "the five are not counted twice");
    assert.equal(lt.amount1, 26);
    assert.equal(lt.countedThrough, 500);
  });
});

describe("what changed while a count's deposits were priced", () => {
  it("a Lifetime scan finishing then finds them in the epoch cache", async () => {
    /*-
     *  A scan keeps the counts saved while it ran by reading the cache
     *  when it writes (`withLaterCounts`). Its write can land while this
     *  count's deposits are being priced, so they must be in the cache
     *  by then, not only in memory.
     */
    chain(500, LOGS);
    const inCache = [];
    onLookup = () => inCache.push(writes.fresh.at(-1)?.deposits.length);
    await countDeposits(deps(), "move");
    assert.deepEqual(inCache, [3, 3], "both lookups found all three saved");
  });

  it("a Reload that cleared the results then leaves them cleared", async () => {
    const d = deps();
    chain(500, LOGS);
    onLookup = () => {
      d._botState.lifetimeHodlAmounts = null;
    };
    assert.deepEqual(await countDeposits(d, "move"), {
      counted: false,
      added: false,
    });
    assert.equal(d._botState.lifetimeHodlAmounts, null);
    assert.equal(writes.lifetime.length, 1, "nothing written after the clear");
  });
});

describe("a price service that is down", () => {
  it("leaves a move's deposits recorded, unpriced", async () => {
    pricesDown = true;
    chain(500, LOGS);
    const d = deps();
    const r = await countDeposits(d, "move");
    assert.deepEqual(r, { counted: true, added: true });
    const lt = d._botState.lifetimeHodlAmounts;
    assert.deepEqual(
      lt.deposits.slice(1).map((e) => [e.txHash, e.usd]),
      [
        ["0xa", undefined],
        ["0xb", undefined],
      ],
    );
    assert.equal(lt.amount0, 15, "the coins count all the same");
    assert.equal(writes.fresh.length, 2, "saved, before the pricing and after");
  });

  it("leaves a poll's deposits held, unpriced", async () => {
    pricesDown = true;
    chain(500, LOGS);
    const d = deps();
    assert.equal((await countDeposits(d, "poll")).counted, true);
    assert.equal(d._botState._depositOverlay.entries.length, 2);
  });
});

describe("a count that cannot run", () => {
  it("waits while the Lifetime results do not exist yet", async () => {
    chain(500, LOGS);
    const d = deps();
    d._botState.lifetimeHodlAmounts = null;
    assert.deepEqual(await countDeposits(d, "move"), {
      counted: false,
      added: false,
    });
    assert.equal(windows.length, 0);
  });

  it("waits while the current NFT's mint block is unknown", async () => {
    chain(500, LOGS);
    const d = deps();
    d._rebalanceEvents = [];
    assert.equal((await countDeposits(d, "move")).counted, false);
    assert.equal(windows.length, 0);
  });

  it("is answered as not counted when a read fails, never thrown", async () => {
    provider = {
      getBlockNumber: async () => {
        throw new Error("endpoint down");
      },
    };
    const d = deps();
    const before = d._botState.lifetimeHodlAmounts;
    assert.deepEqual(await countDeposits(d, "move"), {
      counted: false,
      added: false,
    });
    assert.equal(d._botState.lifetimeHodlAmounts, before);
    assert.equal(writes.lifetime.length + writes.fresh.length, 0);
  });
});

describe("a poll's count on a rise in the wallet's coins", () => {
  const coins = (raw0, raw1) => ({ raw0, raw1 });

  it("runs on the first poll, then only when the coins rise", async () => {
    chain(500, LOGS);
    const d = deps();
    await countDepositsOnRise(d, coins(500n, 600n));
    assert.ok(windows.length > 0, "the first poll counts");
    windows = [];
    await countDepositsOnRise(d, coins(500n, 600n));
    await countDepositsOnRise(d, coins(400n, 600n));
    assert.equal(windows.length, 0, "no rise, no count");
    assert.deepEqual(d._botState._depositWalletSeen, coins(400n, 600n));
    chain(600, [...LOGS, arrival(T1, 1, 550, "0xc")]);
    windows = [];
    await countDepositsOnRise(d, coins(400n, 601n));
    assert.deepEqual(
      [...new Set(windows)],
      [501],
      "a rise counts the new blocks",
    );
    assert.equal(d._botState._depositOverlay.entries.at(-1).txHash, "0xc");
  });

  it("counts on the first poll after a move's count, even when the wallet fell", async () => {
    /*-
     *  The poll before the move saw 500 and 600. The move took most of
     *  those coins, and one of token0 arrived after its count read the
     *  chain: the wallet now holds less than that poll saw, and the
     *  deposit is still counted.
     */
    chain(500, LOGS);
    const d = deps();
    await countDepositsOnRise(d, coins(500n, 600n));
    await countDeposits(d, "move");
    chain(600, [...LOGS, arrival(T0, 1, 550, "0xc")]);
    windows = [];
    await countDepositsOnRise(d, coins(30n, 40n));
    assert.deepEqual([...new Set(windows)], [501]);
    assert.equal(d._botState._depositOverlay.entries.at(-1).txHash, "0xc");
  });

  it("keeps the old reading when the count could not run, so the next poll asks again", async () => {
    chain(500, LOGS);
    const d = deps();
    d._botState._depositWalletSeen = coins(1n, 1n);
    d._botState.lifetimeHodlAmounts = null;
    await countDepositsOnRise(d, coins(9n, 9n));
    assert.deepEqual(d._botState._depositWalletSeen, coins(1n, 1n));
  });
});
