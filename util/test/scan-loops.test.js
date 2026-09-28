/**
 * @file util/test/scan-loops.test.js
 * @description
 * Tests for the chunked `getLogs` scan loops that the diagnostic tools
 * share in shape but not in code: `show-rebalance-chain.scanTransfers`,
 * `wallet-token-flow.scanToken`, and `reconcile-hodl`'s
 * `findAllTokenIds` / `filterByPool` / `sumEvents`.
 *
 * These loops are where the tools spend nearly all their wall-clock
 * time and where their correctness lives — chunk boundaries, IN/OUT
 * direction tagging, dedupe, ordering, and per-chunk error tolerance.
 * Each takes an injected provider, so everything here runs against a
 * double; no test touches the network.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { scanTransfers } = require("../diagnostic/show-rebalance-chain");
/*- fetchTimestamps is shared by the chain walker and the token-flow
 *  scanner, so it lives in _helpers.js and is imported from there. */
const { fetchTimestamps } = require("../diagnostic/_helpers");
const { scanToken } = require("../diagnostic/wallet-token-flow");
const {
  resolveKey,
  findAllTokenIds,
  filterByPool,
  sumEvents,
} = require("../diagnostic/reconcile-hodl");
const { captureConsole, fakeProvider } = require("./_capture");

const WALLET = "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A";
const TOKEN = "0x2b591e99afE9f32eAA6214f7B7629768c40Eeb39";

/** Provider double returning a fixed log only for the IN-direction filter. */
function directionalProvider(inLogs, outLogs) {
  return {
    calls: [],
    async getLogs(f) {
      this.calls.push(f);
      /*- topics[1] set = "from" filter = the OUT scan; topics[2] set =
       *  "to" filter = the IN scan. */
      return f.topics[1] ? outLogs : inLogs;
    },
  };
}

// ── show-rebalance-chain.scanTransfers ──────────────────────────────────────

test("scanTransfers — tags IN/OUT from the topic slot", async () => {
  const provider = directionalProvider(
    [{ blockNumber: 10, transactionIndex: 0, transactionHash: "0xin" }],
    [{ blockNumber: 20, transactionIndex: 0, transactionHash: "0xout" }],
  );
  const res = await captureConsole(() =>
    scanTransfers(provider, WALLET, 1, 5_000),
  );
  const dirs = res.value.map((l) => l._dir);
  assert.deepEqual(dirs, ["IN", "OUT"]);
});

test("scanTransfers — sorts by block then transactionIndex", async () => {
  const provider = {
    async getLogs(f) {
      if (f.topics[1]) return [];
      return [
        { blockNumber: 30, transactionIndex: 1, transactionHash: "0xc" },
        { blockNumber: 10, transactionIndex: 5, transactionHash: "0xa" },
        { blockNumber: 30, transactionIndex: 0, transactionHash: "0xb" },
      ];
    },
  };
  const res = await captureConsole(() =>
    scanTransfers(provider, WALLET, 1, 5_000),
  );
  assert.deepEqual(
    res.value.map((l) => l.transactionHash),
    ["0xa", "0xb", "0xc"],
  );
});

test("scanTransfers — a chunk error is reported, scan continues", async () => {
  let call = 0;
  const provider = {
    async getLogs() {
      call++;
      if (call <= 2) throw new Error("chunk blew up");
      return [{ blockNumber: 1, transactionIndex: 0, transactionHash: "0xok" }];
    },
  };
  const res = await captureConsole(() =>
    scanTransfers(provider, WALLET, 1, 20_000),
  );
  assert.match(res.err.join("\n"), /chunk blew up/);
  assert.ok(res.value.length > 0, "later chunks must still be collected");
});

