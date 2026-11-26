"use strict";

/**
 * @file test/script-args.test.js
 * @description How a script that changes something reads its arguments
 *   (scripts/_script-args.js): `--help` prints its help and stops, and an
 *   argument it does not take is refused with exit status 2, both before
 *   it does anything. And that scripts/reset-wallet.js, scripts/stop.js
 *   and scripts/clear-blockchain-scan-cache.js answer them before their
 *   first act. Those three are read, not run: running them would delete
 *   the operator's wallet, stop a running server, or empty the scan
 *   caches.
 */

const { describe, it, afterEach } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const {
  readScriptArgs,
  answeredWithoutWork,
} = require("../scripts/_script-args");

const ROOT = path.join(__dirname, "..");
const TEXT = { tag: "x", help: "HELP", nothing: "Nothing was deleted." };

/** What a call to `answeredWithoutWork` wrote, and its answer. */
function answer(argv, takes) {
  const out = [];
  const err = [];
  const answered = answeredWithoutWork(readScriptArgs(argv, takes), TEXT, {
    out: (s) => out.push(s),
    err: (s) => err.push(s),
  });
  return { answered, out, err };
}

afterEach(() => {
  process.exitCode = undefined;
});

describe("a script's arguments", () => {
  it("are none by default", () => {
    const args = readScriptArgs([]);
    assert.equal(args.help, false);
    assert.equal(args.flags.size, 0);
    assert.equal(args.bad, null);
  });

  it("ask for help with --help or -h", () => {
    assert.equal(readScriptArgs(["--help"]).help, true);
    assert.equal(readScriptArgs(["-h"]).help, true);
  });

  it("hold the flags the script takes, and name the first it does not", () => {
    const args = readScriptArgs(["--dry-run", "--hlep", "--x"], ["--dry-run"]);
    assert.equal(args.flags.has("--dry-run"), true);
    assert.equal(args.bad, "--hlep");
  });
});

describe("answering them before any work", () => {
  it("prints the help for --help, and the run is over", () => {
    const r = answer(["--help"]);
    assert.equal(r.answered, true);
    assert.deepEqual(r.out, ["HELP"]);
    assert.equal(process.exitCode, undefined);
  });

  it("refuses an argument the script does not take, with exit status 2", () => {
    const r = answer(["--hlep"]);
    assert.equal(r.answered, true);
    assert.match(r.err[0], /^\[x\] Unrecognized argument: --hlep\. /);
    assert.match(r.err[0], /Nothing was deleted\./);
    assert.match(r.err[0], /HELP$/);
    assert.equal(process.exitCode, 2);
  });

  it("leaves the work to the script when neither is given", () => {
    const r = answer(["--dry-run"], ["--dry-run"]);
    assert.equal(r.answered, false);
    assert.deepEqual(r.out, []);
    assert.deepEqual(r.err, []);
  });
});

describe("a script that changes something", () => {
  // Each script, and the first thing its main() does once arguments pass.
  const SCRIPTS = [
    ["scripts/reset-wallet.js", "deleteWalletFiles();"],
    ["scripts/stop.js", "stopServer();"],
    ["scripts/clear-blockchain-scan-cache.js", "waitForServerExit();"],
  ];
  for (const [file, firstAct] of SCRIPTS)
    it(`${file} answers its arguments before it does anything`, () => {
      const src = fs.readFileSync(path.join(ROOT, file), "utf8");
      const main = src.indexOf("function main() {");
      assert.ok(main > 0, "a main()");
      const check = src.indexOf(
        "if (answeredWithoutWork(args, text)) return;",
        main,
      );
      const act = src.indexOf(firstAct, main);
      assert.ok(check > main, "the check is in main()");
      assert.ok(act > check, `${firstAct} only after the check`);
      assert.match(src, /readScriptArgs\(process\.argv\.slice\(2\)/);
      assert.match(src, /if \(require\.main === module\) main\(\);/);
    });
});
