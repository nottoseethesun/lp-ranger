/**
 * @file test/get-logs-chunked.test.js
 * @description Tests for the shared block-range chunker.
 *
 * The arithmetic carries the weight here.  An off-by-one in the window
 * maths does not throw — it silently skips a block, and the missing
 * event surfaces much later as a wrong P&L figure with no trail back to
 * the cause.  So the boundaries are tested exhaustively: exact
 * multiples, remainders, single-block ranges, inverted ranges.
 *
 * The other half is error behaviour.  A range-cap rejection MUST reach
 * the caller rather than being smoothed into an empty array, because
 * "no events" and "we could not read" lead to opposite conclusions —
 * that confusion is exactly what made the original bug invisible.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");

const {
  scanChunked,
  chunkRanges,
  resolveToBlock,
  throwIfAborted,
  _DEFAULT_CHUNK_SIZE,
} = require("../src/get-logs-chunked");
const SHIPPED = require("../app-config/app-defaults-for-user-configurable/bot-config-defaults.json");

describe("chunkRanges — window arithmetic", () => {
  it("splits an exact multiple into equal windows", () => {
    assert.deepStrictEqual(chunkRanges(0, 9, 5), [
      { from: 0, to: 4 },
      { from: 5, to: 9 },
    ]);
  });

  it("gives the remainder its own short final window", () => {
    assert.deepStrictEqual(chunkRanges(0, 11, 5), [
      { from: 0, to: 4 },
      { from: 5, to: 9 },
      { from: 10, to: 11 },
    ]);
  });

  it("covers every block exactly once, with no gap or overlap", () => {
    /*- The property that actually matters.  A gap loses events; an
     *  overlap double-counts them, which for Collect events would
     *  inflate reported fees. */
    const windows = chunkRanges(1000, 4321, 250);
    assert.strictEqual(windows[0].from, 1000);
    assert.strictEqual(windows[windows.length - 1].to, 4321);
    for (let i = 1; i < windows.length; i++) {
      assert.strictEqual(
        windows[i].from,
        windows[i - 1].to + 1,
        "windows must be contiguous",
      );
    }
  });

  it("never exceeds the requested chunk size", () => {
    for (const w of chunkRanges(0, 100_000, 7500)) {
      assert.ok(w.to - w.from + 1 <= 7500, `window ${w.from}-${w.to} too wide`);
    }
  });

  it("returns a single window when the range is narrower than a chunk", () => {
    assert.deepStrictEqual(chunkRanges(100, 103, 7500), [
      { from: 100, to: 103 },
    ]);
  });

  it("handles a one-block range", () => {
    assert.deepStrictEqual(chunkRanges(500, 500, 10), [{ from: 500, to: 500 }]);
  });

  it("returns nothing for an inverted range rather than throwing", () => {
    /*- Callers rely on this to no-op: several compute fromBlock from a
     *  previous event and toBlock from the next one, which invert when
     *  there is no gap between them. */
    assert.deepStrictEqual(chunkRanges(200, 100, 10), []);
  });

  it("returns nothing for non-finite bounds", () => {
    assert.deepStrictEqual(chunkRanges(NaN, 100, 10), []);
    assert.deepStrictEqual(chunkRanges(0, undefined, 10), []);
  });

  it("visits newest-first when asked, still covering everything", () => {
    const desc = chunkRanges(0, 9, 5, "desc");
    assert.deepStrictEqual(desc, [
      { from: 5, to: 9 },
      { from: 0, to: 4 },
    ]);
  });
});

describe("chunk size wiring", () => {
  it("defaults to the single shipped getLogsChunkSize literal", () => {
    assert.strictEqual(_DEFAULT_CHUNK_SIZE, SHIPPED.getLogsChunkSize);
  });

  it("clears the strictest endpoint cap observed in the wild", () => {
    /*- rpc-pulsechain.g4mm4.io rejects anything over 10000 blocks with
     *  JSON-RPC -32602.  A default above that would be rejected by the
     *  very endpoint this setting exists to satisfy. */
    assert.ok(_DEFAULT_CHUNK_SIZE <= 10_000);
  });
});

describe("resolveToBlock", () => {
  it("passes a numeric bound straight through", async () => {
    assert.strictEqual(await resolveToBlock(null, 1234), 1234);
  });

  it("asks the provider for the head when given 'latest'", async () => {
    const provider = { getBlockNumber: async () => 999 };
    assert.strictEqual(await resolveToBlock(provider, "latest"), 999);
  });

  it("throws a useful message when 'latest' has no provider to resolve it", async () => {
    await assert.rejects(
      () => resolveToBlock(null, "latest"),
      /numeric toBlock or a provider with getBlockNumber/,
    );
  });
});

