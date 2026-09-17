/**
 * @file test/bot-recorder-scan-helpers.test.js
 * @description `fetchAllNftEvents` reads a whole rebalance chain's event
 *   history in one batched pass, while keeping every NFT's own scan
 *   window and the resume buffer's reuse rules.
 *
 * Two things are pinned here.
 *
 * **Floors.** Each NFT is floored at its own mint block, not the pool's
 * creation block. An NFT cannot emit IncreaseLiquidity / Collect /
 * DecreaseLiquidity before it is minted, so everything before its mint
 * is a guaranteed-empty walk. A shared floor above a mint block still
 * wins. The floors are computed by `nft-events-batch.scanFloors`; these
 * tests record what that real function produces from the arguments the
 * helper passes, so a helper passing the wrong floor or dropping the
 * mint blocks fails here.
 *
 * **The resume buffer.** It carries one lifetime scan across a failure.
 * Reuse is exact only for a retired NFT read at the same floor, and the
 * live NFT is never stored. Under batching the READ is all-or-nothing,
 * so a failed read buffers nothing — see the tests below for why that
 * is acceptable and where the buffer still earns its keep.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const { format } = require("node:util");

const { _setSinkForTests } = require("../src/log");
const { mintBlocksByTokenId } = require("../src/nft-mint-blocks");
const batch = require("../src/nft-events-batch");

/** #100 → #200 → #300, minted 5M and 6M blocks in. */
const CHAIN = [
  { oldTokenId: "100", newTokenId: "200", blockNumber: 5_000_000 },
  { oldTokenId: "200", newTokenId: "300", blockNumber: 6_000_000 },
];
const IDS = ["100", "200", "300"];
const POOL_FLOOR = 1_000_000;

/**
 * Replace the batched read with a recorder.
 *
 * Records, per call, which ids were requested and the floor each id
 * was given — computed by the module's REAL `scanFloors`, so the test
 * checks the floors the scan would actually use. Returns a result with
 * an entry for every requested id, as the real batch does.
 *
 * @param {object} [o]
 * @param {number} [o.failCalls]  Throw on the first N calls.
 * @param {Map<string, object>} [o.events]  tokenId -> events to return.
 */
function stubBatch(o = {}) {
  const calls = [];
  const floors = new Map();
  let failures = o.failCalls ?? 0;
  const orig = batch.scanChainNftEvents;
  batch.scanChainNftEvents = async (ids, args) => {
    const list = [...ids].map(String);
    calls.push(list);
    const f = batch.scanFloors(list, args.mintBlocks, args.sharedFloor);
    for (const [id, from] of f.floors) floors.set(id, from);
    if (failures > 0) {
      failures -= 1;
      throw new Error("simulated non-transient RPC failure");
    }
    return new Map(
      list.map((id) => [id, o.events?.get(id) ?? batch.emptyEvents()]),
    );
  };
  return {
    calls,
    floors,
    /** Every id requested across all calls, in order. */
    requested: () => calls.flat(),
    restore: () => {
      batch.scanChainNftEvents = orig;
    },
  };
}

/*-
 *  Required after the stub is installed, so the helper binds the stub
 *  rather than the real batched read.
 */
function helpers() {
  delete require.cache[require.resolve("../src/bot-recorder-scan-helpers")];
  return require("../src/bot-recorder-scan-helpers");
}

/** Run with a stub installed, always restoring it. */
async function withStub(opts, fn) {
  const s = stubBatch(opts);
  try {
    return await fn(s, helpers());
  } finally {
    s.restore();
  }
}

/** One pass, swallowing the simulated failure. */
async function pass(fetch, buf, opts = {}) {
  try {
    return await fetch(
      IDS,
      opts.floor ?? POOL_FLOOR,
      mintBlocksByTokenId(CHAIN),
      { resumeBuffer: buf, liveTokenId: opts.liveTokenId ?? "999" },
    );
  } catch {
    return null;
  }
}

describe("collectTokenIds", () => {
  it("covers the current NFT and every NFT in the chain", () => {
    const { collectTokenIds } = helpers();
    const ids = collectTokenIds({ tokenId: "300" }, CHAIN);
    assert.deepEqual([...ids].sort(), ["100", "200", "300"]);
  });
});

// ── Batching ─────────────────────────────────────────────────────────

