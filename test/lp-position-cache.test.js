/**
 * @file test/lp-position-cache.test.js
 * @description Tests for the LP position cache module.
 */

"use strict";

const { describe, it, beforeEach } = require("node:test");
const assert = require("assert");
const path = require("path");
const {
  sendFileProblemsTo,
  _forgetToldFileProblemsForTests,
} = require("../src/lib/file-problem");
const {
  lpPositionCachePath,
  loadLpPositionCache,
  saveLpPositionCache,
  clearLpPositionCache,
  hasPositionActivitySince,
} = require("../src/bot/lp-position-cache");

// ── Mock fs ─────────────────────────────────────────────────────────────────

/*- Mirror real fs's ENOENT shape (code === "ENOENT") so callers that
 *  branch on `err.code` see the same behaviour they would in production.
 *  Without `code`, `clearLpPositionCache`'s "warn on non-ENOENT" guard
 *  would fire spurious warnings under the mock. */
function _enoent() {
  const e = new Error("ENOENT");
  e.code = "ENOENT";
  return e;
}

function createMockFs() {
  const files = {};
  return {
    files,
    readFileSync(p) {
      if (files[p] === undefined) throw _enoent();
      return files[p];
    },
    writeFileSync(p, data) {
      files[p] = data;
    },
    mkdirSync() {},
    unlinkSync(p) {
      if (files[p] === undefined) throw _enoent();
      delete files[p];
    },
  };
}

const WALLET = "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A";
const CHAIN = "pulsechain";

// ── lpPositionCachePath ─────────────────────────────────────────────────────

describe("lp-position-cache — lpPositionCachePath", () => {
  it("builds path with blockchain + contract + wallet", () => {
    const result = lpPositionCachePath(WALLET, "pulsechain", "0xCC05bf");
    assert.ok(path.basename(result).startsWith("lp-position-cache-pulse"));
    assert.ok(result.includes("tmp"));
  });

  it("refuses a missing chain rather than assuming one", () => {
    /*-
     *  Loading too: a cache that cannot be named must not read as one
     *  that is merely empty.
     */
    assert.throws(() => lpPositionCachePath(WALLET, undefined), /cacheTag/);
    assert.throws(
      () => loadLpPositionCache(WALLET, { fsModule: createMockFs() }),
      /cacheTag/,
    );
  });

  it("is case-insensitive", () => {
    const a = lpPositionCachePath("0xABCDEF1234567890", "pulsechain", "0xCC");
    const b = lpPositionCachePath("0xabcdef1234567890", "pulsechain", "0xCC");
    assert.strictEqual(a, b);
  });
});

// ── save + load round-trip ──────────────────────────────────────────────────

describe("lp-position-cache — save/load", () => {
  let mockFs;
  beforeEach(() => {
    mockFs = createMockFs();
  });

  it("round-trips positions and lastBlock", () => {
    const positions = [{ tokenId: "100", token0: "0xAAA", fee: 3000 }];
    saveLpPositionCache(WALLET, positions, 26100000, {
      blockchain: CHAIN,
      fsModule: mockFs,
    });
    const cached = loadLpPositionCache(WALLET, {
      blockchain: CHAIN,
      fsModule: mockFs,
    });
    assert.deepStrictEqual(cached.positions, positions);
    assert.strictEqual(cached.lastBlock, 26100000);
  });

  it("returns null when no cache exists", () => {
    assert.strictEqual(
      loadLpPositionCache(WALLET, { blockchain: CHAIN, fsModule: mockFs }),
      null,
    );
  });

  it("returns null for corrupt cache", () => {
    const filePath = lpPositionCachePath(WALLET, CHAIN);
    mockFs.files[filePath] = "NOT JSON";
    assert.strictEqual(
      loadLpPositionCache(WALLET, { blockchain: CHAIN, fsModule: mockFs }),
      null,
    );
  });

  it("returns null when positions field is missing", () => {
    const filePath = lpPositionCachePath(WALLET, CHAIN);
    mockFs.files[filePath] = JSON.stringify({ lastBlock: 100 });
    assert.strictEqual(
      loadLpPositionCache(WALLET, { blockchain: CHAIN, fsModule: mockFs }),
      null,
    );
  });

  it("returns null when lastBlock is missing", () => {
    const filePath = lpPositionCachePath(WALLET, CHAIN);
    mockFs.files[filePath] = JSON.stringify({ positions: [] });
    assert.strictEqual(
      loadLpPositionCache(WALLET, { blockchain: CHAIN, fsModule: mockFs }),
      null,
    );
  });
});

// ── clearLpPositionCache ────────────────────────────────────────────────────

