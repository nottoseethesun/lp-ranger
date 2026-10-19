"use strict";

/**
 * @file src/pool-already-managed.js
 * @module pool-already-managed
 * @description
 * Keeps LP Ranger to **one active position per pool**, a rule the README
 * and the User Manual both state. The reason is attribution: the app
 * traces each position's profit and loss across its whole life, through
 * every rebalance. Two positions open in the same pool hold the same
 * tokens, in the same pool, in the same wallet — indistinguishable
 * on-chain — so gains moving between them cannot be assigned to either.
 * Residual coins have the same problem: with one position they clearly
 * belong to it, with two any split is a guess. Rather than report a
 * number that looks precise but was guessed, the app declines the second
 * position.
 *
 * Three places apply the rule. A Manage is refused when another position
 * already manages the pool, and a re-open of a closed position when the
 * wallet holds an open one in its pool (`rejectIfPoolManaged`). At
 * start-up, each pool keeps one of the positions saved as managed, and
 * the rest come off the list (`poolHoldersForStartUp`).
 *
 * Each position's pool is read from the chain, through the position
 * manager's own interface (src/pm-abi.js), whose outputs carry the names
 * read below. A position whose pool cannot be read is not started: no
 * check can show that pool free of another position. The rest is
 * injectable end to end: callers supply the bot-state map and the
 * canonical pool-key builder, so no decision here reads global state and
 * the comparison rule stays owned by `position-manager.js`. Only its logs
 * read more: a refusal names the pool's coins from the symbol cache.
 */

const { PM_ABI } = require("./pm-abi");
const { log } = require("./log");
const { emojiId, abbrAddr, logCtx } = require("./logger");
const { getTokenSymbol } = require("./token-symbol-cache");

/**
 * Reduce a pool identity to the app's canonical pool key, or null.
 *
 * Delegates the normalisation to the injected `poolKeyFn`. The caller
 * binds `poolKey` from `src/pool-key.js`, which owns it: lower-casing
 * the addresses, sorting the pair so token order cannot matter, and
 * qualifying by chain, contract and wallet. Defining a second rule here
 * would give the app two notions of "the same pool" that could drift
 * apart silently, and this gate would then disagree with the pool keys
 * the status payload and the daily-cap counters already use.
 *
 * Guards completeness first: a partial identity returns null rather
 * than a key, so two partial identities never compare equal.
 *
 * @param {{token0?: string, token1?: string, fee?: number|string}} pool
 * @param {(t0: string, t1: string, fee: *) => string} poolKeyFn
 *   Canonical key builder, bound to chain/contract/wallet by the caller.
 * @returns {string|null}
 */
function poolKeyOf(pool, poolKeyFn) {
  if (pool === null || pool === undefined) return null;
  if (typeof poolKeyFn !== "function") return null;
  const { token0, token1, fee } = pool;
  if (typeof token0 !== "string" || typeof token1 !== "string") return null;
  if (fee === null || fee === undefined || fee === "") return null;
  return poolKeyFn(token0, token1, fee);
}

/*- Scan the RUNNING bot states for one already holding `wanted`.
 *  Split out of `findPoolConflict` to keep it under the complexity
 *  cap; it carries no policy of its own. */
function _runningHolder(botStates, selfKey, poolKeyFn, wanted) {
  const entries =
    botStates instanceof Map
      ? botStates.entries()
      : Object.entries(botStates ?? {});
  for (const [key, state] of entries) {
    if (selfKey !== undefined && selfKey !== null && key === selfKey) continue;
    if (state === null || state === undefined) continue;
    /*- Only a position the bot is actually running holds a pool. A
     *  stopped one keeps its config for history and must not block a
     *  different position in the same pool from being started. */
    if (state.running !== true) continue;
    const ap = state.activePosition;
    if (ap === null || ap === undefined) continue;
    if (poolKeyOf(ap, poolKeyFn) !== wanted) continue;
    return { key, tokenId: String(ap.tokenId ?? key.split("-").pop()) };
  }
  return null;
}

