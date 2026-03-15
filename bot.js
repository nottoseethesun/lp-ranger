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
const {
  pollCycle,
  appendLog,
  createProviderWithFallback,
  resolvePrivateKey,
  startBotLoop,
} = require('./src/bot-loop');

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

// ── Headless bot state (console-only, no HTTP server) ────────────────────────

const _botState = {
  running: false,
  rangeWidthPct: config.RANGE_WIDTH_PCT,
  slippagePct: config.SLIPPAGE_PCT,
};

/**
 * Minimal state updater for headless mode — logs key events to console.
 * @param {object} patch  State patch.
 */
function _updateBotState(patch) {
  Object.assign(_botState, patch);
}

// ── Main entry ───────────────────────────────────────────────────────────────

async function main() {
  const dryRun = config.DRY_RUN;

  if (!dryRun) {
    config.assertLiveModeReady();
  }

  const privateKey = await resolvePrivateKey({ askPassword: _askPassword });
  if (!privateKey && !dryRun) {
    console.error('[bot] No private key available. Set PRIVATE_KEY, KEY_FILE, or import a wallet.');
    process.exit(1);
  }

  const handle = await startBotLoop({
    privateKey,
    dryRun,
    updateBotState: _updateBotState,
    botState: _botState,
  });

  // Graceful shutdown
  const shutdown = () => {
    console.log('\n[bot] Shutting down…');
    handle.stop();
    process.exit(0);
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

module.exports = { pollCycle, appendLog, createProviderWithFallback };
