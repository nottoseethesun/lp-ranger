/**
 * @file dashboard-help-figures.js
 * @description The configured numbers the dashboard's help quotes, and
 *   the one place they are written into the page.
 *
 *   The server works the table out (`GET /api/help-figures`, built by
 *   `src/resolved-settings.js` through `src/help-figures.js`) from the
 *   values this install runs on: the shipped settings, the operator's
 *   overrides on top, and `.env` on top of both. So a help dialog states
 *   the figure in force rather than the shipped one. The answer also
 *   carries the Bot Settings defaults those figures came from, for the
 *   dashboard's own displays of the same rules, such as the Doubling
 *   Trigger Window.
 *
 *   `loadHelpFigures` asks at startup, asking again until the server
 *   answers (`dashboard-ask-server.js`, as the chain is asked for), and
 *   keeps the answer. Static help in `index.html` holds an
 *   empty `<span data-figure="name">` for each figure it quotes, and the
 *   answer's figures are written into them once it arrives. Until then
 *   those spans stay empty, the dialogs have no figures to show, and
 *   `helpFigures` and `resolvedBotDefaults` return null.
 */

import { log } from "./dashboard-log.js";
import { writeFigures } from "./dashboard-figure-elements.js";
import { askUntilAnswered } from "./dashboard-ask-server.js";
/*-
 *  How long a startup question to the server may take, and the least
 *  time between two: the limit the chain's question uses too, built
 *  into the page because it is needed before the server has answered.
 */
import SERVER_DOWN from "../app-config/app-defaults-for-user-configurable/ui-defaults_non-layout_for-server-down-scenario.json" with { type: "json" };

// The server's answer, `{ figures, botDefaults }`; null until it lands.
let _answer = null;

/**
 * Every figure the help quotes, worded for a sentence.
 * @returns {Readonly<Record<string, string>>|null} Null until the server
 *   has answered.
 */
export function helpFigures() {
  return _answer === null ? null : _answer.figures;
}

/**
 * The Bot Settings defaults in force, those the figures were worked out
 * from.
 * @returns {object|null} Null until the server has answered.
 */
export function resolvedBotDefaults() {
  return _answer === null ? null : _answer.botDefaults;
}

/**
 * Write each figure the page's markup names into its span, in the page
 * and in its templates. A span naming no figure is left empty and
 * reported, rather than stopping startup over a line of help.
 * @param {Record<string, string>} figures
 */
function _fillPageFigures(figures) {
  /*-
   *  A template's content is a fragment of its own, which a search of
   *  the document does not enter, so each one is searched as well.
   *  Filled once here, every copy cloned from it later carries the
   *  figures.
   */
  const templates = [...document.querySelectorAll("template")];
  writeFigures([document, ...templates.map((t) => t.content)], figures, (n) =>
    log.warn(
      "[lp-ranger] [help] the page names a figure that does not exist: %s",
      n,
    ),
  );
}

/** Why an answer to `GET /api/help-figures` is not one, or null when it is. */
function _holdsNoFigures(body) {
  const figures = body?.figures;
  return figures !== undefined &&
    figures !== null &&
    typeof figures === "object"
    ? null
    : "its answer held no figures";
}

/**
 * Learn the help's figures from the server, asking until it answers,
 * then write them into the page. Started at startup and not waited for:
 * the dashboard works without them, and only the help waits.
 *
 * @param {object} opts
 * @param {Function} opts.onUnanswered  Called once for each request that
 *   ends without the figures; startup hands in the status poll's own
 *   counter, as it does for the chain.
 * @param {Function} opts.onAnswered    Called once, when one brings them.
 * @param {Function} [opts.fetchFn]   The fetch to ask with; the
 *   browser's own unless a test passes a scripted one.
 * @param {number} [opts.askEveryMs]  How long each request has to
 *   answer, and the least time between two.
 * @param {Function} [opts.warnFn]    Where an unanswered request is
 *   logged; the browser console unless a test passes its own.
 * @returns {Promise<void>} Settles once the figures are in.
 */
export async function loadHelpFigures({
  onUnanswered,
  onAnswered,
  fetchFn = fetch,
  askEveryMs = SERVER_DOWN.chainQueryTimeoutMs,
  warnFn = log.warn,
}) {
  _answer = await askUntilAnswered({
    url: "/api/help-figures",
    refusal: _holdsNoFigures,
    logTag: "[lp-ranger] [help]",
    asked: "asked the server for the help's figures",
    onUnanswered,
    onAnswered,
    fetchFn,
    askEveryMs,
    warnFn,
  });
  _fillPageFigures(_answer.figures);
}
