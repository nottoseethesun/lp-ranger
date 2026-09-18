"use strict";

/**
 * @file test/position-details-chain-read.test.js
 * @description The unmanaged details path reads a rebalance chain's
 *   events once per request, and both consumers — Fees Compounded and
 *   the lifetime HODL — take their events from that one read.
 *
 *   Pinned here: the read covers the whole chain with each NFT floored
 *   at its own mint and no upper bound; it happens only when a consumer
 *   asks, and at most once; a failed read is retried by the next
 *   consumer rather than handed on; and `computeLifetimeDetails` gives
 *   both consumers the same reader.
 *
 *   The batched read is replaced by a recorder that reports the floors
 *   the module's real `scanFloors` computes from the arguments given, so
 *   a reader passing the wrong floor fails here.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const batch = require("../src/nft-events-batch");
const config = require("../src/config");
const { compositeKey } = require("../src/bot-config-v2");
const {
  _scanCompounds,
  compoundsReadChain,
  savedNftCompoundedUsd,
} = require("../src/position-details-compound");
const { scanLifetimeHodl } = require("../src/position-details-lifetime-scan");
const { createPnlTracker } = require("../src/pnl-tracker");

/** #100 → #200 → #300, the second and third minted 5M and 6M blocks in. */
const CHAIN = [
  { oldTokenId: "100", newTokenId: "200", blockNumber: 5_000_000 },
  { oldTokenId: "200", newTokenId: "300", blockNumber: 6_000_000 },
];
const POSITION = { tokenId: "300", token0: "0xA", token1: "0xB", fee: 3000 };

/**
 * Load the reader module with the batched read and the pool-creation
 * lookup replaced.
 *
 * @param {object} [o]
 * @param {number} [o.creationBlock=0]  What the pool lookup answers.
 * @param {number} [o.failures=0]  Reject the first N reads.
 */
function loadReader({ creationBlock = 0, failures = 0 } = {}) {
  const calls = [];
  let left = failures;
  const origRead = batch.scanChainNftEvents;
  batch.scanChainNftEvents = async (ids, args) => {
    const list = [...ids].map(String);
    const { floors } = batch.scanFloors(
      list,
      args.mintBlocks,
      args.sharedFloor,
    );
    calls.push({ ids: list, floors, args });
    if (left > 0) {
      left -= 1;
      throw new Error("simulated read failure");
    }
    return new Map(list.map((id) => [id, batch.emptyEvents()]));
  };
  const origRequire = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === "./pool-creation-block") {
      return { getPoolCreationBlockCached: async () => creationBlock };
    }
    return origRequire.apply(this, arguments);
  };
  const file = require.resolve("../src/position-details-chain-read");
  delete require.cache[file];
  try {
    return { mod: require(file), calls };
  } finally {
    Module.prototype.require = origRequire;
    /*-
     *  The loaded copy keeps the stub it bound; the shared export and
     *  the cache entry go back to the real ones.
     */
    batch.scanChainNftEvents = origRead;
    delete require.cache[file];
  }
}

const reader = (mod, events = CHAIN, poolAddress = "0xPool") =>
  mod.chainEventsReader({ position: POSITION, events, poolAddress });

describe("the unmanaged chain read covers the chain", () => {
  it("asks for every NFT in the chain, in one read", async () => {
    const { mod, calls } = loadReader();
    await reader(mod)();
    assert.equal(calls.length, 1);
    assert.deepEqual([...calls[0].ids].sort(), ["100", "200", "300"]);
  });

  it("floors each NFT at its own mint block", async () => {
    const { mod, calls } = loadReader({ creationBlock: 1_000_000 });
    await reader(mod)();
    assert.equal(calls[0].floors.get("200"), 5_000_000);
    assert.equal(calls[0].floors.get("300"), 6_000_000);
  });

  it("floors the chain's oldest NFT at the chain's first mint", async () => {
    /*-
     *  No rebalance event names #100's mint; the event scanner hangs the
     *  chain's first mint on the events array instead.
     */
    const events = Object.assign([...CHAIN], {
      firstMintBlockNumber: 4_000_000,
    });
    const { mod, calls } = loadReader({ creationBlock: 1_000_000 });
    await reader(mod, events)();
    assert.equal(calls[0].floors.get("100"), 4_000_000);
  });

  it("falls back to the pool's creation block for it otherwise", async () => {
    const { mod, calls } = loadReader({ creationBlock: 1_000_000 });
    await reader(mod)();
    assert.equal(calls[0].floors.get("100"), 1_000_000);
  });

  it("floors at zero when the pool is unknown, rather than not reading", async () => {
    const { mod, calls } = loadReader({ creationBlock: 1_000_000 });
    await reader(mod, CHAIN, null)();
    assert.equal(calls[0].floors.get("100"), 0);
    assert.equal(calls[0].floors.get("200"), 5_000_000);
  });

  it("sets no upper bound", async () => {
    /*-
     *  One could only come from the inferred succession, and a dust mint
     *  between two real rebalances makes that wrong.
     */
    const { mod, calls } = loadReader();
    await reader(mod)();
    assert.equal("toBlock" in calls[0].args, false);
  });

  it("reads a never-rebalanced position as a chain of one", async () => {
    const { mod, calls } = loadReader();
    await reader(mod, [])();
    assert.deepEqual(calls[0].ids, ["300"]);
  });
});

