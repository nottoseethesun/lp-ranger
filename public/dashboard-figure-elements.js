/**
 * @file dashboard-figure-elements.js
 * @description Writes the help's figures into the page elements that
 *   name them. Shared by the dashboard (`dashboard-help-figures.js`) and
 *   the User Manual (`dashboard-manual-figures.js`). The manual loads it
 *   straight from the server rather than through the dashboard's bundle,
 *   so it imports nothing.
 */

/**
 * Write each figure into every element under `roots` whose
 * `data-figure` names it. An element naming a figure the table lacks is
 * left as it is and reported, rather than stopping a page over a line of
 * help.
 * @param {Array<Document|DocumentFragment>} roots  Where to look.
 * @param {Record<string, string>} figures  Figure name to its wording.
 * @param {(name: string) => void} onUnknown  Told each name the table
 *   lacks.
 */
export function writeFigures(roots, figures, onUnknown) {
  for (const root of roots)
    for (const el of root.querySelectorAll("[data-figure]")) {
      const name = el.dataset.figure;
      if (Object.hasOwn(figures, name)) el.textContent = figures[name];
      else onUnknown(name);
    }
}
