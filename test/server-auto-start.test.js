"use strict";

/**
 * @file test/server-auto-start.test.js
 * @description The start-up (src/server-auto-start.js). Once the wallet
 *   is unlocked, the server starts each position saved as managed, one at
 *   a time, spread over a poll interval. It reports its progress while it
 *   runs, which holds the dashboard's badge at Syncing, and ends at its
 *   next turn once the app is stopping.
 *
 *   A saved position that cannot be managed comes off the list: its NFT
 *   left the wallet or no longer exists, or another saved position keeps
 *   its pool, since LP Ranger manages one active position per pool: the
 *   pool's open position keeps it, else the first listed. One that only
 *   failed to start, or whose owner or pool could not be read, stays on
 *   the list for the next launch. While a wallet is loaded, a saved
 *   position of another wallet or chain is neither started nor touched;
 *   with none loaded, every wallet's are read, and each wallet keeps its
 *   own position in a pool.
 *
 *   Driven through the real start-up with the chain stood in for: who
 *   owns each NFT and which pool it is in come from the test, and the
 *   position manager records the starts instead of running bot loops.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const config = require("../src/config");
const appPhase = require("../src/app-phase");
const { createAutoStartManagedPositions } = require("../src/server-auto-start");
const { captureWarnings } = require("./helpers/capture-warnings");

const WALLET = "0x1111111111111111111111111111111111111111";
const OTHER_WALLET = "0x2222222222222222222222222222222222222222";
const OTHER_CHAIN =
  config.CHAIN_NAME === "pulsechain" ? "pulsechain-testnet" : "pulsechain";

/** A saved position's key: this chain and wallet unless named. */
const keyOf = (id, wallet = WALLET, chain = config.CHAIN_NAME) =>
  `${chain}-${wallet}-${config.POSITION_MANAGER}-${id}`;

/** A pool, as the position manager's `positions` read reports one. */
const POOL = {
  token0: "0x" + "a1".repeat(20),
  token1: "0x" + "b2".repeat(20),
  fee: 2500n,
};
// A position in POOL holding liquidity, and one drained.
const OPEN = { ...POOL, liquidity: 5000n };
const CLOSED = { ...POOL, liquidity: 0n };

/**
 * An ethers stand-in whose contracts answer who owns each NFT and which
 * pool it is in. An owner or pool given as an Error is thrown; an NFT
 * with no pool given is open, alone in a pool of its own.
 */
function chainStandIn(owners, pools) {
  return {
    Contract: class {
      async ownerOf(id) {
        const owner = owners[String(id)];
        if (owner instanceof Error) throw owner;
        return owner;
      }
      async positions(id) {
        const pool = pools[String(id)];
        if (pool instanceof Error) throw pool;
        if (pool === undefined)
          return { ...OPEN, token1: "0x" + String(id).padStart(40, "0") };
        return pool;
      }
    },
  };
}

/** An error ethers raises for a call the contract reverts. */
function reverted() {
  const e = new Error("execution reverted: ERC721: invalid token ID");
  e.code = "CALL_EXCEPTION";
  return e;
}

/**
 * A start-up over the saved positions `keys`, each owned by the wallet
 * unless `owners` says otherwise, with `loaded` the wallet loaded, or
 * null for none.
 * @returns {{run: Function, started: string[], progress: object[],
 *   diskConfig: object}}
 */
