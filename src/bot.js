/**
 * @file src/bot.js
 * @description Headless (no UI) rebalance bot for the LP Ranger.
 * Runs the bot loop without starting the dashboard server.
 *
 * For the full app (dashboard + bot), use `npm start` (node src/server.js).
 *
 * Modes
 * ─────
 *   node src/bot.js              Headless bot (requires PRIVATE_KEY or app-config/user-configurable/wallet.json)
 *   DRY_RUN=true node src/bot.js Read-only mode — connects, detects, polls, but
 *                                 never signs or sends transactions.
 *
 * Usage: node src/bot.js   (or: npm run bot)
 */

"use strict";

const cliHelp = require("./bot/bot-cli-help");

/*- `--help` answers and leaves, ahead of every other line in this file.
 *  It starts no bot, so it must not open the operator's log file and
 *  must not announce a start. The banner below is a REQUIRE side effect,
 *  which is what put it ahead of this check: moving the check up is the
 *  only way to stay in front of it. */
if (process.argv.includes("--help") || process.argv.includes("-h")) {
  cliHelp();
  process.exit(0);
}

/*- Boot wiring for the --log-file CLI flag + logging.json static
 *  tunable.  MUST run before any log output so the file captures the
 *  startup banner.  No-op when neither source opts in.  See
 *  src/lib/boot-log-file.js + src/lib/log-file.js. */
require("./lib/boot-log-file").bootLogFile();

/*-
 *  Every setting is checked before any is read: the JSON settings files
 *  with the operator's copies, `.env` and bot-config.json. A wrong one
 *  stops the bot here, each named, rather than leaving it to run on a
 *  value nobody chose. See src/lib/settings-check.js.
 */
require("./lib/settings-check").refuseToStartOnBadSettings();

/*-
 *  The dashboard settings, which the bot's wait for the dashboard is
 *  built on: read now, just checked, and kept for the life of the
 *  process (src/lib/ui-defaults.js), so an edit to the operator's copy
 *  takes effect at the next restart, where the check above refuses a bad
 *  value.
 */
require("./lib/ui-defaults").readUiDefaults();

const { log } = require("./lib/log");
// First statement of a real run — bot-banner prints on require (side
// effect, cached so it fires exactly once per process). Required here so
// the banner lands at the top of the log before any other module loads.
require("./bot/bot-banner");

const { pausePriceLookups } = require("./bot/price-fetcher");

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

const config = require("./lib/config");
const { createBot } = require("./bot/bot-interface");
const { startBotLoop } = require("./bot/bot-loop");
const { resetErrorLog } = require("./lib/error-log");
const { resolvePrivateKey } = require("./bot/bot-private-key");
const walletManager = require("./lib/wallet-manager");
const { loadConfig, managedKeys } = require("./lib/bot-config-v2");
const { createPerPositionBotState } = require("./bot/position-states");
const { migrateAppConfig } = require("./lib/migrate-app-config");
const { askPassword: _askPassword } = require("./lib/ask-password");
const { readShutdownTimings } = require("./lib/shutdown-timing");

// One-time migration of legacy root-level config files into app-config/.
// Idempotent: a no-op after the first successful run.
migrateAppConfig();

// ── Main entry ───────────────────────────────────────────────────────────────

async function main() {
  // Read before anything starts, so an unusable value stops startup.
  const { exitTimeoutMs } = readShutdownTimings();
  /*-
   *  Put the wallet's files right before the key is read from them: the
   *  copy a save cut short left is put back as wallet.json, or removed
   *  (src/lib/wallet-manager.js), as the server does as it starts.
   */
  walletManager.settleWalletFile();
  const dryRun = config.DRY_RUN;
  if (!dryRun) config.assertLiveModeReady();

  const privateKey = await resolvePrivateKey({
    askPassword: _askPassword,
  });
  if (!privateKey && !dryRun) {
    log.error(
      walletManager.hasWallet()
        ? "[bot] The wallet is locked: no password was given. Set" +
            " WALLET_PASSWORD in .env, or start the bot from a terminal" +
            " to type it."
        : "[bot] No private key available. Set PRIVATE_KEY in .env, or" +
            " import a wallet via `node scripts/import-wallet.js` (or the" +
            " dashboard).",
    );
    process.exit(1);
  }

  const diskConfig = loadConfig();
  /*-
   *  The wallet whose saved positions the start-up starts: the signer's,
   *  or any wallet's in a dry run with no key, whose signer is a random
   *  wallet. It is known once the shared signer is built, below, and the
   *  start-up reads it only after that.
   */
  let wallet = null;
  /*-
   *  The bot is built the one way the server builds it
   *  (src/bot/bot-interface.js), today's per-pool rebalance counts read
   *  from the rebalance log included, so a restart keeps each pool's
   *  daily cap.
   */
  const bot = createBot({
    diskConfig,
    walletManager: { getAddress: () => wallet },
  });
  bot.setPrivateKey(privateKey);
  /*- App-wide shared signer: every bot-loop below must sign through the
   *  same NonceManager so per-position counters cannot drift. */
  const shared = await bot.sharedSigner();
  wallet = privateKey === null ? null : shared.address;

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
      bot.stopAll();
    }, exitTimeoutMs);
    return;
  }

  /*-
   *  Start the positions saved as managed the way the server does
   *  (src/bot/auto-start.js), so the same rules hold headless: one
   *  active position per pool, and a position that cannot be managed comes
   *  off the list.
   */
  await bot.startManagedPositions();

  _awaitShutdown(() => bot.stopAll(), exitTimeoutMs);
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
   *  lingers (current problems are re-logged by the scans). See src/lib/error-log.js. */
  resetErrorLog();
  main().catch((err) => {
    log.error("[bot] Fatal:", err.message);
    process.exit(1);
  });
}

module.exports = { main };