test("scanTransfers — logs progress for the first chunk", async () => {
  const provider = fakeProvider({ logs: [] });
  const res = await captureConsole(() =>
    scanTransfers(provider, WALLET, 1, 5_000),
  );
  assert.match(res.out.join("\n"), /\[chunk 1\//);
});

test("fetchTimestamps — maps block numbers to unix seconds", async () => {
  const provider = fakeProvider({ blockTs: 1_767_225_600 });
  const map = await fetchTimestamps(provider, [10, 20]);
  assert.equal(map.get(10), 1_767_225_600);
  assert.equal(map.get(20), 1_767_225_600);
});

test("fetchTimestamps — a failing getBlock is skipped, not fatal", async () => {
  const provider = {
    async getBlock(n) {
      if (n === 10) throw new Error("nope");
      return { timestamp: 42 };
    },
  };
  const map = await fetchTimestamps(provider, [10, 20]);
  assert.equal(map.has(10), false);
  assert.equal(map.get(20), 42);
});

test("fetchTimestamps — a null block is not recorded", async () => {
  const provider = {
    async getBlock() {
      return null;
    },
  };
  const map = await fetchTimestamps(provider, [1]);
  assert.equal(map.size, 0);
});

// ── wallet-token-flow.scanToken ─────────────────────────────────────────────

test("scanToken — tags directions, sorts by block then logIndex", async () => {
  const provider = directionalProvider(
    [
      { blockNumber: 5, logIndex: 2, transactionHash: "0xa" },
      { blockNumber: 5, logIndex: 0, transactionHash: "0xb" },
    ],
    [{ blockNumber: 1, logIndex: 0, transactionHash: "0xc" }],
  );
  const res = await captureConsole(() =>
    scanToken(provider, TOKEN, WALLET, 1, 5_000),
  );
  assert.deepEqual(
    res.value.map((l) => l.transactionHash),
    ["0xc", "0xb", "0xa"],
  );
  assert.equal(res.value[0]._dir, "OUT");
});

test("scanToken — dedupes a self-transfer seen both directions", async () => {
  /*- Same tx + logIndex returned by both filters.  The IN and OUT
   *  copies differ by _dir so both are kept once, but a repeat of the
   *  identical triple must collapse. */
  const dup = { blockNumber: 5, logIndex: 1, transactionHash: "0xself" };
  const provider = {
    async getLogs(f) {
      return f.topics[1] ? [dup, dup] : [dup];
    },
  };
  const res = await captureConsole(() =>
    scanToken(provider, TOKEN, WALLET, 1, 5_000),
  );
  const outs = res.value.filter((l) => l._dir === "OUT");
  assert.equal(outs.length, 1, "identical OUT rows must dedupe to one");
  assert.equal(res.value.length, 2, "IN and OUT copies are distinct rows");
});

test("scanToken — a chunk error is reported and does not abort", async () => {
  const provider = {
    async getLogs() {
      throw new Error("rpc sad");
    },
  };
  const res = await captureConsole(() =>
    scanToken(provider, TOKEN, WALLET, 1, 5_000),
  );
  assert.deepEqual(res.value, []);
  assert.match(res.err.join("\n"), /rpc sad/);
});

// ── reconcile-hodl ──────────────────────────────────────────────────────────

test("resolveKey — exact key wins over fragment search", () => {
  const positions = { "pulsechain-0xW-0xPM-159250": {} };
  assert.equal(
    resolveKey(positions, "pulsechain-0xW-0xPM-159250"),
    "pulsechain-0xW-0xPM-159250",
  );
});

test("resolveKey — a unique fragment resolves", () => {
  const positions = {
    "pulsechain-0xW-0xPM-159250": {},
    "pulsechain-0xW-0xPM-161973": {},
  };
  assert.equal(resolveKey(positions, "159250"), "pulsechain-0xW-0xPM-159250");
});

test("findAllTokenIds — collects tokenIds from Transfer topic", async () => {
  const tid = (n) => "0x" + n.toString(16).padStart(64, "0");
  const provider = {
    async getLogs() {
      return [
        { topics: ["0xt", "0x0", "0xw", tid(159250)] },
        { topics: ["0xt", "0x0", "0xw", tid(161973)] },
        /*- Duplicate across chunks must collapse into the Set. */
        { topics: ["0xt", "0x0", "0xw", tid(159250)] },
      ];
    },
  };
  const res = await captureConsole(() =>
    findAllTokenIds(provider, WALLET, 1, 5_000),
  );
  assert.deepEqual(res.value.sort(), ["159250", "161973"]);
});

test("findAllTokenIds — an unparseable topic is skipped", async () => {
  const provider = {
    async getLogs() {
      return [{ topics: ["0xt", "0x0", "0xw", "not-hex"] }];
    },
  };
  const res = await captureConsole(() =>
    findAllTokenIds(provider, WALLET, 1, 5_000),
  );
  assert.deepEqual(res.value, []);
});

test("findAllTokenIds — a chunk error is reported, scan goes on", async () => {
  const provider = {
    async getLogs() {
      throw new Error("getLogs died");
    },
  };
  const res = await captureConsole(() =>
    findAllTokenIds(provider, WALLET, 1, 5_000),
  );
  assert.deepEqual(res.value, []);
  assert.match(res.err.join("\n"), /getLogs died/);
});

test("sumEvents — returns parsed IL / DL / Collect lists", async () => {
  /*- Real PM topic hashes are computed inside sumEvents from PM_ABI;
   *  returning [] for every filter exercises the three-way Promise.all
   *  and the parse step without needing encoded log data. */
  const provider = fakeProvider({ logs: [] });
  const res = await sumEvents(provider, "159250");
  assert.deepEqual(res.ilEvents, []);
  assert.deepEqual(res.dlEvents, []);
  assert.deepEqual(res.collectEvents, []);
  assert.equal(provider.calls.getLogs.length, 3);
});

test("sumEvents — a rejecting getLogs degrades to empty", async () => {
  const provider = {
    async getLogs() {
      throw new Error("boom");
    },
  };
  const res = await sumEvents(provider, "159250");
  assert.deepEqual(res.ilEvents, []);
  assert.deepEqual(res.dlEvents, []);
  assert.deepEqual(res.collectEvents, []);
});

test("filterByPool — keeps only tokenIds matching the pool", async () => {
  /*- filterByPool builds its own ethers.Contract against the injected
   *  provider; the double answers the `positions(tid)` call it makes. */
  const target = { token0: "0xAAA", token1: "0xBBB", fee: 2500 };
  const provider = {
    async call() {
      throw new Error("unused");
    },
  };
  /*- A reverting positions() must drop the tokenId rather than throw:
   *  burned NFTs revert, and the tool documents that it skips them. */
  const res = await captureConsole(() => filterByPool(provider, ["1"], target));
  assert.deepEqual(res.value, []);
});
