"use strict";

/**
 * @file src/centered-offset.js
 * @module centered-offset
 * @description
 * The Position Offset that splits a range evenly about the current price,
 * half above and half below. Not a default: it is the middle of the
 * offset's 0 to 100 scale, so it is what "centred" means, whatever an
 * operator sets `offsetToken0Pct` to.
 *
 * Three places mean centred by it. A rebalance that re-uses a position's
 * range pins the offset here (`src/bot-cycle-opts.js`), and only a centred
 * range is held to contain the current tick (`src/range-math.js`). The
 * dashboard's No Offset button fills both fields with it
 * (`public/dashboard-throttle.js`), and the help quotes it.
 *
 * **Deliberately dependency-free**, as `src/pool-key.js` and
 * `src/range-check.js` are: the dashboard bundle reaches it, and
 * `src/range-math.js`, which held it before, loads the Uniswap SDK.
 *
 * Add no `require` to this file.
 */

const CENTERED_OFFSET_PCT = 50;

module.exports = { CENTERED_OFFSET_PCT };
