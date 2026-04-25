/**
 * @file test/bot-config-v2.test.js
 * @description Tests for bot-config-v2: load, save, composite keys.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");
const os = require("os");
const {
  compositeKey,
  parseCompositeKey,
  loadConfig,
  saveConfig,
  getPositionConfig,
  addManagedPosition,
  removeManagedPosition,
  migratePositionKey,
  managedKeys,
  GLOBAL_KEYS,
  POSITION_KEYS,
  readConfigValue,
} = require("../src/bot-config-v2");

/** Create a temp directory for each test. */
function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "bcv2-"));
}

describe("bot-config-v2", () => {
  // ── compositeKey / parseCompositeKey ─────────────────────────────────────

  describe("compositeKey()", () => {
    it("builds a dash-separated key with checksummed addresses", () => {
      const w = "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A";
      const c = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
      const key = compositeKey("pulsechain", w, c, "42");
      assert.equal(key, "pulsechain-" + w + "-" + c + "-42");
    });
  });

  describe("parseCompositeKey()", () => {
    it("round-trips with compositeKey", () => {
      const w = "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A";
      const c = "0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2";
      const key = compositeKey("pulsechain", w, c, "99");
      const parsed = parseCompositeKey(key);
      assert.equal(parsed.blockchain, "pulsechain");
      assert.equal(parsed.wallet, w);
      assert.equal(parsed.contract, c);
      assert.equal(parsed.tokenId, "99");
    });

    it("returns null for invalid keys", () => {
      assert.equal(parseCompositeKey(null), null);
      assert.equal(parseCompositeKey(""), null);
      assert.equal(parseCompositeKey("only-two-parts"), null);
      assert.equal(
        parseCompositeKey("a-b-c-d"),
        null,
        "addresses must start with 0x",
      );
    });
  });

  // ── loadConfig / saveConfig ─────────────────────────────────────────────

  describe("loadConfig()", () => {
    it("returns empty structure when no file exists", () => {
      const dir = tmpDir();
      const cfg = loadConfig(dir);
      assert.deepEqual(cfg.global, {});
      assert.deepEqual(cfg.positions, {});
    });

    it("loads an existing config", () => {
      const dir = tmpDir();
      const saved = {
        global: { slippagePct: 1.0 },
        positions: { "key-1": { status: "running" } },
      };
      fs.writeFileSync(
        path.join(dir, ".bot-config.json"),
        JSON.stringify(saved),
      );
      const loaded = loadConfig(dir);
      assert.equal(loaded.global.slippagePct, 1.0);
      assert.equal(loaded.positions["key-1"].status, "running");
    });

    it("returns empty structure for malformed config", () => {
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, ".bot-config.json"), "not json!");
      const loaded = loadConfig(dir);
      assert.deepEqual(loaded.positions, {});
    });

    it("ignores obsolete managedPositions array", () => {
      const dir = tmpDir();
      fs.writeFileSync(
        path.join(dir, ".bot-config.json"),
        JSON.stringify({
          global: {},
          managedPositions: ["k1"],
          positions: { k1: { status: "running" } },
        }),
      );
      const loaded = loadConfig(dir);
      assert.equal(loaded.managedPositions, undefined);
      assert.equal(loaded.positions.k1.status, "running");
    });
  });

  describe("saveConfig()", () => {
    it("writes valid JSON to disk", () => {
      const dir = tmpDir();
      const cfg = {
        global: { slippagePct: 0.7 },
        positions: {},
      };
      saveConfig(cfg, dir);

      const raw = JSON.parse(
        fs.readFileSync(path.join(dir, ".bot-config.json"), "utf8"),
      );
      assert.equal(raw.global.slippagePct, 0.7);
      assert.equal(
        raw.version,
        undefined,
        "version field should not be written",
      );
    });

    it("strips legacy fields", () => {
      const dir = tmpDir();
      const cfg = {
        global: {},
        positions: {},
        version: 2,
        managedPositions: ["k1"],
      };
      saveConfig(cfg, dir);

      const raw = JSON.parse(
        fs.readFileSync(path.join(dir, ".bot-config.json"), "utf8"),
      );
      assert.equal(raw.version, undefined);
      assert.equal(raw.managedPositions, undefined);
    });
  });

  // ── Position management ─────────────────────────────────────────────────

  describe("getPositionConfig()", () => {
    it("creates entry if missing", () => {
      const cfg = { global: {}, positions: {} };
      const pos = getPositionConfig(cfg, "key-1");
      assert.deepEqual(pos, {});
      assert.ok(cfg.positions["key-1"]);
    });

    it("returns existing entry", () => {
      const cfg = {
        global: {},
        positions: { "key-1": { status: "paused" } },
      };
      const pos = getPositionConfig(cfg, "key-1");
      assert.equal(pos.status, "paused");
    });
  });

  describe("addManagedPosition()", () => {
    it("creates entry and sets status to running", () => {
      const cfg = { global: {}, positions: {} };
      addManagedPosition(cfg, "key-1");
      assert.equal(cfg.positions["key-1"].status, "running");
    });

    it("reactivates a stopped position", () => {
      const cfg = {
        global: {},
        positions: {
          "key-1": { status: "stopped", slippagePct: 1.2 },
        },
      };
      addManagedPosition(cfg, "key-1");
      assert.equal(cfg.positions["key-1"].status, "running");
      assert.equal(
        cfg.positions["key-1"].slippagePct,
        1.2,
        "existing config preserved",
      );
    });

    it("does not overwrite running status", () => {
      const cfg = {
        global: {},
        positions: {
          "key-1": { status: "running", slippagePct: 1.2 },
        },
      };
      addManagedPosition(cfg, "key-1");
      assert.equal(cfg.positions["key-1"].status, "running");
      assert.equal(
        cfg.positions["key-1"].slippagePct,
        1.2,
        "existing config preserved",
      );
    });
  });

  describe("removeManagedPosition()", () => {
    it("marks position as stopped", () => {
      const cfg = {
        global: {},
        positions: {
          "key-1": { status: "running" },
          "key-2": { status: "running" },
        },
      };
      removeManagedPosition(cfg, "key-1");
      assert.equal(cfg.positions["key-1"].status, "stopped");
      assert.equal(cfg.positions["key-2"].status, "running");
    });

    it("keeps position data for history", () => {
      const cfg = {
        global: {},
        positions: {
          "key-1": {
            status: "running",
            hodlBaseline: { x: 1 },
          },
        },
      };
      removeManagedPosition(cfg, "key-1");
      assert.deepEqual(cfg.positions["key-1"].hodlBaseline, { x: 1 });
    });
  });

  describe("migratePositionKey()", () => {
    it("moves config from old key to new key", () => {
      const cfg = {
        global: {},
        positions: {
          "old-key": {
            status: "running",
            pnlEpochs: [1, 2],
          },
        },
      };
      migratePositionKey(cfg, "old-key", "new-key");
      assert.equal(cfg.positions["new-key"].status, "running");
      assert.deepEqual(cfg.positions["new-key"].pnlEpochs, [1, 2]);
      assert.equal(cfg.positions["old-key"], undefined);
    });

    it("no-op when old === new", () => {
      const cfg = {
        global: {},
        positions: { "key-1": { status: "running" } },
      };
      migratePositionKey(cfg, "key-1", "key-1");
      assert.equal(cfg.positions["key-1"].status, "running");
    });
  });

  // ── managedKeys ───────────────────────────────────────────────────────

  describe("managedKeys()", () => {
    it("returns only running positions", () => {
      const cfg = {
        global: {},
        positions: {
          a: { status: "running" },
          b: { status: "stopped" },
          c: {},
        },
      };
      const keys = managedKeys(cfg);
      assert.deepEqual(keys, ["a"]);
    });

    it("returns empty array for no positions", () => {
      assert.deepEqual(managedKeys({ global: {}, positions: {} }), []);
    });
  });

  // ── Key lists ───────────────────────────────────────────────────────────

  describe("exported key lists", () => {
    it("GLOBAL_KEYS does not overlap with POSITION_KEYS", () => {
      const overlap = GLOBAL_KEYS.filter((k) => POSITION_KEYS.includes(k));
      assert.deepEqual(
        overlap,
        [],
        "Global and position keys must not overlap",
      );
    });

    it("approvalMultiple is a GLOBAL_KEY (one setting, all positions)", () => {
      assert.ok(
        GLOBAL_KEYS.includes("approvalMultiple"),
        "approvalMultiple should live in GLOBAL_KEYS so it applies wallet-wide",
      );
      assert.ok(
        !POSITION_KEYS.includes("approvalMultiple"),
        "approvalMultiple must not also be in POSITION_KEYS",
      );
    });
  });

  describe("readConfigValue", () => {
    it("returns position-level value when set", () => {
      const cfg = {
        global: { slippagePct: 0.5 },
        positions: { k1: { slippagePct: 1.0 } },
      };
      assert.equal(readConfigValue(cfg, "k1", "slippagePct"), 1.0);
    });

    it("falls back to global when position key is missing", () => {
      const cfg = {
        global: { slippagePct: 0.5 },
        positions: { k1: {} },
      };
      assert.equal(readConfigValue(cfg, "k1", "slippagePct"), 0.5);
    });

    it("returns undefined when neither scope has the key", () => {
      const cfg = { global: {}, positions: { k1: {} } };
      assert.equal(readConfigValue(cfg, "k1", "missing"), undefined);
    });
  });

  describe("loadConfig edge cases", () => {
    it("returns empty config for an empty file", () => {
      const dir = tmpDir();
      fs.writeFileSync(path.join(dir, ".bot-config.json"), "", "utf8");
      const cfg = loadConfig(dir);
      assert.deepEqual(cfg, { global: {}, positions: {} });
      fs.rmSync(dir, { recursive: true });
    });
  });
});
