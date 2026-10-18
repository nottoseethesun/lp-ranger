/**
 * @file test/bot-cycle-drain.test.js
 * @description Tests for `checkRetireRequest` — the poll-cycle hook that acts
 *   on a `_retireReason` stamped by the lifetime scan's heal step. Verifies it
 *   fires the `positionDataInvalid` Telegram notification carrying the reason,
 *   signals the poll loop to retire, clears the reason so it can't re-fire, and
 *   no-ops when no reason is set. `notify` + `getTokenSymbol` are mocked via
 *   the module loader (same pattern as bot-recorder-lifetime.test.js).
 * Run with: npm test
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const Module = require("module");

const _origRequire = Module.prototype.require;
let _notifyCalls = [];

function _installMocks() {
  _notifyCalls = [];
  Module.prototype.require = function (id) {
    if (id === "./telegram-notifications/telegram") {
      return {
        notify: (type, details) => {
          _notifyCalls.push({ type, details });
          return Promise.resolve(true);
        },
      };
    }
    if (id === "./token-symbol-cache") {
      return { getTokenSymbol: (a) => "SYM:" + a };
    }
    return _origRequire.apply(this, arguments);
  };
  delete require.cache[require.resolve("../src/bot-cycle-drain")];
}

function _restoreMocks() {
  Module.prototype.require = _origRequire;
  delete require.cache[require.resolve("../src/bot-cycle-drain")];
}

describe("checkRetireRequest", () => {
  let checkRetireRequest;
  beforeEach(() => {
    _installMocks();
    ({ checkRetireRequest } = require("../src/bot-cycle-drain"));
  });
  afterEach(() => {
    _restoreMocks();
  });

  it("returns null and fires nothing when no _retireReason is set", () => {
    const deps = {
      position: { tokenId: "1", token0: "0xA", token1: "0xB" },
      _botState: {},
    };
    assert.equal(checkRetireRequest(deps), null);
    assert.equal(_notifyCalls.length, 0);
  });

  it("fires positionDataInvalid with the reason and signals a retire", () => {
    const state = { _retireReason: "decimals unreadable — auto-stopped" };
    const deps = {
      position: { tokenId: "42", token0: "0xA", token1: "0xB" },
      _botState: state,
    };
    const res = checkRetireRequest(deps);
    assert.deepEqual(res, { rebalanced: false, retired: true });
    assert.equal(_notifyCalls.length, 1);
    assert.equal(_notifyCalls[0].type, "positionDataInvalid");
    assert.equal(
      _notifyCalls[0].details.message,
      "decimals unreadable — auto-stopped",
    );
    /*- Reason cleared so a subsequent poll can't double-fire the retire. */
    assert.equal(state._retireReason, null);
  });

  it("does not re-fire once the reason is cleared", () => {
    const state = { _retireReason: "x" };
    const deps = {
      position: { tokenId: "7", token0: "0xA", token1: "0xB" },
      _botState: state,
    };
    checkRetireRequest(deps);
    const second = checkRetireRequest(deps);
    assert.equal(second, null);
    assert.equal(_notifyCalls.length, 1);
  });
});
