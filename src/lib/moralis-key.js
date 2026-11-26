/**
 * @file src/lib/moralis-key.js
 * @description The stored Moralis api key: whether it is used, and
 * whether Moralis takes it. The server checks the key when it is saved
 * or unlocked and answers the key dialog's status question with it
 * (src/server/moralis-key-status.js); util/bookkeeping checks it before a
 * report prices through it.
 */

"use strict";

const { log } = require("./log");
const config = require("./config");
const { getApiKey } = require("./api-key-holder");
const { MORALIS_API } = require("./price-service-urls");
const { readBotConfigDefaults } = require("./bot-config-defaults");

/**
 * Whether the stored Moralis key is used: the operator's saved choice,
 * else the install's default.
 *
 * The choice is saved in bot-config.json's `global` section by the key
 * dialog's switch, and a `null` save clears it. With none saved, the
 * default in bot-config-defaults.json decides, the operator's copy of
 * that file on top. The server applies the answer when the wallet is
 * unlocked, and the bot on every save of the switch
 * (src/bot/settings-save.js); `GET /api/status` publishes it, so the
 * switch shows what is applied.
 *
 * @param {object|undefined} globalCfg  bot-config.json's `global`.
 * @returns {boolean}
 */
function moralisEnabledIn(globalCfg) {
  const saved = globalCfg?.moralisEnabled;
  return typeof saved === "boolean"
    ? saved
    : readBotConfigDefaults().moralisEnabled;
}

/**
 * The request that checks a Moralis key on a chain: the price of the
 * chain's wrapped native token, both named in its chains.json entry, so
 * the probe asks something Moralis answers for that chain.
 * @param {object} chain  A chains.json entry.
 * @returns {string|null} The url, or null for a chain with no Moralis id
 *   or no wrapped native token, which leaves nothing to probe with.
 */
function moralisProbeUrl(chain) {
  const moralisChain = chain.priceServices.moralisChain;
  const token = chain.nativeWrappedToken;
  if (moralisChain === "" || token === "") return null;
  return `${MORALIS_API}/erc20/${token}/price?chain=${moralisChain}`;
}

/**
 * Ping Moralis with the in-memory key; return "valid" | "invalid" | "quota",
 * or null with no key. On a chain Moralis is not asked about — no Moralis
 * id, or no wrapped native token to price — it answers "unsupported"
 * without a request: the key is there, and it is the chain that leaves it
 * unused, which the dashboard must not report as a missing key.
 * Logs the request URL, status, and response body for diagnostics.
 * @returns {Promise<string|null>}
 */
async function pingMoralis() {
  const key = getApiKey("moralis");
  if (!key) return null;
  const url = moralisProbeUrl(config.CHAIN);
  if (url === null) {
    log.info(
      "[moralis] Key not checked: %s has no Moralis id or wrapped native token in chains.json",
      config.CHAIN_NAME,
    );
    return "unsupported";
  }
  log.info("[moralis] Validating key → GET %s", url);
  const r = await fetch(url, {
    headers: { Accept: "application/json", "X-API-Key": key },
  });
  const text = await r.text();
  if (r.ok) {
    log.info("[moralis] Key valid (status %d)", r.status);
    return "valid";
  }
  const isQuota = text.includes("usage") || r.status === 429;
  if (isQuota) {
    log.warn(
      "[moralis] Key valid but QUOTA exceeded (status %d): %s",
      r.status,
      text,
    );
    return "quota";
  }
  log.warn("[moralis] Key INVALID (status %d): %s", r.status, text);
  return "invalid";
}

module.exports = {
  moralisEnabledIn,
  pingMoralis,
  moralisProbeUrl,
};
