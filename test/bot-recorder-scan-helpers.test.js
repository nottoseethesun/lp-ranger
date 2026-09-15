/**
 * @file test/bot-recorder-scan-helpers.test.js
 * @description Each NFT in the rebalance chain is scanned across its own
 *   life, not the pool's.
 *
 * `fetchAllNftEvents` took one `fromBlock` for the whole chain — the
 * pool's creation block — and handed the same one to every NFT. An NFT
 * cannot emit IncreaseLiquidity / Collect / DecreaseLiquidity before it
 * is minted, so everything before its mint was a guaranteed-empty walk.
 *
 * Measured on a real position: a 132-rebalance chain in a pool created
 * two years before the operator's first deposit. At the 9,000-block
 * chunk width that is 954 chunks per NFT across ~133 NFTs, three
 * queries each, every one of them paced — the best part of a day, nearly
 * all of it scanning blocks where the NFT did not yet exist. Floored at
 * each NFT's own mint, most drop to single-digit
 * chunks.
 *
 * The resume case is the subtle one and has its own test: there
 * `fromBlock` is a checkpoint from a previous scan, not the pool's
 * creation block, and it has to win over an earlier mint block or the
 * scan re-walks ground it already covered.
 */

"use strict";

const { describe, it, mock } = require("node:test");
const assert = require("node:assert/strict");
const { format } = require("node:util");

const { _setSinkForTests } = require("../src/log");
const { mintBlocksByTokenId } = require("../src/nft-mint-blocks");

/** Record the fromBlock each NFT's scan was given. */
function withStubbedScanner(fn) {
  const compounder = require("../src/compounder");
  const seen = new Map();
  const restore = compounder.scanNftEvents;
  mock.method(compounder, "scanNftEvents", async (tid, opts) => {
    seen.set(String(tid), opts.fromBlock);
    return { ilEvents: [], collectEvents: [], dlEvents: [], ilLogsCount: 0 };
  });
  return fn(seen).finally(() => {
    compounder.scanNftEvents = restore;
    mock.reset();
  });
}

/*- Required after the stub is installed, so it binds the mocked
 *  `scanNftEvents` rather than the real one. */
function helpers() {
  delete require.cache[require.resolve("../src/bot-recorder-scan-helpers")];
  return require("../src/bot-recorder-scan-helpers");
}

/** #100 → #200 → #300, minted 5M and 6M blocks in. */
const CHAIN = [
  { oldTokenId: "100", newTokenId: "200", blockNumber: 5_000_000 },
  { oldTokenId: "200", newTokenId: "300", blockNumber: 6_000_000 },
];
const POOL_CREATION = 1_000_000;

describe("collectTokenIds", () => {
  it("covers the current NFT and every NFT in the chain", () => {
    const { collectTokenIds } = helpers();
    const ids = collectTokenIds({ tokenId: "300" }, CHAIN);
    assert.deepEqual([...ids].sort(), ["100", "200", "300"]);
  });
});

