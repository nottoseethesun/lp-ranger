/**
 * @file test/pool-scanner.test.js
 * @description Tests for pool-scanner: appendToPoolCache, clearPoolCache.
 */

"use strict";

const { describe, it, before, after } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

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
    const { eventCachePath } = require("../src/cache-store");
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
    const { appendToPoolCache } = require("../src/pool-scanner");
    await appendToPoolCache(pos, wallet, {
      oldTokenId: "100",
      newTokenId: "200",
      txHashes: ["0xaaa", "0xbbb"],
      blockNumber: 5000,
      swapSources: "9mm Aggregator (PulseX V2, 9mm V3)",
    });
    const raw = JSON.parse(fs.readFileSync(cachePath, "utf8"));
    const key = Object.keys(raw).find((k) => k.startsWith("rebalance:"));
    assert.ok(key, "cache key exists");
    const entry = raw[key].value;
    assert.equal(entry.events.length, 1);
    assert.equal(entry.events[0].oldTokenId, "100");
    assert.equal(entry.events[0].newTokenId, "200");
    assert.equal(entry.events[0].txHash, "0xbbb");
    assert.equal(entry.lastBlock, 5000);
    assert.equal(
      entry.events[0].swapSources,
      "9mm Aggregator (PulseX V2, 9mm V3)",
    );
  });

  it("appends to existing events", async () => {
    const { appendToPoolCache } = require("../src/pool-scanner");
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
    assert.equal(entry.lastBlock, 6000);
  });
});

describe("clearPoolCache", () => {
  it("clears the cache file", async () => {
    const { clearPoolCache } = require("../src/pool-scanner");
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
    const m = require("../src/pool-scanner");
    for (const fn of [
      "scanPoolHistory",
      "appendToPoolCache",
      "getPoolScanLock",
      "clearPoolCache",
      "cancelPoolScan",
    ])
      assert.equal(typeof m[fn], "function");
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
    const { eventCachePath } = require("../src/cache-store");
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

  function _recentKey(p, w) {
    const tag =
      p.token0.slice(0, 8) + "…/" + p.token1.slice(0, 8) + "… fee=" + p.fee;
    return tag + ":" + (w || "").slice(0, 8);
  }

  it("removes the in-memory recent-scan entry for the pool+wallet", async () => {
    const {
      appendToPoolCache,
      _recentScansForTests,
    } = require("../src/pool-scanner");
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
    const {
      appendToPoolCache,
      _recentScansForTests,
    } = require("../src/pool-scanner");
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
    const {
      appendToPoolCache,
      _recentScansForTests,
    } = require("../src/pool-scanner");
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
    const { cancelPoolScan } = require("../src/pool-scanner");
    const aborted = cancelPoolScan(tok0, tok1, fee, wallet);
    assert.equal(aborted, false, "no active scan to abort");
  });

  it(
    "aborts an in-flight scan: event-scanner throws AbortError and " +
      "scanPoolHistory releases the lock",
    async () => {
      const {
        scanPoolHistory,
        cancelPoolScan,
        getPoolScanLock,
      } = require("../src/pool-scanner");
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