function startUp({
  keys,
  owners = {},
  pools = {},
  failStart = [],
  onStart = () => {},
  loaded = WALLET,
}) {
  const diskConfig = { global: {}, positions: {} };
  const ownerOf = { ...owners };
  for (const key of keys) {
    diskConfig.positions[key] = { status: "running" };
    const id = key.split("-").pop();
    if (!(id in ownerOf)) ownerOf[id] = WALLET;
  }
  const started = [];
  const progress = [];
  const positionMgr = {
    startPosition: async (key) => {
      progress.push(appPhase.startUpProgress());
      if (failStart.includes(key)) throw new Error("pool unavailable");
      started.push(key);
      await onStart(key, diskConfig);
    },
    runningCount: () => started.length,
    poolKey: (_c, _pm, w, t0, t1, fee) => `${w}-${t0}-${t1}-${fee}`,
  };
  const run = createAutoStartManagedPositions({
    diskConfig,
    positionMgr,
    privateKeyRef: { current: null },
    walletManager: { getAddress: () => loaded },
    getAllPositionBotStates: () => new Map(),
    createPerPositionBotState: () => ({}),
    attachMultiPosDeps: () => {},
    updatePositionState: () => {},
    readConfigValue: () => undefined,
    ethersLib: chainStandIn(ownerOf, pools),
    readProvider: () => ({}),
  });
  return { run, started, progress, diskConfig };
}

/**
 * Run a start-up to its end, ending each wait between starts at once.
 *
 * TEST-ONLY global swap: the waits between starts are the start-up's own
 * timers, read from `setTimeout`, which takes no stand-in. The test
 * runner puts it back pristine as the case ends.
 */
async function runToEnd(t, run) {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  let ended = false;
  const done = run().then(() => {
    ended = true;
  });
  for (let turn = 0; turn < 50 && !ended; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
    t.mock.timers.tick(config.CHECK_INTERVAL_SEC * 1000);
  }
  await done;
}

const statusOf = (s, key) => s.diskConfig.positions[key].status;

beforeEach(() => appPhase._resetAppPhaseForTests());

describe("the start-up", () => {
  it("starts each saved position, reporting its progress until it ends", async (t) => {
    const keys = [keyOf(101), keyOf(102), keyOf(103)];
    const s = startUp({ keys });
    await runToEnd(t, s.run);
    assert.deepEqual(s.started, keys);
    assert.deepEqual(s.progress, [
      { done: 0, total: 3 },
      { done: 1, total: 3 },
      { done: 2, total: 3 },
    ]);
    assert.equal(appPhase.startUpProgress(), null, "over once it ends");
  });

  it("starts only this chain's and this wallet's, and leaves the rest on their lists", async (t) => {
    const mine = keyOf(101);
    const otherWallet = keyOf(102, OTHER_WALLET);
    const otherChain = keyOf(103, WALLET, OTHER_CHAIN);
    const s = startUp({
      keys: [mine, otherWallet, otherChain],
      owners: { 102: OTHER_WALLET, 103: OTHER_WALLET },
    });
    await runToEnd(t, s.run);
    assert.deepEqual(s.started, [mine]);
    assert.equal(statusOf(s, otherWallet), "running");
    assert.equal(statusOf(s, otherChain), "running");
  });

  it("does not run a second time while one is under way", async (t) => {
    const keys = [keyOf(101), keyOf(102)];
    const s = startUp({ keys });
    await Promise.all([runToEnd(t, s.run), s.run()]);
    assert.deepEqual(s.started, keys, "each position started once");
  });

  it("ends at its next turn once the app is stopping", async (t) => {
    const keys = [keyOf(101), keyOf(102), keyOf(103)];
    const s = startUp({ keys, onStart: () => appPhase.markStopping() });
    await runToEnd(t, s.run);
    assert.deepEqual(s.started, [keys[0]]);
    assert.equal(statusOf(s, keys[1]), "running", "left for the next launch");
    assert.equal(statusOf(s, keys[2]), "running");
  });

  it("passes over a position stopped from being managed during the start-up", async (t) => {
    const keys = [keyOf(101), keyOf(102)];
    const s = startUp({
      keys,
      onStart: (_key, diskConfig) => {
        diskConfig.positions[keys[1]].status = "stopped";
      },
    });
    await runToEnd(t, s.run);
    assert.deepEqual(s.started, [keys[0]]);
  });

  it("starts nothing once the app is stopping", async (t) => {
    appPhase.markStopping();
    const s = startUp({ keys: [keyOf(101)] });
    await runToEnd(t, s.run);
    assert.deepEqual(s.started, []);
    assert.equal(appPhase.startUpProgress(), null);
  });
});

