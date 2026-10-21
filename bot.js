/**
 * @file bot.js
 * @description Headless (no UI) rebalance bot for the LP Ranger.
 * Runs the bot loop without starting the dashboard server.
 *
 * For the full app (dashboard + bot), use `npm start` (node server.js).
 *
 * Modes
 * ─────
 *   node bot.js              Headless bot (requires PRIVATE_KEY or app-config/user-configurable/wallet.json)
 *   DRY_RUN=true node bot.js Read-only mode — connects, detects, polls, but
 *                             never signs or sends transactions.
 *
 * Usage: node bot.js   (or: npm run bot)
 */

"use strict";

const cliHelp = require("./src/cli-help");

/*- `--help` answers and leaves, ahead of every other line in this file.
 *  It starts no bot, so it must not open the operator's log file and
 *  must not announce a start. The banner below is a REQUIRE side effect,
 *  which is what put it ahead of this check: moving the check up is the
 *  only way to stay in front of it. */
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  cliHelp("bot");
  process.exit(0);
}

/*- Boot wiring for the --log-file CLI flag + logging.json static
 *  tunable.  MUST run before any log output so the file captures the
 *  startup banner.  No-op when neither source opts in.  See
 *  src/boot-log-file.js + src/log-file.js. */
require("./src/boot-log-file").bootLogFile();

/*-
 *  Every setting is checked before any is read: the JSON settings files
 *  with the operator's copies, `.env` and bot-config.json. A wrong one
 *  stops the bot here, each named, rather than leaving it to run on a
 *  value nobody chose. See src/settings-check.js.
 */
require("./src/settings-check").refuseToStartOnBadSettings();

const { log } = require("./src/log");
// First statement of a real run — bot-banner prints on require (side
// effect, cached so it fires exactly once per process). Required here so
// the banner lands at the top of the log before any other module loads.
require("./src/bot-banner");

const { pausePriceLookups } = require("./src/price-fetcher");
const { readPriceCacheSettings } = require("./src/price-fetcher-gate");

/*- Headless default: pause price lookups at startup.  Without a server
 *  there is no idle tracker and no browser to drive pause/unpause, so
 *  the only consumers that need fresh prices are moves (auto/manual
 *  rebalance + compound), which engage `withFreshPricesAllowed`
 *  themselves.  Operators can opt out with
 *  `--start-with-price-lookups-unpaused` (e.g. when they want
 *  continuous P&L cache warming on a headless box).  See
 *  docs/architecture.md "Idle-Driven Price-Lookup Pause". */
const _startUnpaused = process.argv.includes(
  "--start-with-price-lookups-unpaused",
);
if (!_startUnpaused) pausePriceLookups("headless startup");

const ethers = require("ethers");
const config = require("./src/config");
const { startBotLoop } = require("./src/bot-loop");
const { resetErrorLog } = require("./src/error-log");
const { resolvePrivateKey } = require("./src/bot-private-key");
const { createRebalanceLock } = require("./src/rebalance-lock");
const { createPositionManager } = require("./src/position-manager");
const {
  loadConfig,
  managedKeys,
  readConfigValue,
} = require("./src/bot-config-v2");
const {
  createPerPositionBotState,
  attachMultiPosDeps,
  updatePositionState,
  getAllPositionBotStates,
} = require("./src/server-positions");
const { createAutoStartManagedPositions } = require("./src/server-auto-start");
const { migrateAppConfig } = require("./src/migrate-app-config");
const { askPassword: _askPassword } = require("./src/ask-password");
const { readShutdownTimings } = require("./src/shutdown-timing");

// One-time migration of legacy root-level config files into app-config/.
// Idempotent: a no-op after the first successful run.
migrateAppConfig();

// ── Main entry ───────────────────────────────────────────────────────────────

async function main() {
  // Read before anything starts, so an unusable value stops startup.
  const { exitTimeoutMs } = readShutdownTimings();
  const dryRun = config.DRY_RUN;
  if (!dryRun) config.assertLiveModeReady();

  const privateKey = await resolvePrivateKey({
    askPassword: _askPassword,
  });
  if (!privateKey && !dryRun) {
    log.error(
      "[bot] No private key available. Set PRIVATE_KEY in .env, or import" +
        " a wallet via `node scripts/import-wallet.js` (or the dashboard).",
    );
    process.exit(1);
  }

  const diskConfig = loadConfig();
  readPriceCacheSettings();
  const rebalanceLock = createRebalanceLock();
  const positionMgr = createPositionManager({
    rebalanceLock,
    dailyMax:
      diskConfig.global.maxRebalancesPerDay || config.MAX_REBALANCES_PER_DAY,
  });
  /*- App-wide shared signer: every bot-loop below must sign through the
   *  same NonceManager so per-position counters cannot drift. */
  const shared = await positionMgr.getSharedSigner({
    privateKey,
    ethersLib: ethers,
    dryRun,
  });

  // If no managed positions in config, fall back to POSITION_ID env var (single-position start)
  if (managedKeys(diskConfig).length === 0 && (config.POSITION_ID || !dryRun)) {
    log.info(
      "[bot] No managed positions in config — starting single-position mode",
    );
    const botState = createPerPositionBotState(diskConfig.global, {});
    const handle = await startBotLoop({
      privateKey,
      provider: shared.provider,
      signer: shared.signer,
      address: shared.address,
      dryRun,
      updateBotState: (patch) => {
        Object.assign(botState, patch);
      },
      botState,
      positionId: config.POSITION_ID || undefined,
      getConfig: (k) => diskConfig.global[k],
    });
    _awaitShutdown(() => {
      handle.stop();
      positionMgr.stopAll();
    }, exitTimeoutMs);
    return;
  }

  /*-
   *  Start the positions saved as managed the way the server does
   *  (src/server-auto-start.js), so the same rules hold headless: one
   *  active position per pool, and a position that cannot be managed comes
   *  off the list. The wallet is the signer's, or any wallet's in a dry run
   *  with no key, whose signer is a random wallet.
   */
  const wallet = privateKey === null ? null : shared.address;
  await createAutoStartManagedPositions({
    diskConfig,
    positionMgr,
    privateKeyRef: { current: privateKey },
    walletManager: { getAddress: () => wallet },
    getAllPositionBotStates,
    createPerPositionBotState,
    attachMultiPosDeps,
    updatePositionState,
    readConfigValue,
  })();

  _awaitShutdown(() => positionMgr.stopAll(), exitTimeoutMs);
}

/**
 * Register SIGINT/SIGTERM handlers for graceful shutdown.
 * @param {() => *} stopFn  Stops the running positions.
 * @param {number} exitTimeoutMs  How long a stop may take before the
 *   process exits anyway: `shutdown.exitTimeoutMs` in app-runtime.json,
 *   the figure the server uses.
 */
function _awaitShutdown(stopFn, exitTimeoutMs) {
  const shutdown = () => {
    log.info("\n[bot] Shutting down…");
    Promise.resolve(stopFn())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
    setTimeout(() => process.exit(0), exitTimeoutMs);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  /*- Fresh start: delete the previous run's error.log so no stale entry
   *  lingers (current problems are re-logged by the scans). See src/error-log.js. */
  resetErrorLog();
  main().catch((err) => {
    log.error("[bot] Fatal:", err.message);
    process.exit(1);
  });
}

module.exports = { main };
