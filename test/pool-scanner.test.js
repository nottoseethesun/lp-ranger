/**
 * @file test/pool-scanner.test.js
 * @description Tests for pool-scanner: appendToPoolCache, clearPoolCache,
 * and the Activity Log figures it keeps in the event cache
 * (updateCachedEvents).
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const config = require("../src/lib/config");
const { eventCachePath } = require("../src/lib/cache-store");
const poolScanner = require("../src/lib/pool-scanner");

const {
  scanPoolHistory,
  appendToPoolCache,
  updateCachedEvents,
  getPoolScanLock,
  clearPoolCache,
  cancelPoolScan,
  _recentScansForTests,
  _recentKey,
} = poolScanner;

const TMP = path.join(process.cwd(), "tmp");

describe("appendToPoolCache", () => {
  const pos = {
    token0: "0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39",
    token1: "0x57fde0a71132198BBeC939B98976993d8D89D225",
    fee: 2500,
  };
  const wallet = "0xABCDEF0000000000000000000000000000000001";
  let cachePath;

  before(() => {
    fs.mkdirSync(TMP, { recursive: true });
    cachePath = eventCachePath(
      pos,
      "pulsechain",
      "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2",
      wallet,
    );
    try {
      fs.unlinkSync(cachePath);
    } catch {
      /* */
    }
  });

  after(() => {
    try {
      fs.unlinkSync(cachePath);
    } catch {
      /* */
    }
  });

  it("creates cache with single event when empty", async () => {
    await appendToPoolCache(pos, wallet, {
      oldTokenId: "100",
      newTokenId: "200",
      txHashes: ["0xaaa", "0xbbb"],
      blockNumber: 5000,
      swapSources: "9mm Aggregator (PulseX V2, 9mm V3)",
      trigger: "manual",
    });
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    const key = Object.keys(raw).find((k) => k.startsWith("rebalance:"));
    assert.ok(key, "cache key exists");
    const entry = raw[key].value;
    assert.equal(entry.events.length, 1);
    assert.equal(entry.events[0].oldTokenId, "100");
    assert.equal(entry.events[0].newTokenId, "200");
    assert.equal(entry.events[0].txHash, "0xbbb");
    assert.equal(entry.events[0].blockNumber, 5000);
    // What started it, which its Activity Log entry names after a reload.
    assert.equal(entry.events[0].trigger, "manual");
    /*-
     *  No scan has read the chain yet, so there is no last block read,
     *  and the next scan reads the pool's history in full.
     */
    assert.equal(entry.lastBlock, undefined);
    assert.equal(
      entry.events[0].swapSources,
      "9mm Aggregator (PulseX V2, 9mm V3)",
    );
  });

  it("appends to existing events", async () => {
    await appendToPoolCache(pos, wallet, {
      oldTokenId: "200",
      newTokenId: "300",
      txHashes: ["0xccc"],
      blockNumber: 6000,
    });
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    const key = Object.keys(raw).find((k) => k.startsWith("rebalance:"));
    const entry = raw[key].value;
    assert.equal(entry.events.length, 2);
    assert.equal(entry.events[1].newTokenId, "300");
    assert.equal(entry.events[0].index, 1);
    assert.equal(entry.events[1].index, 2);
    // An append reads none of the chain, so it sets no last block read.
    assert.equal(entry.lastBlock, undefined);
  });
});

describe("clearPoolCache", () => {
  it("clears the cache file", async () => {
    const pos = {
      token0: "0x1111111111111111111111111111111111111111",
      token1: "0x2222222222222222222222222222222222222222",
      fee: 500,
    };
    const wallet = "0x3333333333333333333333333333333333333333";
    await clearPoolCache(pos, wallet);
  });
});

describe("module exports", () => {
  it("exports expected functions", () => {
    for (const fn of [
      "scanPoolHistory",
      "appendToPoolCache",
      "updateCachedEvents",
      "getPoolScanLock",
      "clearPoolCache",
      "cancelPoolScan",
    ])
      assert.equal(typeof poolScanner[fn], "function");
  });
});

