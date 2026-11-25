"use strict";

/**
 * @file test/ask-password.test.js
 * @description
 * Tests for the terminal prompt for a secret (src/lib/ask-password.js): what
 * is typed reaches the caller, and none of it reaches the screen; a prompt
 * whose input ends with nothing typed answers null, and says why. The
 * keys are written to a stream standing in for the terminal, and what the
 * prompt shows is gathered from a stream standing in for stderr.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const util = require("node:util");
const { PassThrough, Writable } = require("stream");
const { askPassword } = require("../src/lib/ask-password");
const { _setSinkForTests } = require("../src/lib/log");

/**
 * A stand-in for stderr that keeps what is written to it.
 * @returns {{output: Writable, shown: string[]}}
 */
function screen() {
  const shown = [];
  const output = new Writable({
    write(chunk, _encoding, done) {
      shown.push(chunk.toString());
      done();
    },
  });
  return { output, shown };
}

test("a typed answer reaches the caller, and nothing of it shows", async () => {
  const input = new PassThrough();
  const { output, shown } = screen();
  const answer = askPassword("Password: ", { input, output });
  input.write("hunter2\r");
  assert.equal(await answer, "hunter2");
  assert.equal(shown.join(""), "Password: \n");
});

test("answers null, saying why, when the input ends with nothing typed", async () => {
  /*-
   *  As when nothing can be typed: a service manager starting LP Ranger
   *  with its input on /dev/null, which ends at once. Readline never
   *  answers then, and the prompt must not wait for ever.
   */
  const input = new PassThrough();
  const { output } = screen();
  const warned = [];
  // The log module's seam for its output, put back in the `finally`.
  const restoreLog = _setSinkForTests({
    warn: (...args) => warned.push(util.format(...args)),
  });
  try {
    const answer = askPassword("Password: ", { input, output });
    input.end();
    assert.equal(await answer, null);
  } finally {
    restoreLog();
  }
  assert.equal(warned.length, 1);
  assert.match(warned[0], /The prompt closed before anything was typed/);
  assert.match(warned[0], /no terminal to type into/);
});

test("a typed answer is not followed by the warning", async () => {
  const input = new PassThrough();
  const { output } = screen();
  const warned = [];
  const restoreLog = _setSinkForTests({
    warn: (...args) => warned.push(util.format(...args)),
  });
  try {
    const answer = askPassword("Password: ", { input, output });
    input.write("hunter2\r");
    input.end();
    assert.equal(await answer, "hunter2");
  } finally {
    restoreLog();
  }
  assert.deepEqual(warned, []);
});

test("a backspace still edits the answer, and nothing of it shows", async () => {
  const input = new PassThrough();
  const { output, shown } = screen();
  const answer = askPassword("Password: ", { input, output });
  input.write("hunterX\x7f2\r");
  assert.equal(await answer, "hunter2");
  assert.equal(shown.join(""), "Password: \n");
});
