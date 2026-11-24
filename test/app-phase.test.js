"use strict";

/**
 * @file test/app-phase.test.js
 * @description What the app as a whole is doing, where that decides
 *   whether anything may start (src/bot/app-phase.js): the start-up, which
 *   starts the positions saved as managed one at a time, a wallet import,
 *   and the stop for good.
 *
 *   While the start-up runs, a request that would start positions is
 *   refused, naming its progress, and a second start-up does not begin.
 *   While a wallet import runs, a Manage and a second import are refused,
 *   and the import's own closing start-up still begins. Once the app is
 *   stopping, nothing starts and no start-up begins, and nothing clears
 *   it.
 */

const { describe, it, beforeEach } = require("node:test");
const assert = require("node:assert/strict");
const phase = require("../src/bot/app-phase");

beforeEach(() => phase._resetAppPhaseForTests());

describe("the start-up", () => {
  it("is under way from its beginning to its end, with its progress", () => {
    assert.equal(phase.startUpProgress(), null);
    assert.equal(phase.beginStartUp(3), true);
    assert.deepEqual(phase.startUpProgress(), { done: 0, total: 3 });
    phase.noteStartUpProgress(2);
    assert.deepEqual(phase.startUpProgress(), { done: 2, total: 3 });
    phase.endStartUp();
    assert.equal(phase.startUpProgress(), null);
  });

  it("does not begin a second time while the first is under way", () => {
    assert.equal(phase.beginStartUp(2), true);
    assert.equal(phase.beginStartUp(5), false);
    assert.deepEqual(phase.startUpProgress(), { done: 0, total: 2 });
  });

  it("refuses a request that would start positions, naming its progress", () => {
    phase.beginStartUp(4);
    phase.noteStartUpProgress(1);
    assert.match(phase.refusalToStart(), /still starting .*\(1 of 4\)/);
  });

  it("refuses nothing once it has ended", () => {
    phase.beginStartUp(1);
    phase.endStartUp();
    assert.equal(phase.refusalToStart(), null);
  });

  it("hands back a copy of its progress, which the caller cannot change", () => {
    phase.beginStartUp(2);
    phase.startUpProgress().done = 2;
    assert.deepEqual(phase.startUpProgress(), { done: 0, total: 2 });
  });
});

describe("the stop for good", () => {
  it("is not set until a stop marks it, and then stays set", () => {
    assert.equal(phase.isStopping(), false);
    phase.markStopping();
    assert.equal(phase.isStopping(), true);
    phase.endStartUp();
    assert.equal(phase.isStopping(), true);
  });

  it("refuses every request that would start positions", () => {
    phase.markStopping();
    assert.match(phase.refusalToStart(), /stopping/);
  });

  it("keeps a start-up from beginning", () => {
    phase.markStopping();
    assert.equal(phase.beginStartUp(1), false);
    assert.equal(phase.startUpProgress(), null);
  });

  it("names the stop, not the start-up, when both are so", () => {
    phase.beginStartUp(3);
    phase.markStopping();
    assert.match(phase.refusalToStart(), /stopping/);
  });
});

describe("a wallet import", () => {
  it("is under way from its beginning to its end, refusing a Manage meanwhile", () => {
    assert.equal(phase.walletImportUnderWay(), false);
    assert.equal(phase.beginWalletImport(), null);
    assert.equal(phase.walletImportUnderWay(), true);
    assert.match(phase.refusalToStart(), /importing a wallet/);
    phase.endWalletImport();
    assert.equal(phase.walletImportUnderWay(), false);
    assert.equal(phase.refusalToStart(), null);
  });

  it("does not begin during a start-up, another import, or a stop", () => {
    phase.beginStartUp(2);
    assert.match(phase.beginWalletImport(), /still starting/);
    phase.endStartUp();
    assert.equal(phase.beginWalletImport(), null);
    assert.match(phase.beginWalletImport(), /importing a wallet/);
    phase.endWalletImport();
    phase.markStopping();
    assert.match(phase.beginWalletImport(), /stopping/);
    assert.equal(phase.walletImportUnderWay(), false);
  });

  it("lets its own closing start-up begin, naming that start-up's progress", () => {
    phase.beginWalletImport();
    assert.equal(phase.beginStartUp(2), true);
    phase.noteStartUpProgress(1);
    assert.match(phase.refusalToStart(), /still starting .*\(1 of 2\)/);
    phase.endStartUp();
    assert.match(phase.refusalToStart(), /importing a wallet/);
  });
});