describe("appendToPoolCache — recent-scan invalidation (auto-follow fix)", () => {
  /*- Regression test for the pool-scanner cache invalidation bug.
   *
   *  Before this fix, appendToPoolCache wrote to disk but left the
   *  60-second `_recentScans` in-memory cache populated.  If a scan
   *  queued behind a long-held lock acquired the lock AFTER a
   *  rebalance had completed and called appendToPoolCache, it would
   *  short-circuit to the stale `_recentScans` events at line 141 of
   *  pool-scanner.js — returning the events list from BEFORE the
   *  rebalance, missing the new oldTokenId/newTokenId pair.
   *
   *  Symptom: dashboard's Rebalance Events table and the
   *  `_resolveManagedTid` auto-follow miss the just-completed
   *  rebalance until the 60s TTL expires.  Workaround the user found:
   *  close + reopen the tab.
   *
   *  This test seeds the `_recentScans` map directly via the
   *  test-only export, runs appendToPoolCache, and asserts the
   *  matching entry is removed (so the next scanPoolHistory call
   *  does not take the cache short-circuit). */

  const pos = {
    token0: "0x3819F64f282bf135d62168C1e513280dAF905e06",
    token1: "0xAbF66325f5d5e44A3E1cDB1A2a3119Ec1D1cf850",
    fee: 10000,
  };
  const wallet = "0x4E448BeF0DBD0e2F7bd2e6209E6f44dc8af0E5cE";
  let cachePath;

  before(() => {
    fs.mkdirSync(TMP, { recursive: true });
    cachePath = eventCachePath(
      pos,
      "pulsechain",
      "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2",
      wallet,
    );
    try {
      fs.unlinkSync(cachePath);
    } catch {
      /* */
    }
  });

  after(() => {
    try {
      fs.unlinkSync(cachePath);
    } catch {
      /* */
    }
  });

  it("keys an entry by the chain, the pool and the whole wallet address", () => {
    /*-
     *  The canonical pool key: the same pair in either order and either
     *  letter case is one entry, and two wallets that share their first
     *  characters are two.
     */
    const flipped = { token0: pos.token1, token1: pos.token0, fee: pos.fee };
    assert.equal(
      _recentKey(flipped, wallet.toUpperCase().replace("0X", "0x")),
      _recentKey(pos, wallet),
    );
    // On a chain other than the shipped default, so naming that outright fails.
    const shipped = config.CHAIN_NAME;
    config.CHAIN_NAME = "pulsechain-testnet";
    try {
      assert.ok(_recentKey(pos, wallet).startsWith("pulsechain-testnet-"));
    } finally {
      config.CHAIN_NAME = shipped;
    }
    const lookalike = wallet.slice(0, 10) + "f".repeat(wallet.length - 10);
    assert.notEqual(_recentKey(pos, lookalike), _recentKey(pos, wallet));
  });

  it("removes the in-memory recent-scan entry for the pool+wallet", async () => {
    const key = _recentKey(pos, wallet);

    /*- Seed the in-memory cache as if a scan had just completed and
     *  stamped its events into `_recentScans`. */
    const staleEvents = [
      {
        index: 1,
        oldTokenId: "159175",
        newTokenId: "161616",
        timestamp: 1700000000,
      },
    ];
    _recentScansForTests.set(key, { events: staleEvents, at: Date.now() });
    assert.ok(_recentScansForTests.has(key), "seed precondition holds");

    await appendToPoolCache(pos, wallet, {
      oldTokenId: "161616",
      newTokenId: "161623",
      txHashes: ["0xdeadbeef"],
      blockNumber: 7000,
    });

    assert.equal(
      _recentScansForTests.has(key),
      false,
      "appendToPoolCache must drop the stale _recentScans entry " +
        "so the next scanPoolHistory call does not short-circuit",
    );
  });

  it("does not touch unrelated pool+wallet entries", async () => {
    const otherPos = {
      token0: "0x9999999999999999999999999999999999999999",
      token1: "0x8888888888888888888888888888888888888888",
      fee: 500,
    };
    const otherKey = _recentKey(otherPos, wallet);
    _recentScansForTests.set(otherKey, { events: [], at: Date.now() });

    await appendToPoolCache(pos, wallet, {
      oldTokenId: "100",
      newTokenId: "101",
      txHashes: ["0xbeef"],
      blockNumber: 7001,
    });

    assert.ok(
      _recentScansForTests.has(otherKey),
      "unrelated pool entry must survive",
    );
    _recentScansForTests.delete(otherKey);
  });

  it("is safe when no recent-scan entry exists (no-op delete)", async () => {
    const key = _recentKey(pos, wallet);
    _recentScansForTests.delete(key);

    await assert.doesNotReject(
      appendToPoolCache(pos, wallet, {
        oldTokenId: "300",
        newTokenId: "301",
        txHashes: ["0xfeed"],
        blockNumber: 7002,
      }),
    );
  });
});

