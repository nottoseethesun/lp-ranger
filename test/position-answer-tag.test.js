"use strict";

/**
 * @file test/position-answer-tag.test.js
 * @description Every answer about a position names it, by its full key,
 *   so a dashboard that has moved to another position since it asked
 *   can tell the answer is not for the one on screen. The user,
 *   2026-10-18: "responses from the server need to be tagged with the
 *   fully-qualified position identifier".
 *
 *   `positionKey` is the key the request named. A rebalance can mint the
 *   position a new NFT while the request is under way; the answer then
 *   names the new key as well, as `livePositionKey`. Stop Managing's
 *   answer after such a move is pinned in
 *   test/server-positions-stale-key-races.test.js.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const { positionTag } = require("../src/lib/position-answer-tag");
const { createRouteHandlers } = require("../src/server/server-routes");

const KEY = "pulsechain-0x1-0x2-100";

describe("the tag", () => {
  it("names the position the request named", () => {
    assert.deepEqual(positionTag(KEY), { positionKey: KEY });
    assert.deepEqual(positionTag(KEY, KEY), { positionKey: KEY });
  });

  it("names the new key as well when a rebalance moved it", () => {
    assert.deepEqual(positionTag(KEY, "pulsechain-0x1-0x2-101"), {
      positionKey: KEY,
      livePositionKey: "pulsechain-0x1-0x2-101",
    });
  });

  it("is empty for a request that named no position", () => {
    assert.deepEqual(positionTag(undefined), {});
    assert.deepEqual(positionTag(""), {});
  });
});

describe("POST /api/config's answer", () => {
  /** Answer `body` with a configuration of the case's own. */
  async function answer(body) {
    const res = {};
    await createRouteHandlers({
      diskConfig: { global: {}, positions: {} },
      positionMgr: { getAll: () => [], get: () => null },
      privateKeyRef: { current: null },
      walletManager: { getStatus: () => ({ loaded: false }) },
      jsonResponse: (r, status, b) => Object.assign(r, { status, body: b }),
      readJsonBody: async () => body,
      getAllPositionBotStates: () => new Map(),
      createPerPositionBotState: () => ({}),
      attachMultiPosDeps: () => {},
      updatePositionState: () => {},
    })._handleApiConfig({}, res);
    return res;
  }

  it("names the position it saved for", async () => {
    const res = await answer({ positionKey: KEY, maxRebalancesPerDay: 3 });
    assert.equal(res.status, 200);
    assert.equal(res.body.positionKey, KEY);
  });

  it("names the position it refused a value for", async () => {
    const res = await answer({ positionKey: KEY, maxRebalancesPerDay: 0 });
    assert.equal(res.status, 400);
    assert.equal(res.body.invalidValueForKey, "maxRebalancesPerDay");
    assert.equal(res.body.positionKey, KEY);
  });
});
