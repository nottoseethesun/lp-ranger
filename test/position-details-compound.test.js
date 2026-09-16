/**
 * @file test/position-details-compound.test.js
 * @description Tests for _scanCompounds in position-details-compound.js.
 *
 *   The chain's events come from the request's shared chain read, and the
 *   classifier is injected, so no RPC is involved.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");
const os = require("os");
const { _scanCompounds } = require("../src/position-details-compound");
const { emptyEvents } = require("../src/nft-events-batch");

/** A chain read answering every id with `eventsOf(id)`. */
function readerFor(ids, eventsOf = () => emptyEvents()) {
  const calls = [];
  const read = async () => {
    calls.push(1);
    return new Map(ids.map((id) => [id, eventsOf(id)]));
  };
  return { read, calls };
}

/** Run `_scanCompounds` with the fixture's constant arguments filled in. */
function scan({ position, events, cfg, dir, read, classify }) {
  return _scanCompounds(
    { token0: "0xA", token1: "0xB", fee: 3000, ...position },
    events,
    { walletAddress: "0xW" },
    { decimals0: 18, decimals1: 18 },
    { price0: 1, price1: 1 },
    cfg || { global: {}, positions: {} },
    "test-key",
    read,
    dir,
    classify,
  );
}

describe("_scanCompounds", () => {
  const _tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-shared-"));

  it("returns total=0, current=0 when no compounds detected", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-test-"));
    const result = await scan({
      position: { tokenId: "100" },
      events: [{ oldTokenId: "99", newTokenId: "100" }],
      dir,
      read: readerFor(["100", "99"]).read,
      classify: async () => ({ totalCompoundedUsd: 0, compounds: [] }),
    });
    assert.deepStrictEqual(result, { total: 0, current: 0, currentGasUsd: 0 });
    fs.rmSync(dir, { recursive: true });
  });

  it("returns total and updates in-memory config when compounds found", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-test2-"));
    /*- Pre-seed the position slot — _scanCompounds no longer lazy-
     *  creates on the write path; the write is skipped when the slot
     *  is absent (so we don't resurrect phantoms for unmanaged
     *  positions).  This test mimics a MANAGED position where the
     *  slot already exists. */
    const cfg = {
      global: {},
      positions: { "test-key": { status: "running" } },
    };
    const result = await scan({
      position: { tokenId: "200" },
      events: [{ oldTokenId: "199", newTokenId: "200" }],
      cfg,
      dir,
      read: readerFor(["200", "199"]).read,
      classify: async () => ({ totalCompoundedUsd: 5.5, compounds: [] }),
    });
    // Mock returns 5.5 per NFT, 2 NFTs classified (199, 200) = total 11
    assert.strictEqual(result.total, 11);
    assert.strictEqual(cfg.positions["test-key"].totalCompoundedUsd, 11);
    fs.rmSync(dir, { recursive: true });
  });

  it("current = sum of standalone compounds' usdValue, not totalCompoundedUsd", async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sc-test-cur-"));
    /*- Per-tokenId mock: current NFT (250) has totalCompoundedUsd=7.42
     *  (lifetime collected fees) but only 3 standalone compound events
     *  worth 2.21 each.  Verifies the loop sums the standalone events
     *  for `current` (matching bot-recorder-lifetime's compoundHistory
     *  model), not totalCompoundedUsd. */
    const perToken = {
      248: { totalCompoundedUsd: 1.0, compounds: [{ usdValue: 1.0 }] },
      249: { totalCompoundedUsd: 2.5, compounds: [{ usdValue: 2.5 }] },
      250: {
        totalCompoundedUsd: 7.42,
        compounds: [{ usdValue: 2.21 }, { usdValue: 2.21 }, { usdValue: 2.22 }],
      },
    };
    const result = await scan({
      position: { tokenId: "250" },
      events: [
        { oldTokenId: "248", newTokenId: "249" },
        { oldTokenId: "249", newTokenId: "250" },
      ],
      dir,
      read: readerFor(["250", "248", "249"]).read,
      classify: async (_ev, opts) =>
        perToken[opts.tokenId] || { totalCompoundedUsd: 0, compounds: [] },
    });
    assert.strictEqual(result.total, 1.0 + 2.5 + 7.42);
    assert.strictEqual(result.current, 2.21 + 2.21 + 2.22);
    fs.rmSync(dir, { recursive: true });
  });

  it("classifies every NFT in the chain, the current one included", async () => {
    const classified = [];
    await scan({
      position: { tokenId: "300" },
      events: [
        { oldTokenId: "298", newTokenId: "299" },
        { oldTokenId: "299", newTokenId: "300" },
      ],
      dir: _tmpDir,
      read: readerFor(["300", "298", "299"]).read,
      classify: async (_ev, opts) => {
        classified.push(opts.tokenId);
        return { totalCompoundedUsd: 0, compounds: [] };
      },
    });
    assert.deepStrictEqual(classified.sort(), ["298", "299", "300"]);
  });

  it("classifies each NFT with its own events", async () => {
    /*- The read returns every NFT's events at once, so which events
     *  reach which NFT's classification is the thing to pin. */
    const own = (id) => ({ ...emptyEvents(), ilLogsCount: Number(id) });
    const seen = new Map();
    await scan({
      position: { tokenId: "300" },
      events: [
        { oldTokenId: "298", newTokenId: "299" },
        { oldTokenId: "299", newTokenId: "300" },
      ],
      dir: _tmpDir,
      read: readerFor(["300", "298", "299"], own).read,
      classify: async (ev, opts) => {
        seen.set(opts.tokenId, ev.ilLogsCount);
        return { totalCompoundedUsd: 0, compounds: [] };
      },
    });
    assert.deepStrictEqual(Object.fromEntries(seen), {
      298: 298,
      299: 299,
      300: 300,
    });
  });

  it("reads the chain once, not once per NFT", async () => {
    const r = readerFor(["300", "298", "299"]);
    await scan({
      position: { tokenId: "300" },
      events: [
        { oldTokenId: "298", newTokenId: "299" },
        { oldTokenId: "299", newTokenId: "300" },
      ],
      dir: _tmpDir,
      read: r.read,
      classify: async () => ({ totalCompoundedUsd: 0, compounds: [] }),
    });
    assert.strictEqual(r.calls.length, 1);
  });

  it("does not count an NFT the read left out as zero", async () => {
    /*- A partial total written as the lifetime figure would stand until
     *  the next full reload. Failing the scan leaves nothing written. */
    const cfg = {
      global: {},
      positions: { "test-key": { status: "running" } },
    };
    const result = await scan({
      position: { tokenId: "300" },
      events: [
        { oldTokenId: "298", newTokenId: "299" },
        { oldTokenId: "299", newTokenId: "300" },
      ],
      cfg,
      dir: _tmpDir,
      read: readerFor(["300", "299"]).read,
      classify: async () => ({ totalCompoundedUsd: 5, compounds: [] }),
    });
    assert.deepStrictEqual(result, { total: 0, current: 0, currentGasUsd: 0 });
    assert.strictEqual(cfg.positions["test-key"].totalCompoundedUsd, undefined);
  });

  it("returns total=0, current=0 when classification fails", async () => {
    const result = await scan({
      position: { tokenId: "400" },
      events: [{ oldTokenId: "399", newTokenId: "400" }],
      dir: _tmpDir,
      read: readerFor(["400", "399"]).read,
      classify: async () => {
        throw new Error("RPC fail");
      },
    });
    assert.deepStrictEqual(result, { total: 0, current: 0, currentGasUsd: 0 });
  });

  it("returns total=0, current=0 when the chain read fails", async () => {
    const result = await scan({
      position: { tokenId: "400" },
      events: [{ oldTokenId: "399", newTokenId: "400" }],
      dir: _tmpDir,
      read: async () => {
        throw new Error("RPC fail");
      },
      classify: async () => ({ totalCompoundedUsd: 5, compounds: [] }),
    });
    assert.deepStrictEqual(result, { total: 0, current: 0, currentGasUsd: 0 });
  });
});