describe("scanChunked — traversal", () => {
  it("concatenates results across windows in visit order", async () => {
    const out = await scanChunked({
      fromBlock: 0,
      toBlock: 29,
      chunkSize: 10,
      query: async (from) => [from],
    });
    assert.deepStrictEqual(out, [0, 10, 20]);
  });

  it("resolves a 'latest' upper bound once, not per window", async () => {
    let headCalls = 0;
    const provider = {
      getBlockNumber: async () => {
        headCalls++;
        return 25;
      },
    };
    const seen = [];
    await scanChunked({
      provider,
      fromBlock: 0,
      toBlock: "latest",
      chunkSize: 10,
      query: async (f, t) => {
        seen.push([f, t]);
        return [];
      },
    });
    assert.strictEqual(headCalls, 1, "head must not drift mid-scan");
    assert.deepStrictEqual(seen, [
      [0, 9],
      [10, 19],
      [20, 25],
    ]);
  });

  it("stops early when onChunk says it has what it needs", async () => {
    let calls = 0;
    await scanChunked({
      fromBlock: 0,
      toBlock: 100_000,
      chunkSize: 10_000,
      query: async (from) => {
        calls++;
        return [from];
      },
      onChunk: (found) => found[0] >= 20_000,
    });
    assert.strictEqual(calls, 3, "should not keep scanning after a hit");
  });

  it("reports progress once per window", async () => {
    const seen = [];
    await scanChunked({
      fromBlock: 0,
      toBlock: 29,
      chunkSize: 10,
      query: async () => [],
      onProgress: (done, total) => seen.push([done, total]),
    });
    assert.deepStrictEqual(seen, [
      [1, 3],
      [2, 3],
      [3, 3],
    ]);
  });

  it("does nothing at all for an inverted range", async () => {
    let calls = 0;
    const out = await scanChunked({
      fromBlock: 500,
      toBlock: 100,
      chunkSize: 10,
      query: async () => {
        calls++;
        return [1];
      },
    });
    assert.strictEqual(calls, 0);
    assert.deepStrictEqual(out, []);
  });
});

describe("scanChunked — failure behaviour", () => {
  it("propagates a chunk failure by default", async () => {
    await assert.rejects(
      () =>
        scanChunked({
          fromBlock: 0,
          toBlock: 100,
          chunkSize: 50,
          query: async () => {
            throw new Error("rpc unavailable");
          },
        }),
      /rpc unavailable/,
    );
  });

  it("continues past a failed window only when bestEffort is explicit", async () => {
    const out = await scanChunked({
      fromBlock: 0,
      toBlock: 29,
      chunkSize: 10,
      bestEffort: true,
      query: async (from) => {
        if (from === 10) throw new Error("flaky");
        return [from];
      },
    });
    assert.deepStrictEqual(out, [0, 20], "the failed window is skipped");
  });

  it("aborts promptly when the signal is already aborted", async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    await assert.rejects(
      () =>
        scanChunked({
          fromBlock: 0,
          toBlock: 100,
          chunkSize: 10,
          signal: ac.signal,
          query: async () => {
            calls++;
            return [];
          },
        }),
      (err) => err.name === "AbortError",
    );
    assert.strictEqual(calls, 0);
  });

  it("lets an AbortError escape even in bestEffort mode", async () => {
    /*- Cancellation is not a flaky chunk.  Swallowing it would leave a
     *  cancelled scan grinding through every remaining window. */
    const err = new Error("Scan aborted");
    err.name = "AbortError";
    await assert.rejects(
      () =>
        scanChunked({
          fromBlock: 0,
          toBlock: 100,
          chunkSize: 50,
          bestEffort: true,
          query: async () => {
            throw err;
          },
        }),
      (e) => e.name === "AbortError",
    );
  });
});

describe("scanChunked — the block-range cap error", () => {
  /** An ethers-shaped rejection, as g4mm4 actually returns it. */
  function capError() {
    return Object.assign(new Error("could not coalesce error (…payload…)"), {
      code: "UNKNOWN_ERROR",
      error: {
        code: -32602,
        message: "eth_getLogs is limited to a 10000 block range",
      },
    });
  }

  it("replaces the raw ethers dump with span, cap and the setting to change", async () => {
    await assert.rejects(
      () =>
        scanChunked({
          fromBlock: 0,
          toBlock: 100_000,
          chunkSize: 7500,
          query: async () => {
            throw capError();
          },
        }),
      (err) => {
        assert.strictEqual(err.name, "BlockRangeCapError");
        assert.match(err.message, /7500-block query/);
        assert.match(err.message, /allows 10000 blocks/);
        assert.match(err.message, /getLogsChunkSize/);
        assert.ok(!/coalesce/.test(err.message), "no raw ethers dump");
        return true;
      },
    );
  });

  it("keeps the original error as the cause", async () => {
    await assert.rejects(
      () =>
        scanChunked({
          fromBlock: 0,
          toBlock: 100,
          chunkSize: 50,
          query: async () => {
            throw capError();
          },
        }),
      (err) => err.cause && err.cause.code === "UNKNOWN_ERROR",
    );
  });

  it("throws even in bestEffort mode", async () => {
    /*- bestEffort exists for a flaky endpoint, not a misconfiguration.
     *  Every window would fail identically, so carrying on would return
     *  an empty result and bury the reason. */
    await assert.rejects(
      () =>
        scanChunked({
          fromBlock: 0,
          toBlock: 100,
          chunkSize: 50,
          bestEffort: true,
          query: async () => {
            throw capError();
          },
        }),
      (err) => err.name === "BlockRangeCapError",
    );
  });
});

describe("throwIfAborted", () => {
  it("does nothing without a signal", () => {
    assert.doesNotThrow(() => throwIfAborted(undefined, "x"));
  });

  it("does nothing for a live signal", () => {
    const ac = new AbortController();
    assert.doesNotThrow(() => throwIfAborted(ac.signal, "x"));
  });

  it("throws an AbortError for an aborted signal", () => {
    const ac = new AbortController();
    ac.abort();
    assert.throws(
      () => throwIfAborted(ac.signal, "x"),
      (e) => e.name === "AbortError",
    );
  });
});
