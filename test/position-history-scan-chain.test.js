"use strict";

/**
 * @file test/position-history-scan-chain.test.js
 * @description `scanChainCollectAndDrain` reads a whole rebalance
 *   chain's Collect/DecreaseLiquidity history in one pass, and must
 *   return, NFT for NFT, what reading each NFT on its own returns.
 *
 *   That equivalence is what lets epoch reconstruction use it in place
 *   of one read per closed NFT. The oracle is the single-NFT read,
 *   `scanCollectAndDrain`, run against the same node from each NFT's own
 *   mint — the request epoch reconstruction used to make for every NFT.
 *
 *   Logs are encoded with the real position-manager ABI and decoded by
 *   the real decoder. The node filters the way a real one does, and one
 *   test uses a node that does not filter by token id at all, so the
 *   read's own attribution of logs to NFTs is what is being tested.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const {
  eventsFor,
  fetchChainNftEvents,
  emptyEvents,
} = require("../src/nft-events-batch");
const { parseLogs } = require("../src/nft-event-parse");
const {
  mintBlocksByTokenId,
  chainScanFloor,
} = require("../src/nft-mint-blocks");
const {
  IFACE,
  PM,
  encodedLog,
  makeProvider,
} = require("./helpers/nft-log-fixtures");

const POOL = "0x" + "b".repeat(40);
const POOL_CREATED = 1_000;
const HEAD = 40_000;
const RECIPIENT = "0x" + "a".repeat(40);
const E = (n) => BigInt(n) * 10n ** 15n;

/** Where each NFT in the chain was really minted. */
const MINTS = { 100: 2_000, 101: 12_000, 102: 25_000 };

/*- A three-NFT chain. #100 is the oldest: no rebalance event names its
 *  mint, so its floor has to come from the chain's first mint. #101 is
 *  minted in the block #100 is drained in. #999 belongs to someone else
 *  and sits inside the chain's range. #103 was minted and never
 *  collected. */
const LOGS = [
  encodedLog("IncreaseLiquidity", "100", [500n, E(100), E(100)], 2_000),
  encodedLog("Collect", "100", [RECIPIENT, E(3), E(1)], 8_000, 0),
  encodedLog("IncreaseLiquidity", "100", [10n, E(3), E(1)], 8_000, 1),
  encodedLog("Collect", "999", [RECIPIENT, E(50), E(50)], 9_000, 0),
  encodedLog("DecreaseLiquidity", "100", [510n, E(98), E(104)], 12_000, 0),
  encodedLog("Collect", "100", [RECIPIENT, E(99), E(105)], 12_000, 1),
  encodedLog("IncreaseLiquidity", "101", [490n, E(97), E(103)], 12_000, 2),
  encodedLog("DecreaseLiquidity", "101", [490n, E(90), E(110)], 25_000, 0),
  encodedLog("Collect", "101", [RECIPIENT, E(92), E(111)], 25_000, 1),
  encodedLog("IncreaseLiquidity", "102", [480n, E(90), E(110)], 25_000, 2),
  encodedLog("IncreaseLiquidity", "103", [1n, 1n, 1n], 30_000, 0),
  encodedLog("Collect", "102", [RECIPIENT, E(2), E(2)], 33_000, 0),
];

const EVENTS = Object.assign(
  [
    { oldTokenId: "100", newTokenId: "101", blockNumber: 12_000 },
    { oldTokenId: "101", newTokenId: "102", blockNumber: 25_000 },
  ],
  { firstMintBlockNumber: 2_000 },
);

const CHAIN = ["100", "101", "102"];
const topicOf = (name) => IFACE.getEvent(name).topicHash;

/**
 * Load the scan helpers against `node`, with the pool lookups replaced
 * by recorders.
 *
 * The batch module is loaded fresh too, because it takes its provider
 * from `send-transaction` at load time.
 *
 * @param {object} node
 * @returns {{mod: object, poolCalls: string[]}}
 */
function load(node) {
  const poolCalls = [];
  const fresh = [
    require.resolve("../src/position-history-scan-helpers"),
    require.resolve("../src/nft-events-batch"),
  ];
  for (const f of fresh) delete require.cache[f];
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === "./send-transaction") {
      return { getManagedReadProvider: () => node };
    }
    if (id === "./pool-creation-block") {
      return {
        resolvePoolAddressForToken: async () => {
          poolCalls.push("address");
          return POOL;
        },
        getPoolCreationBlockCached: async () => {
          poolCalls.push("created");
          return POOL_CREATED;
        },
      };
    }
    return orig.apply(this, arguments);
  };
  try {
    return {
      mod: require("../src/position-history-scan-helpers"),
      poolCalls,
    };
  } finally {
    Module.prototype.require = orig;
    /*- Evicted again so the copies holding these stubs are not handed
     *  to whoever requires the modules next. */
    for (const f of fresh) delete require.cache[f];
  }
}

