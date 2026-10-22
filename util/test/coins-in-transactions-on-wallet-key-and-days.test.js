"use strict";

/**
 * @file util/test/coins-in-transactions-on-wallet-key-and-days.test.js
 * @description
 * Tests for three things the wallet bookkeeping report settles before it
 * reads the chain (`util/bookkeeping/coins-in-transactions-on-wallet/`):
 * the lock on the cache of prices, which one run holds at a time; the
 * Moralis key, opened by a stand-in so no case prompts; and the last
 * whole day, which cuts a range that reaches past it and refuses one with
 * no whole day. The run and its stand-ins are in `_wallet-report-run.js`;
 * each case names the moment the run happens, or takes its fixed one. No
 * case reads the install's own `app-data/` or reaches the network: the
 * lock is in the test process's own cache folder.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { cachePath } = require("../bookkeeping/usd-prices");
const { PRICE_CACHE_LOCK_FILE } = require("../bookkeeping/price-cache-lock");
const { run, csvOf, readCsv, wroteCsv } = require("./_wallet-report-run");

const LOCK = cachePath(PRICE_CACHE_LOCK_FILE);

test("a run holds the lock on the cache of prices while it runs, and releases it", async () => {
  let holder = null;
  const { exitCode } = await run([], {
    unlock: async () => {
      holder = JSON.parse(fs.readFileSync(LOCK, "utf8"));
    },
  });
  assert.equal(exitCode, 0);
  assert.equal(holder.pid, process.pid, "held from before the key is asked");
  assert.equal(fs.existsSync(LOCK), false);
});

test("a run stops while another run holds the lock, asking for no key", async () => {
  const other = { pid: 4242, takenAt: "2026-10-21T14:02:11.000Z" };
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  fs.writeFileSync(LOCK, JSON.stringify(other));
  try {
    let asked = false;
    const { err, exitCode, dir, chain } = await run([], {
      unlock: async () => {
        asked = true;
      },
    });
    assert.equal(exitCode, 1);
    assert.equal(asked, false);
    assert.equal(wroteCsv(dir), false);
    assert.equal(chain.asked.receipts, 0);
    assert.ok(
      err
        .at(-1)
        .startsWith(
          "Another run of the report holds the cache of prices: process " +
            "4242, since 2026-10-21T14:02:11.000Z. Run this one once it ends.",
        ),
      err.at(-1),
    );
    const kept = JSON.parse(fs.readFileSync(LOCK, "utf8"));
    assert.deepEqual(kept, other, "the other run's lock stays");
  } finally {
    fs.rmSync(LOCK, { force: true });
  }
});

test("a run cut short while the key is asked for exits 1", async () => {
  let during = null;
  const { exitCode } = await run([], {
    unlock: async () => {
      during = process.exitCode;
    },
  });
  assert.equal(during, 1);
  assert.equal(exitCode, 0, "and 0 once the csv is written");
});

test("the run stops when the Moralis key cannot be opened, reading nothing", async () => {
  const unlock = async () => {
    throw Object.assign(new Error("Moralis refused the api key."), {
      keyRefused: true,
    });
  };
  const { err, exitCode, dir, chain } = await run([], { unlock });
  assert.equal(exitCode, 1);
  assert.equal(wroteCsv(dir), false);
  assert.equal(chain.asked.receipts, 0);
  assert.equal(err.at(-1), "Moralis refused the api key.");
  assert.equal(fs.existsSync(LOCK), false, "the lock is released");
});

test("a range reaching past the last whole day is cut there", async () => {
  /*-
   *  2026-10-20 06:00 UTC: 2026-10-19 is the last whole day in UTC, and
   *  2026-10-20 becomes whole when that day ends.
   */
  const { out, exitCode, dir } = await run(["--end-date", "2026-10-25"], {
    nowMs: Date.UTC(2026, 9, 20, 6),
  });
  assert.equal(exitCode, 0);
  assert.equal(
    out[0],
    "The report ends at 2026-10-19, the last whole day. 2026-10-20 " +
      "becomes whole at 2026-10-21 00:00:00 UTC, once the UTC day of its " +
      "last hour has ended.",
  );
  assert.equal(readCsv(csvOf(dir, "2026-10-19", "2026-10-19")).length, 9);
});

test("a range in a zone west of Greenwich waits for its last hour's UTC day", async () => {
  /*-
   *  2026-10-21 06:00 UTC is 01:00 on the 21st in Chicago: the 20th has
   *  ended there, but its last hours fall on the UTC 21st, which has not.
   */
  const { out, dir } = await run(
    ["--time-zone", "America/Chicago", "--end-date", "2026-10-20"],
    { nowMs: Date.UTC(2026, 9, 21, 6) },
  );
  assert.equal(
    out[0],
    "The report ends at 2026-10-19, the last whole day. 2026-10-20 " +
      "becomes whole at 2026-10-21 19:00:00 America/Chicago, once the UTC " +
      "day of its last hour has ended.",
  );
  assert.ok(
    readCsv(csvOf(dir, "2026-10-19", "2026-10-19", "America-Chicago")).length >
      0,
  );
});

test("a range with no whole day writes nothing, and asks for no key", async () => {
  let asked = false;
  const { err, exitCode, dir, chain } = await run([], {
    nowMs: Date.UTC(2026, 9, 19, 23),
    unlock: async () => {
      asked = true;
    },
  });
  assert.equal(exitCode, 1);
  assert.equal(asked, false);
  assert.equal(chain.asked.receipts, 0);
  assert.equal(wroteCsv(dir), false);
  assert.equal(
    err.at(-1),
    "No day of the range is whole yet, so no csv was written: 2026-10-19 " +
      "becomes whole at 2026-10-20 00:00:00 UTC, once the UTC day of its " +
      "last hour has ended.",
  );
});
