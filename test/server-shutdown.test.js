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
 *
 * The same goes for the sender it starts: a path that names no file
 * fails just as quietly, so the last test holds where the sender is.
 */

"use strict";

const { describe, it } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const {
  buildShutdownMessage,
  notifyFileProblemBeforeExit,
  _SEND_SCRIPT,
} = require("../src/server/telegram-notifications/server-shutdown");
const telegram = require("../src/lib/telegram-notifications/telegram");
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

describe("server-shutdown — the sender it starts", () => {
  it("starts src/telegram-send.js, and the file is there", () => {
    /*- The sender runs detached, its output thrown away, so a path that
     *  names no file leaves no trace: the shutdown alert never arrives. */
    assert.equal(
      _SEND_SCRIPT,
      path.join(__dirname, "..", "src", "telegram-send.js"),
    );
    assert.ok(fs.existsSync(_SEND_SCRIPT), _SEND_SCRIPT);
  });
});

describe("server-shutdown — the file failure's alert, as the server stops for it", () => {
  const WORDS =
    "LP Ranger could not write to /srv/app-data/rebalance_log.json: the disk is full.\n\n" +
    "Free some space on the disk.";

  it("is the alert for other errors, with the words and the error, valid MarkdownV2", () => {
    const { text, plain } = telegram.alertMessage("otherError", {
      message: WORDS,
      error: "ENOSPC: no space left on device",
    });
    assertValidMarkdownV2(text);
    assert.match(plain, /Other Error/);
    assert.ok(plain.includes(WORDS), plain);
    assert.match(plain, /Error: ENOSPC: no space left on device/);
  });

  it("is sent only once Telegram holds its keys and the alert is on", () => {
    /*-
     *  Before the unlock the keys are not read, so the stop goes on with
     *  the log line alone (the user's ruling, 2026-11-27); nothing is
     *  started then.
     */
    assert.equal(telegram.isConfigured(), false, "no keys in this test");
    assert.equal(telegram.wouldSend("otherError"), false);
    // A stand-in sender: a real one would reach Telegram from the test.
    notifyFileProblemBeforeExit(WORDS, "ENOSPC", () =>
      assert.fail("sent with no Telegram keys"),
    );
  });

  it("is handed to the sender with the keys held and the alert on, and not with the alert off", () => {
    /*-
     *  TEST-ONLY: the Telegram keys and switches are set in memory and put
     *  back in the `finally`; the sender is a stand-in, so nothing leaves
     *  the machine.
     */
    const sent = [];
    const send = (text, plain) => sent.push({ text, plain });
    const before = telegram.getEnabledEvents();
    telegram.setBotToken("123:test");
    telegram.setChatId("42");
    try {
      telegram.setEnabledEvents({ otherError: false });
      notifyFileProblemBeforeExit(WORDS, "ENOSPC", send);
      assert.deepEqual(sent, [], "the alert off: nothing sent");
      telegram.setEnabledEvents({ otherError: true });
      notifyFileProblemBeforeExit(WORDS, "ENOSPC", send);
      assert.equal(sent.length, 1, "sent once");
      assert.ok(sent[0].plain.includes(WORDS), sent[0].plain);
      assertValidMarkdownV2(sent[0].text);
    } finally {
      telegram.setBotToken(null);
      telegram.setChatId(null);
      telegram.setEnabledEvents(before);
    }
  });

  it("would be sent with the keys held and the alert on, and not with the alert off", () => {
    /*-
     *  TEST-ONLY: the Telegram keys and switches are set in memory and put
     *  back in the `finally`; nothing is sent, since only `wouldSend` is
     *  asked.
     */
    const before = telegram.getEnabledEvents();
    telegram.setBotToken("123:test");
    telegram.setChatId("42");
    try {
      telegram.setEnabledEvents({ otherError: true });
      assert.equal(telegram.wouldSend("otherError"), true);
      telegram.setEnabledEvents({ otherError: false });
      assert.equal(telegram.wouldSend("otherError"), false);
    } finally {
      telegram.setBotToken(null);
      telegram.setChatId(null);
      telegram.setEnabledEvents(before);
    }
  });
});