describe("lp-position-cache — clear", () => {
  it("removes the cache file", () => {
    const mockFs = createMockFs();
    saveLpPositionCache(WALLET, [{ tokenId: "1" }], 100, {
      blockchain: CHAIN,
      fsModule: mockFs,
    });
    assert.ok(
      loadLpPositionCache(WALLET, { blockchain: CHAIN, fsModule: mockFs }),
    );
    clearLpPositionCache(WALLET, { blockchain: CHAIN, fsModule: mockFs });
    const after = loadLpPositionCache(WALLET, {
      blockchain: CHAIN,
      fsModule: mockFs,
    });
    assert.strictEqual(after, null);
  });

  it("does not throw when file does not exist", () => {
    const mockFs = createMockFs();
    assert.doesNotThrow(() =>
      clearLpPositionCache(WALLET, { blockchain: CHAIN, fsModule: mockFs }),
    );
  });

  it("tells a delete that fails for a reason other than the file being gone (permissions, etc.)", () => {
    /*- Operator-visibility regression guard: a permission/disk-full
     *  failure must not masquerade as a successful clear.  ENOENT
     *  stays silent (normal first-rebalance / already-cleared path);
     *  any other error is told as every caught file failure is
     *  (src/lib/file-problem.js), so the operator can see why a stale
     *  cache might outlive a rebalance.
     *
     *  TEST-ONLY: the alert a program sets is a stand-in, put back in
     *  the `finally`. */
    const mockFs = createMockFs();
    mockFs.unlinkSync = () => {
      const e = new Error("EACCES: permission denied");
      e.code = "EACCES";
      throw e;
    };
    const alerts = [];
    _forgetToldFileProblemsForTests();
    sendFileProblemsTo((words) => alerts.push(words));
    try {
      assert.doesNotThrow(() =>
        clearLpPositionCache(WALLET, { blockchain: CHAIN, fsModule: mockFs }),
      );
      assert.equal(alerts.length, 1);
      assert.match(
        alerts[0],
        /^LP Ranger could not delete .*lp-position-cache/,
      );
    } finally {
      sendFileProblemsTo(null);
    }
  });
});

// ── hasPositionActivitySince ────────────────────────────────────────────────

describe("lp-position-cache — hasPositionActivitySince", () => {
  function mockContract(
    transferOutHits,
    transferInHits,
    increaseHits,
    decreaseHits,
  ) {
    return {
      filters: {
        Transfer: () => "transfer-filter",
        IncreaseLiquidity: () => "increase-filter",
        DecreaseLiquidity: () => "decrease-filter",
      },
      queryFilter: async (_filter, _from, _to) => {
        if (_filter === "transfer-filter") {
          // Called twice: once for out, once for in
          const result = transferOutHits || transferInHits;
          if (transferOutHits) {
            transferOutHits = null;
            return result;
          }
          return transferInHits || [];
        }
        if (_filter === "increase-filter") return increaseHits || [];
        if (_filter === "decrease-filter") return decreaseHits || [];
        return [];
      },
    };
  }

  it("returns false when no events found", async () => {
    const contract = mockContract([], [], [], []);
    const result = await hasPositionActivitySince(
      contract,
      WALLET,
      ["100", "200"],
      100,
      200,
    );
    assert.strictEqual(result, false);
  });

  it("returns true when Transfer out events found", async () => {
    const contract = mockContract([{ fake: true }], [], [], []);
    const result = await hasPositionActivitySince(
      contract,
      WALLET,
      ["100"],
      100,
      200,
    );
    assert.strictEqual(result, true);
  });

  it("returns true when IncreaseLiquidity events found", async () => {
    const contract = mockContract([], [], [{ fake: true }], []);
    const result = await hasPositionActivitySince(
      contract,
      WALLET,
      ["100"],
      100,
      200,
    );
    assert.strictEqual(result, true);
  });

  it("returns true when DecreaseLiquidity events found", async () => {
    const contract = mockContract([], [], [], [{ fake: true }]);
    const result = await hasPositionActivitySince(
      contract,
      WALLET,
      ["100"],
      100,
      200,
    );
    assert.strictEqual(result, true);
  });

  it("returns false when fromBlock > toBlock", async () => {
    const contract = mockContract([{ fake: true }]);
    const result = await hasPositionActivitySince(
      contract,
      WALLET,
      ["100"],
      200,
      100,
    );
    assert.strictEqual(result, false);
  });

  it("works with empty tokenId list (Transfer only)", async () => {
    let callCount = 0;
    const contract = {
      filters: {
        Transfer: () => "transfer-filter",
        IncreaseLiquidity: () => "increase-filter",
        DecreaseLiquidity: () => "decrease-filter",
      },
      queryFilter: async () => {
        callCount++;
        return [];
      },
    };
    const result = await hasPositionActivitySince(
      contract,
      WALLET,
      [],
      100,
      200,
    );
    assert.strictEqual(result, false);
    assert.strictEqual(
      callCount,
      2,
      "only Transfer queries, no liquidity queries",
    );
  });
});
