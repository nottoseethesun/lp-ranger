/**
 * @file dashboard-manual-figures.js
 * @description The User Manual's figures, as this install runs.
 *
 *   The manual's build writes the shipped figures into each
 *   `<span data-figure="name">`, and those are what the copy GitHub
 *   Pages publishes shows. The copy this app serves runs this module,
 *   which asks the server for the install's own figures
 *   (`GET /api/help-figures`: the shipped settings, with the operator's
 *   overrides and `.env` on top) and writes each into its span, so the
 *   manual states the figures in force. If the server does not answer,
 *   the shipped figures stay, and the console says why.
 *
 *   The build bundles it on its own (`scripts/build-bundles.js`) into
 *   `src/client/web/dist/manual-figures.js`, which the manual loads with the
 *   build's stamp, as every page loads its scripts. The Pages build
 *   removes the tag that loads it, since a static copy has no server to
 *   ask.
 */

import { writeFigures } from "./dashboard-figure-elements.js";

/**
 * Ask for the install's figures and write them into the manual.
 * @param {Function} [fetchFn]  The fetch to ask with; the browser's own
 *   unless a test passes a scripted one.
 * @returns {Promise<void>}
 */
export async function fillManualFigures(fetchFn = fetch) {
  let figures;
  try {
    const res = await fetchFn("/api/help-figures");
    if (!res.ok) throw new Error(`the server answered HTTP ${res.status}`);
    ({ figures } = await res.json());
  } catch (err) {
    console.warn(
      "[lp-ranger] [manual] could not fetch this install's figures (%s); " +
        "the manual shows the shipped ones",
      err.message,
    );
    return;
  }
  writeFigures([document], figures, (name) =>
    console.warn(
      "[lp-ranger] [manual] the manual names a figure that does not exist: %s",
      name,
    ),
  );
}

fillManualFigures();
