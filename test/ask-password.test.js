"use strict";

/**
 * @file test/ask-password.test.js
 * @description
 * Tests for the terminal prompt for a secret (src/lib/ask-password.js): what
 * is typed reaches the caller, and none of it reaches the screen. The
 * keys are written to a stream standing in for the terminal, and what the
 * prompt shows is gathered from a stream standing in for stderr.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { PassThrough, Writable } = require("stream");
const { askPassword } = require("../src/lib/ask-password");

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

test("a backspace still edits the answer, and nothing of it shows", async () => {
  const input = new PassThrough();
  const { output, shown } = screen();
  const answer = askPassword("Password: ", { input, output });
  input.write("hunterX\x7f2\r");
  assert.equal(await answer, "hunter2");
  assert.equal(shown.join(""), "Password: \n");
});