describe("a saved position that cannot be managed", () => {
  it("comes off the list when its NFT is no longer in the wallet", async (t) => {
    const key = keyOf(101);
    const s = startUp({ keys: [key], owners: { 101: OTHER_WALLET } });
    const warned = captureWarnings();
    try {
      await runToEnd(t, s.run);
    } finally {
      warned.restore();
    }
    assert.deepEqual(s.started, []);
    assert.equal(statusOf(s, key), "stopped");
    // Logged by its NFT and that NFT's emoji, as every position's line is.
    assert.match(
      warned.lines.join("\n"),
      /auto-start: NFT #101 \S+ cannot be managed: it is no longer in the wallet/,
    );
  });

  it("comes off the list when its NFT no longer exists", async (t) => {
    const key = keyOf(101);
    const s = startUp({ keys: [key], owners: { 101: reverted() } });
    await runToEnd(t, s.run);
    assert.deepEqual(s.started, []);
    assert.equal(statusOf(s, key), "stopped");
  });

  it("stays on the list when who owns it cannot be read", async (t) => {
    const key = keyOf(101);
    const unanswered = new Error("missing response");
    unanswered.code = "BAD_DATA";
    const s = startUp({ keys: [key], owners: { 101: unanswered } });
    await runToEnd(t, s.run);
    assert.deepEqual(s.started, []);
    assert.equal(statusOf(s, key), "running");
  });

  it("stays on the list, not started, when its pool cannot be read", async (t) => {
    /*-
     *  With its pool unknown, nothing shows that no other listed position
     *  is in it, so it is not started: one active position per pool.
     */
    const keys = [keyOf(101), keyOf(102)];
    const s = startUp({
      keys,
      pools: { 101: new Error("could not reach the endpoint"), 102: OPEN },
    });
    await runToEnd(t, s.run);
    assert.deepEqual(s.started, [keys[1]]);
    assert.equal(statusOf(s, keys[0]), "running", "left for the next launch");
  });

  it("comes off the list when the open position in its pool is listed after it", async (t) => {
    // One active position per pool: the open one keeps it.
    const keys = [keyOf(101), keyOf(102)];
    const s = startUp({ keys, pools: { 101: CLOSED, 102: OPEN } });
    await runToEnd(t, s.run);
    assert.deepEqual(s.started, [keys[1]]);
    assert.equal(statusOf(s, keys[0]), "stopped");
    assert.equal(statusOf(s, keys[1]), "running");
  });

  it("stays on its own wallet's list when another wallet's position is in the same pool", async (t) => {
    /*-
     *  With no wallet loaded, the list read holds every wallet's
     *  positions. One position per pool holds in each wallet, as a
     *  Manage keys it, so two wallets' positions in one pool are not in
     *  conflict.
     */
    const mine = keyOf(101);
    const theirs = keyOf(102, OTHER_WALLET);
    const s = startUp({
      keys: [mine, theirs],
      pools: { 101: OPEN, 102: OPEN },
      loaded: null,
    });
    await runToEnd(t, s.run);
    assert.deepEqual(s.started, [mine, theirs]);
    assert.equal(statusOf(s, theirs), "running");
  });

  it("comes off the list when a position listed before it keeps its pool", async (t) => {
    const keys = [keyOf(101), keyOf(102)];
    const s = startUp({ keys, pools: { 101: OPEN, 102: OPEN } });
    await runToEnd(t, s.run);
    assert.deepEqual(s.started, [keys[0]]);
    assert.equal(statusOf(s, keys[1]), "stopped");
  });

  it("stays off the list when the position keeping its pool fails to start", async (t) => {
    const keys = [keyOf(101), keyOf(102)];
    const s = startUp({
      keys,
      pools: { 101: OPEN, 102: CLOSED },
      failStart: [keys[0]],
    });
    await runToEnd(t, s.run);
    assert.deepEqual(s.started, []);
    assert.equal(statusOf(s, keys[0]), "running", "a failed start stays");
    assert.equal(statusOf(s, keys[1]), "stopped");
  });
});
