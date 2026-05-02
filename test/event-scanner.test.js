"use strict";

/**
 * @file test/event-scanner.test.js
 * @description Unit tests for the event-scanner module.
 */

const path = require("path");
const os = require("os");

/*- Scope the pool-creation-block disk cache to this test run so the
    integration test below ("pool-age optimisation skips blocks before
    creation") starts from a clean cache and isn't affected by parallel
    test runs.  Must be set before requiring the module under test. */
process.env.POOL_CREATION_BLOCK_CACHE_PATH = path.join(
  os.tmpdir(),
  "pool-creation-blocks-cache-es-test-" + process.pid + ".json",
);

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("assert");
const {
  scanRebalanceHistory,
  buildCacheKey,
  _BLOCKS_PER_YEAR,
  _DEFAULT_CHUNK_SIZE,
  _PAIRING_WINDOW_SEC,
  _CHUNK_DELAY_MS,
} = require("../src/event-scanner");
const poolCreationBlock = require("../src/pool-creation-block");

const WALLET = "0xABCDEF0000000000000000000000000000000001";
const POS_MGR = "0x1234560000000000000000000000000000000099";
const ZERO = "0x0000000000000000000000000000000000000000";
const BASE_TS = 1_700_000_000;

function mkProvider(block = 1_000_000, base = BASE_TS) {
  return {
    getBlockNumber: async () => block,
    getBlock: async (n) => ({ timestamp: base + n }),
  };
}

function mkEvent(from, to, tokenId, block, tx, idx = 0) {
  return {
    args: [from, to, { toString: () => tokenId }],
    blockNumber: block,
    transactionHash: tx,
    index: idx,
  };
}

function mkEthers(inEv = [], outEv = []) {
  return {
    Contract: class {
      constructor() {
        this.filters = {
          Transfer: (f, t) => ({ _from: f, _to: t, topics: [] }),
        };
        this.queryFilter = async (filter) =>
          filter._from === null ? inEv : outEv;
      }
    },
  };
}

function mkCache() {
  const s = new Map();
  return {
    _store: s,
    async get(k) {
      return s.get(k) ?? null;
    },
    async set(k, v) {
      s.set(k, v);
    },
  };
}

const scanOpts = (extra = {}) => ({
  positionManagerAddress: POS_MGR,
  walletAddress: WALLET,
  maxYears: 1,
  chunkSize: 50_000,
  chunkDelayMs: 0,
  ...extra,
});

const wOut = (id, block, tx) =>
  mkEvent(WALLET.toLowerCase(), ZERO, id, block, tx);
const wIn = (id, block, tx) =>
  mkEvent(ZERO, WALLET.toLowerCase(), id, block, tx);

// ── Constants ────────────────────────────────────────────────────────────────

describe("Constants", () => {
  it("_BLOCKS_PER_YEAR ≈ 3,155,760", () => {
    assert.ok(Math.abs(_BLOCKS_PER_YEAR - 3_155_760) < 10);
  });
  it("_DEFAULT_CHUNK_SIZE is 10000", () =>
    assert.strictEqual(_DEFAULT_CHUNK_SIZE, 10000));
  it("_PAIRING_WINDOW_SEC is 300", () =>
    assert.strictEqual(_PAIRING_WINDOW_SEC, 300));
  it("_CHUNK_DELAY_MS is 250", () => assert.strictEqual(_CHUNK_DELAY_MS, 250));
});

describe("buildCacheKey", () => {
  it("builds pool-scoped key from components", () => {
    const key = buildCacheKey(WALLET, "0xPM", "0xAAA", "0xBBB", 2500);
    assert.ok(key.startsWith("rebalance:"));
    assert.ok(key.includes(WALLET.toLowerCase()));
    assert.ok(key.includes("0xaaa-0xbbb-2500"));
  });

  it("returns base key without pool tokens", () => {
    const key = buildCacheKey(WALLET, "0xPM");
    assert.ok(key.startsWith("rebalance:"));
    assert.ok(!key.includes("-"));
  });
});

// ── scanRebalanceHistory ─────────────────────────────────────────────────────

