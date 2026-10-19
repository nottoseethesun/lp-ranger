/**
 * @file src/server-auto-start.js
 * @description
 * The start-up: once the wallet is unlocked, start a bot loop for each
 * position saved as managed (`status: "running"` in bot-config.json).
 * That saved list is what the next launch starts: a Manage adds to it, a
 * Stop Managing or a retire removes from it, and a stop of the app,
 * gentle or not, leaves it as it is.
 *
 * The positions start one at a time, spread over a poll interval, all
 * signing through the app-wide shared signer (one NonceManager for the
 * wallet). A position starts only while its NFT is still in the wallet,
 * and only if it is the one position its pool keeps: LP Ranger manages
 * one active position per pool, so a pool's open position keeps it, and
 * any other saved position in that pool comes off the list. While the
 * start-up runs, src/app-phase.js records its progress, which the
 * dashboard shows as Syncing and the server reads to refuse a request
 * that would start positions. The server and the headless bot (bot.js)
 * both start their saved positions this way.
 *
 * Exported as `createAutoStartManagedPositions(deps)` factory.
 */

"use strict";

const { log } = require("./log");
const { emojiId } = require("./logger");
const ethers = require("ethers");
const {
  readPoolOfPosition,
  poolHoldersForStartUp,
} = require("./pool-already-managed");
const config = require("./config");
const sendTx = require("./send-transaction");
const {
  getPositionConfig,
  saveConfig,
  managedKeys,
  removeManagedPosition,
} = require("./bot-config-v2");
const { startBotLoop } = require("./bot-loop");
const { createOnRetire } = require("./server-positions");
const { parseCompositeKey } = require("./composite-key");
const { isContractRevert } = require("./rpc-error-classifier");
const {
  beginStartUp,
  noteStartUpProgress,
  endStartUp,
  isStopping,
} = require("./app-phase");

/**
 * How a start-up log line names a saved position: its NFT and the NFT's
 * emoji (src/logger.js).
 * @param {string} key  The position's composite key.
 * @returns {string}  e.g. "NFT #157149 ⭐🌵🐎".
 */
function _nftOf(key) {
  const tokenId = key.split("-").pop();
  const emoji = emojiId(tokenId);
  return `NFT #${tokenId} ${emoji}`;
}

/**
 * Factory that returns `_autoStartManagedPositions`.
 *
 * @param {object} deps
 * @param {object} deps.diskConfig
 * @param {object} deps.positionMgr
 * @param {{ current: string|null }} deps.privateKeyRef
 * @param {object} deps.walletManager
 * @param {Function} deps.getAllPositionBotStates
 * @param {Function} deps.createPerPositionBotState
 * @param {Function} deps.attachMultiPosDeps
 * @param {Function} deps.updatePositionState
 * @param {Function} deps.readConfigValue
 * @param {object} [deps.ethersLib]  Builds the contracts the start-up
 *   reads (who owns each NFT, which pool it is in); ethers itself unless
 *   a test stands in for the chain.
 * @param {Function} [deps.readProvider]  The provider those reads go
 *   through. A thunk, since the managed read provider is not built until
 *   `sendTx.init()` has run.
 * @returns {Function} Async function that auto-starts all running positions.
 */
