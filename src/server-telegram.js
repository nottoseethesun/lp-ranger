/**
 * @file src/server-telegram.js
 * @module serverTelegram
 * @description
 * API route handlers for Telegram notification configuration.
 *
 * Routes:
 *   POST /api/telegram/config  — save bot token, chat ID, event preferences
 *   GET  /api/telegram/config  — return current config (no secrets)
 *   POST /api/telegram/test    — send a test message
 *
 * Bot token and chat ID are encrypted via api-key-store (same pattern as
 * the Moralis API key).  Event preferences are stored in bot-config global.
 */

"use strict";

const {
  saveEncryptedKey,
  loadEncryptedKey,
  hasEncryptedKey,
} = require("./api-key-store");
const telegram = require("./telegram");
const {
  BALANCED_THRESHOLD,
  BALANCED_COOLDOWN_MS,
} = require("./balanced-notifier");

/**
 * Create Telegram route handlers, scoped to the server's session state.
 * @param {object} opts
 * @param {Function} opts.readJsonBody     Parse request JSON.
 * @param {Function} opts.jsonResponse     Send JSON response.
 * @param {Function} opts.getSessionPassword  Returns the wallet session password.
 * @param {object}   opts.diskConfig       Bot config (global + positions).
 * @param {Function} opts.saveConfig       Persist bot config to disk.
 * @returns {object} Route handler functions.
 */
function createTelegramHandlers(opts) {
  const {
    readJsonBody,
    jsonResponse,
    getSessionPassword,
    diskConfig,
    saveConfig,
  } = opts;

  /**
   * POST /api/telegram/config
   * Body: { botToken?, chatId?, enabledEvents?: { oorTimeout: true, ... }, password? }
   */
  async function handleTelegramConfig(req, res) {
    const body = await readJsonBody(req);
    const pw = body.password || getSessionPassword();

    try {
      // Save bot token (encrypted)
      if (body.botToken) {
        if (!pw)
          return jsonResponse(res, 400, {
            ok: false,
            error: "Password required",
          });
        await saveEncryptedKey("telegramBotToken", body.botToken, pw);
        telegram.setBotToken(body.botToken);
        console.log("[telegram] Bot token saved");
      }

      // Save chat ID (encrypted)
      if (body.chatId) {
        if (!pw)
          return jsonResponse(res, 400, {
            ok: false,
            error: "Password required",
          });
        await saveEncryptedKey("telegramChatId", body.chatId, pw);
        telegram.setChatId(body.chatId);
        console.log("[telegram] Chat ID saved");
      }

      // Save event preferences to bot-config global section
      if (body.enabledEvents && typeof body.enabledEvents === "object") {
        if (!diskConfig.global) diskConfig.global = {};
        diskConfig.global.telegramEvents = body.enabledEvents;
        saveConfig(diskConfig);
        telegram.setEnabledEvents(body.enabledEvents);
        console.log("[telegram] Event preferences saved");
      }

      jsonResponse(res, 200, { ok: true });
    } catch (err) {
      console.error("[telegram] Save failed:", err.message);
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
  }

  /**
   * GET /api/telegram/config
   * Returns: { hasToken, hasChatId, enabledEvents, configured,
   *            balancedThresholdPct, balancedCooldownMs }
   *
   * The balanced-* fields surface the code-only constants from
   * `src/balanced-notifier.js` so the dashboard can render them
   * dynamically (label percent + warning-note cadence).
   */
  function handleTelegramStatus(_, res) {
    const hasToken = hasEncryptedKey("telegramBotToken");
    const hasChatId = hasEncryptedKey("telegramChatId");
    jsonResponse(res, 200, {
      hasToken,
      hasChatId,
      configured: telegram.isConfigured(),
      enabledEvents: telegram.getEnabledEvents(),
      balancedThresholdPct: BALANCED_THRESHOLD * 100,
      balancedCooldownMs: BALANCED_COOLDOWN_MS,
    });
  }

  /** POST /api/telegram/test — send a test notification. */
  async function handleTelegramTest(_, res) {
    if (!telegram.isConfigured()) {
      return jsonResponse(res, 400, {
        ok: false,
        error: "Telegram not configured — set bot token and chat ID first",
      });
    }
    const result = await telegram.testConnection();
    jsonResponse(res, result.ok ? 200 : 502, result);
  }

  /**
   * Decrypt Telegram credentials after wallet unlock.
   * @param {string} password  Wallet password.
   */
  async function decryptTelegramKeys(password) {
    const hasToken = hasEncryptedKey("telegramBotToken");
    const hasChatId = hasEncryptedKey("telegramChatId");
    if (!hasToken && !hasChatId) {
      console.log(
        "[telegram] No encrypted Telegram keys on disk — notifications disabled until configured in Settings.",
      );
      return;
    }
    for (const svc of ["telegramBotToken", "telegramChatId"]) {
      if (!hasEncryptedKey(svc)) continue;
      try {
        const val = await loadEncryptedKey(svc, password);
        if (svc === "telegramBotToken") telegram.setBotToken(val);
        else telegram.setChatId(val);
        console.log("[telegram] Decrypted %s", svc);
      } catch (err) {
        console.warn("[telegram] Failed to decrypt %s: %s", svc, err.message);
      }
    }
    // Restore event preferences from config
    const events = diskConfig.global?.telegramEvents;
    if (events) telegram.setEnabledEvents(events);
    console.log(
      "[telegram] Post-unlock state: configured=%s (token=%s, chatId=%s)",
      telegram.isConfigured(),
      hasToken ? "on-disk" : "missing",
      hasChatId ? "on-disk" : "missing",
    );
  }

  return {
    handleTelegramConfig,
    handleTelegramStatus,
    handleTelegramTest,
    decryptTelegramKeys,
  };
}

module.exports = { createTelegramHandlers };