describe("fetchAllNftEvents scan floors", () => {
  it("scans each NFT from its own mint block", async () => {
    await withStubbedScanner(async (seen) => {
      const { fetchAllNftEvents } = helpers();
      await fetchAllNftEvents(
        ["100", "200", "300"],
        POOL_CREATION,
        mintBlocksByTokenId(CHAIN),
      );
      assert.equal(seen.get("200"), 5_000_000);
      assert.equal(seen.get("300"), 6_000_000);
    });
  });

  it("falls back to the shared floor for the chain's first NFT", async () => {
    /*- #100 appears only as an oldTokenId, so its mint predates the
     *  chain and the pool's creation block is the honest answer. */
    await withStubbedScanner(async (seen) => {
      const { fetchAllNftEvents } = helpers();
      await fetchAllNftEvents(
        ["100", "200", "300"],
        POOL_CREATION,
        mintBlocksByTokenId(CHAIN),
      );
      assert.equal(seen.get("100"), POOL_CREATION);
    });
  });

  it("keeps a resume checkpoint that is later than the mint block", async () => {
    /*- The incremental path passes a checkpoint from a previous scan as
     *  `fromBlock`.  Using the earlier mint block here would re-walk
     *  everything the last scan already covered — the exact waste this
     *  change exists to remove. */
    const CHECKPOINT = 7_000_000;
    await withStubbedScanner(async (seen) => {
      const { fetchAllNftEvents } = helpers();
      await fetchAllNftEvents(
        ["100", "200", "300"],
        CHECKPOINT,
        mintBlocksByTokenId(CHAIN),
      );
      for (const tid of ["100", "200", "300"]) {
        assert.equal(
          seen.get(tid),
          CHECKPOINT,
          `${tid} must resume, not rescan`,
        );
      }
    });
  });

  it("behaves as before when no mint blocks are supplied", async () => {
    /*- Callers without a chain to read from still get the old contract. */
    await withStubbedScanner(async (seen) => {
      const { fetchAllNftEvents } = helpers();
      await fetchAllNftEvents(["100", "200"], POOL_CREATION);
      assert.equal(seen.get("100"), POOL_CREATION);
      assert.equal(seen.get("200"), POOL_CREATION);
    });
  });

  it("never scans below the shared floor", async () => {
    /*- A mint block earlier than the floor must not widen the scan. */
    await withStubbedScanner(async (seen) => {
      const { fetchAllNftEvents } = helpers();
      await fetchAllNftEvents(
        ["200"],
        POOL_CREATION,
        mintBlocksByTokenId([
          { newTokenId: "200", blockNumber: POOL_CREATION - 500 },
        ]),
      );
      assert.equal(seen.get("200"), POOL_CREATION);
    });
  });
});

// ── per-NFT resume buffer ────────────────────────────────────────────────────

describe("fetchAllNftEvents resume buffer", () => {
  /*- A throw anywhere in this loop used to discard every NFT already
   *  read, because the results lived only in a local Map. On a real
   *  132-NFT chain that meant three attempts, each re-reading the same
   *  NFTs, and no net progress across two hours. The buffer carries one
   *  scan across a failure; it is not a cache that may answer a later
   *  scan, which is why the floor and the live NFT both gate reuse. */

  const CHAIN_IDS = ["100", "200", "300"];
  const POOL_FLOOR = 1_000_000;

  /** Scanner stub that fails on `failOn` the first time it sees it. */
  function stubScanner(failOn) {
    const compounder = require("../src/compounder");
    const seen = [];
    let failed = false;
    const restore = compounder.scanNftEvents;
    compounder.scanNftEvents = async (tid) => {
      seen.push(String(tid));
      if (String(tid) === failOn && !failed) {
        failed = true;
        throw new Error("simulated RPC outage");
      }
      return { ilEvents: [], collectEvents: [], dlEvents: [], ilLogsCount: 0 };
    };
    return {
      seen,
      restore: () => {
        compounder.scanNftEvents = restore;
      },
    };
  }

  /** Run one pass, swallowing the simulated outage. */
  async function pass(fetch, buf, opts = {}) {
    try {
      await fetch(
        CHAIN_IDS,
        opts.floor ?? POOL_FLOOR,
        mintBlocksByTokenId(CHAIN),
        {
          resumeBuffer: buf,
          liveTokenId: opts.liveTokenId ?? "999",
        },
      );
    } catch {
      /* the simulated outage */
    }
  }

  it("re-reads only the NFT that failed", async () => {
    const stub = stubScanner("300");
    try {
      const { fetchAllNftEvents } = helpers();
      const buf = new Map();
      await pass(fetchAllNftEvents, buf);
      assert.deepEqual(stub.seen, ["100", "200", "300"]);
      assert.deepEqual(
        [...buf.keys()],
        ["100", "200"],
        "the failed NFT must not be buffered",
      );
      stub.seen.length = 0;
      await pass(fetchAllNftEvents, buf);
      assert.deepEqual(
        stub.seen,
        ["300"],
        "the retry re-read more than the gap",
      );
    } finally {
      stub.restore();
      mock.reset();
    }
  });

  it("always re-reads the live NFT", async () => {
    /*- A retired NFT is inert, but the live one keeps emitting and the
     *  chain head moves between a failure and the retry, so a buffered
     *  read of it would stop short of the head. */
    const stub = stubScanner(null);
    try {
      const { fetchAllNftEvents } = helpers();
      const buf = new Map();
      await pass(fetchAllNftEvents, buf, { liveTokenId: "300" });
      stub.seen.length = 0;
      await pass(fetchAllNftEvents, buf, { liveTokenId: "300" });
      assert.deepEqual(stub.seen, ["300"]);
    } finally {
      stub.restore();
      mock.reset();
    }
  });

  it("re-reads an NFT whose effective floor changed", async () => {
    /*- Reuse across a different span would double-count into the
     *  aggregates when wider and drop events when narrower. Only #100
     *  moves here: the others' own mint blocks already exceed both
     *  floors, so `Math.max` leaves their span untouched. */
    const stub = stubScanner(null);
    try {
      const { fetchAllNftEvents } = helpers();
      const buf = new Map();
      await pass(fetchAllNftEvents, buf);
      stub.seen.length = 0;
      await pass(fetchAllNftEvents, buf, { floor: 2_000_000 });
      assert.deepEqual(stub.seen, ["100"]);
    } finally {
      stub.restore();
      mock.reset();
    }
  });

  it("scans everything when no buffer is supplied", async () => {
    /*- Callers that pass no buffer keep the original contract. */
    const stub = stubScanner(null);
    try {
      const { fetchAllNftEvents } = helpers();
      await fetchAllNftEvents(
        CHAIN_IDS,
        POOL_FLOOR,
        mintBlocksByTokenId(CHAIN),
      );
      stub.seen.length = 0;
      await fetchAllNftEvents(
        CHAIN_IDS,
        POOL_FLOOR,
        mintBlocksByTokenId(CHAIN),
      );
      assert.deepEqual(stub.seen, CHAIN_IDS);
    } finally {
      stub.restore();
      mock.reset();
    }
  });
});

