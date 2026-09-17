/**
 * @file util/diagnostic/test/rescan-pool-history-apply.test.js
 * @description
 * Covers the destructive half of `rescan-pool-history` — the y/N gate,
 * the mutation itself, and the `main` orchestration that sequences
 * them.
 *
 * This is the only tool in `util/diagnostic/` that WRITES. It deletes
 * compound history and deposit totals from the operator's bot-config
 * and, with `--clear-hodl`, the pool's cached lifetime HODL. None of
 * those fields can be recomputed from what is left behind, so two
 * properties matter more than anything else here and are asserted
 * directly:
 *
 *   1. A backup exists before anything is deleted.
 *   2. Nothing is deleted unless the operator said yes.
 *
 * The sibling `rescan-pool-history.test.js` covers argument parsing and
 * key resolution; `loaders-and-plan.test.js` covers `_loadJson` and
 * `_printPlan`. Neither is duplicated here.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { captureConsole, captureExit } = require("./_capture");
const { _confirm, _applyMutations, main } = require("../rescan-pool-history");

const WALLET = "0x4e448D6fd48B2Bb0F2Ca5c1D1d34E4bDd5FE6E8f";
const PM = "0xCC05bf158fF2Bdc37eb0d2A2Ea6D2A4Ba1Bd0Ee7";
const TOKEN_ID = "162980";
const POS_KEY = `pulsechain-${WALLET}-${PM}-${TOKEN_ID}`;
const POOL_KEY = `pulsechain.${PM}.${WALLET}.0xT0.0xT1.2500`;

/** Everything the tool strips, plus fields it must leave alone. */
function positionFixture() {
  return {
    status: "running",
    totalCompoundedUsd: 240.1,
    compoundHistory: [{ usdValue: 240.1 }],
    lastCompoundAt: 1_700_000_000,
    totalLifetimeDepositUsd: 1000,
    depositUsedFallback: true,
    /*- Not price-derived: must survive. */
    hodlBaseline: { hodlAmount0: 5, hodlAmount1: 6 },
    slippagePct: 0.75,
  };
}

/** A second pool on the same wallet and contract. */
const OTHER_POOL_KEY = `pulsechain.${PM}.${WALLET}.0xT2.0xT3.500`;

/** A pool's epoch cache entry, as the app writes it. */
function poolEntry() {
  return {
    lifetimeHodlAmounts: { amount0: 1, amount1: 2 },
    closedEpochs: [{ keep: true }],
  };
}

/**
 * A scratch install with a config and an epoch cache on disk.
 *
 * @param {object} [o]
 * @param {boolean} [o.withCache]  Write the epoch cache at all.
 * @param {boolean} [o.twoPools]   Give the wallet a second pool.
 */
function fixture({ withCache = true, twoPools = false } = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "rescan-test-"));
  const configPath = path.join(dir, "bot-config.json");
  const epochPath = path.join(dir, "pnl-epochs-cache.json");
  fs.writeFileSync(
    configPath,
    JSON.stringify({ global: {}, positions: { [POS_KEY]: positionFixture() } }),
  );
  if (withCache) {
    const cache = { [POOL_KEY]: poolEntry() };
    if (twoPools === true) cache[OTHER_POOL_KEY] = poolEntry();
    fs.writeFileSync(epochPath, JSON.stringify(cache));
  }
  return { dir, configPath, epochPath };
}

const readJson = (p) => JSON.parse(fs.readFileSync(p, "utf8"));

/** Backup files this run created, newest first. */
function backups(dir) {
  return fs.readdirSync(dir).filter((n) => n.includes(".pre-rescan."));
}

/* ---------- the confirmation gate ---------- */

/** readline double that answers with `answer` and records close(). */
function fakeReadline(answer, record = {}) {
  return () => ({
    question: (_prompt, cb) => cb(answer),
    close: () => {
      record.closed = true;
    },
  });
}

test("_confirm — 'y' and 'yes' proceed, case-insensitively", async () => {
  assert.equal(await _confirm(fakeReadline("y")), true);
  assert.equal(await _confirm(fakeReadline("yes")), true);
  assert.equal(await _confirm(fakeReadline("YES")), true);
  assert.equal(await _confirm(fakeReadline("  y  ")), true);
});

test("_confirm — anything else is a no", async () => {
  /*- Everything that is not an explicit yes must abort: this gate
   *  stands in front of an irreversible edit, so a stray newline or a
   *  piped empty stdin has to mean no. */
  for (const answer of ["", "n", "no", "\n", "yeah", "sure", "Y E S"]) {
    assert.equal(
      await _confirm(fakeReadline(answer)),
      false,
      `"${answer}" must not be read as consent`,
    );
  }
});

