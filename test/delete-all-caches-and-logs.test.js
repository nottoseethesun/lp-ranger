"use strict";

/**
 * @file test/delete-all-caches-and-logs.test.js
 * @description What `npm run delete-all-caches-and-logs` does, and what
 *   `npm run build-and-start -- --delete-all-caches-and-logs` does before
 *   it builds (scripts/delete-all-caches-and-logs.js): it deletes all of
 *   LP Ranger's caches and logs, the way back from a damaged one. Run
 *   alone, it starts nothing after, and says how to start LP Ranger again
 *   (the way when you run the headless bot); run by build-and-start, it
 *   says the server starts after, in place of a headless bot that ran. It says first that it deletes them all, that a running LP Ranger
 *   is stopped first and that the rebuild can take several hours, and asks
 *   for YES, in capitals. YES stops each LP Ranger program that runs, the
 *   server first and then the headless bot, each once nothing is under
 *   way, waiting for each to exit; then it deletes every scan cache, the
 *   figures worked out from the blockchain for each position, the
 *   rebalance log wherever it is, and the diagnostic log and the error
 *   log, keeping the wallet, the keys, the settings, the records no scan
 *   can rebuild and today's rebalance counts. Any other answer stops and
 *   deletes nothing; so does a program that does not stop, or a process
 *   that cannot be told apart from LP Ranger. It names a file it could not
 *   delete, and leaves a diagnostic or error log outside the install
 *   folder alone.
 *
 *   Each case works in a folder of its own: its install folder, its
 *   settings folder, and the scan-cache folder the test process has under
 *   `node --test` (src/lib/scan-cache-dir.js). Every path handed to the
 *   script is a full path inside the case's folder, so no mistake in how
 *   the script resolves a path can reach the operator's files. The stops
 *   are stand-ins, but for the real wiring at the end: finding a program
 *   by its PID file, and stopping a stand-in headless bot by its signal.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { spawn } = require("child_process");
const { makeTestTempFolder } = require("../src/lib/test-temp-folders");
const { scanCacheDir } = require("../src/lib/scan-cache-dir");
const { loadConfig } = require("../src/lib/bot-config-v2");
const { CHAIN_DERIVED_POSITION_KEYS } = require("../src/lib/bot-config-keys");
const { poolDailyCountsPath } = require("../src/bot/pool-daily-counts-file");
const { SERVER_PID_FILE, BOT_PID_FILE } = require("../src/lib/pid-file");
const {
  deleteAllCachesAndLogs,
  runningPrograms,
  stopBotGently,
  _exitStatus,
} = require("../scripts/delete-all-caches-and-logs");
const { DECLINED_EXIT } = require("../scripts/_delete-all-flag");

const KEY = "pulsechain-0xW-0xC-100";
const LOGS = [
  "app-data/rebalance_log.json",
  "logs/lp-ranger.log",
  "logs/error.log",
];
const CACHES = ["event-cache-a.json", "pnl-epochs-cache.json"];
/*- What the warning promises to keep, at its place in an install. */
const KEPT = [
  "app-config/user-configurable/wallet.json",
  "app-config/user-configurable/api-keys.json",
  "app-config/user-configurable/bot-config.json",
  "app-data/pool-daily-counts.json",
];
const NOTHING_RUNS = () => ({ server: null, bot: null, unknown: [] });

let root;
let configDir;

/** A file of the case's install folder holding `text`. */
function put(rel, text = "x") {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
}

/** A full path inside the case's install folder. */
const inRoot = (rel) => path.join(root, rel);

beforeEach(() => {
  root = makeTestTempFolder("delete-all-root");
  configDir = makeTestTempFolder("delete-all-config");
  for (const f of [...LOGS, ...KEPT]) put(f);
  for (const f of CACHES) fs.writeFileSync(path.join(scanCacheDir(), f), "{}");
  // A position's settings, records no scan rebuilds, and scan figures.
  fs.writeFileSync(
    path.join(configDir, "bot-config.json"),
    JSON.stringify({
      global: {},
      positions: {
        [KEY]: {
          status: "running",
          slippagePctToken0: 0.75,
          residuals: { amount0: "5" },
          compoundedAmount0: 1111.16,
          hodlBaseline: { entryValue: 1 },
          totalLifetimeDepositUsd: 2406.7,
        },
      },
    }),
  );
});

