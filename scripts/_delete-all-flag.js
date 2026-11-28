"use strict";

/**
 * @file scripts/_delete-all-flag.js
 * @description The flag `npm run build-and-start` takes to delete all of
 *   LP Ranger's caches and logs before it builds; the argument it gives
 *   its deletion step (scripts/delete-all-caches-and-logs.js), saying the
 *   server starts after it; and the exit status that step gives build-and-
 *   start when the operator's answer was not YES, on which build-and-start
 *   stops with no error. Run on its own, as
 *   `npm run delete-all-caches-and-logs`, the step gets no argument and
 *   starts nothing after (the user's ruling, 2026-11-28: the way to clear
 *   the caches and logs when you run the headless bot). Dependency-free,
 *   so build-and-start loads nothing that reads `.env`: the server it
 *   starts would take `.env`'s values for ones the shell set
 *   (src/lib/env-settings.js `setBeforeEnvFile`). The leading underscore
 *   marks a helper, not a command.
 */

/** The flag. */
const DELETE_ALL_FLAG = "--delete-all-caches-and-logs";

/** What build-and-start gives its deletion step: the server starts after. */
const SERVER_STARTS_AFTER = "--server-starts-after";

/** The deletion step's exit status for an answer that was not YES. */
const DECLINED_EXIT = 3;

module.exports = { DELETE_ALL_FLAG, SERVER_STARTS_AFTER, DECLINED_EXIT };