describe("fetchAllNftEvents — the live NFT is never buffered", () => {
  /*- Not merely never reused. The live NFT retires at the next
   *  rebalance; from that moment it is no longer the live one, so a
   *  buffered entry for it looks reusable — but it was read while the
   *  NFT was still open and predates the drain that retired it. Reusing
   *  it drops that NFT's closing Collect and DecreaseLiquidity and
   *  understates its lifetime fees.
   *
   *  The scan floor cannot catch this: until a scan completes there is
   *  no resume checkpoint, so both passes floor at the pool creation
   *  block and the floors compare equal. */

  const CHAIN = [
    { oldTokenId: "100", newTokenId: "200", blockNumber: 5_000_000 },
    { oldTokenId: "200", newTokenId: "300", blockNumber: 6_000_000 },
  ];
  const IDS = ["100", "200", "300"];
  const FLOOR = 1_000_000;

  /** Scanner stub recording which NFTs were read. */
  function stub() {
    const compounder = require("../src/compounder");
    const seen = [];
    const restore = compounder.scanNftEvents;
    compounder.scanNftEvents = async (tid) => {
      seen.push(String(tid));
      return { ilEvents: [], collectEvents: [], dlEvents: [], ilLogsCount: 0 };
    };
    return {
      seen,
      restore: () => {
        compounder.scanNftEvents = restore;
      },
    };
  }

  it("keeps the live NFT out of the buffer entirely", async () => {
    const s = stub();
    try {
      const { fetchAllNftEvents } = helpers();
      const buf = new Map();
      await fetchAllNftEvents(IDS, FLOOR, mintBlocksByTokenId(CHAIN), {
        resumeBuffer: buf,
        liveTokenId: "300",
      });
      assert.deepEqual(
        [...buf.keys()],
        ["100", "200"],
        "#300 was live, so its read must not be retained",
      );
    } finally {
      s.restore();
      mock.reset();
    }
  });

  it("re-reads a just-retired NFT after a rebalance", async () => {
    /*- Pass one with #300 live, then a rebalance makes #400 live and
     *  #300 retired. #300 must be read again, at the same floor. */
    const s = stub();
    try {
      const { fetchAllNftEvents } = helpers();
      const buf = new Map();
      const mb = mintBlocksByTokenId(CHAIN);
      await fetchAllNftEvents(IDS, FLOOR, mb, {
        resumeBuffer: buf,
        liveTokenId: "300",
      });
      s.seen.length = 0;
      await fetchAllNftEvents(IDS, FLOOR, mb, {
        resumeBuffer: buf,
        liveTokenId: "400",
      });
      assert.ok(
        s.seen.includes("300"),
        "the retired NFT's drain would be missed",
      );
    } finally {
      s.restore();
      mock.reset();
    }
  });
});

