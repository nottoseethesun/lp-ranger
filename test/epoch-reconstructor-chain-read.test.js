"use strict";

/**
 * @file test/epoch-reconstructor-chain-read.test.js
 * @description Epoch reconstruction reads the chain's
 *   Collect/DecreaseLiquidity history once, for exactly the NFTs it is
 *   about to build, and hands each NFT its own slice.
 *
 *   Reading one NFT at a time, each from its own mint to the chain head,
 *   repeated almost the whole chain per NFT. Reading the chain at once
 *   moves "which NFT is this" from the request to the response, so what
 *   needs pinning is the sequencing: the read runs before the loop, it
 *   was prepared with the ids the loop will ask for, and a failed read
 *   leaves every NFT's history unknown rather than setting off one read
 *   per NFT.
 *
 *   `getPositionHistory` is replaced by a recorder, so what these tests
 *   see is exactly what the reconstructor hands it.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { format } = require("node:util");
const { _setSinkForTests } = require("../src/log");
const { collectAndDrainOf } = require("../src/position-history-scan-helpers");

const IDS = ["10", "11", "12"];

/** A complete history, so every NFT the loop reads builds an epoch. */
const HISTORY = {
  mintDate: "2026-03-15T10:00:00Z",
  closeDate: "2026-03-16T10:00:00Z",
  entryValueUsd: 100,
  exitValueUsd: 95,
  feesEarnedUsd: 1,
  gasCostWei: "0",
};

/*- What a buffered NFT holds: the history as it was when its epoch
 *  built, gas already converted — a buffered read is not converted
 *  again. */
const BUFFERED = { ...HISTORY, gasNative: 0, gasCostUsd: 0 };

/** A history unique to `id`, so a mixed-up hand-off shows. */
const drainOf = (id) => ({
  collectEvents: [{ amount0: BigInt(id), amount1: 0n, blockNumber: +id }],
  dlEvents: [],
});

/** A chain read that answers every id it was asked for. */
const readAll = async (ids) =>
  new Map(ids.map((id) => [String(id), drainOf(id)]));

/**
 * Load `_fetchEpochsFromChain` with the chain read and the per-NFT
 * history replaced by recorders.
 *
 * @param {Function} read  Stands in for `scanChainCollectAndDrain`.
 * @returns {{fetch: Function, trace: object[]}}
 */
function load(read) {
  const trace = [];
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === "./position-history-scan-helpers") {
      return {
        scanChainCollectAndDrain: async (ids, events) => {
          trace.push({ step: "read", ids: [...ids], events });
          return read(ids, events);
        },
        /*- The real mapping: which histories a shared read yields is
         *  part of what these tests pin. */
        collectAndDrainOf,
      };
    }
    if (id === "./position-history") {
      return {
        getPositionHistory: async (tokenId, opts) => {
          trace.push({ step: "history", tokenId, opts });
          return { ...HISTORY };
        },
      };
    }
    /*- Neither may reach the network from a unit test. */
    if (id === "./bot-pnl-updater") return { actualGasCostUsd: async () => 0 };
    if (id === "./price-fetcher") {
      return {
        fetchTokenPriceUsd: async () => 1,
        withFreshPricesAllowed: async (fn) => fn(),
      };
    }
    return orig.apply(this, arguments);
  };
  try {
    delete require.cache[require.resolve("../src/epoch-reconstructor")];
    const mod = require("../src/epoch-reconstructor");
    /*- Evicted again so the stubbed copy is not handed to whoever
     *  requires the module next. */
    delete require.cache[require.resolve("../src/epoch-reconstructor")];
    return { fetch: mod._fetchEpochsFromChain, trace };
  } finally {
    Module.prototype.require = orig;
  }
}

const historyCalls = (trace) => trace.filter((t) => t.step === "history");

/** Capture formatted `log.warn` lines through the module's test sink. */
function captureWarnings() {
  const lines = [];
  const restore = _setSinkForTests({
    warn: (...a) => lines.push(format(...a)),
  });
  return { lines, restore };
}