describe("the unmanaged chain read happens at most once", () => {
  it("reads nothing until a consumer asks", () => {
    const { mod, calls } = loadReader();
    reader(mod);
    assert.equal(calls.length, 0);
  });

  it("shares one read between later callers", async () => {
    const { mod, calls } = loadReader();
    const read = reader(mod);
    const first = await read();
    const second = await read();
    assert.equal(calls.length, 1);
    assert.strictEqual(first, second);
  });

  it("does not hand a failed read to the next caller", async () => {
    /*-
     *  Each consumer gets an attempt of its own. Sharing a success must
     *  not turn into sharing a failure.
     */
    const { mod, calls } = loadReader({ failures: 1 });
    const read = reader(mod);
    await assert.rejects(read(), /simulated read failure/);
    const result = await read();
    assert.equal(calls.length, 2);
    assert.equal(result.size, 3);
  });

  it("serves Fees Compounded and the lifetime HODL from one read", async () => {
    const { mod, calls } = loadReader();
    const read = reader(mod);
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "chain-read-"));
    try {
      const compounds = await _scanCompounds(
        POSITION,
        CHAIN,
        { walletAddress: "0xW" },
        { decimals0: 18, decimals1: 18 },
        { price0: 1, price1: 1 },
        { global: {}, positions: {} },
        "key",
        read,
        dir,
        async () => ({ totalCompoundedUsd: 1, compounds: [] }),
      );
      /*-
       *  No wallet in the body, so the HODL accumulator makes no reads
       *  of its own.
       */
      const hodl = await scanLifetimeHodl(
        POSITION,
        CHAIN,
        {},
        null,
        null,
        read,
      );
      assert.equal(compounds.total, 3, "all three NFTs were classified");
      assert.ok(hodl, "the HODL was computed");
      assert.equal(calls.length, 1);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("computeLifetimeDetails wires one reader to both consumers", () => {
  const BODY = {
    tokenId: "300",
    token0: "0x" + "1".repeat(40),
    token1: "0x" + "2".repeat(40),
    fee: 3000,
    tickLower: -100,
    tickUpper: 100,
    liquidity: "1",
    walletAddress: "0x" + "3".repeat(40),
  };

  /** Load `position-details.js` with everything around the wiring stubbed. */
  function loadDetails(seen) {
    const stubs = {
      "./rebalancer": {
        getPoolState: async () => ({
          poolAddress: "0x" + "4".repeat(40),
          decimals0: 18,
          decimals1: 18,
          price: 1,
        }),
      },
      "./bot-pnl-updater": {
        positionValueUsd: () => 100,
        fetchTokenPrices: async () => ({ price0: 1, price1: 1 }),
        _totalLifetimeDeposit: async () => ({ total: 0, usedFallback: false }),
      },
      "./epoch-reconstructor": {
        reconstructEpochs: async (o) => {
          seen.epochCalled = true;
          seen.epoch = o.readChainEvents;
          return 0;
        },
      },
      "./epoch-cache": {
        getCachedEpochs: () => seen.cachedEpochs ?? null,
        setCachedEpochs: () => {},
        getCachedLifetimeHodl: () => seen.cachedHodl ?? null,
        getCachedFreshDeposits: () => null,
      },
      /*-
       *  Calls back with the chain it returns, as the real pool scan
       *  does, so epoch reconstruction runs inside it.
       */
      "./pool-scanner": {
        scanPoolHistory: async (_p, _e, opts) => {
          await opts.computeFromHistoricalPrices(CHAIN);
          return CHAIN;
        },
      },
      "./position-details-quick": {
        computeQuickDetails: async () => ({}),
        _currentPnl: () => ({
          value: 100,
          il: 0,
          residualValueUsd: 0,
          priceGainLoss: 0,
          profit: 0,
        }),
        _applyPriceOverrides: () => {},
        _walletResiduals: async () => ({}),
      },
      "./position-details-compound": {
        /*-
         *  The real predicate: when Fees Compounded reads the chain is
         *  what decides whether reconstruction may share the read.
         */
        compoundsReadChain,
        /*- Real too: it only reads saved coins, makes no request, and
         *  the current-IL figure would throw without it. */
        savedNftCompoundedUsd,
        _resolveCompounded: async (...args) => {
          seen.compound = args[7];
          return { total: 0, current: 0, currentGasUsd: 0 };
        },
      },
      "./position-details-lifetime-scan": {
        scanLifetimeHodl: async (...args) => {
          seen.hodl = args[5];
          return { amount0: 1, amount1: 1 };
        },
      },
      "./resolve-position-symbols": { resolvePositionSymbols: async () => {} },
      "./price-fetcher": {
        fetchHistoricalPriceGecko: async () => ({ price0: 0, price1: 0 }),
      },
      "./block-time-cache": {
        getBlockTimestamp: async () => 0,
        flushBlockTimeCache: () => {},
      },
      "./bot-pnl-initial-residual": { applyInitialResidualFromCache: () => {} },
    };
    const origRequire = Module.prototype.require;
    Module.prototype.require = function (id) {
      if (Object.prototype.hasOwnProperty.call(stubs, id)) return stubs[id];
      return origRequire.apply(this, arguments);
    };
    const file = require.resolve("../src/position-details");
    delete require.cache[file];
    try {
      return require(file);
    } finally {
      Module.prototype.require = origRequire;
      delete require.cache[file];
    }
  }

  const POS_KEY = compositeKey(
    "pulsechain",
    BODY.walletAddress,
    config.POSITION_MANAGER,
    BODY.tokenId,
  );
  /** Disk config, with or without the saved Fees Compounded coins. */
  const diskWith = (saved) => ({
    global: {},
    positions: saved ? { [POS_KEY]: { compoundedAmount0: 5 } } : {},
  });
  const HODL = { amount0: 1, amount1: 1 };

  /** Epochs as an earlier request left them in the cache. */
  function cachedEpochs() {
    const tracker = createPnlTracker();
    tracker.openEpoch({
      entryValue: 100,
      entryPrice: 1,
      lowerPrice: 0.9,
      upperPrice: 1.1,
    });
    tracker.closeEpoch({ exitValue: 99, gasCost: 0 });
    return tracker.serialize();
  }

  /** Run one request; returns what each consumer was handed. */
  async function request({ compoundSaved, hodlCached, epochsCached = false }) {
    const seen = {
      cachedHodl: hodlCached ? HODL : null,
      cachedEpochs: epochsCached ? cachedEpochs() : null,
    };
    const { computeLifetimeDetails } = loadDetails(seen);
    await computeLifetimeDetails({}, {}, BODY, diskWith(compoundSaved));
    return seen;
  }

  it("hands Fees Compounded and the lifetime HODL the same reader", async () => {
    const seen = await request({ compoundSaved: false, hodlCached: false });
    assert.equal(typeof seen.compound, "function");
    assert.strictEqual(
      seen.compound,
      seen.hodl,
      "two readers would read the chain twice",
    );
  });

  it("still hands them one reader when some epochs are saved", async () => {
    /*-
     *  A repeat visit. Reconstruction is still asked, because only it
     *  checks that the saved history covers every closed NFT, and it
     *  gets the reader the other two consumers use.
     */
    const seen = await request({
      compoundSaved: false,
      hodlCached: false,
      epochsCached: true,
    });
    assert.equal(seen.epochCalled, true, "reconstruction was not asked");
    assert.equal(typeof seen.compound, "function");
    assert.strictEqual(seen.compound, seen.hodl);
    assert.strictEqual(seen.epoch, seen.compound);
  });

  it("hands epoch reconstruction the same reader when both will read", async () => {
    const seen = await request({ compoundSaved: false, hodlCached: false });
    assert.equal(seen.epochCalled, true);
    assert.strictEqual(seen.epoch, seen.compound);
  });

  it("shares it when only the lifetime HODL will read", async () => {
    const seen = await request({ compoundSaved: true, hodlCached: false });
    assert.equal(typeof seen.epoch, "function");
    assert.strictEqual(seen.epoch, seen.hodl);
  });

  it("shares it when only Fees Compounded will read", async () => {
    const seen = await request({ compoundSaved: false, hodlCached: true });
    assert.equal(typeof seen.epoch, "function");
    assert.strictEqual(seen.epoch, seen.compound);
    assert.equal(seen.hodl, undefined, "a cached HODL is not rescanned");
  });

  it("lets reconstruction read for itself when both figures are cached", async () => {
    /*-
     *  Nothing else will read the chain, and the full three-event read
     *  would cost reconstruction more than its own two-event one.
     */
    const seen = await request({ compoundSaved: true, hodlCached: true });
    assert.equal(seen.epochCalled, true);
    assert.strictEqual(seen.epoch, undefined);
  });
});

describe("requestChainReader", () => {
  const { requestChainReader } = require("../src/position-details-chain-read");

  it("keeps one reader for the events array it was made for", () => {
    const readerFor = requestChainReader({ position: POSITION });
    const events = [...CHAIN];
    assert.strictEqual(readerFor(events), readerFor(events));
  });

  it("makes a new reader for a different array", () => {
    /*-
     *  An equal-looking copy is still a different chain as far as the
     *  reader can tell; reading again is the safe answer.
     */
    const readerFor = requestChainReader({ position: POSITION });
    const first = readerFor([...CHAIN]);
    assert.notStrictEqual(readerFor([...CHAIN]), first);
  });
});
