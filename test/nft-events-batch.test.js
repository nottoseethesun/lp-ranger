"use strict";

/**
 * @file test/nft-events-batch.test.js
 * @description Tests for `src/nft-events-batch.js`, which fetches a
 *   whole chain of NFTs' event history in one pass instead of one pass
 *   per NFT.
 *
 *   The batching itself is arithmetic on how logs are requested. What
 *   needs pinning is the contract that makes it safe to substitute for
 *   the per-NFT scans: every requested id gets an entry, logs are
 *   partitioned by `topics[1]` rather than by which request they came
 *   back on, each id is re-floored to its own mint block, and an id the
 *   batch was never prepared for fails loudly instead of reading as an
 *   NFT with no history.
 *
 *   The real `ethers.Interface` and the real position-manager ABI are
 *   used throughout — a hand-written topic hash would pass these tests
 *   while matching nothing on chain.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { format } = require("node:util");
const { _setSinkForTests } = require("../src/log");
const { emojiId } = require("../src/logger");

const {
  ID_BATCH_SIZE,
  EVENT_NAMES,
  eventNamesOf,
  tokenIdOfLog,
  scanFloors,
  emptyEvents,
  fetchChainNftEvents,
  eventsFor,
  _chunkIds,
  _keepAtOrAbove,
  _byChainOrder,
} = require("../src/nft-events-batch");
const { topicForTokenId } = require("../src/nft-token-topic");
const {
  IFACE,
  PM,
  logFor,
  makeProvider,
} = require("./helpers/nft-log-fixtures");

const parseLogs = (_iface, logs) =>
  logs.map((l) => ({ blockNumber: l.blockNumber, txHash: l.transactionHash }));

const base = (provider, extra) => ({
  provider,
  iface: IFACE,
  address: PM,
  parseLogs,
  chunkSize: 9000,
  ...extra,
});

// ── Primitives ───────────────────────────────────────────────────────

describe("topicForTokenId / tokenIdOfLog", () => {
  it("round-trips a token id through its topic word", () => {
    for (const id of ["0", "1", "71544", "164418", "999999999999"]) {
      assert.equal(tokenIdOfLog({ topics: ["0x00", topicForTokenId(id)] }), id);
    }
  });

  it("produces a full 32-byte topic word", () => {
    const t = topicForTokenId("164418");
    assert.equal(t.length, 66, "0x + 64 hex chars");
    assert.match(t, /^0x[0-9a-f]{64}$/);
  });

  it("reads the id from topics[1], not from the decoded body", () => {
    /*-
     *  Partitioning must not depend on the ABI being right about the
     *  unindexed fields; an undecodable log still has to be routed.
     */
    const l = logFor("Collect", "12345", 10);
    l.data = "0xdeadbeef";
    assert.equal(tokenIdOfLog(l), "12345");
  });

  it("returns null for a log with no second topic", () => {
    assert.equal(tokenIdOfLog({ topics: ["0x00"] }), null);
    assert.equal(tokenIdOfLog({}), null);
    assert.equal(tokenIdOfLog(null), null);
  });
});