/**
 * Find a position that already holds the given pool.
 *
 * Two kinds count. A RUNNING position holds its pool outright. So does
 * one that is still STARTING: its Manage request was allowed and the
 * loop is coming up, but `state.running` is not set until it is, and
 * that window is seconds of RPC work — long enough for a second
 * request in the same pool to arrive and find nothing.
 *
 * @param {object} opts
 * @param {object} opts.pool  Pool identity of the position being started.
 * @param {Map<string, object>|object} opts.botStates  Per-position bot
 *   states, keyed by composite key — `getAllPositionBotStates()`.
 * @param {string} [opts.selfKey]  Composite key of the position being
 *   started, excluded from the comparison. Required for correctness on
 *   the rebalance path: a rebalance mints a new tokenId and migrates the
 *   key within the same pool, so without this the position would be
 *   rejected against itself.
 * @param {(t0: string, t1: string, fee: *) => string} opts.poolKeyFn
 *   Canonical key builder, bound to chain/contract/wallet by the caller.
 * @param {Map<string, string|null>} [opts.startingPools]  Composite key
 *   -> pool key for requests that passed the gate but have not finished
 *   starting.
 * @returns {{key: string, tokenId: string}|null}  The conflicting
 *   position, or null when the pool is free.
 */
function findPoolConflict({
  pool,
  botStates,
  selfKey,
  poolKeyFn,
  startingPools,
}) {
  const wanted = poolKeyOf(pool, poolKeyFn);
  if (wanted === null) return null;
  const running = _runningHolder(botStates, selfKey, poolKeyFn, wanted);
  if (running !== null) return running;
  /*- Then the in-flight starts. These hold their pool just as firmly:
   *  the request was allowed and the loop is coming up. */
  if (startingPools !== undefined && startingPools !== null) {
    for (const [key, pk] of startingPools.entries()) {
      if (key === selfKey || pk !== wanted) continue;
      return { key, tokenId: String(key.split("-").pop()) };
    }
  }
  return null;
}

/**
 * Read a position's pool identity, and whether it is open, from chain.
 *
 * The Manage request carries only a tokenId, and a position's config
 * slot does not record its pool, so the identity has to be resolved
 * before the gate can compare it. Read on-chain rather than accepting a
 * client-supplied pool: this decision governs whether a second bot loop
 * starts trading a pool, and a caller that can name any pool it likes
 * could route around the rule. The same answer carries the position's
 * liquidity, zero once it is closed.
 *
 * Returns null rather than throwing when the read fails, and each caller
 * then declines to start the position. Every caller passes the managed
 * read provider, which carries a read to the next endpoint while the
 * endpoint is what failed, so a null is mostly the contract's own
 * refusal, such as the revert for an NFT that does not exist.
 *
 * @param {object} opts
 * @param {object} opts.provider    ethers provider.
 * @param {object} opts.ethersLib   Injected ethers (testability).
 * @param {string} opts.positionManager  NFT contract address.
 * @param {string|number} opts.tokenId
 * @returns {Promise<{token0: string, token1: string, fee: number,
 *   liquidity: bigint}|null>}
 */
async function readPoolOfPosition({
  provider,
  ethersLib,
  positionManager,
  tokenId,
}) {
  try {
    const pm = new ethersLib.Contract(positionManager, PM_ABI, provider);
    const d = await pm.positions(BigInt(tokenId));
    return {
      token0: d.token0,
      token1: d.token1,
      fee: Number(d.fee),
      liquidity: d.liquidity,
    };
  } catch (err) {
    // Logged here, since the callers see only the null.
    const id = String(tokenId);
    const emoji = emojiId(id);
    log.warn(
      "[pool-rule] Could not read the pool of NFT #%s %s from the chain: %s",
      id,
      emoji,
      err.message,
    );
    return null;
  }
}

/**
 * The position a refusal is about, as a log line names it: the chain,
 * the wallet, the position manager, the NFT and its emoji (src/logger.js),
 * then, once its pool is known, the pool's coins and fee. A coin the
 * symbol cache has not met yet shows by its address.
 * @param {object} o  As for `rejectIfPoolManaged`.
 * @param {object|null} pool  The position's pool, or null when it could
 *   not be read.
 * @returns {string}
 */
