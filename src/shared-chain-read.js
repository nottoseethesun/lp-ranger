"use strict";

/**
 * @file src/shared-chain-read.js
 * @module shared-chain-read
 * @description
 * Whether a scan pass prepares one chain read for its steps to share,
 * and the read itself when it does.
 *
 * A scan pass (`_scanAndReconstruct`, src/bot-recorder.js) runs the event
 * scan, then epoch reconstruction, the lifetime scan and, last, the
 * Activity Log figures of the Rebalance events still waiting for them.
 * The last three can each need the NFT events of the position's whole
 * chain: the lifetime scan when it has figures to work out, epoch
 * reconstruction when it has closed NFTs' histories to build, and a
 * waiting Rebalance event that has no wallet readings of its own, which
 * finds its drain there. Reading for each would read the chain more than
 * once, and on a long chain one read takes minutes.
 *
 * So once the event scan has found the chain, the pass prepares the
 * lifetime scan's read (`prepareLifetimeRead`,
 * src/bot-recorder-lifetime.js) when the lifetime scan or a waiting
 * Rebalance event will need it, and the other steps take their events
 * from it. Preparing starts nothing: the read runs when a step first asks
 * for it, and every later step shares its answer.
 */

const { log } = require("./log");
const {
  lifetimeScanPlan,
  prepareLifetimeRead,
  scanLogCtx,
} = require("./bot-recorder-lifetime");
const { figuresNeedNftEvents } = require("./rebalance-activity-figures");

/**
 * The pass's shared chain read, or null when no step will need it and
 * epoch reconstruction must read for itself.
 *
 * The lifetime scan's plan does not decide alone. A stop during an
 * earlier pass's last step can leave a Rebalance event waiting for its
 * figures after every Lifetime figure was saved, and with no read
 * prepared it would wait until a rebalance, Re-scan Prices or Reload
 * Current Position made a pass read the chain (`figuresNeedNftEvents`).
 * A read prepared for the figures alone leaves the lifetime scan's resume
 * buffer untouched, since the plan it asks when it starts finds no
 * lifetime figures to work out (`prepareLifetimeRead`).
 *
 * Runs inside the event scan's callback, whose other steps are all kept
 * from breaking the event scan; this one is too. A failure here costs the
 * sharing, not the scan: each step then reads separately.
 *
 * @param {object} position  Live position.
 * @param {object} botState  Live per-position bot state.
 * @param {Array} evts  The chain the event scan just found.
 * @param {object|null} epochKey  The pool's epoch-cache key.
 * @returns {object|null}  A prepared read (src/bot-recorder-lifetime-read.js).
 */
function prepareSharedRead(position, botState, evts, epochKey) {
  if (botState === undefined || botState === null) return null;
  try {
    const plan = lifetimeScanPlan(botState, epochKey, position, evts);
    if (!plan.needed && !figuresNeedNftEvents(evts)) return null;
    return prepareLifetimeRead(position, botState, evts, epochKey);
  } catch (err) {
    const ctx = scanLogCtx(position);
    log.warn(
      "[bot] %s/%s NFT #%s %s: Could not prepare the shared chain read, so epoch reconstruction reads on its own: %s",
      ctx.t0Sym,
      ctx.t1Sym,
      ctx.tokenIdStr,
      ctx.tokenEmoji,
      err.message,
    );
    return null;
  }
}

/**
 * Epoch reconstruction's view of the shared read: its per-NFT events, or
 * nothing when the pass prepared no read.
 *
 * @param {object|null} sharedRead  From `prepareSharedRead`.
 * @returns {(() => Promise<Map<string, object>>)|undefined}
 */
function epochEventsFrom(sharedRead) {
  if (sharedRead === null) return undefined;
  return sharedRead.read;
}

module.exports = { prepareSharedRead, epochEventsFrom };