describe("scanRebalanceHistory", () => {
  it("returns empty when no events", async () => {
    const r = await scanRebalanceHistory(
      mkProvider(5000),
      mkEthers(),
      scanOpts({ chunkSize: 10_000 }),
    );
    assert.deepStrictEqual(r, []);
  });

  it("pairs transfer-out + transfer-in within 5 min", async () => {
    const r = await scanRebalanceHistory(
      mkProvider(5000, BASE_TS),
      mkEthers([wIn("43", 110, "0xbbb")], [wOut("42", 100, "0xaaa")]),
      scanOpts(),
    );
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].oldTokenId, "42");
    assert.strictEqual(r[0].newTokenId, "43");
    assert.strictEqual(r[0].txHash, "0xbbb");
  });

  it("does not pair events beyond 5 min window", async () => {
    const r = await scanRebalanceHistory(
      mkProvider(5000, BASE_TS),
      mkEthers([wIn("43", 401, "0xbbb")], [wOut("42", 100, "0xaaa")]),
      scanOpts(),
    );
    assert.strictEqual(r.length, 0);
  });

  it("handles multiple pairs chronologically", async () => {
    const r = await scanRebalanceHistory(
      mkProvider(5000, BASE_TS),
      mkEthers(
        [wIn("11", 105, "0xb1"), wIn("21", 1005, "0xb2")],
        [wOut("10", 100, "0xa1"), wOut("20", 1000, "0xa2")],
      ),
      scanOpts(),
    );
    assert.strictEqual(r.length, 2);
    assert.strictEqual(r[0].oldTokenId, "10");
    assert.strictEqual(r[1].oldTokenId, "20");
  });

  it("assigns 1-based index", async () => {
    const r = await scanRebalanceHistory(
      mkProvider(5000, BASE_TS),
      mkEthers(
        [wIn("11", 105, "0xb1"), wIn("21", 505, "0xb2")],
        [wOut("10", 100, "0xa1"), wOut("20", 500, "0xa2")],
      ),
      scanOpts(),
    );
    assert.strictEqual(r[0].index, 1);
    assert.strictEqual(r[1].index, 2);
  });

  it("computes correct fromBlock based on maxYears", async () => {
    const currentBlock = 20_000_000;
    const maxYears = 2;
    const expected = currentBlock - Math.round(maxYears * _BLOCKS_PER_YEAR);
    const ranges = [];
    const ethers = {
      Contract: class {
        constructor() {
          this.filters = {
            Transfer: (f, t) => ({ _from: f, _to: t, topics: [] }),
          };
          this.queryFilter = async (_f, from) => {
            ranges.push(from);
            return [];
          };
        }
      },
    };
    await scanRebalanceHistory(
      mkProvider(currentBlock),
      ethers,
      scanOpts({ maxYears, chunkSize: _DEFAULT_CHUNK_SIZE }),
    );
    assert.strictEqual(ranges[0], expected);
  });

  it("handles RPC errors gracefully", async () => {
    const warnings = [];
    const origWarn = console.warn;
    console.warn = (...a) => {
      warnings.push(a.join(" "));
    };
    try {
      const ethers = {
        Contract: class {
          constructor() {
            this.filters = {
              Transfer: () => ({ _from: null, topics: [] }),
            };
            this.queryFilter = async () => {
              throw new Error("RPC timeout");
            };
          }
        },
      };
      const r = await scanRebalanceHistory(
        mkProvider(5000),
        ethers,
        scanOpts(),
      );
      assert.deepStrictEqual(r, []);
      assert.ok(warnings.some((w) => w.includes("failed")));
    } finally {
      console.warn = origWarn;
    }
  });

  it("uses cache to skip scanned blocks", async () => {
    const ranges = [];
    const ethers = {
      Contract: class {
        constructor() {
          this.filters = {
            Transfer: (f, t) => ({ _from: f, _to: t, topics: [] }),
          };
          this.queryFilter = async (_f, from) => {
            ranges.push(from);
            return [];
          };
        }
      },
    };
    const cache = mkCache();
    const key = `rebalance:${WALLET.toLowerCase()}:${POS_MGR.toLowerCase()}`;
    cache._store.set(key, {
      events: [
        {
          index: 1,
          timestamp: BASE_TS + 100,
          oldTokenId: "1",
          newTokenId: "2",
          txHash: "0x111",
          blockNumber: 100,
        },
      ],
      lastBlock: 4000,
    });
    const r = await scanRebalanceHistory(
      mkProvider(5000, BASE_TS),
      ethers,
      scanOpts({ cache }),
    );
    assert.ok(ranges[0] >= 4001, `Expected ≥4001, got ${ranges[0]}`);
    assert.ok(r.some((e) => e.txHash === "0x111"));
  });

  it("returns cached results when no new blocks", async () => {
    const cache = mkCache();
    const key = `rebalance:${WALLET.toLowerCase()}:${POS_MGR.toLowerCase()}`;
    cache._store.set(key, {
      events: [
        {
          index: 1,
          timestamp: BASE_TS + 100,
          oldTokenId: "10",
          newTokenId: "11",
          txHash: "0xaaa",
          blockNumber: 100,
        },
      ],
      lastBlock: 4000,
    });
    const r = await scanRebalanceHistory(
      mkProvider(4000, BASE_TS),
      mkEthers(),
      scanOpts({ cache }),
    );
    assert.strictEqual(r.length, 1);
    assert.strictEqual(r[0].txHash, "0xaaa");
  });

  it("pairs consecutive mints when old NFT is not burned", async () => {
    const r = await scanRebalanceHistory(
      mkProvider(5000, BASE_TS),
      mkEthers(
        [
          wIn("10", 100, "0xa1"),
          wIn("11", 200, "0xa2"),
          wIn("12", 600, "0xa3"),
        ],
        [],
      ),
      scanOpts(),
    );
    assert.strictEqual(r.length, 2);
    assert.strictEqual(r[0].oldTokenId, "10");
    assert.strictEqual(r[0].newTokenId, "11");
    assert.strictEqual(r[1].oldTokenId, "11");
    assert.strictEqual(r[1].newTokenId, "12");
  });

  it("deduplicates by txHash + logIndex", async () => {
    const dup = wIn("43", 110, "0xbbb");
    const ethers = {
      Contract: class {
        constructor() {
          this.filters = {
            Transfer: (f, t) => ({ _from: f, _to: t, topics: [] }),
          };
          this.queryFilter = async (filter) =>
            filter._from === null ? [dup, dup] : [wOut("42", 100, "0xaaa")];
        }
      },
    };
    const r = await scanRebalanceHistory(
      mkProvider(5000, BASE_TS),
      ethers,
      scanOpts(),
    );
    assert.strictEqual(r.length, 1);
  });
});

