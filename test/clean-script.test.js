/**
 * @file test/clean-script.test.js
 * @description Guards what `npm run clean` promises: that it leaves
 *   nothing behind.
 *
 * A hand-written list of cache filenames cannot hold that promise: a
 * cache added later is simply absent from it, `clean` prints success
 * regardless, and the operator is left with a warm cache — the exact
 * condition the command exists to remove.
 *
 * `clean` and `dev-clean` therefore both run `scripts/clean.js`, which
 * delegates the cache to `clear-blockchain-scan-cache.js`. These tests
 * assert the delegation rather than the filenames, so a cache added
 * later is covered without anyone updating a list.
 *
 * Nothing here deletes anything: the cache helper is exercised in
 * dry-run only.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  DEV_PRESERVE,
  STATE_FILES,
  BUILD_ARTIFACTS,
  BUILD_DIRS,
  LOG_FILES,
} = require("../scripts/clean");
const { clearScanCache } = require("../scripts/clear-blockchain-scan-cache");

const ROOT = path.resolve(__dirname, "..");
const readRoot = (p) => fs.readFileSync(path.join(ROOT, p), "utf8");
const pkg = JSON.parse(readRoot("package.json"));

test("clean + dev-clean both delegate to scripts/clean.js", () => {
  assert.match(pkg.scripts.clean, /^node scripts\/clean\.js$/);
  assert.match(pkg.scripts["dev-clean"], /^node scripts\/clean\.js --dev$/);
});

test("neither npm script carries its own cache list any more", () => {
  /*- The duplication that let the two drift apart. */
  for (const s of [pkg.scripts.clean, pkg.scripts["dev-clean"]]) {
    assert.doesNotMatch(s, /tmp\//, "no tmp/ paths in the npm script");
    assert.doesNotMatch(s, /event-cache/);
  }
});

test("clean.js delegates the cache to the script that owns it", () => {
  const src = readRoot("scripts/clean.js");
  assert.match(src, /require\("\.\/clear-blockchain-scan-cache"\)/);
  assert.match(src, /clearScanCache\(/);
});

test("clean.js names no cache files except the dev keep-list", () => {
  /*- A second list of cache filenames would reintroduce the drift. The
   *  dev keep-list is the one legitimate mention, and it is an
   *  exception list rather than a delete list. */
  const src = readRoot("scripts/clean.js");
  const mentioned = [...src.matchAll(/"([a-z0-9-]+-cache\.json)"/g)].map(
    (m) => m[1],
  );
  assert.deepEqual(
    mentioned.filter((f) => !DEV_PRESERVE.includes(f)),
    [],
    "clean.js must not enumerate caches it intends to delete",
  );
});

test("a full clean preserves nothing", () => {
  /*- dry-run: reads the directory, deletes nothing. */
  const r = clearScanCache({ dryRun: true });
  assert.equal(r.kept.length, 0);
  assert.equal(r.removed, 0, "dry run must not delete");
});

test("dev-clean preserves exactly the three quota-costing caches", () => {
  const r = clearScanCache({ dryRun: true, preserve: DEV_PRESERVE });
  assert.equal(r.removed, 0, "dry run must not delete");
  for (const f of r.files) {
    assert.ok(
      !DEV_PRESERVE.includes(path.basename(f)),
      `${path.basename(f)} is preserved and must not be queued for deletion`,
    );
  }
  for (const k of r.kept) assert.ok(DEV_PRESERVE.includes(k));
});

test("the delete lists never name a tracked file", () => {
  /*- `app-config/user-configurable/` and `app-data/` are tracked via
   *  their README.md. Deleting those would leave the directories
   *  untracked and the operator without the override instructions. */
  const all = [...STATE_FILES, ...BUILD_ARTIFACTS, ...BUILD_DIRS, ...LOG_FILES];
  for (const f of all) {
    assert.ok(!f.endsWith("README.md"), `${f} is tracked repo content`);
    assert.ok(!f.endsWith(".env"), `${f} holds operator secrets`);
  }
});

test("wallet removal is left to reset-wallet, not duplicated", () => {
  /*- reset-wallet also scrubs WALLET_PASSWORD from .env; deleting
   *  wallet.json here would do half the job and look complete. */
  assert.ok(!STATE_FILES.some((f) => f.endsWith("wallet.json")));
  assert.match(readRoot("scripts/clean.js"), /reset-wallet/);
});

test("build artifacts are cleared, and the prestart guard covers it", () => {
  /*- A fresh clone has none of them, so a full reset should not either.
   *  Safe because scripts/check-build-artifacts.js fails `npm start`
   *  with the missing files named and `npm run build` as the fix. */
  assert.ok(BUILD_DIRS.includes("public/dist"));
  assert.ok(BUILD_ARTIFACTS.includes("public/disclosure-content.js"));
  assert.ok(fs.existsSync(path.join(ROOT, "scripts/check-build-artifacts.js")));
  assert.match(pkg.scripts.prestart, /check-build-artifacts/);
});

test("clean waits for shutdown rather than racing it", () => {
  /*- `npm run stop` sends SIGTERM; the server then stops every position
   *  and closes its listener. Clearing immediately would be rewritten
   *  by a server still winding down. */
  const src = readRoot("scripts/clean.js");
  assert.match(src, /waitForServerExit\(/);
  assert.match(src, /"stop"/);
});
