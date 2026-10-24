/**
 * @file src/lib/server-scan.js
 * @description
 * LP position scan route handlers extracted from server-routes.js.
 * Handles position enumeration with LP position cache integration,
 * background liquidity refresh, and token symbol resolution.
 */

"use strict";

const { log } = require("./log");
const ethers = require("ethers");
const config = require("./config");
const sendTx = require("./send-transaction");
const { cancelPoolScan } = require("./pool-scanner");
const { setTokenSymbol, flushSymbolCache } = require("./token-symbol-cache");
const {
  detectPositionType,
  refreshLpPositionLiquidity,
} = require("./position-detector");
const { getPoolState } = require("./rebalancer-pools");
const {
  loadLpPositionCache,
  saveLpPositionCache,
  hasPositionActivitySince,
} = require("./lp-position-cache");
const { PM_ABI } = require("./pm-abi");
const { resolveLiveKey } = require("./server-key-resolver");

const _C = "\x1b[38;5;118;48;5;94m";
const _R = "\x1b[0m";
function _log(msg, ...a) {
  log.info(_C + "[lp-cache] " + msg + _R, ...a);
}

/** What stands in for a token whose name cannot be read. */
function _fallbackLabel(addr) {
  if (typeof addr !== "string" || addr === "") return "?";
  return addr.slice(0, 6) + "\u2026" + addr.slice(-4);
}

/**
 * Read a token's name from the chain, or its symbol when it has no name.
 * @param {object} prov  ethers provider.
 * @param {string} addr  Token address.
 * @returns {Promise<string|null>} Null when the chain answers neither.
 */
async function _readTokenName(prov, addr) {
  if (typeof addr !== "string" || addr === "") return null;
  try {
    const c = new ethers.Contract(
      addr,
      [
        "function symbol() view returns (string)",
        "function name() view returns (string)",
      ],
      prov,
    );
    const nm = await c.name().catch(() => null);
    if (nm) return nm;
    const sym = await c.symbol().catch(() => null);
    return sym || null;
  } catch {
    return null;
  }
}

/**
 * Resolve the on-chain symbol for a token, or its abbreviated address
 * when the chain answers with neither a name nor a symbol.
 * @param {object} prov  ethers provider.
 * @param {string} addr  Token address.
 * @returns {Promise<string>}
 */
async function resolveTokenSymbol(prov, addr) {
  return (await _readTokenName(prov, addr)) ?? _fallbackLabel(addr);
}

/**
 * Resolve token symbols for a set of addresses.
 *
 * Only a name the chain gave is cached. The abbreviated address stands in
 * for this scan's list and the next scan asks again. Cached, it would be
 * taken as the token's name from then on, and positions would show it in
 * move logs and alerts.
 *
 * @param {object} prov  ethers provider.
 * @param {Set<string>} addrSet  Token addresses.
 * @returns {Promise<Object<string,string>>}
 */
async function resolveSymbolMap(prov, addrSet) {
  const symMap = {};
  await Promise.all(
    [...addrSet].map(async (a) => {
      const name = await _readTokenName(prov, a);
      if (name !== null) setTokenSymbol(a, name);
      symMap[a] = name ?? _fallbackLabel(a);
    }),
  );
  flushSymbolCache();
  return symMap;
}

/**
 * Whether a token's saved name is only its address: the whole address or
 * the shortened stand-in a scan saves when the chain did not answer,
 * compared without regard to case.
 * @param {*} name  The saved name.
 * @param {string} addr  The token's address.
 * @returns {boolean}
 */
function _isAddressStandIn(name, addr) {
  if (typeof name !== "string" || typeof addr !== "string") return false;
  const n = name.toLowerCase();
  return n === addr.toLowerCase() || n === _fallbackLabel(addr).toLowerCase();
}

/**
 * Give each token of saved positions whose name is only its address one
 * read of its real name, with no retry of its own; a name that comes back
 * replaces the stand-in. The saved list kept the stand-in as the token's
 * name, so the position showed the shortened address until a rescan. Run
 * on the list a scan serves from its cache: a full scan has just made
 * that one read itself.
 * @param {object} prov  ethers provider.
 * @param {object[]} positions  Saved NFT positions.
 * @returns {Promise<{positions: object[], changed: boolean}>}  `changed`
 *   when a real name replaced a stand-in, for the caller to save.
 */