describe("_lifetimeResumeBuffer", () => {
  /*- The buffer carries one scan across a failure. A full rescan means
   *  a rebalance fired, so the chain it buffered is no longer the chain
   *  being scanned — most obviously the NFT that rebalance just
   *  retired, whose drain is not in the buffered read. The floor
   *  comparison cannot catch that: with no completed scan there is no
   *  resume checkpoint, so both passes floor at the pool creation block
   *  and compare equal. */
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
    /*- This is the first thing in the lifetime scan to reach into
     *  `botState`. Throwing here would turn an absent one into a
     *  failure before any scanning is attempted, where it previously
     *  surfaced only at the end — so the scan must still run, just
     *  without resume. */
    for (const missing of [undefined, null]) {
      const buf = _lifetimeResumeBuffer(missing, false);
      assert.ok(buf instanceof Map, "callers must still get a usable buffer");
      assert.strictEqual(buf.size, 0);
    }
  });
});

describe("fetchAllNftEvents — reporting what the buffer saved", () => {
  /*- Without this line, reuse is visible only as the ABSENCE of
   *  `compounder IncreaseLiquidity #<id>` progress lines for the NFTs
   *  that were skipped. Absence reads identically to a scan that had no
   *  work to do, so an operator checking whether resume actually worked
   *  had nothing to look at. The burn-in procedure greps for it. */

  const IDS = ["100", "200", "300"];
  const FLOOR = 1_000_000;

  /** Capture `log.info` through the module's own sink. */
  function captureInfo() {
    const lines = [];
    const restore = _setSinkForTests({
      log: (...a) => lines.push(format(...a)),
    });
    return { lines, restore };
  }

  /** Scanner stub that throws for `failOn` the first time only. */
  function stub(failOn) {
    const compounder = require("../src/compounder");
    const orig = compounder.scanNftEvents;
    let failed = false;
    compounder.scanNftEvents = async (tid) => {
      if (String(tid) === failOn && !failed) {
        failed = true;
        throw new Error("simulated RPC outage");
      }
      return { ilEvents: [], collectEvents: [], dlEvents: [], ilLogsCount: 0 };
    };
    return () => {
      compounder.scanNftEvents = orig;
    };
  }

  async function pass(fetch, buf) {
    try {
      await fetch(IDS, FLOOR, mintBlocksByTokenId(CHAIN), {
        resumeBuffer: buf,
        liveTokenId: "999",
      });
    } catch {
      /* the simulated outage */
    }
  }

  it("reports the split once the buffer is used", async () => {
    const restoreScanner = stub("300");
    try {
      const { fetchAllNftEvents } = helpers();
      const buf = new Map();
      await pass(fetchAllNftEvents, buf); // #100, #200 buffered; #300 throws
      const { lines, restore } = captureInfo();
      try {
        await pass(fetchAllNftEvents, buf); // retry: two reused, one read
      } finally {
        restore();
      }
      const line = lines.find((l) => l.includes("Lifetime scan resumed"));
      assert.ok(line, "a resumed scan must say so");
      assert.match(line, /2 of 3 NFT read\(s\) taken from the buffer/);
      assert.match(line, /1 re-fetched/);
    } finally {
      restoreScanner();
      mock.reset();
    }
  });

  it("stays silent when nothing was reused", async () => {
    /*- A line on every scan would be noise, and would train the reader
     *  to skip the one case it exists to report. */
    const restoreScanner = stub(null);
    try {
      const { fetchAllNftEvents } = helpers();
      const { lines, restore } = captureInfo();
      try {
        await pass(fetchAllNftEvents, new Map());
      } finally {
        restore();
      }
      assert.equal(
        lines.filter((l) => l.includes("Lifetime scan resumed")).length,
        0,
        "a first pass reuses nothing and must not claim otherwise",
      );
    } finally {
      restoreScanner();
      mock.reset();
    }
  });
});