describe("epoch reconstruction reads the chain once", () => {
  it("reads before any NFT is built, and only once", async () => {
    const { fetch, trace } = load(readAll);
    await fetch(IDS, [], null, null, null, new Map());
    assert.deepEqual(
      trace.map((t) => t.step),
      ["read", "history", "history", "history"],
    );
  });

  it("hands each NFT its own history", async () => {
    const { fetch, trace } = load(readAll);
    await fetch(IDS, [], null, null, null, new Map());
    const calls = historyCalls(trace);
    assert.deepEqual(
      calls.map((c) => c.tokenId),
      IDS,
    );
    for (const c of calls) {
      assert.deepEqual(c.opts.collectAndDrain, drainOf(c.tokenId));
    }
  });

  it("passes the rebalance events through unchanged", async () => {
    /*- The same array, not a copy: the chain's first mint travels as a
     *  property on it, and a copy would drop the oldest NFT's floor to
     *  the pool's creation block. */
    const events = [{ oldTokenId: "10", newTokenId: "11", blockNumber: 5 }];
    events.firstMintBlockNumber = 3;
    const { fetch, trace } = load(readAll);
    await fetch(["10"], events, null, null, null, new Map());
    assert.strictEqual(trace[0].events, events);
  });

  it("still gives each NFT the rest of what it needs", async () => {
    const events = [{ oldTokenId: "10", newTokenId: "11" }];
    const activePos = { token0: "0xA", token1: "0xB", fee: 2500 };
    const prices = { price0: 2, price1: 3 };
    const { fetch, trace } = load(readAll);
    await fetch(["10"], events, activePos, prices, null, new Map());
    const { opts } = historyCalls(trace)[0];
    assert.strictEqual(opts.rebalanceEvents, events);
    assert.strictEqual(opts.activePosition, activePos);
    assert.strictEqual(opts.fallbackPrices, prices);
  });
});