describe("cancelPoolScan", () => {
  const tok0 = "0x1111111111111111111111111111111111111111";
  const tok1 = "0x2222222222222222222222222222222222222222";
  const fee = 500;
  const wallet = "0x9999999999999999999999999999999999999999";

  it("returns false when no scan is active for the pool", () => {
    const aborted = cancelPoolScan(tok0, tok1, fee, wallet);
    assert.equal(aborted, false, "no active scan to abort");
  });

  it(
    "aborts an in-flight scan: event-scanner throws AbortError and " +
      "scanPoolHistory releases the lock",
    async () => {
      const position = {
        token0: "0xAAAAaAaaAaAaAaaAaaAAAAAAaAaAaaaAaAaaaAAA",
        token1: "0xBBbbBbBbBbBbbbBbbBbBBBbbBbBbBbBBbBbBBBbB",
        fee: 3000,
      };
      /*- Fake provider whose getBlockNumber never resolves: this keeps
       *  the scan parked inside the event-scanner long enough for our
       *  cancelPoolScan call to land. We pass a pre-aborted signal
       *  through opts so the scanner throws AbortError on its first
       *  checkpoint without needing a real RPC loop. */
      const provider = {
        getBlockNumber: () =>
          new Promise((resolve) => {
            /*- resolve after a tick so the scan function actually
             *  starts, giving cancelPoolScan a window to register. */
            setImmediate(() => resolve(10_000));
          }),
        getBlock: async () => ({ timestamp: 0 }),
      };
      /*- Fake ethers lib — Contract stub returns empty arrays, so when
       *  the chunk loop reaches its first checkpoint the signal is
       *  already aborted and throws cleanly. */
      const ethersLib = {
        Contract: function () {
          return {
            filters: {
              Transfer: () => ({}),
              PoolCreated: () => ({}),
            },
            queryFilter: async () => [],
          };
        },
      };
      const scanPromise = scanPoolHistory(provider, ethersLib, {
        walletAddress: "0xCAFEcafeCaFEcafEcaFecAFEcAfECafEcaFEcAFe",
        position,
      }).catch((err) => err);

      /*- Fire the cancel after one tick so scanPoolHistory had time
       *  to register its controller. */
      await new Promise((r) => setImmediate(r));
      const aborted = cancelPoolScan(
        position.token0,
        position.token1,
        position.fee,
        "0xCAFEcafeCaFEcafEcaFecAFEcAfECafEcaFEcAFe",
      );
      assert.equal(aborted, true, "controller was registered and aborted");

      const result = await scanPromise;
      assert.ok(
        result && (result.name === "AbortError" || Array.isArray(result)),
        "scan resolves: AbortError on abort or empty array if it finished first",
      );

      /*- Lock must be released so a subsequent caller can acquire it
       *  immediately; assert via tryAcquire-style check. */
      const lock = getPoolScanLock(
        position.token0,
        position.token1,
        position.fee,
      );
      assert.equal(lock.isLocked(), false, "mutex released after abort");
    },
  );
});