describe("fetchAllNftEvents reads the chain in one batch", () => {
  it("asks for every NFT in a single call", () =>
    withStub({}, async (s, { fetchAllNftEvents }) => {
      await fetchAllNftEvents(IDS, POOL_FLOOR, mintBlocksByTokenId(CHAIN));
      assert.equal(s.calls.length, 1, "one batched read, not one per NFT");
      assert.deepEqual(s.calls[0], IDS);
    }));

  it("returns an entry for every NFT, keyed by string id", () =>
    withStub({}, async (_s, { fetchAllNftEvents }) => {
      const { allNftEvents } = await fetchAllNftEvents(
        [100, 200, 300],
        POOL_FLOOR,
        mintBlocksByTokenId(CHAIN),
      );
      assert.deepEqual([...allNftEvents.keys()], IDS);
    }));

  it("makes no read at all when the buffer answers everything", () =>
    withStub({}, async (s, { fetchAllNftEvents }) => {
      const buf = new Map();
      await pass(fetchAllNftEvents, buf); // all three retired → all buffered
      s.calls.length = 0;
      await pass(fetchAllNftEvents, buf);
      assert.equal(s.calls.length, 0);
    }));

  it("carries the highest event block out as the checkpoint", () => {
    const events = new Map([
      [
        "200",
        {
          ...batch.emptyEvents(),
          collectEvents: [{ blockNumber: 6_500_000 }],
        },
      ],
      [
        "300",
        { ...batch.emptyEvents(), ilEvents: [{ blockNumber: 7_250_000 }] },
      ],
    ]);
    return withStub({ events }, async (_s, { fetchAllNftEvents }) => {
      const { maxBlock } = await fetchAllNftEvents(
        IDS,
        POOL_FLOOR,
        mintBlocksByTokenId(CHAIN),
      );
      assert.equal(maxBlock, 7_250_000);
    });
  });

  it("leaves the checkpoint at the floor when nothing was found", () =>
    withStub({}, async (_s, { fetchAllNftEvents }) => {
      const { maxBlock } = await fetchAllNftEvents(
        IDS,
        POOL_FLOOR,
        mintBlocksByTokenId(CHAIN),
      );
      assert.equal(maxBlock, POOL_FLOOR);
    }));
});

// ── Floors ───────────────────────────────────────────────────────────

describe("fetchAllNftEvents scan floors", () => {
  it("floors each NFT at its own mint block", () =>
    withStub({}, async (s, { fetchAllNftEvents }) => {
      await fetchAllNftEvents(IDS, POOL_FLOOR, mintBlocksByTokenId(CHAIN));
      assert.equal(s.floors.get("200"), 5_000_000);
      assert.equal(s.floors.get("300"), 6_000_000);
    }));

  it("falls back to the shared floor for the chain's first NFT", () =>
    /*- #100 appears only as an oldTokenId, so its mint predates the
     *  chain and the pool's creation block is the honest answer. */
    withStub({}, async (s, { fetchAllNftEvents }) => {
      await fetchAllNftEvents(IDS, POOL_FLOOR, mintBlocksByTokenId(CHAIN));
      assert.equal(s.floors.get("100"), POOL_FLOOR);
    }));

  it("keeps a shared floor that is later than the mint block", () => {
    // `nftScanFrom` keeps the later of the two floors.
    const FLOOR = 7_000_000;
    return withStub({}, async (s, { fetchAllNftEvents }) => {
      await fetchAllNftEvents(IDS, FLOOR, mintBlocksByTokenId(CHAIN));
      for (const tid of IDS) {
        assert.equal(s.floors.get(tid), FLOOR, `${tid} keeps the floor`);
      }
    });
  });

  it("uses the shared floor for every NFT when no mint blocks are given", () =>
    withStub({}, async (s, { fetchAllNftEvents }) => {
      await fetchAllNftEvents(["100", "200"], POOL_FLOOR);
      assert.equal(s.floors.get("100"), POOL_FLOOR);
      assert.equal(s.floors.get("200"), POOL_FLOOR);
    }));

  it("never floors below the shared floor", () =>
    /*- A mint block earlier than the floor must not widen the scan. */
    withStub({}, async (s, { fetchAllNftEvents }) => {
      await fetchAllNftEvents(
        ["200"],
        POOL_FLOOR,
        mintBlocksByTokenId([
          { newTokenId: "200", blockNumber: POOL_FLOOR - 500 },
        ]),
      );
      assert.equal(s.floors.get("200"), POOL_FLOOR);
    }));
});

// ── Resume buffer ────────────────────────────────────────────────────