const getLogsCalls = (node) => node.calls.filter((c) => c.method === "getLogs");

describe("scanChainCollectAndDrain — the same answer as one NFT at a time", () => {
  it("matches the single-NFT read for every NFT in the chain", async () => {
    const node = makeProvider(LOGS, HEAD);
    const { mod } = load(node);
    const batch = await mod.scanChainCollectAndDrain(CHAIN, EVENTS);
    for (const id of CHAIN) {
      const alone = await mod.scanCollectAndDrain(id, node, MINTS[id]);
      assert.ok(alone, `#${id} has a history on this chain`);
      assert.deepEqual(eventsFor(batch, id), alone, `#${id}`);
    }
  });

  it("attributes logs by token id, even from a node that does not", async () => {
    /*- A node that ignores the token-id filter returns every NFT's logs
     *  for each event type. The answer must not change. */
    const loose = makeProvider(LOGS, HEAD);
    const strictGetLogs = loose.getLogs;
    loose.getLogs = async (q) =>
      strictGetLogs({
        ...q,
        topics: [q.topics[0], LOGS.map((l) => l.topics[1])],
      });
    const strict = makeProvider(LOGS, HEAD);
    const fromLoose = await load(loose).mod.scanChainCollectAndDrain(
      CHAIN,
      EVENTS,
    );
    const fromStrict = await load(strict).mod.scanChainCollectAndDrain(
      CHAIN,
      EVENTS,
    );
    assert.deepEqual(fromLoose, fromStrict);
    assert.equal(fromLoose.has("999"), false);
  });

  it("orders each NFT's Collects by chain position, whatever the node does", async () => {
    /*- The exit value is read from the LAST Collect, so a compound
     *  sorted after the drain would be reported as the exit. */
    const node = makeProvider(LOGS, HEAD);
    const inOrder = node.getLogs;
    node.getLogs = async (q) =>
      (await inOrder(q)).sort((x, y) => y.blockNumber - x.blockNumber);
    const batch = await load(node).mod.scanChainCollectAndDrain(CHAIN, EVENTS);
    assert.deepEqual(
      eventsFor(batch, "100").collectEvents.map((e) => e.blockNumber),
      [8_000, 12_000],
    );
    assert.equal(eventsFor(batch, "100").collectEvents[1].amount0, E(99));
  });
});

describe("scanChainCollectAndDrain — one read for the chain", () => {
  it("carries the whole chain in every request", async () => {
    const node = makeProvider(LOGS, HEAD);
    await load(node).mod.scanChainCollectAndDrain(CHAIN, EVENTS);
    const calls = getLogsCalls(node);
    assert.ok(calls.length > 0);
    for (const c of calls) {
      assert.ok(Array.isArray(c.topics[1]), "token ids go in as a set");
      assert.equal(c.topics[1].length, CHAIN.length);
    }
  });

  it("asks only for Collect and DecreaseLiquidity", async () => {
    /*- IncreaseLiquidity is a third full pass nobody here reads. */
    const node = makeProvider(LOGS, HEAD);
    await load(node).mod.scanChainCollectAndDrain(CHAIN, EVENTS);
    assert.deepEqual(
      [...new Set(getLogsCalls(node).map((c) => c.topics[0]))],
      [topicOf("Collect"), topicOf("DecreaseLiquidity")],
    );
  });

  it("starts at the chain's first mint, not the pool's creation", async () => {
    const node = makeProvider(LOGS, HEAD);
    await load(node).mod.scanChainCollectAndDrain(CHAIN, EVENTS);
    const lowest = Math.min(...getLogsCalls(node).map((c) => c.fromBlock));
    assert.equal(lowest, EVENTS.firstMintBlockNumber);
  });

  it("falls back to the pool's creation block without a first mint", async () => {
    /*- A copied events array loses the property. That costs time, not
     *  correctness: the floor can only move down. */
    const node = makeProvider(LOGS, HEAD);
    await load(node).mod.scanChainCollectAndDrain(CHAIN, [...EVENTS]);
    const lowest = Math.min(...getLogsCalls(node).map((c) => c.fromBlock));
    assert.equal(lowest, POOL_CREATED);
  });

  it("reaches the chain head", async () => {
    const node = makeProvider(LOGS, HEAD);
    await load(node).mod.scanChainCollectAndDrain(CHAIN, EVENTS);
    const highest = Math.max(...getLogsCalls(node).map((c) => c.toBlock));
    assert.equal(highest, HEAD);
  });

  it("resolves the pool floor once, not once per NFT", async () => {
    const node = makeProvider(LOGS, HEAD);
    const { mod, poolCalls } = load(node);
    await mod.scanChainCollectAndDrain(CHAIN, EVENTS);
    assert.deepEqual(poolCalls, ["address", "created"]);
  });

  it("asks nothing of the chain for an empty list", async () => {
    const node = makeProvider(LOGS, HEAD);
    const { mod, poolCalls } = load(node);
    const batch = await mod.scanChainCollectAndDrain([], EVENTS);
    assert.equal(batch.size, 0);
    assert.deepEqual(node.calls, []);
    assert.deepEqual(poolCalls, []);
  });
});