describe("_chunkIds", () => {
  it("groups into fixed sizes with a short final group", () => {
    assert.deepEqual(_chunkIds([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  });

  it("leaves no empty group when the list is an exact multiple", () => {
    /*-
     *  An empty trailing group would be a request with an empty topic
     *  array, which a node may read as "no filter" on that slot.
     */
    assert.deepEqual(_chunkIds([1, 2, 3, 4], 2), [
      [1, 2],
      [3, 4],
    ]);
  });

  it("returns nothing for an empty list", () => {
    assert.deepEqual(_chunkIds([], 100), []);
  });
});

// ── Floors ───────────────────────────────────────────────────────────

describe("scanFloors", () => {
  it("keeps each id's own floor and unions at the lowest", () => {
    const mints = new Map([
      ["1", 500],
      ["2", 900],
      ["3", 300],
    ]);
    const { floors, unionFrom } = scanFloors(["1", "2", "3"], mints, 100);
    assert.equal(floors.get("1"), 500);
    assert.equal(floors.get("2"), 900);
    assert.equal(floors.get("3"), 300);
    assert.equal(unionFrom, 300, "one request starts at the lowest floor");
  });

  it("a shared floor above a mint block wins", () => {
    /*-
     *  `nftScanFrom` combines with Math.max: the scan reads nothing
     *  below the shared floor, even for an NFT minted before it.
     */
    const { floors, unionFrom } = scanFloors(["1"], new Map([["1", 500]]), 800);
    assert.equal(floors.get("1"), 800);
    assert.equal(unionFrom, 800);
  });

  it("falls back to the shared floor for an id with no mint block", () => {
    /*-
     *  The chain's oldest NFT appears only as an oldTokenId and has no
     *  mint block in the events.
     */
    const { floors } = scanFloors(["9"], new Map(), 250);
    assert.equal(floors.get("9"), 250);
  });
});

// ── Partitioning ─────────────────────────────────────────────────────

describe("_keepAtOrAbove", () => {
  const floors = new Map([
    ["1", 100],
    ["2", 500],
  ]);

  it("routes each log to its own id", () => {
    const out = _keepAtOrAbove(
      [logFor("Collect", "1", 150), logFor("Collect", "2", 600)],
      floors,
    );
    assert.equal(out.get("1").length, 1);
    assert.equal(out.get("2").length, 1);
  });

  it("drops a log below that id's own floor", () => {
    /*-
     *  The union request starts at 100, so #2's window legitimately
     *  returns blocks it must not keep. Without this the batched result
     *  would include events a per-NFT scan excludes.
     */
    const out = _keepAtOrAbove([logFor("Collect", "2", 200)], floors);
    assert.equal(out.has("2"), false);
  });

  it("keeps a log exactly on the floor", () => {
    const out = _keepAtOrAbove([logFor("Collect", "2", 500)], floors);
    assert.equal(out.get("2").length, 1);
  });

  it("ignores logs for ids outside the batch", () => {
    const out = _keepAtOrAbove([logFor("Collect", "77", 900)], floors);
    assert.equal(out.size, 0);
  });
});

// ── The fetch ────────────────────────────────────────────────────────

describe("fetchChainNftEvents", () => {
  it("returns an entry for EVERY requested id, even with no events", () => {
    /*-
     *  A missing key would be read downstream as "this NFT has no
     *  history", which is a closed epoch with no fees rather than a
     *  bug.
     */
    return fetchChainNftEvents(
      base(makeProvider([]), {
        tokenIds: ["1", "2", "3"],
        mintBlocks: new Map(),
        sharedFloor: 0,
      }),
    ).then((batch) => {
      assert.deepEqual([...batch.keys()], ["1", "2", "3"]);
      for (const id of ["1", "2", "3"]) {
        assert.deepEqual(batch.get(id), emptyEvents());
      }
    });
  });

  it("partitions interleaved logs by token id", async () => {
    const logs = [
      logFor("IncreaseLiquidity", "1", 110),
      logFor("IncreaseLiquidity", "2", 120),
      logFor("Collect", "1", 130),
      logFor("DecreaseLiquidity", "2", 140),
      logFor("Collect", "2", 150),
    ];
    const batch = await fetchChainNftEvents(
      base(makeProvider(logs), {
        tokenIds: ["1", "2"],
        mintBlocks: new Map(),
        sharedFloor: 0,
      }),
    );
    assert.equal(batch.get("1").ilEvents.length, 1);
    assert.equal(batch.get("1").collectEvents.length, 1);
    assert.equal(batch.get("1").dlEvents.length, 0);
    assert.equal(batch.get("2").ilEvents.length, 1);
    assert.equal(batch.get("2").collectEvents.length, 1);
    assert.equal(batch.get("2").dlEvents.length, 1);
  });

  it("re-floors each id, so the result matches the per-NFT scan", () => {
    /*-
     *  #2 is minted at 500. The union request starts at 100 for #1's
     *  sake and so sees #2's block-200 log, which a per-NFT scan floored
     *  at 500 never returns.
     */
    const logs = [logFor("Collect", "2", 200), logFor("Collect", "2", 700)];
    return fetchChainNftEvents(
      base(makeProvider(logs), {
        tokenIds: ["1", "2"],
        mintBlocks: new Map([
          ["1", 100],
          ["2", 500],
        ]),
        sharedFloor: 0,
      }),
    ).then((batch) => {
      assert.equal(batch.get("2").collectEvents.length, 1);
      assert.equal(batch.get("2").collectEvents[0].blockNumber, 700);
    });
  });

  it("resolves the head once for the whole batch", async () => {
    /*-
     *  Every id and every event type must cover an identical range; a
     *  head resolved per scan could drift between them.
     */
    const p = makeProvider([]);
    await fetchChainNftEvents(
      base(p, { tokenIds: ["1", "2"], mintBlocks: new Map(), sharedFloor: 0 }),
    );
    const heads = p.calls.filter((c) => c.method === "getBlockNumber");
    assert.equal(heads.length, 1);
  });

  it("honours an explicit head without asking the chain", async () => {
    const p = makeProvider([], 999);
    await fetchChainNftEvents(
      base(p, {
        tokenIds: ["1"],
        mintBlocks: new Map(),
        sharedFloor: 0,
        toBlock: 400,
      }),
    );
    assert.equal(
      p.calls.some((c) => c.method === "getBlockNumber"),
      false,
    );
    assert.equal(
      p.calls.every((c) => c.method !== "getLogs" || c.toBlock <= 400),
      true,
    );
  });

  it("carries every id in ONE filter when the chain fits a batch", async () => {
    const p = makeProvider([]);
    const ids = Array.from({ length: 50 }, (_, i) => String(i + 1));
    await fetchChainNftEvents(
      base(p, { tokenIds: ids, mintBlocks: new Map(), sharedFloor: 0 }),
    );
    const gets = p.calls.filter((c) => c.method === "getLogs");
    assert.equal(
      gets.every(
        (c) => Array.isArray(c.topics[1]) && c.topics[1].length === 50,
      ),
      true,
      "each request should OR-match all 50 ids",
    );
    /*-
     *  3 event types x 1 block chunk x 1 id-group. A per-NFT scan of
     *  each id makes 150 requests for the same data.
     */
    assert.equal(gets.length, EVENT_NAMES.length);
  });

  it("splits an over-long id list into groups", async () => {
    const p = makeProvider([]);
    const n = ID_BATCH_SIZE + 25;
    const ids = Array.from({ length: n }, (_, i) => String(i + 1));
    await fetchChainNftEvents(
      base(p, { tokenIds: ids, mintBlocks: new Map(), sharedFloor: 0 }),
    );
    const gets = p.calls.filter((c) => c.method === "getLogs");
    assert.equal(gets.length, EVENT_NAMES.length * 2, "two id-groups");
    const sizes = gets.map((c) => c.topics[1].length).sort((a, b) => a - b);
    assert.deepEqual(sizes.slice(0, 3), [25, 25, 25]);
  });

  it("labels each group's progress with its first NFT", async () => {
    // Two reads can run at once, so each progress line names its group.
    const ids = Array.from({ length: ID_BATCH_SIZE + 25 }, (_, i) =>
      String(i + 1),
    );
    const second = String(ID_BATCH_SIZE + 1);
    const lines = [];
    const restore = _setSinkForTests({
      log: (...a) => lines.push(format(...a)),
    });
    try {
      await fetchChainNftEvents(
        base(makeProvider([]), {
          tokenIds: ids,
          mintBlocks: new Map(),
          sharedFloor: 0,
          eventNames: ["Collect"],
        }),
      );
    } finally {
      restore();
    }
    const progress = lines.filter((l) => l.includes("nft-batch Collect"));
    const firstLabel = `#1 ${emojiId("1")} +${ID_BATCH_SIZE - 1}`;
    const secondLabel = `#${second} ${emojiId(second)} +24`;
    assert.ok(
      progress.some((l) => l.includes(firstLabel)),
      progress.join("\n"),
    );
    assert.ok(
      progress.some((l) => l.includes(secondLabel)),
      progress.join("\n"),
    );
  });

  it("returns an empty map for an empty chain, asking nothing", async () => {
    const p = makeProvider([]);
    const batch = await fetchChainNftEvents(
      base(p, { tokenIds: [], mintBlocks: new Map(), sharedFloor: 0 }),
    );
    assert.equal(batch.size, 0);
    assert.equal(p.calls.length, 0);
  });

  it("accepts numeric token ids and keys the result by string", async () => {
    const batch = await fetchChainNftEvents(
      base(makeProvider([logFor("Collect", "7", 300)]), {
        tokenIds: [7],
        mintBlocks: new Map(),
        sharedFloor: 0,
      }),
    );
    assert.equal(batch.get("7").collectEvents.length, 1);
  });
});

// ── Fetching only some event types ───────────────────────────────────

describe("fetching only the event types a caller reads", () => {
  /*-
   *  Each event type is a full pass over the union range, so a reader
   *  that uses two of the three pays half as much again for the third
   *  unless it can leave it out.
   */
  const DRAIN = ["Collect", "DecreaseLiquidity"];
  const topicOf = (name) => IFACE.getEvent(name).topicHash;

  it("defaults to all three", () => {
    assert.deepEqual(eventNamesOf(undefined), [...EVENT_NAMES]);
    assert.deepEqual(eventNamesOf(null), [...EVENT_NAMES]);
  });

  it("refuses an unknown event before any request is made", async () => {
    // A misspelling must not cost a long scan before it is noticed.
    const p = makeProvider([]);
    await assert.rejects(
      fetchChainNftEvents(
        base(p, {
          tokenIds: ["1"],
          mintBlocks: new Map(),
          sharedFloor: 0,
          eventNames: ["Colect"],
        }),
      ),
      /unknown event "Colect"/,
    );
    assert.equal(p.calls.length, 0);
  });

  it("refuses an empty selection", () => {
    assert.throws(() => eventNamesOf([]), /no event types requested/);
  });

  it("queries only the requested types", async () => {
    const p = makeProvider([]);
    await fetchChainNftEvents(
      base(p, {
        tokenIds: ["1", "2"],
        mintBlocks: new Map(),
        sharedFloor: 0,
        eventNames: DRAIN,
      }),
    );
    const topics = p.calls
      .filter((c) => c.method === "getLogs")
      .map((c) => c.topics[0]);
    assert.deepEqual(topics.sort(), DRAIN.map(topicOf).sort());
  });

  it("gives each entry only the histories that were fetched", async () => {
    /*-
     *  No `ilEvents` at all, rather than an empty one: a consumer
     *  reaching for a history nobody requested must not read `[]` as
     *  "this NFT never added liquidity".
     */
    const batch = await fetchChainNftEvents(
      base(makeProvider([logFor("Collect", "1", 200)]), {
        tokenIds: ["1", "2"],
        mintBlocks: new Map(),
        sharedFloor: 0,
        eventNames: DRAIN,
      }),
    );
    assert.deepEqual(Object.keys(eventsFor(batch, "1")).sort(), [
      "collectEvents",
      "dlEvents",
    ]);
    assert.equal(eventsFor(batch, "1").collectEvents.length, 1);
    assert.deepEqual(eventsFor(batch, "2"), emptyEvents(DRAIN));
    assert.equal("ilEvents" in eventsFor(batch, "2"), false);
  });

  it("sends a repeated id once", async () => {
    /*-
     *  The id-group size is what bounds the topic array, so a duplicate
     *  would take a slot a real id needs.
     */
    const p = makeProvider([]);
    const batch = await fetchChainNftEvents(
      base(p, {
        tokenIds: ["1", "2", "1", 2],
        mintBlocks: new Map(),
        sharedFloor: 0,
      }),
    );
    const gets = p.calls.filter((c) => c.method === "getLogs");
    for (const c of gets) {
      assert.deepEqual(c.topics[1], [topicForTokenId(1), topicForTokenId(2)]);
    }
    assert.deepEqual([...batch.keys()], ["1", "2"]);
  });
});

// ── The prepared-query guard ─────────────────────────────────────────

describe("eventsFor", () => {
  it("returns the entry for an id the batch was prepared with", async () => {
    const batch = await fetchChainNftEvents(
      base(makeProvider([logFor("Collect", "1", 200)]), {
        tokenIds: ["1"],
        mintBlocks: new Map(),
        sharedFloor: 0,
      }),
    );
    assert.equal(eventsFor(batch, "1").collectEvents.length, 1);
  });

  it("THROWS for an id the batch never queried", () => {
    /*-
     *  The whole point. Returning empty here would be indistinguishable
     *  from an NFT with no history, and downstream that is a closed
     *  epoch with no fees — a wrong money figure, reported confidently.
     *  A caller reaching for an unqueried id has a sequencing bug and
     *  must hear about it.
     */
    const batch = new Map([["1", emptyEvents()]]);
    assert.throws(() => eventsFor(batch, "2"), /no events fetched for #2/);
  });

  it("matches on string and numeric ids alike", () => {
    const batch = new Map([["1", emptyEvents()]]);
    assert.doesNotThrow(() => eventsFor(batch, 1));
  });
});

// ── Equivalence with the per-NFT scan ────────────────────────────────

describe("batched result equals the per-NFT result", () => {
  /*-
   *  The substitution this module exists to justify. The oracle is the
   *  fake node answering a SINGLE-id filter over that id's own window —
   *  the exact request `scanNftEvents` makes — not a re-implementation
   *  of our own partitioning, which would only prove the copy matches
   *  the copy.
   */
  async function perNft(provider, id, from, head) {
    const out = {};
    for (const name of EVENT_NAMES) {
      out[name] = await provider.getLogs({
        address: PM,
        fromBlock: from,
        toBlock: head,
        topics: [IFACE.getEvent(name).topicHash, topicForTokenId(id)],
      });
    }
    return out;
  }

  it("matches for every id across a mixed chain", async () => {
    const mints = new Map([
      ["10", 100],
      ["20", 400],
      ["30", 700],
    ]);
    const ids = ["10", "20", "30"];
    const logs = [];
    /*-
     *  Spread events across the whole range, including blocks that fall
     *  below a younger NFT's floor — the case re-flooring exists for.
     */
    for (const [i, id] of ids.entries()) {
      for (const b of [150, 450, 750, 950]) {
        logs.push(logFor(EVENT_NAMES[i % 3], id, b));
        logs.push(logFor("Collect", id, b + 1));
      }
    }
    const provider = makeProvider(logs, 1000);
    const batch = await fetchChainNftEvents(
      base(provider, { tokenIds: ids, mintBlocks: mints, sharedFloor: 0 }),
    );

    const FIELD = {
      IncreaseLiquidity: "ilEvents",
      Collect: "collectEvents",
      DecreaseLiquidity: "dlEvents",
    };
    for (const id of ids) {
      const expect = await perNft(provider, id, mints.get(id), 1000);
      for (const name of EVENT_NAMES) {
        assert.deepEqual(
          eventsFor(batch, id)
            [FIELD[name]].map((e) => e.blockNumber)
            .sort(),
          expect[name].map((l) => l.blockNumber).sort(),
          `#${id} ${name} must match the single-id query`,
        );
      }
    }
  });

  it("matches when an id has no events at all", async () => {
    const provider = makeProvider([logFor("Collect", "10", 500)], 1000);
    const batch = await fetchChainNftEvents(
      base(provider, {
        tokenIds: ["10", "99"],
        mintBlocks: new Map([
          ["10", 100],
          ["99", 100],
        ]),
        sharedFloor: 0,
      }),
    );
    const expect = await perNft(provider, "99", 100, 1000);
    assert.equal(expect.Collect.length, 0);
    assert.deepEqual(eventsFor(batch, "99"), emptyEvents());
  });
});

// ── Chain order ──────────────────────────────────────────────────────

describe("per-id logs come back in chain order", () => {
  /*-
   *  `classifyCompounds` reads an NFT's FIRST IncreaseLiquidity as the
   *  mint deposit and the rest as compounds. Out of order, a compound is
   *  skipped as "the mint" and the mint is counted as a compound — both
   *  silent, both wrong money.
   */
  it("sorts by block, then by position within the block", () => {
    const a = { ...logFor("IncreaseLiquidity", "1", 300), index: 0 };
    const b = { ...logFor("IncreaseLiquidity", "1", 100), index: 5 };
    const c = { ...logFor("IncreaseLiquidity", "1", 100), index: 2 };
    const out = _keepAtOrAbove([a, b, c], new Map([["1", 0]]));
    assert.deepEqual(
      out.get("1").map((l) => [l.blockNumber, l.index]),
      [
        [100, 2],
        [100, 5],
        [300, 0],
      ],
    );
  });

  it("keeps arrival order within a block when index is absent", () => {
    /*-
     *  Array.prototype.sort is stable, so this is the transport's order,
     *  not an arbitrary one.
     */
    const first = { ...logFor("Collect", "1", 100), transactionHash: "0x1" };
    const second = { ...logFor("Collect", "1", 100), transactionHash: "0x2" };
    const out = _keepAtOrAbove([first, second], new Map([["1", 0]]));
    assert.deepEqual(
      out.get("1").map((l) => l.transactionHash),
      ["0x1", "0x2"],
    );
  });

  it("orders the fetch result even when the transport does not", async () => {
    /*-
     *  A provider returning logs newest-first stands in for any future
     *  change that parallelises windows. The mint must still lead.
     */
    const mint = { ...logFor("IncreaseLiquidity", "1", 100), index: 0 };
    const compound = { ...logFor("IncreaseLiquidity", "1", 900), index: 0 };
    const p = makeProvider([compound, mint], 1000);
    const orig = p.getLogs;
    /*-
     *  Force newest-first whatever order the fixture array is in. A
     *  plain .reverse() of an array that already happened to be
     *  newest-first delivers ascending order, and the test then passes
     *  without the sort it exists to check.
     */
    p.getLogs = async (q) =>
      (await orig(q)).sort((x, y) => y.blockNumber - x.blockNumber);
    const batch = await fetchChainNftEvents(
      base(p, { tokenIds: ["1"], mintBlocks: new Map(), sharedFloor: 0 }),
    );
    assert.deepEqual(
      eventsFor(batch, "1").ilEvents.map((e) => e.blockNumber),
      [100, 900],
      "the mint deposit must be the first IncreaseLiquidity",
    );
  });

  it("compares numerically, not as text", () => {
    assert.ok(
      _byChainOrder(
        { blockNumber: 9, index: 0 },
        { blockNumber: 10, index: 0 },
      ) < 0,
    );
    assert.ok(
      _byChainOrder(
        { blockNumber: 5, index: 9 },
        { blockNumber: 5, index: 10 },
      ) < 0,
    );
  });
});
