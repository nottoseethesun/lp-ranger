/**
 * @file test/telegram.test.js
 * @description Unit tests for the Telegram notification module.
 */

"use strict";

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");

let _originalFetch;
beforeEach(() => {
  _originalFetch = globalThis.fetch;
});
afterEach(() => {
  globalThis.fetch = _originalFetch;
});

const {
  setBotToken,
  setChatId,
  isConfigured,
  setEnabledEvents,
  getEnabledEvents,
  notify,
  testConnection,
  EVENT_DEFAULTS,
  _posLabel,
} = require("../src/telegram");

describe("telegram — configuration", () => {
  beforeEach(() => {
    setBotToken(null);
    setChatId(null);
    setEnabledEvents(EVENT_DEFAULTS);
  });

  it("isConfigured returns false when token or chatId is missing", () => {
    assert.strictEqual(isConfigured(), false);
    setBotToken("tok");
    assert.strictEqual(isConfigured(), false);
    setChatId("123");
    assert.strictEqual(isConfigured(), true);
  });

  it("setEnabledEvents overrides defaults", () => {
    setEnabledEvents({ oorTimeout: false, rebalanceSuccess: true });
    const ev = getEnabledEvents();
    assert.strictEqual(ev.oorTimeout, false);
    assert.strictEqual(ev.rebalanceSuccess, true);
    assert.strictEqual(ev.rebalanceFail, true, "untouched default");
  });

  it("setEnabledEvents ignores unknown keys", () => {
    setEnabledEvents({ bogus: true });
    const ev = getEnabledEvents();
    assert.strictEqual(ev.bogus, undefined);
  });
});

describe("telegram — _posLabel", () => {
  it("formats tokenId and symbols", () => {
    const label = _posLabel({
      tokenId: 42,
      token0Symbol: "WPLS",
      token1Symbol: "eHEX",
    });
    assert.strictEqual(label, "#42 (WPLS/eHEX)");
  });

  it("handles missing symbols", () => {
    assert.strictEqual(_posLabel({ tokenId: 7 }), "#7");
  });

  it("handles null position", () => {
    assert.strictEqual(_posLabel(null), "unknown");
  });
});

describe("telegram — notify", () => {
  beforeEach(() => {
    setBotToken("tok");
    setChatId("123");
    setEnabledEvents(EVENT_DEFAULTS);
  });
  afterEach(() => {
    setBotToken(null);
    setChatId(null);
  });

  it("skips when not configured", async () => {
    setBotToken(null);
    const sent = await notify("rebalanceFail", { error: "boom" });
    assert.strictEqual(sent, false);
  });

  it("skips disabled event types", async () => {
    const sent = await notify("rebalanceSuccess", { message: "ok" });
    assert.strictEqual(sent, false, "rebalanceSuccess is off by default");
  });

  it("sends for enabled event types", async () => {
    let captured = null;
    globalThis.fetch = async (url, opts) => {
      captured = { url, body: JSON.parse(opts.body) };
      return { ok: true, json: async () => ({}) };
    };
    const sent = await notify("rebalanceFail", {
      position: { tokenId: 99, token0Symbol: "A", token1Symbol: "B" },
      error: "revert",
    });
    assert.strictEqual(sent, true);
    assert.ok(captured.url.includes("/sendMessage"));
    assert.ok(captured.body.text.includes("Rebalance Failed"));
    assert.ok(captured.body.text.includes("#99 (A/B)"));
    assert.ok(captured.body.text.includes("revert"));
  });

  it("returns false on HTTP failure", async () => {
    globalThis.fetch = async () => ({
      ok: false,
      status: 400,
      text: async () => "bad request",
    });
    const sent = await notify("otherError", { error: "x" });
    assert.strictEqual(sent, false);
  });
});

describe("telegram — testConnection", () => {
  afterEach(() => {
    setBotToken(null);
    setChatId(null);
  });

  it("returns error when not configured", async () => {
    const r = await testConnection();
    assert.strictEqual(r.ok, false);
    assert.ok(r.error.includes("not configured"));
  });

  it("returns ok on successful send", async () => {
    setBotToken("tok");
    setChatId("123");
    globalThis.fetch = async () => ({
      ok: true,
      json: async () => ({}),
    });
    const r = await testConnection();
    assert.strictEqual(r.ok, true);
  });
});
