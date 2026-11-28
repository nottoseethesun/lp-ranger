"use strict";

/**
 * @file scripts/_delete-all-flag.js
 * @description The flag `npm run build-and-start` takes to delete all of
 *   LP Ranger's caches and logs before it builds, and the exit status its
 *   deletion step (scripts/delete-all-caches-and-logs.js) gives when the
 *   operator's answer was not YES, on which build-and-start stops with no
 *   error. Dependency-free, so build-and-start loads nothing that reads
 *   `.env`: the server it starts would take `.env`'s values for ones the
 *   shell set (src/lib/env-settings.js `setBeforeEnvFile`). The leading
 *   underscore marks a helper, not a command.
 */

/** The flag. */
const DELETE_ALL_FLAG = "--delete-all-caches-and-logs";

/** The deletion step's exit status for an answer that was not YES. */
const DECLINED_EXIT = 3;

module.exports = { DELETE_ALL_FLAG, DECLINED_EXIT };