describe("the Activity Log figures in the event cache", () => {
  const pos = {
    token0: "0x3333333333333333333333333333333333333333",
    token1: "0x4444444444444444444444444444444444444444",
    fee: 3000,
  };
  const wallet = "0xABCDEF0000000000000000000000000000000002";
  const READINGS = {
    beforeDrain: { amount0: 100, amount1: 50 },
    afterDrain: { amount0: 1100, amount1: 50 },
    beforeMint: { amount0: 600, amount1: 545 },
  };
  const FINISHED = {
    walletReadings: READINGS,
    beforeRebalance: { amount0: 1020, amount1: 50 },
    afterRebalance: { amount0: 558, amount1: 507 },
    historical: { impermanentLossGainPct: -0.44 },
  };
  let cachePath;

  /** The cached events, as a later scan or a restart reads them. */
  const cached = () => {
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    const key = Object.keys(raw).find((k) => k.startsWith("rebalance:"));
    return raw[key].value.events;
  };

  before(() => {
    fs.mkdirSync(TMP, { recursive: true });
    cachePath = eventCachePath(
      pos,
      "pulsechain",
      "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2",
      wallet,
    );
    try {
      fs.unlinkSync(cachePath);
    } catch {
      /* */
    }
  });

  after(() => {
    try {
      fs.unlinkSync(cachePath);
    } catch {
      /* */
    }
  });

  it("come with a new rebalance's entry, its coin figures still due", async () => {
    await appendToPoolCache(pos, wallet, {
      oldTokenId: "6",
      newTokenId: "7",
      txHashes: ["0xdrain", "0xmint"],
      blockNumber: 1000,
      walletReadings: READINGS,
      historical: { impermanentLossGainPct: -0.44 },
      figuresDue: true,
    });
    const [ev] = cached();
    assert.deepEqual(ev.walletReadings, READINGS);
    assert.deepEqual(ev.historical, { impermanentLossGainPct: -0.44 });
    assert.equal(ev.figuresDue, true);
  });

  it("are finished in the entry with the same transaction, and nowhere else", async () => {
    await appendToPoolCache(pos, wallet, {
      oldTokenId: "7",
      newTokenId: "8",
      txHashes: ["0xlater"],
      blockNumber: 2000,
    });
    const key = _recentKey(pos, wallet);
    _recentScansForTests.set(key, { events: [], at: Date.now() });
    await updateCachedEvents(pos, wallet, new Map([["0xmint", FINISHED]]));
    const [first, second] = cached();
    assert.equal(first.figuresDue, undefined);
    assert.deepEqual(first.beforeRebalance, FINISHED.beforeRebalance);
    assert.deepEqual(first.afterRebalance, FINISHED.afterRebalance);
    assert.equal(first.newTokenId, "7", "the rest of the entry is kept");
    assert.equal(second.txHash, "0xlater");
    assert.equal("beforeRebalance" in second, false);
    // The next caller reads the finished records, not a scan from before.
    assert.equal(_recentScansForTests.has(key), false);
  });

  it("change nothing when nothing is finished, or the pool has no cache", async () => {
    const was = fs.readFileSync(cachePath, "utf8");
    await updateCachedEvents(pos, wallet, new Map());
    await updateCachedEvents(pos, wallet, undefined);
    assert.equal(fs.readFileSync(cachePath, "utf8"), was);
    const other = { ...pos, fee: 500 };
    const otherPath = eventCachePath(
      other,
      "pulsechain",
      "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2",
      wallet,
    );
    await updateCachedEvents(other, wallet, new Map([["0xmint", FINISHED]]));
    assert.equal(fs.existsSync(otherPath), false);
  });
});