function createAutoStartManagedPositions(deps) {
  const {
    diskConfig,
    positionMgr,
    privateKeyRef,
    walletManager,
    getAllPositionBotStates,
    createPerPositionBotState,
    attachMultiPosDeps,
    updatePositionState,
    readConfigValue,
    ethersLib = ethers,
    readProvider = () => sendTx.getManagedReadProvider(),
  } = deps;

  /** Initialise the app-wide shared NonceManager signer (best-effort). */
  async function _initSharedSigner(eth) {
    const noKey =
      privateKeyRef.current === null || privateKeyRef.current === undefined;
    if (noKey && !config.DRY_RUN) return null;
    try {
      return await positionMgr.getSharedSigner({
        privateKey: privateKeyRef.current,
        ethersLib: eth,
        dryRun: config.DRY_RUN,
      });
    } catch (err) {
      log.warn(
        "[server] Shared signer init failed: %s —" +
          " positions will start without injected signer",
        err.message,
      );
      return null;
    }
  }

  /**
   * Take `key` off the list of positions saved as managed, for a reason
   * that will not pass: the position cannot be managed.
   * @param {string} key
   * @param {string} why  Logged, in the operator's words.
   */
  function _dropFromList(key, why) {
    const nft = _nftOf(key);
    log.warn(
      "[server] auto-start: %s cannot be managed: %s; taken off the managed positions",
      nft,
      why,
    );
    removeManagedPosition(diskConfig, key);
    saveConfig(diskConfig);
  }

  /**
   * Whether the wallet still holds the position's NFT. One it no longer
   * holds, or that no longer exists, comes off the list: the contract
   * reverts when asked who owns an NFT that was burned. Any other failure
   * to ask, an endpoint's error answer included, which ethers labels as
   * it labels a revert (`isContractRevert`), leaves the position on the
   * list for the next launch.
   * @returns {Promise<boolean>} Whether to go on and start it.
   */
  async function _verifyOwnership(pmC, wAddr, tokenId, key) {
    if (wAddr === null || wAddr === undefined) return true;
    try {
      const own = await pmC.ownerOf(tokenId);
      if (own.toLowerCase() === wAddr.toLowerCase()) return true;
      _dropFromList(key, "it is no longer in the wallet");
    } catch (err) {
      if (isContractRevert(err)) _dropFromList(key, "it no longer exists");
      else {
        const nft = _nftOf(key);
        log.warn(
          "[server] auto-start: could not read who owns %s: %s; not started, it stays on the list for the next launch",
          nft,
          err.message,
        );
      }
    }
    return false;
  }

  /**
   * Start a single bot loop for `key` using the shared signer. A failure
   * is logged and leaves the position on the list for the next launch.
   */
  async function _startOne(key, pc, shared) {
    const tokenId = key.split("-").pop();
    const perPositionBotState = createPerPositionBotState(
      diskConfig.global,
      pc,
    );
    attachMultiPosDeps(perPositionBotState, positionMgr);
    getAllPositionBotStates().set(key, perPositionBotState);
    try {
      const kRef = { current: key };
      await positionMgr.startPosition(key, {
        tokenId,
        startLoop: () =>
          startBotLoop({
            privateKey: privateKeyRef.current,
            provider: shared?.provider,
            signer: shared?.signer,
            address: shared?.address,
            dryRun: config.DRY_RUN,
            eagerScan: false,
            updateBotState: (patch) =>
              updatePositionState(kRef, patch, diskConfig, positionMgr),
            botState: perPositionBotState,
            positionId: tokenId,
            getConfig: (k) => readConfigValue(diskConfig, kRef.current, k),
            getPositionCount: () => positionMgr.runningCount(),
            onRetire: createOnRetire({
              keyRef: kRef,
              diskConfig,
              positionMgr,
            }),
          }),
        savedConfig: pc,
      });
    } catch (err) {
      const nft = _nftOf(key);
      log.warn(
        "[server] auto-start: %s failed to start: %s; it stays on the list for the next launch",
        nft,
        err.message,
      );
    }
  }

  /**
   * Which of the saved positions to start: those the wallet still holds,
   * less any whose pool another saved position keeps, since LP Ranger
   * manages one active position per pool. A pool's open position keeps
   * it wherever it stands in the list, so who owns each NFT and which
   * pool it is in are read for every position before any starts.
   *
   * A position that cannot be managed comes off the list here: its NFT
   * left the wallet or no longer exists (`_verifyOwnership`), or another
   * saved position keeps its pool (`poolHoldersForStartUp`). One whose
   * owner or pool could not be read stays on the list and is not
   * started: with its pool unknown, nothing shows that no other saved
   * position is in it.
   *
   * @param {string[]} keys  The saved positions, in list order.
   * @param {object} ctx     As for `_startListed`.
   * @returns {Promise<string[]>}  The keys to start, in list order.
   */
  async function _positionsToStart(keys, ctx) {
    const held = [];
    for (const key of keys) {
      const { wallet, tokenId } = parseCompositeKey(key);
      if (!(await _verifyOwnership(ctx.pmC, ctx.wAddr, tokenId, key))) continue;
      const pool = await readPoolOfPosition({
        provider: ctx.provider,
        ethersLib,
        positionManager: config.POSITION_MANAGER,
        tokenId,
      });
      if (pool === null) {
        const nft = _nftOf(key);
        log.warn(
          "[server] auto-start: %s not started, since its pool could not be read; it stays on the list for the next launch",
          nft,
        );
        continue;
      }
      /*-
       *  The pool is keyed by the position's own wallet, as a Manage keys
       *  it: one active position per pool in each wallet. With no wallet
       *  loaded, the list read holds every wallet's positions.
       */
      const poolKey = positionMgr.poolKey(
        config.CHAIN_NAME,
        config.POSITION_MANAGER,
        wallet,
        pool.token0,
        pool.token1,
        pool.fee,
      );
      held.push({ key, tokenId, pool, poolKey });
    }
    const losers = poolHoldersForStartUp(held);
    for (const [key, holder] of losers) {
      const keeperEmoji = emojiId(holder);
      const why = `NFT #${holder} ${keeperEmoji} keeps its pool, one active position per pool`;
      _dropFromList(key, why);
    }
    return held.filter((p) => !losers.has(p.key)).map((p) => p.key);
  }

  /**
   * Start the saved position `key`, unless a Stop Managing has taken it
   * off the list since the start-up read the list.
   * @param {string} key
   * @param {object} ctx  What the whole start-up shares: `provider`, the
   *   position manager contract `pmC`, the wallet address `wAddr` and the
   *   `shared` signer.
   * @returns {Promise<void>}
   */
  async function _startListed(key, ctx) {
    /*-
     *  Read again at the position's turn, without creating a slot: the
     *  stagger leaves time for a Stop Managing, which clears the saved
     *  status, or a purge, which deletes the slot.
     */
    const pc = getPositionConfig(diskConfig, key);
    if (pc === null || pc.status !== "running") {
      const nft = _nftOf(key);
      log.info("[server] auto-start: %s is no longer saved as managed", nft);
      return;
    }
    await _startOne(key, pc, ctx.shared);
  }

  /**
   * The saved positions this launch is for: those on the chain the app
   * runs, under its position manager, and in the loaded wallet. One saved
   * under another chain or wallet belongs to that chain's or wallet's own
   * launch, so it is neither started nor taken off the list here.
   * @param {string|null} wAddr  The loaded wallet; with none known, every
   *   wallet's.
   * @returns {string[]}
   */
  function _keysForThisLaunch(wAddr) {
    const same = (a, b) => a.toLowerCase() === b.toLowerCase();
    const anyWallet = wAddr === null || wAddr === undefined;
    return managedKeys(diskConfig).filter((key) => {
      const k = parseCompositeKey(key);
      return (
        k !== null &&
        k.blockchain === config.CHAIN_NAME &&
        same(k.contract, config.POSITION_MANAGER) &&
        (anyWallet || same(k.wallet, wAddr))
      );
    });
  }

  /*-
   *  The start-up: each position saved as managed, started one at a
   *  time and spread over a poll interval. While it runs, src/app-phase.js
   *  says so, which refuses a request that would start positions and
   *  holds the dashboard's badge at Syncing. It ends early once the app
   *  starts stopping for good, at its next turn.
   */
  return async function _autoStartManagedPositions() {
    const wAddr = walletManager.getAddress();
    const keys = _keysForThisLaunch(wAddr);
    if (!beginStartUp(keys.length)) {
      log.info(
        "[server] Not starting the managed positions: a start-up is under way, or LP Ranger is stopping",
      );
      return;
    }
    try {
      const provider = readProvider();
      const shared = await _initSharedSigner(ethersLib);
      const ctx = {
        provider,
        pmC: new ethersLib.Contract(
          config.POSITION_MANAGER,
          ["function ownerOf(uint256) view returns (address)"],
          provider,
        ),
        wAddr,
        shared,
      };
      const toStart = await _positionsToStart(keys, ctx);
      // Those it will not start are dealt with already.
      let done = keys.length - toStart.length;
      noteStartUpProgress(done);
      const cnt = toStart.length;
      const stMs =
        cnt > 1 ? Math.floor((config.CHECK_INTERVAL_SEC * 1000) / cnt) : 0;
      for (let i = 0; i < cnt; i++) {
        if (i > 0 && stMs > 0) {
          log.info("[server] Stagger: %dms before %d/%d", stMs, i + 1, cnt);
          await new Promise((r) => setTimeout(r, stMs));
        }
        if (isStopping()) break;
        await _startListed(toStart[i], ctx);
        noteStartUpProgress(++done);
      }
      log.info(
        "[server] Auto-started %d of %d positions",
        positionMgr.runningCount(),
        keys.length,
      );
    } finally {
      endStartUp();
    }
  };
}

module.exports = { createAutoStartManagedPositions };
