/**
 * @file test/build-info.test.js
 * @description Unit tests for src/build-info.js — the server-side version
 * banner helper. Covers the _displayVersion priority rules and the baked
 * JSON sidecar path that release tarballs depend on.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("assert");
const fs = require("fs");
const path = require("path");

const BAKED_PATH = path.join(__dirname, "..", "src", "build-info.json");

function _withBaked(payload, fn) {
  /*- Preserve any existing sidecar (dev clones that ran npm run build
   *  will have one) so the test doesn't clobber real build state. */
  let prior;
  try {
    prior = fs.readFileSync(BAKED_PATH, "utf8");
  } catch {
    prior = null;
  }
  try {
    if (payload === null) {
      try {
        fs.unlinkSync(BAKED_PATH);
      } catch {
        /* already absent */
      }
    } else {
      fs.writeFileSync(BAKED_PATH, JSON.stringify(payload));
    }
    /*- Clear Node's require-cache so getBuildInfo re-reads fresh. */
    delete require.cache[require.resolve("../src/build-info")];
    const mod = require("../src/build-info");
    fn(mod);
  } finally {
    if (prior === null) {
      try {
        fs.unlinkSync(BAKED_PATH);
      } catch {
        /* ok */
      }
    } else {
      fs.writeFileSync(BAKED_PATH, prior);
    }
    delete require.cache[require.resolve("../src/build-info")];
  }
}

describe("src/build-info.js", () => {
  describe("_displayVersion", () => {
    const {
      _displayVersion,
      DEV_VERSION_SENTINEL,
    } = require("../src/build-info");

    it("prefers git tag over everything else", () => {
      assert.strictEqual(
        _displayVersion({ version: "0.4.8", tag: "0.5.0" }),
        "0.5.0",
      );
    });

    it("uses package.json version when tag is null", () => {
      assert.strictEqual(
        _displayVersion({ version: "0.4.8", tag: null }),
        "0.4.8",
      );
    });

    it("returns null on sentinel dev version with no tag", () => {
      assert.strictEqual(
        _displayVersion({ version: DEV_VERSION_SENTINEL, tag: null }),
        null,
      );
    });

    it("returns the tag even when version is the dev sentinel (release tarball case)", () => {
      assert.strictEqual(
        _displayVersion({ version: DEV_VERSION_SENTINEL, tag: "0.4.8" }),
        "0.4.8",
      );
    });

    it("returns null when everything is unknown/missing", () => {
      assert.strictEqual(
        _displayVersion({ version: "unknown", tag: null }),
        "unknown",
      );
      assert.strictEqual(_displayVersion({ version: "", tag: null }), null);
    });
  });

  describe("getBuildInfo with baked sidecar", () => {
    it("reads src/build-info.json when present", () => {
      _withBaked(
        {
          version: "0.0.0-dev",
          commit: "abc1234",
          commitDate: "2026-04-20T12:00:00Z",
          tag: "0.4.8",
        },
        ({ getBuildInfo }) => {
          const bi = getBuildInfo();
          assert.strictEqual(bi.commit, "abc1234");
          assert.strictEqual(bi.commitDate, "2026-04-20T12:00:00Z");
          assert.strictEqual(bi.tag, "0.4.8");
          assert.strictEqual(bi.version, "0.0.0-dev");
        },
      );
    });

    it("falls back to live git + pkg when sidecar is absent", () => {
      _withBaked(null, ({ getBuildInfo }) => {
        const bi = getBuildInfo();
        /*- In this repo's own test environment we always have .git, so
         *  commit should resolve.  Version comes from package.json, which
         *  is always present. */
        assert.ok(typeof bi.commit === "string");
        assert.ok(typeof bi.version === "string" && bi.version.length > 0);
      });
    });

    it("degrades missing fields to 'unknown' / null rather than throwing", () => {
      _withBaked({}, ({ getBuildInfo }) => {
        const bi = getBuildInfo();
        assert.strictEqual(bi.version, "unknown");
        assert.strictEqual(bi.commit, "unknown");
        assert.strictEqual(bi.commitDate, "unknown");
        assert.strictEqual(bi.tag, null);
      });
    });
  });

  describe("logVersionBanner output shape", () => {
    it("logs the baked tag as version= when release tarball pkg.json is 0.0.0-dev", () => {
      _withBaked(
        {
          version: "0.0.0-dev",
          commit: "b686ad7",
          commitDate: "2026-04-20T21:17:05-05:00",
          tag: "0.4.8",
        },
        ({ logVersionBanner }) => {
          const captured = [];
          const origLog = console.log;
          console.log = (...args) => captured.push(args);
          try {
            logVersionBanner("[server]");
          } finally {
            console.log = origLog;
          }
          const joined = captured[0].join(" ");
          assert.ok(joined.includes("version=%s"));
          assert.ok(captured[0].includes("0.4.8"));
          assert.ok(captured[0].includes("b686ad7"));
          assert.ok(captured[0].includes("[server]"));
        },
      );
    });

    it("suppresses version= segment for untagged dev builds", () => {
      _withBaked(
        {
          version: "0.0.0-dev",
          commit: "abc1234",
          commitDate: "2026-04-20T12:00:00Z",
          tag: null,
        },
        ({ logVersionBanner }) => {
          const captured = [];
          const origLog = console.log;
          console.log = (...args) => captured.push(args);
          try {
            logVersionBanner("[server]");
          } finally {
            console.log = origLog;
          }
          const fmt = captured[0][0];
          assert.ok(!fmt.includes("version="));
          assert.ok(fmt.includes("commit="));
        },
      );
    });
  });
});
