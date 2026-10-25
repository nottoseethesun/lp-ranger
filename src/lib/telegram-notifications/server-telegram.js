/**
 * @file src/lib/telegram-notifications/server-telegram.js
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

const { log } = require("../log");
const {
  saveEncryptedKey,
  loadEncryptedKey,
  hasEncryptedKey,
} = require("../api-key-store");
const telegram = require("./telegram");
const {
  BALANCED_BAND_PCT,
  BALANCED_COOLDOWN_MS,
} = require("./balanced-notifier");
const { ALERT_CHOICES } = require("./telegram-events");
const { AJV } = require("../value-kinds");
const { problemsFromErrors } = require("../settings-schema-parts");

// The rule for a set of alert choices, compiled.
const _choicesOk = AJV.compile(ALERT_CHOICES);

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
   *
   * Alert choices are held to the schema the settings check holds the
   * saved set to at startup (`ALERT_CHOICES`), before anything is
   * saved, so a refused request leaves no trace and a saved set can
   * never stop the next start. Leaving `enabledEvents` out keeps the
   * saved choices.
   */
  async function handleTelegramConfig(req, res) {
    const body = await readJsonBody(req);
    const pw = body.password || getSessionPassword();
    if (Object.hasOwn(body, "enabledEvents") && !_choicesOk(body.enabledEvents))
      return jsonResponse(res, 400, {
        ok: false,
        error: problemsFromErrors("enabledEvents", _choicesOk.errors).join(
          "; ",
        ),
      });

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
        log.info("[telegram] Bot token saved");
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
        log.info("[telegram] Chat ID saved");
      }

      // Save event preferences to bot-config global section
      if (Object.hasOwn(body, "enabledEvents")) {
        if (!diskConfig.global) diskConfig.global = {};
        diskConfig.global.telegramEvents = body.enabledEvents;
        saveConfig(diskConfig);
        telegram.setEnabledEvents(body.enabledEvents);
        log.info("[telegram] Event preferences saved");
      }

      jsonResponse(res, 200, { ok: true });
    } catch (err) {
      log.error("[telegram] Save failed:", err.message);
      jsonResponse(res, 500, { ok: false, error: err.message });
    }
  }

  /**
   * GET /api/telegram/config
   * Returns: { hasToken, hasChatId, enabledEvents, configured,
   *            balancedThresholdPct, balancedCooldownMs }
   *
   * The balanced-* fields surface the band and quiet period the notifier
   * uses, `positionBalancedBandPct` and `positionBalancedCooldownMs` in
   * bot-config-defaults.json, so the dashboard can render them
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
      balancedThresholdPct: BALANCED_BAND_PCT,
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
      log.info(
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
        log.info("[telegram] Decrypted %s", svc);
      } catch (err) {
        log.warn("[telegram] Failed to decrypt %s: %s", svc, err.message);
      }
    }
    // Restore event preferences from config
    const events = diskConfig.global?.telegramEvents;
    if (events) telegram.setEnabledEvents(events);
    log.info(
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