async function readStoodInNames(prov, positions) {
  const addrs = new Set();
  for (const p of positions)
    for (const side of ["token0", "token1"])
      if (_isAddressStandIn(p[side + "Symbol"], p[side])) addrs.add(p[side]);
  if (addrs.size === 0) return { positions, changed: false };
  const names = await resolveSymbolMap(prov, addrs);
  let changed = false;
  const out = positions.map((p) => {
    const q = { ...p };
    for (const side of ["token0", "token1"]) {
      const name = names[p[side]];
      if (!addrs.has(p[side]) || _isAddressStandIn(name, p[side])) continue;
      q[side + "Symbol"] = name;
      changed = true;
    }
    return q;
  });
  return { positions: out, changed };
}

/**
 * Fetch current pool ticks for unique pools.
 * @param {object} ethersLib
 * @param {object[]} nftPositions
 * @returns {Promise<Object<string,number>>}
 */
async function fetchPoolTicks(ethersLib, nftPositions) {
  const poolTickMap = {};
  const poolSet = new Set(
    nftPositions
      .filter((p) => p.fee && p.fee > 0)
      .map((p) => p.token0 + "-" + p.token1 + "-" + p.fee),
  );
  await Promise.all(
    [...poolSet].map(async (k) => {
      try {
        const [t0, t1, fee] = k.split("-");
        const ps = await getPoolState(ethersLib, {
          factoryAddress: config.FACTORY,
          token0: t0,
          token1: t1,
          fee: Number(fee),
        });
        poolTickMap[k] = ps.tick;
      } catch {
        /* pool query failed */
      }
    }),
  );
  return poolTickMap;
}

/** Build pool key from position. */
function poolKey(p) {
  return p.token0 + "-" + p.token1 + "-" + p.fee;
}

/**
 * Format NFT positions for the API response.
 * @param {object[]} nftPositions
 * @param {object} symMap   Token address → symbol.
 * @param {object} poolTickMap  Pool key → tick.
 * @returns {object[]}
 */
function formatNftResponse(nftPositions, symMap, poolTickMap) {
  return nftPositions.map((p) => ({
    ...p,
    tokenId: String(p.tokenId),
    liquidity: String(p.liquidity),
    token0Symbol: symMap[p.token0] || p.token0Symbol || "?",
    token1Symbol: symMap[p.token1] || p.token1Symbol || "?",
    poolTick: poolTickMap[poolKey(p)] ?? null,
  }));
}

/**
 * Create scan route handlers.
 * @param {object} deps
 * @param {object} deps.walletManager
 * @param {Function} deps.jsonResponse
 * @param {Function} deps.readJsonBody
 * @param {Function} deps.getGlobalScanStatus
 * @param {Function} deps.setGlobalScanStatus
 * @returns {object}
 */
