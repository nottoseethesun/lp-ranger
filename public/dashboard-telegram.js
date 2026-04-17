/**
 * @file dashboard-telegram.js
 * @description Telegram notification setup dialog.
 * Manages the modal for configuring bot token, chat ID, and event preferences.
 *
 * Depends on: dashboard-helpers.js (g).
 */

import { g, csrfHeaders } from "./dashboard-helpers.js";

/** POST JSON and return parsed response. */
async function _post(url, body) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...csrfHeaders() },
    body: JSON.stringify(body),
  });
  return res.json();
}

const _EVENT_IDS = [
  "oorTimeout",
  "rebalanceSuccess",
  "rebalanceFail",
  "compoundSuccess",
  "compoundFail",
  "otherError",
  "lowGasBalance",
  "shutdown",
];

/** Track whether the wallet modal was open when we launched. */
let _walletWasOpen = false;

/** Show the Telegram setup modal and load current config from server. */
export async function openTelegramModal() {
  const modal = g("telegramModal");
  if (!modal) return;
  // If the wallet setup modal is open, hide it so we appear on top
  const wm = g("walletModal");
  _walletWasOpen = wm && !wm.classList.contains("hidden");
  if (_walletWasOpen) wm.classList.add("hidden");
  modal.classList.remove("hidden");
  _setStatus("");
  _updateTestBtn(false);
  try {
    const res = await fetch("/api/telegram/config");
    const data = await res.json();
    if (data.enabledEvents) {
      for (const id of _EVENT_IDS) {
        const el = g("tgEvt_" + id);
        if (el) el.checked = !!data.enabledEvents[id];
      }
    }
    const tokenEl = g("tgBotToken");
    const chatEl = g("tgChatId");
    if (tokenEl)
      tokenEl.placeholder = data.hasToken
        ? "(saved)"
        : "123456789:ABCdefGhI...";
    if (chatEl) chatEl.placeholder = data.hasChatId ? "(saved)" : "123456789";
    _updateTestBtn(data.configured);
  } catch {
    _setStatus("Could not load config");
  }
}

/** Close the Telegram setup modal. */
export function closeTelegramModal() {
  const modal = g("telegramModal");
  if (modal) modal.classList.add("hidden");
  // Restore the wallet modal if we hid it on open
  if (_walletWasOpen) {
    const wm = g("walletModal");
    if (wm) wm.classList.remove("hidden");
    _walletWasOpen = false;
  }
}

/** Read the event checkboxes and return an enabledEvents map. */
function _readEvents() {
  const events = {};
  for (const id of _EVENT_IDS) {
    const el = g("tgEvt_" + id);
    events[id] = el ? el.checked : false;
  }
  return events;
}

/** Set the status message in the modal. */
function _setStatus(msg, isError) {
  const el = g("tgStatus");
  if (!el) return;
  el.textContent = msg;
  el.className =
    "9mm-pos-mgr-mt-sm" +
    (isError ? " 9mm-pos-mgr-text-err" : " 9mm-pos-mgr-text-ok");
}

/** Enable or disable the Test button. */
function _updateTestBtn(enabled) {
  const btn = g("tgTestBtn");
  if (btn) btn.disabled = !enabled;
}

/** Save Telegram config to the server. */
async function _save() {
  const tokenEl = g("tgBotToken");
  const chatEl = g("tgChatId");
  const body = { enabledEvents: _readEvents() };
  if (tokenEl?.value.trim()) body.botToken = tokenEl.value.trim();
  if (chatEl?.value.trim()) body.chatId = chatEl.value.trim();
  _setStatus("Saving...");
  try {
    const res = await _post("/api/telegram/config", body);
    if (res.ok) {
      _setStatus("Saved");
      if (tokenEl) tokenEl.value = "";
      if (chatEl) chatEl.value = "";
      if (tokenEl && body.botToken) tokenEl.placeholder = "(saved)";
      if (chatEl && body.chatId) chatEl.placeholder = "(saved)";
      _updateTestBtn(true);
    } else {
      _setStatus(res.error || "Save failed", true);
    }
  } catch (err) {
    _setStatus(err.message, true);
  }
}

/** Send a test notification. */
async function _test() {
  _setStatus("Sending test...");
  try {
    const res = await _post("/api/telegram/test", {});
    _setStatus(res.ok ? "Test sent!" : res.error || "Test failed", !res.ok);
  } catch (err) {
    _setStatus(err.message, true);
  }
}

/** Wire up all Telegram-related event listeners. */
export function initTelegram() {
  const saveBtn = g("tgSaveBtn");
  const testBtn = g("tgTestBtn");
  const closeBtn = g("tgCloseBtn");
  if (saveBtn) saveBtn.addEventListener("click", _save);
  if (testBtn) testBtn.addEventListener("click", _test);
  if (closeBtn) closeBtn.addEventListener("click", closeTelegramModal);

  const settingsBtn = g("telegramSettingsBtn");
  if (settingsBtn) settingsBtn.addEventListener("click", openTelegramModal);

  for (const btn of document.querySelectorAll(".setupTelegramBtn")) {
    btn.addEventListener("click", openTelegramModal);
  }

  const modal = g("telegramModal");
  if (modal) {
    modal.addEventListener("click", (e) => {
      if (e.target === modal) closeTelegramModal();
    });
  }
}
