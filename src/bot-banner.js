/**
 * @file src/bot-banner.js
 * @description Bot-subsystem startup banner. Side-effect-on-require: simply
 *   `require("./bot-banner")` to print the banner. Module caching guarantees
 *   it fires exactly once per process, no matter how many bot modules pull
 *   it in.
 *
 *   Why side-effect-on-require (not an exported function): the bot announces
 *   itself when bot code loads. Server-side callers should not have to call
 *   a "start bot" function — server.js loads bot machinery for unmanaged
 *   data fetches anyway, and the banner falls out of that naturally.
 *
 *   Style: light gray on very dark gray, rocket emoji before/after "Started."
 *   ANSI: 38;2;211;211;211 = lt-gray fg, 48;2;25;25;25 = very dark gray bg.
 */

"use strict";

const { log } = require("./log");

log.info(
  "\x1b[38;2;211;211;211;48;2;25;25;25m[lp-ranger bot] \uD83D\uDE80 Started. \uD83D\uDE80\x1b[0m",
);
