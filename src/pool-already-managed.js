"use strict";

/**
 * @file src/pool-already-managed.js
 * @module pool-already-managed
 * @description
 * Decides whether a liquidity pool already has a managed position.
 *
 * LP Ranger supports **one active position per pool**, a rule the README
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
 * The decision is injectable end to end: callers supply the bot-state
 * map and the canonical pool-key builder, so nothing here reads global
 * state and the comparison rule stays owned by `position-manager.js`.
 */

/*- One view method, declared here rather than pulling in the full
 *  position-manager ABI, so this module stays small and the rest of it
 *  stays pure and dependency-free. */
const PM_ABI = [
  "function positions(uint256) view returns (uint96,address,address,address,uint24,int24,int24,uint128,uint256,uint256,uint128,uint128)",
];

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
      : Object.entries(botStates || {});
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
  if (startingPools) {
    for (const [key, pk] of startingPools.entries()) {
      if (key === selfKey || pk !== wanted) continue;
      return { key, tokenId: String(key.split("-").pop()) };
    }
  }
  return null;
}

/**
 * Read a position's pool identity from chain.
 *
 * The Manage request carries only a tokenId, and a position's config
 * slot does not record its pool, so the identity has to be resolved
 * before the gate can compare it. Read on-chain rather than accepting a
 * client-supplied pool: this decision governs whether a second bot loop
 * starts trading a pool, and a caller that can name any pool it likes
 * could route around the rule.
 *
 * Returns null rather than throwing when the read fails. The gate then
 * allows the start, and the normal detection path a moment later fails
 * loudly with its own error — refusing to manage a position because one
 * RPC read hiccuped would be a worse outcome than the duplicate this
 * gate exists to prevent, which the operator can still undo by stopping
 * one of them.
 *
 * @param {object} opts
 * @param {object} opts.provider    ethers provider.
 * @param {object} opts.ethersLib   Injected ethers (testability).
 * @param {string} opts.positionManager  NFT contract address.
 * @param {string|number} opts.tokenId
 * @returns {Promise<{token0: string, token1: string, fee: number}|null>}
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
    return { token0: d.token0, token1: d.token1, fee: Number(d.fee) };
  } catch {
    return null;
  }
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
 * @param {object} o
 * @param {object} o.res                 HTTP response.
 * @param {Function} o.jsonResponse      Injected responder.
 * @param {Function} o.log               Injected warn logger.
 * @param {string} o.key                 Composite key being started.
 * @param {string} o.tokenId
 * @param {string} o.positionManager
 * @param {Map|object} o.botStates
 * @param {object} o.provider
 * @param {object} o.ethersLib
 * @returns {Promise<boolean>}  True when the request was refused.
 */
async function rejectIfPoolManaged(o) {
  const pool = await readPoolOfPosition({
    provider: o.provider,
    ethersLib: o.ethersLib,
    positionManager: o.positionManager,
    tokenId: o.tokenId,
  });
  const hit = findPoolConflict({
    pool,
    botStates: o.botStates,
    selfKey: o.key,
    poolKeyFn: o.poolKeyFn,
    startingPools: o.startingPools,
  });
  /*- Claim before returning, in the same synchronous step as the check.
   *  The only await above is the pool read, so nothing else can
   *  interleave between deciding the pool is free and marking it taken
   *  — which is what makes two concurrent requests for the same pool
   *  resolve to one winner rather than two. */
  if (!hit) {
    if (typeof o.claimPool === "function") {
      o.claimPool(poolKeyOf(pool, o.poolKeyFn));
    }
    return false;
  }
  o.log(
    "[pos-route] Refusing #%s — pool already managed by #%s",
    String(o.tokenId),
    hit.tokenId,
  );
  o.jsonResponse(o.res, 409, {
    ok: false,
    error: "pool-already-managed",
    conflictTokenId: hit.tokenId,
    conflictKey: hit.key,
  });
  return true;
}

/**
 * Claim a pool for one position during boot, or report it taken.
 *
 * Auto-start walks the saved `running` keys in order. A config written
 * before this rule was enforced can already hold two of them in one
 * pool, so the first to be walked claims it and the rest are skipped.
 *
 * Skip, not stop: the saved status is the operator's, and a boot-time
 * rewrite they did not ask for is worse than a clear log line plus a
 * dashboard showing one of the two unmanaged. This function accordingly
 * takes no config dependency at all — it cannot persist anything.
 *
 * A pool that cannot be read is started rather than skipped, on the same
 * reasoning as `readPoolOfPosition`: an unreadable pool claims nothing,
 * so it neither blocks a later position nor gets blocked by one.
 *
 * @param {object} o
 * @param {Map<string, string>} o.claimedPools  poolKey → tokenId that
 *   claimed it this boot. Mutated on a successful claim.
 * @param {string|number} o.tokenId
 * @param {object} o.provider
 * @param {object} o.ethersLib
 * @param {string} o.positionManager
 * @param {Function} o.poolKeyFn
 * @param {Function} o.log  Injected warn logger.
 * @returns {Promise<boolean>}  True when this position should start.
 */
async function claimPoolForBoot(o) {
  const key = poolKeyOf(
    await readPoolOfPosition({
      provider: o.provider,
      ethersLib: o.ethersLib,
      positionManager: o.positionManager,
      tokenId: o.tokenId,
    }),
    o.poolKeyFn,
  );
  if (key === null) return true;
  if (o.claimedPools.has(key)) {
    o.log(
      "[server] auto-start: pool already started by #%s — skipping #%s",
      o.claimedPools.get(key),
      String(o.tokenId),
    );
    return false;
  }
  o.claimedPools.set(key, String(o.tokenId));
  return true;
}

module.exports = {
  poolKeyOf,
  findPoolConflict,
  readPoolOfPosition,
  rejectIfPoolManaged,
  claimPoolForBoot,
};
