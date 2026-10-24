"use strict";

/**
 * @file test/scan-cache-dir.test.js
 * @description Where the scan caches live (src/lib/scan-cache-dir.js):
 *   `app-data/scan-cache/` in the install, and under `node --test` a
 *   folder of the test process's own, so no test reads or writes the
 *   operator's caches.
 */

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const os = require("os");
const path = require("path");
const { spawnSync } = require("child_process");
const { scanCacheDir, scanCachePath } = require("../src/lib/scan-cache-dir");

describe("the scan-cache folder", () => {
  it("is the test process's own temp folder under node --test", () => {
    const dir = scanCacheDir();
    assert.equal(path.dirname(dir), os.tmpdir());
    assert.ok(
      path
        .basename(dir)
        .startsWith(`lp-ranger-test-scan-cache-${process.pid}-`),
      dir,
    );
    assert.equal(scanCacheDir(), dir, "one folder for the whole process");
    assert.equal(scanCachePath("x.json"), path.join(dir, "x.json"));
  });

  it("is app-data/scan-cache/ in the install's folder outside tests", () => {
    const src = JSON.stringify(
      path.join(__dirname, "..", "src", "lib", "scan-cache-dir"),
    );
    const env = { ...process.env };
    delete env.NODE_TEST_CONTEXT;
    const res = spawnSync(
      process.execPath,
      ["-e", `process.stdout.write(require(${src}).scanCacheDir())`],
      { env, encoding: "utf8" },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.equal(
      res.stdout,
      path.join(process.cwd(), "app-data", "scan-cache"),
    );
  });
});
