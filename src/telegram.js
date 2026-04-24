/**
 * @file src/telegram.js
 * @module telegram
 * @description
 * Telegram Bot notification system for LP Ranger.  Sends alerts for
 * configurable position events (rebalance, compound, OOR timeout, errors).
 *
 * Bot token and chat ID are stored encrypted via api-key-store.  Event
 * preferences live in `.bot-config.json` global section.
 *
 * Setup: create a bot via @BotFather, paste the token + your chat ID
 * (from @userinfobot) into the dashboard dialog.
 */

"use strict";

const os = require("os");

/** Machine hostname, included in all notifications. */
const _hostname = os.hostname();

/** In-memory Telegram config (populated from encrypted store on unlock). */
let _botToken = null;
let _chatId = null;

/** Event types and their default enabled state. */
const EVENT_DEFAULTS = {
  oorTimeout: true,
  rebalanceSuccess: false,
  rebalanceFail: true,
  compoundSuccess: false,
  compoundFail: true,
  otherError: true,
  lowGasBalance: true,
  veryLowGas: true,
  shutdown: true,
  positionRetired: true,
};

/** Human-readable labels for each event type. */
const EVENT_LABELS = {
  oorTimeout: "OOR Timeout Triggered",
  rebalanceSuccess: "Rebalance Succeeded",
  rebalanceFail: "Rebalance Failed",
  compoundSuccess: "Compound Succeeded",
  compoundFail: "Compound Failed",
  otherError: "Other Error",
  lowGasBalance: "Low Gas Balance",
  veryLowGas: "Very Low Gas",
  shutdown: "Server and Bot Shutdown/Exit",
  positionRetired: "Drained Position Auto-Retired",
};

/** Currently enabled events (mutated in place by setEnabledEvents). */
const _enabledEvents = { ...EVENT_DEFAULTS };

/**
 * Set the bot token (called after wallet unlock decrypts api-keys).
 * @param {string|null} token  Telegram Bot API token.
 */
function setBotToken(token) {
  _botToken = token || null;
}

/**
 * Set the chat ID (called after wallet unlock decrypts api-keys).
 * @param {string|null} id  Telegram chat ID.
 */
function setChatId(id) {
  _chatId = id || null;
}

/** @returns {boolean} True when both bot token and chat ID are configured. */
function isConfigured() {
  return !!_botToken && !!_chatId;
}

/** @returns {string|null} Current bot token (for shutdown spawn). */
function getBotToken() {
  return _botToken;
}

/** @returns {string|null} Current chat ID (for shutdown spawn). */
function getChatId() {
  return _chatId;
}

/**
 * Update which events trigger notifications.
 * @param {Object<string, boolean>} events  Map of eventType → enabled.
 */
function setEnabledEvents(events) {
  if (!events || typeof events !== "object") return;
  for (const [k, v] of Object.entries(events)) {
    if (k in EVENT_DEFAULTS) _enabledEvents[k] = !!v;
  }
}

/** @returns {Object<string, boolean>} Current enabled-events map. */
function getEnabledEvents() {
  return { ..._enabledEvents };
}

/**
 * Send a Telegram message via the Bot API.
 * @param {string} text  Message text (Markdown or plain).
 * @returns {Promise<boolean>} True on success, false on failure.
 */
async function _send(text) {
  if (!_botToken || !_chatId) return false;
  const url = `https://api.telegram.org/bot${_botToken}/sendMessage`;
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        chat_id: _chatId,
        text,
        parse_mode: "Markdown",
        disable_web_page_preview: true,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      console.warn("[telegram] Send failed: %d %s", res.status, body);
      return false;
    }
    console.log("[telegram] Notification sent: %s", text.split("\n")[0]);
    return true;
  } catch (err) {
    console.warn("[telegram] Send error: %s", err.message);
    return false;
  }
}

/**
 * Build a position label like "#158518 (WPLS/eHEX)".
 * @param {object} position  Position object with tokenId, token0Symbol, token1Symbol.
 * @returns {string}
 */
function _posLabel(position) {
  const id = position?.tokenId ? `#${position.tokenId}` : "unknown";
  const s0 = position?.token0Symbol || position?.symbol0 || "";
  const s1 = position?.token1Symbol || position?.symbol1 || "";
  const pair = s0 && s1 ? ` (${s0}/${s1})` : "";
  return id + pair;
}

/**
 * Send a notification if the event type is enabled and Telegram is configured.
 * @param {string} eventType  One of the EVENT_DEFAULTS keys.
 * @param {object} details    Event-specific details.
 * @param {object} [details.position]  Position object for labelling.
 * @param {string} [details.message]   Human-readable detail text.
 * @param {string} [details.txHash]    Transaction hash (if applicable).
 * @param {string} [details.error]     Error message (for failure events).
 * @returns {Promise<boolean>} True if sent, false if skipped or failed.
 */
async function notify(eventType, details = {}) {
  if (!isConfigured()) return false;
  if (!_enabledEvents[eventType]) return false;
  const label = EVENT_LABELS[eventType] || eventType;
  const pos = _posLabel(details.position);
  const lines = [`*LP Ranger on ${_hostname}*: ${label}`, `Position: ${pos}`];
  if (details.message) lines.push(details.message);
  if (details.txHash) lines.push(`TX: \`${details.txHash}\``);
  if (details.error) lines.push(`Error: ${details.error}`);
  return _send(lines.join("\n"));
}

/**
 * Send a test message to verify the bot token and chat ID work.
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
async function testConnection() {
  if (!_botToken || !_chatId) {
    return { ok: false, error: "Bot token or chat ID not configured" };
  }
  const ok = await _send(
    `*LP Ranger on ${_hostname}*: Test notification \u2014 connection OK!`,
  );
  return ok ? { ok: true } : { ok: false, error: "Failed to send message" };
}

module.exports = {
  setBotToken,
  setChatId,
  isConfigured,
  getBotToken,
  getChatId,
  setEnabledEvents,
  getEnabledEvents,
  notify,
  testConnection,
  EVENT_DEFAULTS,
  EVENT_LABELS,
  _send,
  _posLabel,
};