describe("the read covers exactly the NFTs the loop will fetch", () => {
  it("leaves buffered NFTs out", async () => {
    const buffer = new Map([["11", { ...BUFFERED }]]);
    const { fetch, trace } = load(readAll);
    const epochs = await fetch(IDS, [], null, null, null, buffer);
    assert.deepEqual(trace[0].ids, ["10", "12"]);
    assert.deepEqual(
      historyCalls(trace).map((c) => c.tokenId),
      ["10", "12"],
    );
    assert.equal(epochs.length, 3, "the buffered NFT still builds");
  });

  it("fetches nothing per NFT when every NFT is buffered", async () => {
    const buffer = new Map(IDS.map((id) => [id, { ...BUFFERED }]));
    const { fetch, trace } = load(readAll);
    const epochs = await fetch(IDS, [], null, null, null, buffer);
    assert.ok(
      trace.every((t) => t.step !== "read" || t.ids.length === 0),
      "nothing is left to read",
    );
    assert.equal(historyCalls(trace).length, 0);
    assert.equal(epochs.length, 3);
  });

  it("reads the whole chain when there is no buffer", async () => {
    const { fetch, trace } = load(readAll);
    await fetch(IDS, [], null, null, null);
    assert.deepEqual(trace[0].ids, IDS);
  });

  it("fails an NFT the read was not prepared for, alone and loudly", async () => {
    /*- An NFT missing from the read must not be taken as "no history":
     *  downstream that is a closed epoch with no fees. */
    const { fetch, trace } = load(async (ids) =>
      readAll(ids.filter((id) => id !== "11")),
    );
    const cap = captureWarnings();
    let epochs;
    try {
      epochs = await fetch(IDS, [], null, null, null, new Map());
    } finally {
      cap.restore();
    }
    assert.deepEqual(
      historyCalls(trace).map((c) => c.tokenId),
      ["10", "12"],
      "#11 must fail before its history is assembled",
    );
    assert.equal(epochs.length, 2);
    assert.ok(
      cap.lines.some((l) => /NFT #11:.*no events fetched for #11/.test(l)),
      cap.lines.join("\n"),
    );
  });
});

describe("a failed chain read", () => {
  const failing = async () => {
    throw new Error("rpc unavailable");
  };

  it("leaves every NFT's history unknown, and says why", async () => {
    const { fetch, trace } = load(failing);
    const cap = captureWarnings();
    try {
      await fetch(IDS, [], null, null, null, new Map());
    } finally {
      cap.restore();
    }
    const calls = historyCalls(trace);
    assert.equal(calls.length, 3, "the pass still finishes");
    for (const c of calls) {
      /*- null, not undefined: undefined tells `getPositionHistory` to
       *  read the NFT on its own, which is the walk the chain read
       *  replaces — one NFT at a time, for the whole chain. */
      assert.strictEqual(c.opts.collectAndDrain, null);
    }
    assert.ok(
      cap.lines.some((l) => l.includes("3 closed NFT(s): rpc unavailable")),
      cap.lines.join("\n"),
    );
  });

  it("still builds the NFTs whose figures need no chain read", async () => {
    /*- The history here is complete without the chain, as it is when
     *  the rebalance log already holds the exit value and the fee. */
    const { fetch } = load(failing);
    const cap = captureWarnings();
    try {
      const epochs = await fetch(IDS, [], null, null, null, new Map());
      assert.equal(epochs.length, 3);
    } finally {
      cap.restore();
    }
  });
});

describe("a chain read shared with the lifetime scan", () => {
  /*- When the lifetime scan is going to read the whole chain this pass,
   *  reconstruction takes its histories from that read instead of making
   *  a second. That read carries all three event types for every NFT. */

  /** A whole-chain entry, as the lifetime read returns it. */
  const fullEntry = (id) => ({
    ilEvents: [{ amount0: 1n, amount1: 1n, blockNumber: +id }],
    ...drainOf(id),
    ilLogsCount: 1,
  });

  /** A shared read over `ids`, counting how often it is asked for. */
  function sharedOver(ids, entryOf = fullEntry) {
    const asked = [];
    const read = async () => {
      asked.push(1);
      return new Map(ids.map((id) => [String(id), entryOf(id)]));
    };
    return { read, asked };
  }

  it("takes each NFT's history from it, and makes no read of its own", async () => {
    const { fetch, trace } = load(readAll);
    const shared = sharedOver([...IDS, "13"]);
    await fetch(IDS, [], null, null, null, new Map(), shared.read);
    assert.equal(
      trace.some((t) => t.step === "read"),
      false,
      "a second read of the same chain",
    );
    assert.equal(shared.asked.length, 1);
    for (const c of historyCalls(trace)) {
      assert.deepEqual(c.opts.collectAndDrain, drainOf(c.tokenId));
    }
  });

  it("hands on only Collect and DecreaseLiquidity", async () => {
    const { fetch, trace } = load(readAll);
    await fetch(IDS, [], null, null, null, new Map(), sharedOver(IDS).read);
    for (const c of historyCalls(trace)) {
      assert.deepEqual(Object.keys(c.opts.collectAndDrain).sort(), [
        "collectEvents",
        "dlEvents",
      ]);
    }
  });

  it("keeps the rule that no Collect means the history was not seen", async () => {
    const { fetch, trace } = load(readAll);
    const noCollect = (id) =>
      id === "11" ? { ...fullEntry(id), collectEvents: [] } : fullEntry(id);
    await fetch(
      IDS,
      [],
      null,
      null,
      null,
      new Map(),
      sharedOver(IDS, noCollect).read,
    );
    const byId = new Map(historyCalls(trace).map((c) => [c.tokenId, c]));
    assert.strictEqual(byId.get("11").opts.collectAndDrain, null);
    assert.notStrictEqual(byId.get("10").opts.collectAndDrain, null);
  });

  it("does not start it when every NFT is already buffered", async () => {
    /*- Nothing to read, so reconstruction must not be the reason the
     *  shared read runs. */
    const { fetch } = load(readAll);
    const shared = sharedOver(IDS);
    const buffer = new Map(IDS.map((id) => [id, { ...BUFFERED }]));
    await fetch(IDS, [], null, null, null, buffer, shared.read);
    assert.equal(shared.asked.length, 0);
  });

  it("uses it only for the NFTs still to be read", async () => {
    const { fetch, trace } = load(readAll);
    const buffer = new Map([["11", { ...BUFFERED }]]);
    const epochs = await fetch(
      IDS,
      [],
      null,
      null,
      null,
      buffer,
      sharedOver(IDS).read,
    );
    assert.deepEqual(
      historyCalls(trace).map((c) => c.tokenId),
      ["10", "12"],
    );
    assert.equal(epochs.length, 3);
  });

  it("fails an NFT the shared read does not cover, alone", async () => {
    const { fetch, trace } = load(readAll);
    const cap = captureWarnings();
    let epochs;
    try {
      epochs = await fetch(
        IDS,
        [],
        null,
        null,
        null,
        new Map(),
        sharedOver(["10", "12"]).read,
      );
    } finally {
      cap.restore();
    }
    assert.deepEqual(
      historyCalls(trace).map((c) => c.tokenId),
      ["10", "12"],
    );
    assert.equal(epochs.length, 2);
    assert.ok(
      cap.lines.some((l) => /NFT #11:.*no events fetched for #11/.test(l)),
      cap.lines.join("\n"),
    );
  });

  it("leaves every history unknown when it fails, without reading again", async () => {
    /*- The lifetime scan retries the shared read on its own turn; a
     *  second read here would be the duplicate this sharing removes. */
    const { fetch, trace } = load(readAll);
    const cap = captureWarnings();
    try {
      await fetch(IDS, [], null, null, null, new Map(), async () => {
        throw new Error("rpc unavailable");
      });
    } finally {
      cap.restore();
    }
    assert.equal(
      trace.some((t) => t.step === "read"),
      false,
    );
    for (const c of historyCalls(trace)) {
      assert.strictEqual(c.opts.collectAndDrain, null);
    }
    assert.ok(
      cap.lines.some((l) => l.includes("3 closed NFT(s): rpc unavailable")),
      cap.lines.join("\n"),
    );
  });
});
