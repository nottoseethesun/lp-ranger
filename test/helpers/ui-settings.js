"use strict";

/**
 * @file test/helpers/ui-settings.js
 * @description Has the dashboard learn its settings the way startup does:
 *   `loadUiSettings` asks `GET /api/ui-defaults`, here with the server's
 *   answer scripted as the shipped
 *   ui-defaults_non-layout_for-server-up-scenario.json, plus whatever a
 *   test sets on top. Dashboard code reads these settings and holds none
 *   until they are learned, so a test that drives such code calls this
 *   first, as startup does.
 */

const { loadShippedDefaults } = require("../../src/load-merged-defaults");

/**
 * Teach the dashboard its settings through the real `loadUiSettings`.
 * @param {object} [overrides]  Settings to answer with in place of the
 *   shipped ones, for a test of a configured value.
 * @returns {Promise<Readonly<object>>} The settings the dashboard holds.
 */
async function learnUiSettings(overrides = {}) {
  const { loadUiSettings } =
    await import("../../public/dashboard-ui-settings.js");
  const body = {
    ...loadShippedDefaults(
      "ui-defaults_non-layout_for-server-up-scenario.json",
    ),
    ...overrides,
  };
  return loadUiSettings({
    fetchFn: async () => ({ ok: true, json: async () => body }),
    onUnanswered: () => {},
    onAnswered: () => {},
  });
}

module.exports = { learnUiSettings };
