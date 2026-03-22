/**
 * @file bot.js
 * @description Headless (no UI) rebalance bot for the 9mm v3 Position Manager.
 * Runs the bot loop without starting the dashboard server.
 *
 * For the full app (dashboard + bot), use `npm start` (node server.js).
 *
 * Modes
 * ─────
 *   node bot.js           Headless bot (requires PRIVATE_KEY or KEY_FILE)
 *   DRY_RUN=1 node bot.js Read-only mode — connects, detects, polls, but
 *                          never signs or sends transactions.
 *
 * Usage: node bot.js   (or: npm run bot)
 */

'use strict';

const readline = require('readline');

const config = require('./src/config');
const { resolvePrivateKey, startBotLoop } = require('./src/bot-loop');
const { createRebalanceLock } = require('./src/rebalance-lock');
const { createPositionManager } = require('./src/position-manager');
const { loadConfig, getPositionConfig } = require('./src/bot-config-v2');
const { createPerPositionBotState, updatePositionState } = require('./src/server-positions');

// ── Interactive password prompt ─────────────────────────────────────────────

/**
 * Prompt the user for a password on stdin (no echo).
 * @param {string} prompt  Text to display.
 * @returns {Promise<string>}
 */
function _askPassword(prompt) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stderr,
      terminal: true,
    });
    process.stderr.write(prompt);
    rl.input.on('data', () => {});
    rl.question('', (answer) => {
      rl.close();
      process.stderr.write('\n');
      resolve(answer);
    });
  });
}

// ── Main entry ───────────────────────────────────────────────────────────────

async function main() {
  const dryRun = config.DRY_RUN;
  if (!dryRun) config.assertLiveModeReady();

  const privateKey = await resolvePrivateKey({ askPassword: _askPassword });
  if (!privateKey && !dryRun) {
    console.error('[bot] No private key available. Set PRIVATE_KEY, KEY_FILE, or import a wallet.');
    process.exit(1);
  }

  const diskConfig = loadConfig();
  const rebalanceLock = createRebalanceLock();
  const positionMgr = createPositionManager({
    rebalanceLock,
    dailyMax: diskConfig.global.maxRebalancesPerDay || config.MAX_REBALANCES_PER_DAY,
  });

  // If no managed positions in config, fall back to POSITION_ID env var (single-position start)
  if (diskConfig.managedPositions.length === 0 && (config.POSITION_ID || !dryRun)) {
    console.log('[bot] No managed positions in config — starting single-position mode');
    const botState = createPerPositionBotState(diskConfig.global, {});
    const handle = await startBotLoop({
      privateKey, dryRun,
      updateBotState: (patch) => { Object.assign(botState, patch); },
      botState, positionId: config.POSITION_ID || undefined,
    });
    _awaitShutdown(() => { handle.stop(); positionMgr.stopAll(); });
    return;
  }

  // Auto-start all managed positions with status 'running'
  let started = 0;
  for (const key of diskConfig.managedPositions) {
    const posConfig = getPositionConfig(diskConfig, key);
    if (posConfig.status !== 'running') {
      console.log('[bot] Skipping paused position %s', key);
      continue;
    }
    const tokenId = key.split('-').pop();
    const posBotState = createPerPositionBotState(diskConfig.global, posConfig);
    try {
      await positionMgr.startPosition(key, {
        tokenId,
        startLoop: () => startBotLoop({
          privateKey, dryRun,
          updateBotState: (patch) => updatePositionState(key, patch, diskConfig, positionMgr),
          botState: posBotState, positionId: tokenId,
        }),
        savedConfig: posConfig,
      });
      started++;
    } catch (err) {
      console.error('[bot] Failed to start position %s: %s', key, err.message);
    }
  }
  console.log('[bot] Started %d of %d managed positions', started, diskConfig.managedPositions.length);

  _awaitShutdown(() => positionMgr.stopAll());
}

/** Register SIGINT/SIGTERM handlers for graceful shutdown. */
function _awaitShutdown(stopFn) {
  const shutdown = () => {
    console.log('\n[bot] Shutting down…');
    Promise.resolve(stopFn()).then(() => process.exit(0)).catch(() => process.exit(1));
    setTimeout(() => process.exit(0), 3000);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch(err => {
    console.error('[bot] Fatal:', err.message);
    process.exit(1);
  });
}

module.exports = { main };
