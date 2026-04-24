/**
 * @file bot.js
 * @description Headless (no UI) rebalance bot for the 9mm v3 Position Manager.
 * Runs the bot loop without starting the dashboard server.
 *
 * For the full app (dashboard + bot), use `npm start` (node server.js).
 *
 * Modes
 * ─────
 *   node bot.js           Headless bot (requires PRIVATE_KEY or .wallet.json)
 *   DRY_RUN=1 node bot.js Read-only mode — connects, detects, polls, but
 *                          never signs or sends transactions.
 *
 * Usage: node bot.js   (or: npm run bot)
 */

"use strict";

const { installColorLogger } = require("./src/logger");
installColorLogger();

if (process.argv.includes("--help") || process.argv.includes("-h")) {
  require("./src/cli-help")("bot");
  process.exit(0);
}

const config = require("./src/config");
const { resolvePrivateKey, startBotLoop } = require("./src/bot-loop");
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
    console.error(
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
  const ethers = require("ethers");
  const shared = await positionMgr.getSharedSigner({
    privateKey,
    ethersLib: ethers,
    dryRun,
  });

  // If no managed positions in config, fall back to POSITION_ID env var (single-position start)
  if (managedKeys(diskConfig).length === 0 && (config.POSITION_ID || !dryRun)) {
    console.log(
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
      console.error("[bot] Failed to start position %s: %s", key, err.message);
    }
    i++;
  }
  console.log("[bot] Started %d of %d managed positions", started, keys.length);

  _awaitShutdown(() => positionMgr.stopAll());
}

/** Register SIGINT/SIGTERM handlers for graceful shutdown. */
function _awaitShutdown(stopFn) {
  const shutdown = () => {
    console.log("\n[bot] Shutting down…");
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
    console.error("[bot] Fatal:", err.message);
    process.exit(1);
  });
}

module.exports = { main };
