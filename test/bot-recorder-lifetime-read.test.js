"use strict";

/**
 * @file test/bot-recorder-lifetime-read.test.js
 * @description The lifetime scan's chain read, prepared so epoch
 *   reconstruction can take its events from the same read.
 *
 *   Pinned: what a prepared read covers and when it runs; that it runs
 *   once however many consumers ask; that its start block and resume
 *   buffer are decided when it runs; and that it is reused only for the
 *   chain it was prepared for. Epoch reconstruction can take long enough
 *   for a manual rebalance to land, and a read prepared before that
 *   rebalance describes a chain that no longer exists.
 *
 *   The batched read is replaced by a recorder; the id collection and the
 *   mint-block rules are the real ones, since what a read covers is the
 *   point.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("node:module");
const { format } = require("node:util");
const { _setSinkForTests } = require("../src/log");
const { collectTokenIds } = require("../src/bot-recorder-scan-helpers");

/** #100 → #200 → #300, the chain's first mint at 4,000. */
function chain() {
  return Object.assign(
    [
      { oldTokenId: "100", newTokenId: "200", blockNumber: 5_000 },
      { oldTokenId: "200", newTokenId: "300", blockNumber: 6_000 },
    ],
    { firstMintBlockNumber: 4_000 },
  );
}
const position = () => ({ tokenId: "300" });
const CTX = { t0Sym: "A", t1Sym: "B", tokenIdStr: "300", tokenEmoji: "" };

/** Load the module with the batched read replaced by a recorder. */
function load() {
  const reads = [];
  const orig = Module.prototype.require;
  Module.prototype.require = function (id) {
    if (id === "./bot-recorder-scan-helpers") {
      return {
        collectTokenIds,
        fetchAllNftEvents: async (ids, fromBlock, mintBlocks, opts) => {
          reads.push({ ids: [...ids], fromBlock, mintBlocks, opts });
          return new Map([...ids].map((id) => [id, { id }]));
        },
      };
    }
    return orig.apply(this, arguments);
  };
  const file = require.resolve("../src/bot-recorder-lifetime-read");
  delete require.cache[file];
  try {
    return { mod: require(file), reads };
  } finally {
    Module.prototype.require = orig;
    delete require.cache[file];
  }
}

/** A `start` answering a fixed block and buffer, counting its calls. */
function startAt(fromBlock, resumeBuffer = new Map()) {
  const calls = [];
  const start = async () => {
    calls.push(1);
    return { fromBlock, resumeBuffer };
  };
  return { start, calls, resumeBuffer };
}

describe("prepareChainRead", () => {
  it("reads nothing, and decides nothing, until asked", () => {
    const { mod, reads } = load();
    const s = startAt(1_000);
    mod.prepareChainRead({
      position: position(),
      rebalanceEvents: chain(),
      start: s.start,
    });
    assert.equal(reads.length, 0);
    assert.equal(s.calls.length, 0);
  });

  it("reads every NFT in the chain, each from its own mint", async () => {
    const { mod, reads } = load();
    const prepared = mod.prepareChainRead({
      position: position(),
      rebalanceEvents: chain(),
      start: startAt(1_000).start,
    });
    const events = await prepared.read();
    assert.deepEqual([...reads[0].ids].sort(), ["100", "200", "300"]);
    assert.equal(reads[0].mintBlocks.get("200"), 5_000);
    assert.equal(reads[0].mintBlocks.get("300"), 6_000);
    // The shared floor, lifted to the chain's first mint.
    assert.equal(reads[0].fromBlock, 4_000);
    const readIds = [...events.keys()].sort();
    assert.deepEqual(readIds, ["100", "200", "300"]);
    assert.deepEqual([...prepared.ids].sort(), ["100", "200", "300"]);
  });

  it("passes on the live NFT and the resume buffer", async () => {
    const { mod, reads } = load();
    const s = startAt(1_000);
    await mod
      .prepareChainRead({
        position: position(),
        rebalanceEvents: chain(),
        start: s.start,
      })
      .read();
    assert.equal(reads[0].opts.liveTokenId, "300");
    assert.strictEqual(reads[0].opts.resumeBuffer, s.resumeBuffer);
  });

  it("keeps the live NFT it was prepared for", async () => {
    /*-
     *  The read has to agree with its own signature: a rebalance that
     *  moves the live NFT after preparation is detected by comparing
     *  signatures, not absorbed silently into the read.
     */
    const { mod, reads } = load();
    const pos = position();
    const prepared = mod.prepareChainRead({
      position: pos,
      rebalanceEvents: chain(),
      start: startAt(1_000).start,
    });
    pos.tokenId = "301";
    await prepared.read();
    assert.equal(reads[0].opts.liveTokenId, "300");
  });

  it("reads once, however many consumers ask", async () => {
    const { mod, reads } = load();
    const s = startAt(1_000);
    const prepared = mod.prepareChainRead({
      position: position(),
      rebalanceEvents: chain(),
      start: s.start,
    });
    const [a, b] = await Promise.all([prepared.read(), prepared.read()]);
    const c = await prepared.read();
    assert.equal(reads.length, 1);
    assert.equal(s.calls.length, 1);
    assert.strictEqual(a, b);
    assert.strictEqual(a, c);
  });

  it("tries again after a failed read", async () => {
    const { mod, reads } = load();
    let fail = true;
    const prepared = mod.prepareChainRead({
      position: position(),
      rebalanceEvents: chain(),
      start: async () => {
        if (fail) {
          fail = false;
          throw new Error("pool lookup failed");
        }
        return { fromBlock: 1_000, resumeBuffer: new Map() };
      },
    });
    await assert.rejects(prepared.read(), /pool lookup failed/);
    await prepared.read();
    assert.equal(reads.length, 1);
  });
});

