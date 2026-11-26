"use strict";

/**
 * @file scripts/_kept-folders.js
 * @description What `npm run check` records of the install's folders
 *   once the tests are done: the Folders kept stage's exit code, and the
 *   report scripts/check-report.js shows as its row (kept-folders.json).
 *   The stage passes only when the folders were compared and nothing
 *   changed; folders that could not be compared fail it, the report
 *   naming the error. Its own module because scripts/check.js runs the
 *   whole gate as it loads, so a test can load only this.
 *   The leading underscore marks this as a non-user-facing helper.
 */

/**
 * The Folders kept stage's exit code and report.
 * @param {string[]|null} changes  Each change the tests made to the
 *   install's folders; null when they could not be compared.
 * @param {string|null} error  Why they could not be compared; null once
 *   they were.
 * @returns {{exit: number, report: {changes: (string[]|null),
 *   error: (string|null)}}}  Exit 0 only for folders compared and
 *   unchanged.
 */
function keptFoldersOutcome(changes, error) {
  const kept = changes !== null && changes.length === 0 && error === null;
  return { exit: kept ? 0 : 1, report: { changes, error } };
}

module.exports = { keptFoldersOutcome };