describe("fetchAllNftEvents resume buffer", () => {
  /*-
   *  The buffer carries one lifetime scan across a failure; it is not a
   *  cache that may answer a later scan, which is why the floor and the
   *  live NFT both gate reuse.
   */

  it("a failed read leaves the buffer untouched", () =>
    /*-
     *  The batch succeeds or fails as a unit, so nothing from a failed
     *  read may be stored — a partial result stored as complete would be
     *  reused as settled history on the retry.
     */
    withStub({ failCalls: 1 }, async (_s, { fetchAllNftEvents }) => {
      const buf = new Map();
      const out = await pass(fetchAllNftEvents, buf);
      assert.equal(out, null, "the failure must propagate");
      assert.equal(buf.size, 0);
    }));

  it("the retry after a failed read asks for everything unbuffered", () =>
    /*-
     *  A batch has no part-way: a failed read stores nothing, and the
     *  retry reads every NFT not already buffered. That is affordable:
     *  the whole chain costs minutes, and transient failures are retried
     *  per request beneath this call, so a read fails outright only on
     *  an error a retry would not fix.
     */
    withStub({ failCalls: 1 }, async (s, { fetchAllNftEvents }) => {
      const buf = new Map();
      await pass(fetchAllNftEvents, buf);
      s.calls.length = 0;
      await pass(fetchAllNftEvents, buf);
      assert.deepEqual(s.requested(), IDS);
    }));

  it("after a successful read, a retry re-reads only the live NFT", () =>
    /*-
     *  Where the buffer still pays: the read succeeded and a LATER step
     *  of the lifetime scan threw, so the whole scan is retried.
     */
    withStub({}, async (s, { fetchAllNftEvents }) => {
      const buf = new Map();
      await pass(fetchAllNftEvents, buf, { liveTokenId: "300" });
      s.calls.length = 0;
      await pass(fetchAllNftEvents, buf, { liveTokenId: "300" });
      assert.deepEqual(s.requested(), ["300"]);
    }));

  it("re-reads an NFT whose effective floor changed", () =>
    /*-
     *  Reuse across a different span would hand the scan events its own
     *  read excludes, or leave out events that read includes. Only #100
     *  moves here: the others' own mint blocks already exceed both
     *  floors, so Math.max leaves their span untouched.
     */
    withStub({}, async (s, { fetchAllNftEvents }) => {
      const buf = new Map();
      await pass(fetchAllNftEvents, buf);
      s.calls.length = 0;
      await pass(fetchAllNftEvents, buf, { floor: 2_000_000 });
      assert.deepEqual(s.requested(), ["100"]);
    }));

  it("reads everything when no buffer is supplied", () =>
    withStub({}, async (s, { fetchAllNftEvents }) => {
      await fetchAllNftEvents(IDS, POOL_FLOOR, mintBlocksByTokenId(CHAIN));
      s.calls.length = 0;
      await fetchAllNftEvents(IDS, POOL_FLOOR, mintBlocksByTokenId(CHAIN));
      assert.deepEqual(s.requested(), IDS);
    }));
});

describe("fetchAllNftEvents — the live NFT is never buffered", () => {
  /*-
   *  Not merely never reused. The live NFT retires at the next
   *  rebalance; from then it is no longer the live one, so a buffered
   *  entry for it looks reusable — but it was read while the NFT was
   *  still open and predates the drain that retired it. Reusing it drops
   *  that NFT's closing Collect and DecreaseLiquidity and understates its
   *  lifetime fees.
   *
   *  The floor cannot catch this: both passes floor the NFT at the same
   *  block, so they compare equal.
   */

  it("keeps the live NFT out of the buffer entirely", () =>
    withStub({}, async (_s, { fetchAllNftEvents }) => {
      const buf = new Map();
      await pass(fetchAllNftEvents, buf, { liveTokenId: "300" });
      assert.deepEqual([...buf.keys()], ["100", "200"]);
    }));

  it("re-reads a just-retired NFT after a rebalance", () =>
    /*-
     *  Pass one with #300 live; a rebalance then makes #400 live and
     *  #300 retired. #300 must be read again, at the same floor.
     */
    withStub({}, async (s, { fetchAllNftEvents }) => {
      const buf = new Map();
      await pass(fetchAllNftEvents, buf, { liveTokenId: "300" });
      s.calls.length = 0;
      await pass(fetchAllNftEvents, buf, { liveTokenId: "400" });
      assert.ok(
        s.requested().includes("300"),
        "the retired NFT's drain would be missed",
      );
    }));

  it("matches the live id whether given as a number or a string", () =>
    withStub({}, async (_s, { fetchAllNftEvents }) => {
      const buf = new Map();
      await fetchAllNftEvents(IDS, POOL_FLOOR, mintBlocksByTokenId(CHAIN), {
        resumeBuffer: buf,
        liveTokenId: 300,
      });
      assert.equal(buf.has("300"), false);
    }));
});

// ── Pure decision ────────────────────────────────────────────────────