describe("chainSignature", () => {
  const { mod } = load();
  const base = () => mod.chainSignature(position(), chain());

  it("is the same for the same chain", () => {
    assert.equal(base(), mod.chainSignature(position(), chain()));
  });

  it("changes when a rebalance adds an NFT", () => {
    const events = chain();
    events.push({ oldTokenId: "300", newTokenId: "301", blockNumber: 0 });
    assert.notEqual(base(), mod.chainSignature({ tokenId: "301" }, events));
  });

  it("changes when the live NFT changes within the same chain", () => {
    /*-
     *  A re-opened NFT is already in the chain, so the id set alone
     *  would not show the change.
     */
    assert.notEqual(base(), mod.chainSignature({ tokenId: "200" }, chain()));
  });

  it("changes when an NFT's mint block changes", () => {
    const events = chain();
    events[1].blockNumber = 6_500;
    assert.notEqual(base(), mod.chainSignature(position(), events));
  });

  it("changes when the chain's first mint changes", () => {
    const events = chain();
    events.firstMintBlockNumber = 3_000;
    assert.notEqual(base(), mod.chainSignature(position(), events));
  });
});

describe("chainReadFor", () => {
  /** A read prepared for the fixture chain. */
  const preparedFor = (mod, pos, events) =>
    mod.prepareChainRead({
      position: pos,
      rebalanceEvents: events,
      start: startAt(1_000).start,
    });

  it("uses the prepared read for the chain it was prepared for", () => {
    const { mod } = load();
    const prepared = preparedFor(mod, position(), chain());
    let own = 0;
    const chosen = mod.chainReadFor(
      prepared,
      position(),
      chain(),
      () => {
        own += 1;
        return {};
      },
      CTX,
    );
    assert.strictEqual(chosen, prepared);
    assert.equal(own, 0);
  });

  it("prepares its own when there is none", () => {
    const { mod } = load();
    const own = { own: true };
    for (const none of [null, undefined]) {
      assert.strictEqual(
        mod.chainReadFor(none, position(), chain(), () => own, CTX),
        own,
      );
    }
  });

  it("prepares its own when the chain changed, and says so", () => {
    const { mod } = load();
    const prepared = preparedFor(mod, position(), chain());
    const events = chain();
    events.push({ oldTokenId: "300", newTokenId: "301", blockNumber: 0 });
    const own = { own: true };
    const lines = [];
    const restore = _setSinkForTests({
      log: (...a) => lines.push(format(...a)),
    });
    let chosen;
    try {
      chosen = mod.chainReadFor(
        prepared,
        { tokenId: "301" },
        events,
        () => own,
        CTX,
      );
    } finally {
      restore();
    }
    assert.strictEqual(chosen, own);
    assert.ok(
      lines.some((l) => l.includes("The chain changed during this scan pass")),
      lines.join("\n"),
    );
  });
});