test("_confirm — closes the readline interface either way", async () => {
  const yes = {};
  await _confirm(fakeReadline("y", yes));
  assert.equal(yes.closed, true);
  const no = {};
  await _confirm(fakeReadline("n", no));
  assert.equal(no.closed, true, "a declined prompt must not leak the handle");
});

/* ---------- the mutation ---------- */

test("_applyMutations — strips exactly the price-derived fields", async () => {
  const f = fixture();
  const cfg = readJson(f.configPath);
  const cache = readJson(f.epochPath);
  _applyMutations(cfg, cache, POS_KEY, [POOL_KEY], {}, f);

  const after = readJson(f.configPath).positions[POS_KEY];
  for (const gone of [
    "totalCompoundedUsd",
    "compoundHistory",
    "lastCompoundAt",
    "totalLifetimeDepositUsd",
    "depositUsedFallback",
  ]) {
    assert.equal(gone in after, false, `${gone} must be cleared`);
  }
  assert.deepEqual(
    after.hodlBaseline,
    { hodlAmount0: 5, hodlAmount1: 6 },
    "the HODL baseline is not price-derived and must survive",
  );
  assert.equal(after.status, "running", "unrelated settings are untouched");
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("_applyMutations — backs up the config BEFORE deleting from it", async () => {
  /*- The stripped fields cannot be recomputed from what is left, so an
   *  interrupted run with no backup would lose them for good. */
  const f = fixture();
  const cfg = readJson(f.configPath);
  const { cfgBackup } = _applyMutations(
    cfg,
    readJson(f.epochPath),
    POS_KEY,
    [],
    {},
    f,
  );

  assert.equal(fs.existsSync(cfgBackup), true, "a backup file was written");
  const saved = readJson(cfgBackup).positions[POS_KEY];
  assert.equal(
    saved.totalCompoundedUsd,
    240.1,
    "the backup holds the PRE-mutation values",
  );
  fs.rmSync(f.dir, { recursive: true, force: true });
});

/** The config and the epoch cache as they are on disk now. */
function loaded(f) {
  return { cfg: readJson(f.configPath), cache: readJson(f.epochPath) };
}

/** Assert the epoch cache was neither backed up nor changed. */
function assertCacheUntouched(f, before, cacheBackup) {
  assert.equal(cacheBackup, null, "no cache backup path is reported");
  const after = readJson(f.epochPath);
  assert.deepEqual(after, before, "the cache is unchanged");
  const cacheBackups = backups(f.dir).filter((n) => n.startsWith("pnl-epochs"));
  assert.equal(cacheBackups.length, 0);
}

test("_applyMutations — without --clear-hodl the cache is neither backed up nor touched", async () => {
  const f = fixture();
  const before = readJson(f.epochPath);
  const { cfg, cache } = loaded(f);
  const { cacheBackup } = _applyMutations(
    cfg,
    cache,
    POS_KEY,
    [POOL_KEY],
    {},
    f,
  );
  assertCacheUntouched(f, before, cacheBackup);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("_applyMutations — --clear-hodl drops the lifetime HODL, keeps the epochs", async () => {
  /*-
   *  The field the app writes and reads is `lifetimeHodlAmounts`
   *  (`epoch-cache.getCachedLifetimeHodl`). Deleting any other name
   *  leaves the HODL in place, and the rescan never recomputes it.
   */
  const f = fixture();
  const { cfg, cache } = loaded(f);
  const { cacheBackup } = _applyMutations(
    cfg,
    cache,
    POS_KEY,
    [POOL_KEY],
    { "clear-hodl": true },
    f,
  );
  const entry = readJson(f.epochPath)[POOL_KEY];
  assert.equal("lifetimeHodlAmounts" in entry, false, "the HODL is cleared");
  assert.deepEqual(
    entry.closedEpochs,
    [{ keep: true }],
    "P&L epochs are not price-derived and must survive",
  );
  const saved = readJson(cacheBackup)[POOL_KEY];
  assert.deepEqual(
    saved.lifetimeHodlAmounts,
    { amount0: 1, amount1: 2 },
    "the backup holds the HODL as it was",
  );
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("_applyMutations — no pool keys means the cache is neither backed up nor touched", async () => {
  const f = fixture();
  const before = readJson(f.epochPath);
  const { cfg, cache } = loaded(f);
  const { cacheBackup } = _applyMutations(
    cfg,
    cache,
    POS_KEY,
    [],
    { "clear-hodl": true },
    f,
  );
  assertCacheUntouched(f, before, cacheBackup);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

/* ---------- orchestration ---------- */

test("main — declining the prompt changes nothing on disk", async () => {
  /*- The most important test in this file: a "no" must leave every
   *  byte where it was, including writing no backup. */
  const f = fixture();
  const before = readJson(f.configPath);
  const res = await captureConsole(() =>
    captureExit(() => main([TOKEN_ID], { ...f, confirm: async () => false })),
  );
  assert.equal(res.value.code, 0, "declining is a clean exit, not an error");
  assert.deepEqual(readJson(f.configPath), before, "config untouched");
  assert.deepEqual(backups(f.dir), [], "no backup written for a no-op");
  assert.match(res.out.join("\n"), /aborted by user/);
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("main — accepting the prompt applies the mutation", async () => {
  const f = fixture();
  const res = await captureConsole(() =>
    main([TOKEN_ID], { ...f, confirm: async () => true }),
  );
  const after = readJson(f.configPath).positions[POS_KEY];
  assert.equal("totalCompoundedUsd" in after, false);
  assert.equal(backups(f.dir).length >= 1, true, "a backup was written");
  const out = res.out.join("\n");
  assert.match(out, /config backup:/);
  assert.match(
    out,
    /npm run stop && npm run build-and-start/,
    "names the next step",
  );
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("main — without --clear-hodl, a wallet with two pools needs no disambiguation", async () => {
  /*-
   *  Only `--clear-hodl` touches the epoch cache, so only it has to know
   *  which pool the position is in.
   */
  const f = fixture({ twoPools: true });
  const before = readJson(f.epochPath);
  await captureConsole(() => captureExit(() => main([TOKEN_ID, "--yes"], f)));
  const { cfg, cache } = loaded(f);
  assert.equal(
    "totalCompoundedUsd" in cfg.positions[POS_KEY],
    false,
    "the config was still cleared",
  );
  assert.deepEqual(cache, before, "the cache is unchanged");
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("main --clear-hodl — a wallet with two pools must name one", async () => {
  const f = fixture({ twoPools: true });
  const res = await captureConsole(() =>
    captureExit(() => main([TOKEN_ID, "--clear-hodl", "--yes"], f)),
  );
  assert.equal(res.value.code, 1);
  const errors = res.err.join("\n");
  assert.match(errors, /AMBIGUOUS/);
  const cfg = readJson(f.configPath);
  assert.equal(
    "totalCompoundedUsd" in cfg.positions[POS_KEY],
    true,
    "nothing is cleared before the pool is known",
  );
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("main --yes — skips the prompt entirely", async () => {
  const f = fixture();
  let asked = false;
  await captureConsole(() =>
    main([TOKEN_ID, "--yes"], {
      ...f,
      confirm: async () => {
        asked = true;
        return false;
      },
    }),
  );
  assert.equal(asked, false, "--yes must not consult the prompt");
  assert.equal(
    "totalCompoundedUsd" in readJson(f.configPath).positions[POS_KEY],
    false,
  );
  fs.rmSync(f.dir, { recursive: true, force: true });
});

test("main — exits 1 with usage when no tokenId is given", async () => {
  const res = await captureConsole(() => captureExit(() => main([], {})));
  assert.equal(res.value.code, 1);
  assert.match(
    res.err.join("\n"),
    /Usage: node util\/diagnostic\/rescan-pool-history/,
  );
});

test("main — exits 2 when the config file is absent", async () => {
  /*- A distinct code from the usage error: one is operator input, the
   *  other is a broken install. */
  const res = await captureConsole(() =>
    captureExit(() =>
      main([TOKEN_ID], { configPath: "/nonexistent/bot-config.json" }),
    ),
  );
  assert.equal(res.value.code, 2);
  assert.match(res.err.join("\n"), /config not found at/);
});

test("main — runs with no epoch cache on disk at all", async () => {
  /*- A fresh install has no cache file; the tool must still clear the
   *  config rather than crash on the missing file. */
  const f = fixture({ withCache: false });
  await captureConsole(() => captureExit(() => main([TOKEN_ID, "--yes"], f)));
  assert.equal(
    "compoundHistory" in readJson(f.configPath).positions[POS_KEY],
    false,
  );
  fs.rmSync(f.dir, { recursive: true, force: true });
});
