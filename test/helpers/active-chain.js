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
 * Teach the dashboard its chain through the real `loadActiveChain`. The
 * scripted server answers at once, so nothing goes unanswered for the
 * HALTED count, and neither count is what these tests are about.
 * @param {string} [chainId]  The chain the scripted server names.
 * @param {string} [displayName]  Its name as people read it, which the
 *   labels show; left out, the answer names none.
 * @returns {Promise<string>} The chain the dashboard now holds.
 */
async function learnActiveChain(chainId = "pulsechain", displayName) {
  const { loadActiveChain } = await import("../../public/dashboard-chain.js");
  const answer =
    displayName === undefined ? { chainId } : { chainId, displayName };
  return loadActiveChain({
    fetchFn: async () => ({ ok: true, json: async () => answer }),
    onUnanswered: () => {},
    onAnswered: () => {},
  });
}

module.exports = { learnActiveChain };
