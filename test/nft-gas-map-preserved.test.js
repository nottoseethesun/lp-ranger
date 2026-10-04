/**
 * @file test/nft-gas-map-preserved.test.js
 * @description
 * An NFT the lifetime scan cannot price must keep the gas figure an
 * earlier scan already found.
 *
 * The bot keeps one gas figure per position NFT, in a map saved to disk.
 * The lifetime scan rebuilds that map and writes it **whole**, so the map
 * it produces is the map that survives — anything missing from it is gone
 * from disk.
 *
 * That makes withholding a value and deleting one the same act. Declining
 * to write a figure the scan is unsure of is right; doing it by leaving
 * the NFT out of a map that replaces its predecessor takes the correct
 * figure with it, and the operator's Gas row for that NFT goes blank
 * until some later scan happens to read every receipt in its set. On a
 * long rebalance chain, one unreadable receipt among many NFTs is enough.
 *
 * So the rebuilt map starts from what is already saved. A readable NFT
 * still overwrites its own entry; an unreadable one inherits.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

/*- No `state` knob is touched: the harness's default classify result
 *  carries no gas total, which is exactly the "unknown" these cases need.
 *  Setting one would only restate the default. */
const {
  resetState,
  installMocks,
  restoreMocks,
  makePosition,
  makeBotState,
} = require("./helpers/bot-recorder-lifetime-mocks");

describe("the per-NFT gas map survives an NFT it cannot price", () => {
  let _scanLifetimePoolData;

  beforeEach(() => {
    resetState();
    installMocks();
    ({ _scanLifetimePoolData } = require("../src/bot-recorder-lifetime"));
  });

  afterEach(restoreMocks);

  /**
   * Run one lifetime scan and hand back every state patch it wrote.
   *
   * @param {object} savedGasMap  What is already on disk, per NFT.
   * @returns {Promise<object[]>} The patches, in order.
   */
  async function _runScan(savedGasMap) {
    const position = makePosition();
    /*- No saved compound data, so the scan classifies rather than
     *  trusting what it finds — which is the path that rebuilds the map. */
    const botState = makeBotState({});
    botState.nftGasWeiByTokenId = savedGasMap;
    const patches = [];
    await _scanLifetimePoolData(
      position,
      botState,
      (p) => patches.push(p),
      [],
      "0xW",
      null,
      "epoch-key",
    );
    return patches;
  }

  /** The last gas map any patch carried, or undefined if none did. */
  function _writtenGasMap(patches) {
    return patches
      .map((p) => p.nftGasWeiByTokenId)
      .filter((m) => m !== undefined)
      .pop();
  }

  it("keeps an earlier scan's figure for an NFT whose gas is unknown", async () => {
    /*- The harness's classify result carries no gas total, which is what
     *  an NFT with an unreadable receipt produces: unknown. Every NFT in
     *  this scan is therefore unknown, so anything in the written map can
     *  only have come from what was already saved. */
    const patches = await _runScan({ 41: "999", 42: "111" });
    const written = _writtenGasMap(patches);

    assert.notStrictEqual(
      written,
      undefined,
      "the scan must still write a map, not drop the key",
    );
    assert.strictEqual(
      written["41"],
      "999",
      "an NFT this scan could not price keeps what the last one found",
    );
    assert.strictEqual(written["42"], "111");
  });

  it("writes nothing new when there is nothing saved and nothing readable", async () => {
    /*- The first-scan case. Nothing saved, nothing readable, so the map
     *  stays empty — and an empty map must not be written over a
     *  populated one, which is what the caller's own length check is for. */
    const patches = await _runScan({});
    const written = _writtenGasMap(patches);

    assert.deepStrictEqual(
      written ?? {},
      {},
      "no figure may be invented for an NFT nothing could price",
    );
  });
});