function _positionInLog(o, pool) {
  const id = String(o.tokenId);
  if (pool === null) {
    const emoji = emojiId(id);
    const wallet = abbrAddr(o.wallet);
    const manager = abbrAddr(o.positionManager);
    return `${o.chain} ${wallet} ${manager} #${id} ${emoji}`;
  }
  const symbol0 = getTokenSymbol(pool.token0) ?? abbrAddr(pool.token0);
  const symbol1 = getTokenSymbol(pool.token1) ?? abbrAddr(pool.token1);
  const context = logCtx({
    chain: o.chain,
    wallet: o.wallet,
    factory: o.positionManager,
    tokenId: id,
    symbol0,
    symbol1,
  });
  const feePct = (pool.fee / 10000).toFixed(2);
  return `${context} ${feePct}%`;
}

/**
 * Answer a refused Manage, and log it in two lines: what was refused and
 * why, then what the operator can do.
 * @param {object} o  As for `rejectIfPoolManaged`.
 * @param {object|null} pool  The position's pool, or null when it could
 *   not be read.
 * @param {object} r
 * @param {number} r.status   The answer's HTTP status.
 * @param {object} r.answer   The answer's own fields: `error` and what
 *   goes with it.
 * @param {string} r.why      Why the Manage was refused.
 * @param {string} r.remedy   What the operator can do.
 * @returns {true}  So the caller can return it: the request was refused.
 */
function _refuse(o, pool, r) {
  const position = _positionInLog(o, pool);
  o.log("[pos-route] Manage refused: %s: %s", position, r.why);
  o.log("[pos-route] %s", r.remedy);
  o.jsonResponse(o.res, r.status, {
    ok: false,
    ...r.answer,
    // The position refused, as src/position-answer-tag.js names one.
    positionKey: o.key,
  });
  return true;
}

/**
 * Gate a Manage request on the one-position-per-pool rule.
 *
 * Resolves the incoming position's pool, compares it against the
 * running positions, and — when the pool is taken — sends the refusal
 * itself. Returns whether it handled the request, so the caller is one
 * statement and one branch:
 *
 *     if (await rejectIfPoolManaged({ … })) return;
 *
 * The refusal carries a specific code and names the position holding
 * the pool, rather than a generic 400. An operator who has just been
 * refused needs to know which position to stop if taking the pool over
 * was the intent.
 *
 * A closed position's Manage re-opens it, minting a new position in its
 * pool, so it is also refused when the wallet already holds an open
 * position there, managed or not (`pool-has-open-position`): the
 * re-open would leave two. `openInPool` answers that, and is asked
 * before the managed check, so the check and the claim stay one
 * synchronous step.
 *
 * A position whose pool cannot be read is refused too, with 503 and
 * `pool-info-unavailable`, which the dashboard shows as "click Manage
 * again": nothing can show that pool free.
 *
 * Each refusal is logged in two lines, what was refused and why, then
 * what the operator can do; the page puts the same in its own words
 * (public/dashboard-manage-refusal.js).
 *
 * @param {object} o
 * @param {object} o.res                 HTTP response.
 * @param {Function} o.jsonResponse      Injected responder.
 * @param {Function} o.log               Injected warn logger.
 * @param {string} o.key                 Composite key being started.
 * @param {string} o.tokenId
 * @param {string} o.chain               The chain's key, for the logs.
 * @param {string} o.wallet              The wallet's address, for the logs.
 * @param {string} o.positionManager
 * @param {Map|object} o.botStates
 * @param {object} o.provider
 * @param {object} o.ethersLib
 * @param {Function} o.poolKeyFn  Canonical key builder, bound to
 *   chain/contract/wallet by the caller.
 * @param {Map<string, string|null>} [o.startingPools]  As for
 *   `findPoolConflict`.
 * @param {Function} [o.claimPool]  `(poolKey) => void`: marks the pool
 *   taken by this request, called only when it is not refused.
 * @param {Function} [o.openInPool]  `(pool) => Promise<string|null>`:
 *   the token id of an open position the wallet holds in `pool`, other
 *   than this one, or null (src/open-in-pool.js).
 * @returns {Promise<boolean>}  True when the request was refused.
 */
