"use strict";

/**
 * @file test/clear-scan-derived-config.test.js
 * @description `npm run clear-blockchain-scan-cache` clears scan-derived
 *   values from `bot-config.json`, not just the `tmp/` caches.
 *
 *   The lifetime scan treats a value already in the config as settled and
 *   does not re-derive it. Clearing only `tmp/` therefore gives a start
 *   that is cold for the caches but warm for everything the config
 *   remembers — including any error in it. These tests pin that the
 *   command clears exactly the chain-derived keys, from every position,
 *   and leaves settings and live-recorded values alone.
 *
 *   Every test works in its own temporary directory; the real config is
 *   never read or written.
 */

const { describe, it, beforeEach, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const {
  clearScanDerivedConfig,
} = require("../scripts/clear-blockchain-scan-cache");
const { CHAIN_DERIVED_POSITION_KEYS } = require("../src/bot-config-v2");

const A = "pulsechain-0xW-0xC-100";
const B = "pulsechain-0xW-0xC-200";

let dir;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "clear-scan-cfg-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const file = () => path.join(dir, "bot-config.json");
const write = (cfg) => fs.writeFileSync(file(), JSON.stringify(cfg));
const read = () => JSON.parse(fs.readFileSync(file(), "utf8"));

/** A slot holding every chain-derived key plus settings and live values. */
function fullSlot(status) {
  return {
    status,
    slippagePctToken0: 0.75,
    autoCompoundEnabled: true,
    residuals: { amount0: "5" },
    lastCompoundAt: "2026-09-15T17:53:11.894Z",
    compoundHistory: [{ txHash: "0x1" }],
    totalCompoundedUsd: 1111.16,
    collectedFeesUsd: 12,
    nftCompoundedUsdByTokenId: { 100: 3 },
    nftGasWeiByTokenId: { 100: "1" },
    hodlBaseline: { entryValue: 1 },
    lifetimeHodlAmounts: { amount0: 1 },
    totalLifetimeDepositUsd: 2406.7,
    depositUsedFallback: true,
  };
}

describe("clearScanDerivedConfig", () => {
  it("removes every chain-derived key", () => {
    write({ global: {}, positions: { [A]: fullSlot("running") } });
    clearScanDerivedConfig({ dir });
    const slot = read().positions[A];
    for (const k of CHAIN_DERIVED_POSITION_KEYS) {
      assert.equal(k in slot, false, `${k} should be gone`);
    }
  });

  it("keeps settings, status and live-recorded values", () => {
    /*-
     *  `residuals` and `lastCompoundAt` are recorded at rebalance and
     *  compound time; a scan cannot reproduce them, so clearing them
     *  would lose them rather than rebuild them.
     */
    write({ global: {}, positions: { [A]: fullSlot("running") } });
    clearScanDerivedConfig({ dir });
    const slot = read().positions[A];
    assert.equal(slot.status, "running");
    assert.equal(slot.slippagePctToken0, 0.75);
    assert.equal(slot.autoCompoundEnabled, true);
    assert.deepEqual(slot.residuals, { amount0: "5" });
    assert.equal(slot.lastCompoundAt, "2026-09-15T17:53:11.894Z");
  });

  it("clears stopped positions as well as running ones", () => {
    write({
      global: {},
      positions: { [A]: fullSlot("running"), [B]: fullSlot("stopped") },
    });
    const r = clearScanDerivedConfig({ dir });
    assert.equal(r.positions, 2);
    assert.equal("compoundHistory" in read().positions[B], false);
  });

  it("leaves the global section untouched", () => {
    const global = { telegramEvents: { x: true }, gasFeePct: 0.5 };
    write({ global, positions: { [A]: fullSlot("running") } });
    clearScanDerivedConfig({ dir });
    assert.deepEqual(read().global, global);
  });

  it("reports how much it removed", () => {
    write({ global: {}, positions: { [A]: fullSlot("running") } });
    const r = clearScanDerivedConfig({ dir });
    assert.equal(r.positions, 1);
    assert.equal(r.keys, CHAIN_DERIVED_POSITION_KEYS.length);
  });

  it("a dry run reports the same counts and changes nothing", () => {
    write({ global: {}, positions: { [A]: fullSlot("running") } });
    const before = fs.readFileSync(file(), "utf8");
    const r = clearScanDerivedConfig({ dir, dryRun: true });
    assert.equal(r.keys, CHAIN_DERIVED_POSITION_KEYS.length);
    assert.equal(fs.readFileSync(file(), "utf8"), before);
  });

  it("snapshots the pre-clear file to bot-config.backup.json", () => {
    // The recovery path the command's output points the operator to.
    write({ global: {}, positions: { [A]: fullSlot("running") } });
    clearScanDerivedConfig({ dir });
    const backup = JSON.parse(
      fs.readFileSync(path.join(dir, "bot-config.backup.json"), "utf8"),
    );
    assert.equal(backup.positions[A].totalLifetimeDepositUsd, 2406.7);
  });

  it("does not rewrite a config with nothing to clear", () => {
    write({ global: {}, positions: { [A]: { status: "running" } } });
    const mtime = fs.statSync(file()).mtimeMs;
    const r = clearScanDerivedConfig({ dir });
    assert.equal(r.keys, 0);
    assert.equal(fs.statSync(file()).mtimeMs, mtime);
  });

  it("never overwrites a config it could not parse", () => {
    /*-
     *  `loadConfig` returns an empty config for a damaged file. Saving
     *  that would replace a recoverable file with an empty one.
     */
    fs.writeFileSync(file(), "{ this is not json");
    const r = clearScanDerivedConfig({ dir });
    assert.equal(r.keys, 0);
    assert.equal(fs.readFileSync(file(), "utf8"), "{ this is not json");
  });

  it("does nothing when there is no config at all", () => {
    const r = clearScanDerivedConfig({ dir });
    assert.deepEqual(r, { positions: 0, keys: 0 });
    assert.equal(fs.existsSync(file()), false);
  });
});