it("filters consecutive mints by pool when pool filter provided", async () => {
  const TOKEN0_A = "0xAAAA000000000000000000000000000000000001";
  const TOKEN1_A = "0xAAAA000000000000000000000000000000000002";
  const TOKEN0_B = "0xBBBB000000000000000000000000000000000001";
  const TOKEN1_B = "0xBBBB000000000000000000000000000000000002";
  const FEE = 3000;

  // Three mints: token 10 (pool A), token 11 (pool B), token 12 (pool A)
  // Without filtering: pairs 10→11 and 11→12 (both wrong cross-pool)
  // With pool A filter: pairs 10→12 (correct)
  const positionsData = {
    10: { token0: TOKEN0_A, token1: TOKEN1_A, fee: FEE },
    11: { token0: TOKEN0_B, token1: TOKEN1_B, fee: FEE },
    12: { token0: TOKEN0_A, token1: TOKEN1_A, fee: FEE },
  };

  const ethers = {
    Contract: class {
      constructor() {
        this.positions = async (id) => {
          const p = positionsData[id.toString()];
          if (!p) throw new Error("not found");
          return [0, ZERO, p.token0, p.token1, p.fee, 0, 0, 0, 0, 0, 0, 0];
        };
        this.filters = {
          Transfer: (f, t) => ({ _from: f, _to: t, topics: [] }),
        };
        this.queryFilter = async (filter) =>
          filter._from === null
            ? [
                wIn("10", 100, "0xa1"),
                wIn("11", 200, "0xa2"),
                wIn("12", 300, "0xa3"),
              ]
            : [];
      }
    },
  };

  const r = await scanRebalanceHistory(
    mkProvider(5000, BASE_TS),
    ethers,
    scanOpts({ poolToken0: TOKEN0_A, poolToken1: TOKEN1_A, poolFee: FEE }),
  );
  assert.strictEqual(r.length, 1, `expected 1 pair, got ${r.length}`);
  assert.strictEqual(r[0].oldTokenId, "10");
  assert.strictEqual(r[0].newTokenId, "12");
});

// ── scanRebalanceHistory pool-age optimisation ───────────────────────────────

describe("scanRebalanceHistory pool-age optimisation", () => {
  /*- Reset the disk-cached pool-creation resolver between cases so the
      cached lower bound from one test never leaks into another. */
  beforeEach(() => poolCreationBlock._resetForTests());
  afterEach(() => poolCreationBlock._resetForTests());

  it("skips blocks before pool creation", async () => {
    const ranges = [];
    const creationBlock = 3000;
    const ethers = {
      Contract: class {
        constructor(addr) {
          if (addr === "0xFACTORY") {
            this.filters = { PoolCreated: () => ({ topics: [] }) };
            this.queryFilter = async () => [
              {
                args: [null, null, null, null, "0xPOOL"],
                blockNumber: creationBlock,
              },
            ];
          } else {
            this.filters = {
              Transfer: (f, t) => ({ _from: f, _to: t, topics: [] }),
            };
            this.queryFilter = async (_f, from) => {
              ranges.push(from);
              return [];
            };
          }
        }
      },
    };
    await scanRebalanceHistory(
      mkProvider(5000, BASE_TS),
      ethers,
      scanOpts({ factoryAddress: "0xFACTORY", poolAddress: "0xPOOL" }),
    );
    assert.ok(ranges.length > 0);
    assert.ok(
      ranges[0] >= creationBlock,
      `Expected ≥${creationBlock}, got ${ranges[0]}`,
    );
  });
});
