/**
 * @file test/server-shutdown.test.js
 * @description
 * The shutdown notification is the one message the app sends that does
 * not go through `notify`, so it is the one whose escaping nothing else
 * checks.
 *
 * That matters more than its size. It is sent by a detached child as
 * the server exits, its result is logged into a shutting-down process,
 * and the plain-text fallback means a refusal still delivers something
 * — so a broken version of it would look exactly like a working one.
 * Nobody is reading the log at that moment.
 *
 * Its prose is fixed, which is the trap: a message with no variables
 * looks like it cannot break, and then someone adds a clause with a
 * hyphen or an exclamation mark in it.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

const {
  buildShutdownMessage,
} = require("../src/telegram-notifications/server-shutdown");
const { assertValidMarkdownV2 } = require("./helpers/markdown-v2");

describe("server-shutdown — the message Telegram receives", () => {
  it("is valid MarkdownV2 for this machine's hostname", () => {
    const { text } = buildShutdownMessage();
    assertValidMarkdownV2(text, "shutdown message");
  });

  it("stays valid for hostnames full of reserved characters", () => {
    /*- Hostnames are not ours to choose. A hyphen is the ordinary case
     *  and already reserved in MarkdownV2; the rest are here because
     *  the rule does not care how likely a character is. */
    const hosts = [
      "lp-ranger-1",
      "pop-os-cmb-1",
      "my_server",
      "host.with.dots",
      "weird*name",
      "brace{host}",
      "bang!",
      "back\\slash",
      "every_-.!*[]()~`>#+=|{}",
    ];
    for (const host of hosts) {
      const { text } = buildShutdownMessage(host);
      assertValidMarkdownV2(text, `shutdown message for ${host}`);
    }
  });

  it("keeps the words readable once Telegram unescapes them", () => {
    /*- Escaping must not change what is read. Telegram drops one
     *  backslash before each escaped character, so undoing that has to
     *  give back the plain form exactly. */
    for (const host of ["lp-ranger-1", "my_server", "back\\slash"]) {
      const { text, plain } = buildShutdownMessage(host);
      assert.strictEqual(text.replace(/\\(.)/gs, "$1"), plain);
    }
  });

  it("says what it is for, and names the machine", () => {
    /*- The escaping tests above would all pass on an empty string, so
     *  one assertion holds the content itself. */
    const { plain } = buildShutdownMessage("some-host");
    assert.ok(plain.includes("some-host"), plain);
    assert.ok(plain.includes("shutting down"), plain);
  });
});