describe("scanChainCollectAndDrain — what the entries mean", () => {
  it("has an entry for every id, and refuses one it was not asked for", async () => {
    const batch = await load(
      makeProvider(LOGS, HEAD),
    ).mod.scanChainCollectAndDrain(CHAIN, EVENTS);
    assert.deepEqual([...batch.keys()], CHAIN);
    assert.throws(() => eventsFor(batch, "999"), /no events fetched for #999/);
  });

  it("answers null for an NFT that never emitted a Collect", async () => {
    /*- A closed NFT always emitted one when it was drained, so none at
     *  all means its history was not seen. Zero would overwrite a real
     *  logged figure with a wrong one. */
    const batch = await load(
      makeProvider(LOGS, HEAD),
    ).mod.scanChainCollectAndDrain(["100", "103"], EVENTS);
    assert.strictEqual(eventsFor(batch, "103"), null);
    assert.notStrictEqual(eventsFor(batch, "100"), null);
  });

  it("throws when the read fails, leaving the decision to the caller", async () => {
    const node = makeProvider(LOGS, HEAD);
    node.getLogs = async () => {
      throw new Error("rpc unavailable");
    };
    await assert.rejects(
      load(node).mod.scanChainCollectAndDrain(CHAIN, EVENTS),
      /rpc unavailable/,
    );
  });

  it("still answers null, without throwing, for a single NFT", async () => {
    /*- The single-NFT read keeps its own contract: null for "we do not
     *  know", never an exception. */
    const node = makeProvider(LOGS, HEAD);
    node.getLogs = async () => {
      throw new Error("rpc unavailable");
    };
    const { mod } = load(node);
    assert.equal(await mod.scanCollectAndDrain("100", node, 2_000), null);
  });
});

describe("collectAndDrainOf — histories out of a whole-chain read", () => {
  const { mod } = load(makeProvider([], HEAD));
  const entry = (collect) => ({
    ...emptyEvents(),
    ilEvents: [{ blockNumber: 1 }],
    collectEvents: collect,
    dlEvents: [{ blockNumber: 3 }],
  });

  it("hands on only Collect and DecreaseLiquidity", () => {
    const out = mod.collectAndDrainOf(
      new Map([["100", entry([{ blockNumber: 2 }])]]),
      ["100"],
    );
    assert.deepEqual(out.get("100"), {
      collectEvents: [{ blockNumber: 2 }],
      dlEvents: [{ blockNumber: 3 }],
    });
  });

  it("answers null for an NFT with no Collect", () => {
    const out = mod.collectAndDrainOf(new Map([["100", entry([])]]), ["100"]);
    assert.strictEqual(out.get("100"), null);
  });

  it("leaves out an NFT the read does not cover", () => {
    /*- So the caller's `eventsFor` fails for that NFT, rather than the
     *  NFT reading as one with no history. */
    const out = mod.collectAndDrainOf(
      new Map([["100", entry([{ blockNumber: 2 }])]]),
      ["100", "101"],
    );
    assert.deepEqual([...out.keys()], ["100"]);
    assert.throws(() => eventsFor(out, "101"), /no events fetched for #101/);
  });

  it("matches numeric ids as strings", () => {
    const out = mod.collectAndDrainOf(
      new Map([["100", entry([{ blockNumber: 2 }])]]),
      [100],
    );
    assert.ok(out.has("100"));
  });
});

describe("the lifetime read serves epoch reconstruction exactly", () => {
  /*- What lets one pass read the chain once: the lifetime scan's read —
   *  all three event types, every NFT, each floored at its own mint
   *  above the chain's first mint — yields, for each closed NFT, the
   *  same Collect/DecreaseLiquidity history epoch reconstruction's own
   *  read returns. */
  it("gives every closed NFT the history its own read would", async () => {
    const node = makeProvider(LOGS, HEAD);
    const { mod } = load(node);
    const closed = ["100", "101"];
    const own = await mod.scanChainCollectAndDrain(closed, EVENTS);
    /*- The lifetime read, as `scanChainNftEvents` makes it for the bot. */
    const lifetime = await fetchChainNftEvents({
      tokenIds: CHAIN,
      mintBlocks: mintBlocksByTokenId(EVENTS),
      sharedFloor: chainScanFloor(EVENTS, POOL_CREATED),
      provider: node,
      iface: IFACE,
      address: PM,
      parseLogs,
    });
    assert.deepEqual(mod.collectAndDrainOf(lifetime, closed), own);
  });
});