function createScanHandlers(deps) {
  const {
    walletManager,
    jsonResponse,
    readJsonBody,
    setGlobalScanStatus,
    getAllPositionBotStates,
    positionMgr,
  } = deps;

  let _scanRunning = false;
  let _scanPromise = null;

  async function _handlePositionsScan(req, res) {
    const wSt = walletManager.getStatus();
    if (!wSt.loaded)
      return jsonResponse(res, 400, {
        ok: false,
        error: "No wallet loaded." + " Import a wallet first.",
      });

    if (_scanRunning && _scanPromise) {
      _log(" Scan already running \u2014 waiting");
      const result = await _scanPromise;
      return jsonResponse(res, 200, result);
    }

    _scanPromise = _doScan(req, wSt);
    _scanRunning = true;
    try {
      const result = await _scanPromise;
      jsonResponse(res, 200, result);
    } catch (err) {
      /*- The scan died partway.  `setGlobalScanStatus("ready")` only
       *  runs on the success paths, so without this the status stays
       *  "scanning" for the life of the process — and "scanning" means
       *  "still coming" to every reader.  The dashboard believes it,
       *  pulses its Syncing badge forever and keeps the KPI, range and
       *  history panels blurred and click-through-disabled.
       *
       *  Say it stopped.  Rethrow so the route still reports the
       *  failure — this records the outcome, it does not swallow it. */
      setGlobalScanStatus("error");
      throw err;
    } finally {
      _scanRunning = false;
      _scanPromise = null;
    }
  }

  /**
   * Check LP position cache freshness. The cache is the scanned
   * contract's, read and written under that contract: a request may name
   * a position manager other than the configured one, and its positions
   * must not answer for the configured one's.
   */
  async function _checkCache(prov, ethers, wSt, pmAddr, currentBlock) {
    const cached = loadLpPositionCache(wSt.address, {
      blockchain: config.CHAIN_NAME,
      contract: pmAddr,
    });
    if (!cached) {
      _log(" No cache for wallet %s", wSt.address.slice(0, 8) + "\u2026");
      return null;
    }
    const contract = new ethers.Contract(pmAddr, PM_ABI, prov);
    const tokenIds = cached.positions.map((p) => p.tokenId);
    const hasActivity = await hasPositionActivitySince(
      contract,
      wSt.address,
      tokenIds,
      cached.lastBlock + 1,
      currentBlock,
    );
    if (!hasActivity) {
      const w = wSt.address.slice(0, 8) + "\u2026";
      _log(
        " Cache hit for wallet %s" + " (lastBlock %d \u2192 %d, no activity)",
        w,
        cached.lastBlock,
        currentBlock,
      );
      saveLpPositionCache(wSt.address, cached.positions, currentBlock, {
        blockchain: config.CHAIN_NAME,
        contract: pmAddr,
      });
      return cached;
    }
    _log(
      "Cache invalidated for" + " wallet %s \u2014 activity since block %d",
      wSt.address.slice(0, 8) + "\u2026",
      cached.lastBlock,
    );
    return null;
  }

  /** Full enumeration + symbol resolution. */
  async function _fullScan(prov, wSt, pmAddr, body, currentBlock) {
    setGlobalScanStatus("scanning", { done: 0, total: 0 });
    const w = wSt.address.slice(0, 8) + "\u2026";
    _log("Full scan started for wallet %s", w);
    const result = await detectPositionType(
      prov,
      {
        walletAddress: wSt.address,
        positionManagerAddress: pmAddr,
        candidateAddress: body.erc20Address || undefined,
      },
      {
        onProgress: (done, total) =>
          setGlobalScanStatus("scanning", { done, total }),
      },
    );
    let nfts = result.nftPositions || [];
    const erc20s = result.erc20Positions || [];

    const addrSet = new Set();
    for (const p of nfts) {
      addrSet.add(p.token0);
      addrSet.add(p.token1);
    }
    for (const p of erc20s) {
      if (p.token0) addrSet.add(p.token0);
      if (p.token1) addrSet.add(p.token1);
    }
    const symMap = await resolveSymbolMap(prov, addrSet);
    nfts = nfts.map((p) => ({
      ...p,
      token0Symbol: symMap[p.token0] || "?",
      token1Symbol: symMap[p.token1] || "?",
    }));

    if (nfts.length > 0) {
      saveLpPositionCache(wSt.address, nfts, currentBlock, {
        blockchain: config.CHAIN_NAME,
        contract: pmAddr,
      });
      _log(
        " Full scan complete for" +
          " wallet %s \u2014 cached %d positions" +
          " at block %d",
        w,
        nfts.length,
        currentBlock,
      );
    }
    setGlobalScanStatus("ready");
    return { nfts, erc20s, type: result.type };
  }

  async function _doScan(req, wSt) {
    const body = await readJsonBody(req);
    const pmAddr = body.positionManagerAddress || config.POSITION_MANAGER;
    const prov = sendTx.getManagedReadProvider();
    const force = body.force === true;
    const currentBlock = await prov.getBlockNumber();

    if (force) _log(" Force rescan requested");
    const cached = force
      ? null
      : await _checkCache(prov, ethers, wSt, pmAddr, currentBlock);

    let nftPositions, erc20Positions, type;
    const cacheHit = cached !== null;
    if (cacheHit) {
      const named = await readStoodInNames(prov, cached.positions);
      nftPositions = named.positions;
      if (named.changed)
        saveLpPositionCache(wSt.address, nftPositions, currentBlock, {
          blockchain: config.CHAIN_NAME,
          contract: pmAddr,
        });
      erc20Positions = [];
      type = "nft";
      setGlobalScanStatus("ready");
    } else {
      const r = await _fullScan(prov, wSt, pmAddr, body, currentBlock);
      nftPositions = r.nfts;
      erc20Positions = r.erc20s;
      type = r.type;
    }

    const poolTickMap = await fetchPoolTicks(ethers, nftPositions);
    const symMap = nftPositions.some((p) => !p.token0Symbol)
      ? await resolveSymbolMap(
          prov,
          (() => {
            const s = new Set();
            for (const p of nftPositions) {
              s.add(p.token0);
              s.add(p.token1);
            }
            return s;
          })(),
        )
      : {};

    return {
      ok: true,
      type,
      cached: cacheHit,
      positionManagerAddress: pmAddr,
      nftPositions: formatNftResponse(nftPositions, symMap, poolTickMap),
      erc20Positions: (erc20Positions || []).map((p) => ({
        ...p,
        token0Symbol: p.token0
          ? symMap[p.token0] || p.token0Symbol || "?"
          : "?",
        token1Symbol: p.token1
          ? symMap[p.token1] || p.token1Symbol || "?"
          : "?",
      })),
    };
  }

  async function _handlePositionsRefresh(req, res) {
    const wSt = walletManager.getStatus();
    if (!wSt.loaded)
      return jsonResponse(res, 400, {
        ok: false,
        error: "No wallet loaded.",
      });

    const cached = loadLpPositionCache(wSt.address, {
      blockchain: config.CHAIN_NAME,
      contract: config.POSITION_MANAGER,
    });
    if (!cached)
      return jsonResponse(res, 200, {
        ok: true,
        poolTicks: {},
        liquidities: {},
      });

    const prov = sendTx.getManagedReadProvider();
    const pmAddr = config.POSITION_MANAGER;
    const tokenIds = cached.positions.map((p) => p.tokenId);

    _log("Background refresh for %d positions", tokenIds.length);
    const [liqMap, poolTickMap] = await Promise.all([
      refreshLpPositionLiquidity(prov, pmAddr, tokenIds),
      fetchPoolTicks(ethers, cached.positions),
    ]);

    // Update cache with fresh liquidity
    const updated = cached.positions.map((p) => ({
      ...p,
      liquidity: liqMap.get(p.tokenId) || p.liquidity,
    }));
    saveLpPositionCache(wSt.address, updated, cached.lastBlock, {
      blockchain: config.CHAIN_NAME,
      contract: config.POSITION_MANAGER,
    });

    const liquidities = {};
    for (const [k, v] of liqMap) liquidities[k] = v;

    jsonResponse(res, 200, {
      ok: true,
      poolTicks: poolTickMap,
      liquidities,
    });
  }

  /**
   * POST /api/position/scan-cancel — abort any in-flight event scan for
   * the pool of the caller's position and clear its sync flag so the
   * badge re-syncs on the next restart. Used by the "Reload Current
   * Position" Settings button to recover from a stuck-sync state.
   */
  async function _handlePositionScanCancel(req, res) {
    const body = await readJsonBody(req);
    const { token0, token1, fee, positionKey, walletAddress } = body || {};
    if (!token0 || !token1 || fee === undefined || fee === null) {
      return jsonResponse(res, 400, {
        ok: false,
        error: "token0, token1, and fee required",
      });
    }
    const w = walletAddress || walletManager.getAddress() || "";
    const aborted = cancelPoolScan(token0, token1, fee, w);
    let flagReset = false;
    if (positionKey && getAllPositionBotStates) {
      /*- Resolve to the live key: the body.positionKey was captured by
       *  the dashboard from a recent poll and may be stale by the time
       *  this request arrives (e.g. a parallel rebalance migrated the
       *  key).  Without this, getAllPositionBotStates().get(stale)
       *  returns undefined, flagReset stays false, and the user's
       *  "Reload Current Position" silently fails to clear
       *  rebalanceScanComplete — leaving the Syncing badge stuck. */
      const liveKey = resolveLiveKey(positionMgr, positionKey, (k) =>
        getAllPositionBotStates().get(k),
      );
      const s = getAllPositionBotStates().get(liveKey);
      if (s) {
        s.rebalanceScanComplete = false;
        flagReset = true;
      }
    }
    log.info(
      "[server] scan-cancel pool=%s/%s fee=%s aborted=%s flagReset=%s",
      token0.slice(0, 8),
      token1.slice(0, 8),
      fee,
      aborted,
      flagReset,
    );
    jsonResponse(res, 200, { ok: true, aborted, flagReset });
  }

  return {
    _handlePositionsScan,
    _handlePositionsRefresh,
    _handlePositionScanCancel,
    resolveTokenSymbol,
  };
}

module.exports = {
  createScanHandlers,
  resolveTokenSymbol,
  resolveSymbolMap,
  readStoodInNames,
  fetchPoolTicks,
  formatNftResponse,
  poolKey,
};
