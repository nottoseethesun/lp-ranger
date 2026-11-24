/**
 * @file src/bot/bot-banner.js
 * @description Bot-subsystem startup banner. Side-effect-on-require: simply
 *   `require("./bot-banner")` to print the banner. Module caching guarantees
 *   it fires exactly once per process, no matter how many bot modules pull
 *   it in.
 *
 *   Why side-effect-on-require (not an exported function): the bot announces
 *   itself when bot code loads. Neither program should have to call a
 *   "start bot" function: the server loads the bot's modules anyway, when
 *   it loads the bot's interface (bot-recorder.js requires this file), and
 *   the headless bot requires it right after its settings check, ahead of
 *   every bot module but its help text, so the banner falls out of that
 *   naturally.
 *
 *   Style: light gray on very dark gray, rocket emoji before/after "Started."
 *   ANSI: 38;2;211;211;211 = lt-gray fg, 48;2;25;25;25 = very dark gray bg.
 */

"use strict";

const { log } = require("../lib/log");

log.info(
  "\x1b[38;2;211;211;211;48;2;25;25;25m[lp-ranger bot] \uD83D\uDE80 Started. \uD83D\uDE80\x1b[0m",
);
