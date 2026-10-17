"use strict";

/**
 * @file test/helpers/active-chain.js
 * @description Has the dashboard learn its chain the way startup does:
 *   `loadActiveChain` asks `GET /api/chain`, here with the server's
 *   answer scripted. Dashboard code builds every position key and url
 *   from that chain and holds none until it is learned, so a test that
 *   drives such code calls this first, as startup does.
 */

/**
 * Teach the dashboard its chain through the real `loadActiveChain`.
 * @param {string} [chainId]  The chain the scripted server names.
 * @returns {Promise<string>} The chain the dashboard now holds.
 */
async function learnActiveChain(chainId = "pulsechain") {
  const { loadActiveChain } = await import("../../public/dashboard-chain.js");
  return loadActiveChain({
    fetchFn: async () => ({ ok: true, json: async () => ({ chainId }) }),
  });
}

module.exports = { learnActiveChain };