describe("partitionByBuffer", () => {
  const floors = new Map([
    ["100", 1],
    ["200", 2],
    ["300", 3],
  ]);
  const ev = { tag: "buffered" };

  it("reuses a retired NFT read at the same floor", () => {
    const { partitionByBuffer } = helpers();
    const buf = new Map([["100", { from: 1, ev }]]);
    const out = partitionByBuffer(["100"], buf, floors, null);
    assert.equal(out.reusedEv.get("100"), ev);
    assert.deepEqual(out.toFetch, []);
  });

  it("fetches when the floor differs", () => {
    const { partitionByBuffer } = helpers();
    const buf = new Map([["100", { from: 99, ev }]]);
    const out = partitionByBuffer(["100"], buf, floors, null);
    assert.deepEqual(out.toFetch, ["100"]);
  });

  it("fetches the live NFT even when buffered at the same floor", () => {
    const { partitionByBuffer } = helpers();
    const buf = new Map([["300", { from: 3, ev }]]);
    const out = partitionByBuffer(["300"], buf, floors, "300");
    assert.deepEqual(out.toFetch, ["300"]);
  });

  it("fetches everything when there is no buffer", () => {
    const { partitionByBuffer } = helpers();
    const out = partitionByBuffer(IDS, null, floors, null);
    assert.deepEqual(out.toFetch, IDS);
    assert.equal(out.reusedEv.size, 0);
  });
});

describe("_lifetimeResumeBuffer", () => {
  /*-
   *  A full rescan means a rebalance fired, so the chain it buffered is
   *  no longer the chain being scanned — most obviously the NFT that
   *  rebalance just retired, whose drain is not in the buffered read.
   *  The floor comparison cannot catch that: both passes floor the NFT
   *  at the same block, so they compare equal.
   */
  const { _lifetimeResumeBuffer } = require("../src/bot-recorder-lifetime");

  it("creates one on first use", () => {
    const botState = {};
    const buf = _lifetimeResumeBuffer(botState, false);
    assert.ok(buf instanceof Map);
    assert.strictEqual(botState._lifetimeResumeBuffer, buf);
  });

  it("keeps the same buffer across an ordinary retry", () => {
    const botState = {};
    const first = _lifetimeResumeBuffer(botState, false);
    first.set("100", { from: 1, ev: {} });
    assert.strictEqual(_lifetimeResumeBuffer(botState, false), first);
    assert.strictEqual(first.size, 1);
  });

  it("discards it on a full rescan", () => {
    const botState = {};
    const first = _lifetimeResumeBuffer(botState, false);
    first.set("100", { from: 1, ev: {} });
    const next = _lifetimeResumeBuffer(botState, true);
    assert.notStrictEqual(next, first, "a rebalance must not inherit reads");
    assert.strictEqual(next.size, 0);
  });

  it("replaces a non-Map left on the state", () => {
    /*- `_recordScanSuccess` releases it by assigning null. */
    const botState = { _lifetimeResumeBuffer: null };
    assert.ok(_lifetimeResumeBuffer(botState, false) instanceof Map);
  });

  it("tolerates no state object at all", () => {
    /*-
     *  Without a state object there is nowhere to carry reads, so the
     *  caller still gets a usable buffer and simply reads everything.
     */
    for (const missing of [undefined, null]) {
      const buf = _lifetimeResumeBuffer(missing, false);
      assert.ok(buf instanceof Map, "callers must still get a usable buffer");
      assert.strictEqual(buf.size, 0);
    }
  });
});

describe("fetchAllNftEvents — reporting what the buffer saved", () => {
  /*-
   *  The batched read logs progress per event type across the whole id
   *  list, so nothing else in the log says which NFTs were skipped. This
   *  line is the only record that the buffer answered any of them, and
   *  the burn-in procedure greps for it.
   */

  /** Capture `log.info` through the module's own sink. */
  function captureInfo() {
    const lines = [];
    const restore = _setSinkForTests({
      log: (...a) => lines.push(format(...a)),
    });
    return { lines, restore };
  }

  it("reports the split once the buffer is used", () =>
    withStub({}, async (_s, { fetchAllNftEvents }) => {
      const buf = new Map();
      /*-
       *  #300 is live on the first pass, so only #100 and #200 are
       *  buffered. On the second, #300 has retired and must be read.
       */
      await pass(fetchAllNftEvents, buf, { liveTokenId: "300" });
      const { lines, restore } = captureInfo();
      try {
        await pass(fetchAllNftEvents, buf, { liveTokenId: "999" });
      } finally {
        restore();
      }
      const line = lines.find((l) => l.includes("Lifetime scan resumed"));
      assert.ok(line, "a resumed scan must say so");
      assert.match(line, /2 of 3 NFT read\(s\) taken from the buffer/);
      assert.match(line, /1 re-fetched/);
    }));

  it("stays silent when nothing was reused", () =>
    /*- A line on every scan would be noise, and would train the reader
     *  to skip the one case it exists to report. */
    withStub({}, async (_s, { fetchAllNftEvents }) => {
      const { lines, restore } = captureInfo();
      try {
        await pass(fetchAllNftEvents, new Map());
      } finally {
        restore();
      }
      assert.equal(
        lines.filter((l) => l.includes("Lifetime scan resumed")).length,
        0,
      );
    }));
});
