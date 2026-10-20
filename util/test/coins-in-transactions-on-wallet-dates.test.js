"use strict";

/**
 * @file util/test/coins-in-transactions-on-wallet-dates.test.js
 * @description
 * Tests for the calendar side of the wallet bookkeeping report
 * (`util/bookkeeping/coins-in-transactions-on-wallet/dates.js`): reading
 * dates and time zones, turning a range of whole days in a zone into
 * instants, and writing an instant as that zone's wall clock. The cases
 * that matter most are the nights the clocks change, when a day is 23 or
 * 25 hours long.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { InvalidArgumentError } = require("commander");

const {
  parseDate,
  parseTimeZone,
  localTimeZone,
  offsetAt,
  midnightIn,
  nextDay,
  rangeIn,
  formatIn,
} = require("../bookkeeping/coins-in-transactions-on-wallet/dates");

const HOUR = 60 * 60 * 1000;

test("parseDate takes a real date written YYYY-MM-DD, and nothing else", () => {
  assert.equal(parseDate("2026-10-19"), "2026-10-19");
  assert.equal(parseDate("2028-02-29"), "2028-02-29");
  for (const bad of ["2026-02-30", "2026-13-01", "2026-1-9", "10/19/2026"]) {
    assert.throws(() => parseDate(bad), InvalidArgumentError, bad);
  }
});

test("parseTimeZone takes an IANA name and refuses an unknown one", () => {
  assert.equal(parseTimeZone("America/Chicago"), "America/Chicago");
  assert.equal(parseTimeZone("UTC"), "UTC");
  assert.throws(() => parseTimeZone("Mars/Olympus"), /not a time zone/);
});

test("localTimeZone names a zone parseTimeZone takes", () => {
  assert.equal(parseTimeZone(localTimeZone()), localTimeZone());
});

test("offsetAt reads a zone's offset, daylight saving included", () => {
  assert.equal(offsetAt(Date.UTC(2026, 0, 15, 12), "UTC"), 0);
  assert.equal(
    offsetAt(Date.UTC(2026, 0, 15, 12), "America/Chicago"),
    -6 * HOUR,
  );
  assert.equal(
    offsetAt(Date.UTC(2026, 6, 15, 12), "America/Chicago"),
    -5 * HOUR,
  );
  assert.equal(offsetAt(Date.UTC(2026, 6, 15, 12), "Asia/Kolkata"), 5.5 * HOUR);
});

test("midnightIn finds a day's first moment in the zone", () => {
  assert.equal(midnightIn("2026-10-19", "UTC"), Date.UTC(2026, 9, 19));
  assert.equal(
    midnightIn("2026-10-19", "America/Chicago"),
    Date.UTC(2026, 9, 19, 5),
  );
  assert.equal(
    midnightIn("2026-10-19", "Asia/Kolkata"),
    Date.UTC(2026, 9, 18, 18, 30),
  );
});

test("midnightIn holds on the nights the clocks change", () => {
  // The United States' clocks go forward on 2026-03-08 and back on 2026-11-01.
  assert.equal(
    midnightIn("2026-03-08", "America/Chicago"),
    Date.UTC(2026, 2, 8, 6),
  );
  assert.equal(
    midnightIn("2026-03-09", "America/Chicago"),
    Date.UTC(2026, 2, 9, 5),
  );
  assert.equal(
    midnightIn("2026-11-01", "America/Chicago"),
    Date.UTC(2026, 10, 1, 5),
  );
  assert.equal(
    midnightIn("2026-11-02", "America/Chicago"),
    Date.UTC(2026, 10, 2, 6),
  );
});

test("nextDay crosses months and years", () => {
  assert.equal(nextDay("2026-10-19"), "2026-10-20");
  assert.equal(nextDay("2026-02-28"), "2026-03-01");
  assert.equal(nextDay("2026-12-31"), "2027-01-01");
});

test("rangeIn runs from the first day's start to the day after the last", () => {
  const { startMs, endMs } = rangeIn(
    "2026-10-19",
    "2026-10-19",
    "America/Chicago",
  );
  assert.equal(startMs, Date.UTC(2026, 9, 19, 5));
  assert.equal(endMs, Date.UTC(2026, 9, 20, 5));
  const fallBack = rangeIn("2026-11-01", "2026-11-01", "America/Chicago");
  assert.equal(fallBack.endMs - fallBack.startMs, 25 * HOUR);
});

test("formatIn writes an instant as the zone's wall clock", () => {
  const ms = Date.UTC(2026, 9, 19, 11, 11, 15);
  assert.equal(formatIn(ms, "America/Chicago"), "2026-10-19 06:11:15");
  assert.equal(formatIn(ms, "UTC"), "2026-10-19 11:11:15");
  assert.equal(
    formatIn(Date.UTC(2026, 9, 19, 5), "America/Chicago"),
    "2026-10-19 00:00:00",
  );
});
