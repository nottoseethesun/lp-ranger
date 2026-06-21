/**
 * @file bot.js
 * @description Headless (no UI) rebalance bot for the 9mm v3 Position Manager.
 * Runs the bot loop without starting the dashboard server.
 *
 * For the full app (dashboard + bot), use `npm start` (node server.js).
 *
 * Modes
 * ─────
 *   node bot.js           Headless bot (requires PRIVATE_KEY or app-config/user-configurable/wallet.json)
 *   DRY_RUN=1 node bot.js Read-only mode — connects, detects, polls, but
 *                          never signs or sends transactions.
 *
 * Usage: node bot.js   (or: npm run bot)
 */

"use strict";

/*- Boot wiring for the --log-file CLI flag + logging.json static
 *  tunable.  MUST run before any log output so the file captures the
 *  startup banner.  No-op when neither source opts in.  See
 *  src/boot-log-file.js + src/log-file.js. */
require("./src/boot-log-file").bootLogFile();

const { log } = require("./src/log");
// Very first statement of the bot process — bot-banner prints on require
// (side effect, cached so it fires exactly once per process). Required first
// so the banner lands at the top of the log before any other module loads.
require("./src/bot-banner");

const cliHelp = require("./src/cli-help");
const { pausePriceLookups } = require("./src/price-fetcher");

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  cliHelp("bot");
  process.exit(0);
}

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
const { resolvePrivateKey } = require("./src/bot-private-key");
const { createRebalanceLock } = require("./src/rebalance-lock");
const { createPositionManager } = require("./src/position-manager");
const {
  loadConfig,
  managedKeys,
  getPositionConfig,
  readConfigValue,
} = require("./src/bot-config-v2");
const {
  createPerPositionBotState,
  attachMultiPosDeps,
  updatePositionState,
  createOnRetire,
} = require("./src/server-positions");
const { migrateAppConfig } = require("./src/migrate-app-config");
const { askPassword: _askPassword } = require("./src/ask-password");

// One-time migration of legacy root-level config files into app-config/.
// Idempotent: a no-op after the first successful run.
migrateAppConfig();

// ── Main entry ───────────────────────────────────────────────────────────────

async function main() {
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
    });
    return;
  }

  // Auto-start all managed positions with status 'running' (staggered)
  const keys = managedKeys(diskConfig);
  const count = keys.length;
  const staggerMs =
    count > 1 ? Math.floor((config.CHECK_INTERVAL_SEC * 1000) / count) : 0;
  let started = 0,
    i = 0;
  for (const key of keys) {
    const posConfig = getPositionConfig(diskConfig, key);
    if (i > 0 && staggerMs > 0)
      await new Promise((r) => setTimeout(r, staggerMs));
    const tokenId = key.split("-").pop();
    const posBotState = createPerPositionBotState(diskConfig.global, posConfig);
    attachMultiPosDeps(posBotState, positionMgr);
    try {
      const keyRef = { current: key };
      await positionMgr.startPosition(key, {
        tokenId,
        startLoop: () =>
          startBotLoop({
            privateKey,
            provider: shared.provider,
            signer: shared.signer,
            address: shared.address,
            dryRun,
            updateBotState: (patch) =>
              updatePositionState(keyRef, patch, diskConfig, positionMgr),
            botState: posBotState,
            positionId: tokenId,
            getConfig: (k) => readConfigValue(diskConfig, keyRef.current, k),
            onRetire: createOnRetire({ keyRef, diskConfig, positionMgr }),
          }),
        savedConfig: posConfig,
      });
      started++;
    } catch (err) {
      log.error("[bot] Failed to start position %s: %s", key, err.message);
    }
    i++;
  }
  log.info("[bot] Started %d of %d managed positions", started, keys.length);

  _awaitShutdown(() => positionMgr.stopAll());
}

/** Register SIGINT/SIGTERM handlers for graceful shutdown. */
function _awaitShutdown(stopFn) {
  const shutdown = () => {
    log.info("\n[bot] Shutting down…");
    Promise.resolve(stopFn())
      .then(() => process.exit(0))
      .catch(() => process.exit(1));
    setTimeout(() => process.exit(0), 3000);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    log.error("[bot] Fatal:", err.message);
    process.exit(1);
  });
}

module.exports = { main };