async function rejectIfPoolManaged(o) {
  const pool = await readPoolOfPosition({
    provider: o.provider,
    ethersLib: o.ethersLib,
    positionManager: o.positionManager,
    tokenId: o.tokenId,
  });
  const id = String(o.tokenId);
  const self = `NFT #${id}`;
  const selfEmoji = emojiId(id);
  if (pool === null)
    return _refuse(o, null, {
      status: 503,
      answer: {
        error: "pool-info-unavailable",
        message:
          `LP Ranger could not read the pool of ${self} from the chain, ` +
          "so it cannot check that no other position is managed in that pool. " +
          "Nothing was started.",
        tokenId: id,
      },
      why:
        "its pool could not be read from the chain (the [pool-rule] line before this names the error), " +
        "so LP Ranger cannot check that no other position is managed in that pool",
      remedy: `Nothing was started for ${self} ${selfEmoji}; click Manage again in a moment`,
    });
  const reopening = pool.liquidity === 0n;
  const openSibling =
    reopening && typeof o.openInPool === "function"
      ? await o.openInPool(pool)
      : null;
  const hit = findPoolConflict({
    pool,
    botStates: o.botStates,
    selfKey: o.key,
    poolKeyFn: o.poolKeyFn,
    startingPools: o.startingPools,
  });
  if (hit !== null) {
    const holderEmoji = emojiId(hit.tokenId);
    const holder = `NFT #${hit.tokenId} ${holderEmoji}`;
    return _refuse(o, pool, {
      status: 409,
      answer: {
        error: "pool-already-managed",
        conflictTokenId: hit.tokenId,
        conflictKey: hit.key,
      },
      why: `${holder} is already managed in this pool, and LP Ranger manages one active position per pool`,
      remedy: `To manage ${self} ${selfEmoji} instead, stop managing ${holder} first`,
    });
  }
  if (openSibling !== null) {
    const openEmoji = emojiId(openSibling);
    const open = `NFT #${openSibling} ${openEmoji}`;
    return _refuse(o, pool, {
      status: 409,
      answer: { error: "pool-has-open-position", openTokenId: openSibling },
      why:
        `${self} is closed, so managing it would re-open it as a second open position in this pool, ` +
        `where the wallet already holds open position ${open}; LP Ranger manages one active position per pool`,
      remedy:
        `Manage ${open} instead, or close it first ` +
        "(the last wallet scan saw it open, and the chain did not answer otherwise)",
    });
  }
  /*-
   *  Claim before returning, in the same synchronous step as the check.
   *  Every await comes before the check, so nothing else can interleave
   *  between deciding the pool is free and marking it taken, which is
   *  what makes two concurrent requests for the same pool resolve to one
   *  winner rather than two.
   */
  if (typeof o.claimPool === "function") {
    o.claimPool(poolKeyOf(pool, o.poolKeyFn));
  }
  return false;
}

/**
 * Which of the positions saved as managed each pool keeps, at start-up.
 *
 * bot-config.json can name two saved positions in one pool, since only a
 * Manage request is checked against the rule. Each pool keeps one: the
 * open one, since the rule is one ACTIVE position per pool; with none
 * open, the first listed. Every other saved position in that pool cannot
 * be managed. This function only answers: the start-up takes those off
 * the list (src/server-auto-start.js). A position whose pool could not be
 * read is not passed in, since the start-up does not start it.
 *
 * Each position comes with its pool key, built with that position's own
 * wallet, so two wallets' positions in one pool are in two pools here, as
 * they are to a Manage.
 *
 * @param {Array<{key: string, tokenId: string, pool: object,
 *   poolKey: string}>} listed  The saved positions in list order, each
 *   with its pool as `readPoolOfPosition` reads it and that pool's
 *   canonical key (`poolKey`, src/pool-key.js).
 * @returns {Map<string, string>}  For each saved position that does not
 *   keep its pool, the token id of the one that does.
 */
function poolHoldersForStartUp(listed) {
  const holders = new Map();
  for (const p of listed) {
    const open = p.pool.liquidity > 0n;
    const held = holders.get(p.poolKey);
    if (held === undefined || (open && !held.open))
      holders.set(p.poolKey, { tokenId: p.tokenId, open });
  }
  const losers = new Map();
  for (const p of listed) {
    const held = holders.get(p.poolKey);
    if (held.tokenId !== p.tokenId) losers.set(p.key, held.tokenId);
  }
  return losers;
}

module.exports = {
  poolKeyOf,
  findPoolConflict,
  readPoolOfPosition,
  rejectIfPoolManaged,
  poolHoldersForStartUp,
};