/**
 * Run it with `answer` typed, recording what it said, asked and stopped.
 * @returns {Promise<{outcome: string, said: string[], asked: string[],
 *   stopped: string[]}>}
 */
async function runWith(answer, extra = {}) {
  const said = [];
  const asked = [];
  const stopped = [];
  const stopper = (name) => async (pid) => {
    stopped.push(`${name} ${pid}`);
    return true;
  };
  const outcome = await deleteAllCachesAndLogs({
    ask: async (q) => {
      asked.push(q);
      return answer;
    },
    rebalanceLog: inRoot(LOGS[0]),
    logs: LOGS.slice(1).map(inRoot),
    say: (line) => said.push(line),
    running: NOTHING_RUNS,
    stopServer: stopper("server"),
    stopBot: stopper("bot"),
    root,
    configDir,
    ...extra,
  });
  return { outcome, said, asked, stopped };
}

const exists = (rel) => fs.existsSync(inRoot(rel));
const cachesLeft = () =>
  CACHES.filter((f) => fs.existsSync(path.join(scanCacheDir(), f)));
const nothingDeleted = () => {
  for (const f of LOGS) assert.equal(exists(f), true, `${f} kept`);
  assert.deepEqual(cachesLeft(), CACHES, "the caches kept");
};

describe("deleting all of LP Ranger's caches and logs", () => {
  it("says first that it deletes them all, that a running LP Ranger is stopped first, that the rebuild can take hours, and asks for YES", async () => {
    const { said, asked } = await runWith("no");
    const warning = said.join("\n");
    assert.match(warning, /This deletes ALL of LP Ranger's caches and logs/);
    assert.match(warning, /can take it several hours/);
    assert.match(warning, /Your wallet, keys and settings are kept\./);
    assert.match(
      warning,
      /If LP Ranger is running, it is stopped first, the server and then the headless bot, each once nothing is under way/,
    );
    assert.match(warning, /Nothing is deleted until each has stopped\./);
    assert.doesNotMatch(warning, /Running now/, "nothing runs");
    for (const f of LOGS) assert.ok(warning.includes(` ${f}`), f);
    assert.equal(asked.length, 1);
    assert.match(asked[0], /^Type YES to go ahead, or anything else to cancel/);
  });

  it("names what runs as it asks", async () => {
    const { said } = await runWith("no", {
      running: () => ({ server: 11, bot: 22, unknown: [] }),
    });
    assert.match(
      said.join("\n"),
      /Running now: the server \(PID 11\) and the headless bot \(PID 22\)\./,
    );
  });

  it("deletes every cache and log on YES, keeping the settings and the records no scan rebuilds", async () => {
    const { outcome, said, stopped } = await runWith("YES");
    assert.equal(outcome, "deleted");
    assert.deepEqual(stopped, [], "nothing ran, so nothing was stopped");
    for (const f of LOGS) assert.equal(exists(f), false, `${f} deleted`);
    assert.deepEqual(cachesLeft(), [], "every scan cache deleted");
    const slot = loadConfig(configDir).positions[KEY];
    for (const k of CHAIN_DERIVED_POSITION_KEYS)
      assert.equal(k in slot, false, `${k} gone`);
    assert.equal(slot.slippagePctToken0, 0.75, "a setting kept");
    assert.deepEqual(slot.residuals, { amount0: "5" }, "a live record kept");
    assert.match(said.at(-1), /Deleted all of LP Ranger's caches and logs/);
  });

  it("keeps the wallet, the keys, the settings and today's rebalance counts where an install keeps them", async () => {
    const counts = poolDailyCountsPath();
    fs.mkdirSync(path.dirname(counts), { recursive: true });
    fs.writeFileSync(counts, '{"day":"2026-11-23","counts":{}}');
    const { outcome } = await runWith("YES");
    assert.equal(outcome, "deleted");
    for (const f of KEPT) assert.equal(exists(f), true, `${f} kept`);
    assert.equal(fs.existsSync(counts), true, "the test process's own kept");
  });

  it("on YES stops the server first and then the headless bot, each before anything is deleted", async () => {
    const order = [];
    const stopper = (name) => async (pid) => {
      // At each stop, nothing has been deleted yet.
      nothingDeleted();
      order.push(`${name} ${pid}`);
      return true;
    };
    const { outcome, said } = await runWith("YES", {
      running: () => ({ server: 11, bot: 22, unknown: [] }),
      stopServer: stopper("server"),
      stopBot: stopper("bot"),
    });
    assert.equal(outcome, "deleted");
    assert.deepEqual(order, ["server 11", "bot 22"]);
    for (const f of LOGS) assert.equal(exists(f), false, `${f} deleted`);
    const text = said.join("\n");
    assert.match(
      text,
      /Stopping the LP Ranger server \(PID 11\) once nothing is under way/,
    );
    assert.match(
      text,
      /Stopping the headless bot \(PID 22\) once nothing is under way/,
    );
  });

  it("stops only the headless bot when it alone runs", async () => {
    const { outcome, stopped } = await runWith("YES", {
      running: () => ({ server: null, bot: 22, unknown: [] }),
    });
    assert.equal(outcome, "deleted");
    assert.deepEqual(stopped, ["bot 22"]);
  });

  it("deletes nothing, and stops nothing more, when a program does not stop", async () => {
    const { outcome, said, stopped } = await runWith("YES", {
      running: () => ({ server: 11, bot: 22, unknown: [] }),
      stopServer: async () => false,
      serverStartsAfter: true,
    });
    assert.equal(outcome, "failed");
    assert.deepEqual(stopped, [], "the bot was not asked to stop");
    nothingDeleted();
    assert.match(
      said.at(-1),
      /Could not stop the LP Ranger server \(PID 11\)\. Nothing was deleted, and LP Ranger did not start\./,
    );
  });

  it("asks again after YES, and stops a program that started while it waited", async () => {
    let asks = 0;
    const { outcome, stopped } = await runWith("YES", {
      running: () =>
        asks++ === 0
          ? { server: null, bot: null, unknown: [] }
          : { server: null, bot: 33, unknown: [] },
    });
    assert.equal(outcome, "deleted");
    assert.deepEqual(stopped, ["bot 33"]);
  });

  it("asks again after YES, and refuses a process it can no longer tell from LP Ranger", async () => {
    let asks = 0;
    const { outcome, said, stopped } = await runWith("YES", {
      running: () =>
        asks++ === 0
          ? { server: null, bot: null, unknown: [] }
          : {
              server: null,
              bot: null,
              unknown: ["PID 55 (tmp/lp-ranger-bot.pid)"],
            },
    });
    assert.equal(outcome, "refused");
    assert.deepEqual(stopped, [], "nothing signalled");
    nothingDeleted();
    assert.match(said.at(-1), /Cannot tell whether PID 55/);
  });

  it("signals nothing and deletes nothing when it cannot tell a process from LP Ranger", async () => {
    const { outcome, said, asked, stopped } = await runWith("YES", {
      running: () => ({
        server: null,
        bot: null,
        unknown: ["PID 44 (tmp/lp-ranger.pid)"],
      }),
    });
    assert.equal(outcome, "refused");
    assert.deepEqual(asked, [], "not asked");
    assert.deepEqual(stopped, []);
    nothingDeleted();
    assert.match(
      said[0],
      /Cannot tell whether PID 44 \(tmp\/lp-ranger\.pid\) is LP Ranger/,
    );
    assert.match(said[0], /Nothing was stopped or deleted\./);
  });

  for (const answer of ["yes", "Yes", "Y", "", "NO", "YES please"])
    it(`stops and deletes nothing on ${JSON.stringify(answer)}`, async () => {
      const { outcome, said, stopped } = await runWith(answer, {
        running: () => ({ server: 11, bot: null, unknown: [] }),
      });
      assert.equal(outcome, "declined");
      assert.deepEqual(stopped, [], "the server was not stopped");
      nothingDeleted();
      const slot = loadConfig(configDir).positions[KEY];
      assert.equal(slot.compoundedAmount0, 1111.16, "the figures kept");
      assert.equal(
        said.at(-1),
        "[delete-all] Cancelled: nothing was stopped or deleted.",
      );
    });

  it("names a file it could not delete, and does not start LP Ranger", async () => {
    // A folder, with a file in it, where the error log should be.
    fs.rmSync(inRoot("logs/error.log"));
    put("logs/error.log/inside");
    const { outcome, said } = await runWith("YES", { serverStartsAfter: true });
    assert.equal(outcome, "failed");
    assert.match(said.at(-1), /Could not delete: logs\/error\.log\./);
    assert.match(said.at(-1), /LP Ranger did not start\./);
  });

  it("run alone, names a file it could not delete, and says how to start LP Ranger again", async () => {
    fs.rmSync(inRoot("logs/error.log"));
    put("logs/error.log/inside");
    const { outcome, said } = await runWith("YES");
    assert.equal(outcome, "failed");
    assert.match(
      said.at(-1),
      /Could not delete: logs\/error\.log\. Delete what is left yourself, then start LP Ranger again with npm run bot for the headless bot, or npm run build-and-start for the server\./,
    );
    assert.doesNotMatch(said.at(-1), /did not start/, "nothing was to start");
  });

  it("deletes the rebalance log outside the install folder too, the file the log's last step is for", async () => {
    const outsideLog = path.join(
      makeTestTempFolder("delete-all-outside"),
      "rebalance_log.json",
    );
    fs.writeFileSync(outsideLog, "[");
    const { outcome } = await runWith("YES", { rebalanceLog: outsideLog });
    assert.equal(outcome, "deleted");
    assert.equal(fs.existsSync(outsideLog), false, "deleted");
  });

  it("leaves a diagnostic log outside the install folder alone, and says so", async () => {
    const outsideFile = path.join(
      makeTestTempFolder("delete-all-outside"),
      "lp-ranger.log",
    );
    fs.writeFileSync(outsideFile, "x");
    const { outcome, said } = await runWith("YES", {
      logs: [outsideFile, inRoot(LOGS[2])],
    });
    assert.equal(outcome, "deleted");
    assert.equal(fs.existsSync(outsideFile), true, "left alone");
    assert.match(
      said.join("\n"),
      /Left alone, being outside the install folder: .*lp-ranger\.log/,
    );
  });
});

/*-
 *  Two commands run the step (the user's ruling, 2026-11-28):
 *  `npm run delete-all-caches-and-logs` alone, which starts nothing after,
 *  the way when you run the headless bot; and
 *  `npm run build-and-start -- --delete-all-caches-and-logs`, which tells
 *  it the server starts after, in place of a headless bot that ran.
 */
describe("what follows the deletion", () => {
  const START_AGAIN =
    "start LP Ranger again with npm run bot for the headless bot, or npm run build-and-start for the server";

  it("run alone, says before YES that nothing starts after it, and how to start LP Ranger again", async () => {
    const { said } = await runWith("no", {
      running: () => ({ server: null, bot: 22, unknown: [] }),
    });
    const warning = said.join("\n");
    assert.ok(
      warning.includes(`Nothing starts after it: ${START_AGAIN}.`),
      warning,
    );
    assert.match(warning, /can take it several hours/);
    assert.doesNotMatch(warning, /the server starts/i);
  });

  it("run alone, ends saying nothing was started, and how to start LP Ranger again", async () => {
    const { outcome, said } = await runWith("YES");
    assert.equal(outcome, "deleted");
    assert.equal(
      said.at(-1),
      `[delete-all] Deleted all of LP Ranger's caches and logs. Nothing was started: ${START_AGAIN}. It rebuilds its caches from the blockchain as it runs.`,
    );
  });

  it("run alone, a program that does not stop leaves nothing deleted, and nothing said of a start", async () => {
    const { outcome, said } = await runWith("YES", {
      running: () => ({ server: null, bot: 22, unknown: [] }),
      stopBot: async () => false,
    });
    assert.equal(outcome, "failed");
    nothingDeleted();
    assert.equal(
      said.at(-1),
      "[delete-all] Could not stop the headless bot (PID 22). Nothing was deleted.",
    );
  });

  it("run by build-and-start, says before YES that the server starts after, in place of the headless bot, naming the command that starts nothing", async () => {
    const { said } = await runWith("no", {
      running: () => ({ server: null, bot: 22, unknown: [] }),
      serverStartsAfter: true,
    });
    const warning = said.join("\n");
    assert.match(
      warning,
      /Then the server starts, and rebuilds LP Ranger's caches from the blockchain as it runs, which can take it several hours\./,
    );
    assert.match(
      warning,
      /The server starts in place of the headless bot\. To start the headless bot again instead, type anything but YES, then run npm run delete-all-caches-and-logs, which starts nothing after\./,
    );
  });

  it("run by build-and-start with no headless bot running, says the server starts, naming no other command", async () => {
    const { said } = await runWith("no", { serverStartsAfter: true });
    const warning = said.join("\n");
    assert.match(warning, /Then the server starts/);
    assert.doesNotMatch(warning, /in place of the headless bot/);
    assert.doesNotMatch(warning, /npm run delete-all-caches-and-logs/);
  });

  it("run by build-and-start, ends saying LP Ranger starts now", async () => {
    const { outcome, said } = await runWith("YES", { serverStartsAfter: true });
    assert.equal(outcome, "deleted");
    assert.equal(
      said.at(-1),
      "[delete-all] Deleted all of LP Ranger's caches and logs. LP Ranger starts now, and rebuilds its caches from the blockchain as it runs.",
    );
  });

  it("gives build-and-start DECLINED_EXIT for an answer other than YES, and exits cleanly for it run alone", () => {
    // Run alone, a cancel is no error: npm would report one for any other status.
    assert.equal(_exitStatus("declined", false), 0);
    assert.equal(_exitStatus("declined", true), DECLINED_EXIT);
    for (const alone of [true, false]) {
      assert.equal(_exitStatus("deleted", alone), 0);
      assert.equal(_exitStatus("refused", alone), 1);
      assert.equal(_exitStatus("failed", alone), 1);
    }
  });
});

/**
 * Run a script named `name`, which `body` makes, from a scratch folder,
 * with `cwd` as its working folder, until `fn` has done with it. Once it
 * has spawned, or, with `ready`, once it has printed that line.
 */
async function withScript(name, body, cwd, fn, ready = null) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "lp-ranger-delete-all-"));
  const script = path.join(dir, name);
  fs.writeFileSync(script, body);
  const child = spawn(process.execPath, [script], {
    stdio: ["ignore", "pipe", "ignore"],
    cwd,
  });
  try {
    await new Promise((resolve) => child.once("spawn", resolve));
    if (ready !== null)
      await new Promise((resolve) =>
        child.stdout.on("data", (d) => {
          if (String(d).includes(ready)) resolve();
        }),
      );
    await fn(child);
  } finally {
    child.kill("SIGKILL");
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/** Write a PID file of the case's install folder. */
function putPid(file, pid) {
  put(file, `${pid}\n`);
}

describe("finding and stopping the programs that run", () => {
  it("finds this install's server and headless bot by their PID files, and only them", async () => {
    const idle = "setTimeout(() => {}, 30000);\n";
    await withScript("server.js", idle, root, async (server) => {
      await withScript("bot.js", idle, root, async (bot) => {
        putPid(SERVER_PID_FILE, server.pid);
        putPid(BOT_PID_FILE, bot.pid);
        assert.deepEqual(runningPrograms(root), {
          server: server.pid,
          bot: bot.pid,
          unknown: [],
        });
        // Each file names the other program: neither is believed.
        putPid(SERVER_PID_FILE, bot.pid);
        putPid(BOT_PID_FILE, server.pid);
        assert.deepEqual(runningPrograms(root), {
          server: null,
          bot: null,
          unknown: [],
        });
      });
    });
  });

  it("takes a PID file whose process is gone, or no file, for a program that does not run", () => {
    assert.deepEqual(runningPrograms(root), {
      server: null,
      bot: null,
      unknown: [],
    });
    putPid(BOT_PID_FILE, 2 ** 22 + 1); // above any PID Linux or macOS issues
    assert.equal(runningPrograms(root).bot, null);
  });

  it("stops a headless bot by the signal it takes for a stop once nothing is under way, and waits for it to exit", async () => {
    /*-
     *  A stand-in that, like src/bot.js, takes SIGUSR2 before anything can
     *  find it, and exits once it is done; it says when it is ready.
     */
    const bot =
      "process.on('SIGUSR2', () => setTimeout(() => process.exit(0), 50));\n" +
      "console.log('ready');\n" +
      "setTimeout(() => {}, 30000);\n";
    await withScript(
      "bot.js",
      bot,
      root,
      async (child) => {
        let exitCode = null;
        const exited = new Promise((resolve) =>
          child.once("exit", (code) => resolve((exitCode = code))),
        );
        assert.equal(await stopBotGently(child.pid, () => {}), true);
        // It had exited when the stop answered: nothing is deleted under it.
        assert.equal(exitCode, 0, "exited by itself before the answer");
        await exited;
      },
      "ready",
    );
  });

  it("answers false for a headless bot it cannot signal", async () => {
    assert.equal(await stopBotGently(2 ** 22 + 1, () => {}), false);
  });
});
