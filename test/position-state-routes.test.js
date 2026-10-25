"use strict";

/**
 * @file test/position-state-routes.test.js
 * @description The yes-or-no route in src/server/position-state-routes.js.
 *
 *   `GET /api/is-position-managed` is what the dashboard asks each time it
 *   puts a position on screen, so its Manage/Stop button is drawn from the
 *   server's answer. It is driven here with the same kinds of state the
 *   server holds: running loops, a saved status, and a shutdown's stopped
 *   entries.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const {
  managedPositionList,
  createPositionStateRoutes,
} = require("../src/server/position-state-routes");

const W = "0x1111111111111111111111111111111111111111";
const PM = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
const keyOf = (id) => `pulsechain-${W}-${PM}-${id}`;

/**
 * Routes over a fixed state: `live` are the manager's entries, `saved`
 * the bot-config.json slots.
 */
function routesOver({ live = [], saved = {} } = {}) {
  const diskConfig = { global: {}, positions: saved };
  return createPositionStateRoutes({
    positionMgr: { getAll: () => live },
    diskConfig,
    managedKeys: (cfg) =>
      Object.keys(cfg.positions).filter(
        (k) => cfg.positions[k].status === "running",
      ),
    jsonResponse: (res, status, body) => {
      res.status = status;
      res.body = body;
    },
  });
}

/** Ask one route and return the answer. */
function ask(routes, route, url) {
  const res = {};
  routes[route]({ url }, res);
  return res;
}

const managedUrl = (key) =>
  "/api/is-position-managed?key=" + encodeURIComponent(key);

describe("GET /api/is-position-managed", () => {
  const route = "GET /api/is-position-managed";

  it("answers true for a position whose bot loop is running", () => {
    const routes = routesOver({
      live: [{ key: keyOf(1), tokenId: "1", status: "running" }],
    });
    assert.deepEqual(ask(routes, route, managedUrl(keyOf(1))), {
      status: 200,
      body: { managed: true },
    });
  });

  it("answers true for a position saved as running whose loop has not started", () => {
    const routes = routesOver({ saved: { [keyOf(2)]: { status: "running" } } });
    assert.equal(ask(routes, route, managedUrl(keyOf(2))).body.managed, true);
  });

  it("answers false for a position a shutdown has stopped", () => {
    const routes = routesOver({
      live: [{ key: keyOf(3), tokenId: "3", status: "stopped" }],
    });
    assert.equal(ask(routes, route, managedUrl(keyOf(3))).body.managed, false);
  });

  it("answers false for a position saved as stopped, or not known at all", () => {
    const routes = routesOver({ saved: { [keyOf(4)]: { status: "stopped" } } });
    assert.equal(ask(routes, route, managedUrl(keyOf(4))).body.managed, false);
    assert.equal(ask(routes, route, managedUrl(keyOf(5))).body.managed, false);
  });

  it("refuses a missing key, and one that names no position", () => {
    const routes = routesOver();
    assert.equal(ask(routes, route, "/api/is-position-managed").status, 400);
    assert.equal(
      ask(routes, route, "/api/is-position-managed?key=157149").status,
      400,
    );
  });
});

describe("managedPositionList", () => {
  it("lists the manager's entries, then the saved-running keys not yet live", () => {
    const list = managedPositionList({
      positionMgr: {
        getAll: () => [{ key: keyOf(1), tokenId: "1", status: "running" }],
      },
      diskConfig: {
        positions: {
          [keyOf(1)]: { status: "running" },
          [keyOf(2)]: { status: "running" },
          [keyOf(3)]: { status: "stopped" },
        },
      },
      managedKeys: (cfg) =>
        Object.keys(cfg.positions).filter(
          (k) => cfg.positions[k].status === "running",
        ),
    });
    assert.deepEqual(list, [
      { key: keyOf(1), tokenId: "1", status: "running" },
      { key: keyOf(2), tokenId: "2", status: "running" },
    ]);
  });
});
