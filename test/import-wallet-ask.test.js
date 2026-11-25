"use strict";

/**
 * @file test/import-wallet-ask.test.js
 * @description How the import script asks for a secret
 *   (scripts/_import-wallet-ask.js): the answer comes back trimmed, and a
 *   prompt closed with nothing typed stops the import, nothing imported,
 *   rather than failing on the missing answer. The prompt and the stop
 *   are stand-ins, so nothing is typed and no process ends.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const util = require("node:util");
const { askForImport } = require("../scripts/_import-wallet-ask");
const { _setSinkForTests } = require("../src/lib/log");

test("the answer comes back trimmed", async () => {
  const answer = await askForImport("Key: ", {
    ask: async () => "  0xabc \n",
    stop: () => "stopped",
  });
  assert.equal(answer, "0xabc");
});

test("a prompt closed with nothing typed stops the import, saying so", async () => {
  const said = [];
  let stops = 0;
  let answer;
  // The log module's seam for its output, put back in the `finally`.
  const restoreLog = _setSinkForTests({
    error: (...args) => said.push(util.format(...args)),
  });
  try {
    answer = await askForImport("Key: ", {
      ask: async () => null,
      stop: () => {
        stops++;
        return "stopped";
      },
    });
  } finally {
    restoreLog();
  }
  assert.equal(stops, 1);
  assert.equal(answer, "stopped");
  assert.match(said.join("\n"), /Nothing was imported\./);
});
