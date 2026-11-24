/**
 * @file src/lib/bigint-json.js
 * @description How a BigInt is written into JSON, which has none: as its
 * decimal text, every digit kept. The bot writes its rebalance log this
 * way (src/bot/bot-recorder.js), and the server every answer it sends
 * (src/server.js), since a position's bot state, which the status answer
 * sends whole, keeps some, such as the wallet's readings the deposit
 * count compares.
 */

"use strict";

/**
 * JSON-safe replacer that converts BigInt to string.
 * @param {string} _key
 * @param {*} value
 * @returns {*}
 */
function bigIntReplacer(_key, value) {
  return typeof value === "bigint" ? value.toString() : value;
}

module.exports = { bigIntReplacer };
