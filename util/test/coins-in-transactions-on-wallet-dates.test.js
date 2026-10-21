"use strict";

/**
 * @file util/test/coins-in-transactions-on-wallet-dates.test.js
 * @description
 * Tests for the calendar side of the wallet bookkeeping report
 * (`util/bookkeeping/coins-in-transactions-on-wallet/dates.js`): reading
 * dates and time zones, turning a range of whole days in a zone into
 * instants, writing an instant as that zone's wall clock, and the last
 * whole day at a moment. The cases that matter most are the nights the
 * clocks change, when a day is 23 or 25 hours long, and the zones whose
 * days straddle two UTC days.
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const { InvalidArgumentError } = require("commander");

const {
  parseDate,
  validTimeZones,
  isValidTimeZone,
  parseTimeZone,
  localTimeZone,
  offsetAt,
  midnightIn,
  nextDay,
  previousDay,
  rangeIn,
  formatIn,
  wholeFrom,
  lastWholeDay,
} = require("../bookkeeping/coins-in-transactions-on-wallet/dates");

const HOUR = 60 * 60 * 1000;

test("parseDate takes a real date written YYYY-MM-DD, and nothing else", () => {
  assert.equal(parseDate("2026-10-19"), "2026-10-19");
  assert.equal(parseDate("2028-02-29"), "2028-02-29");
  for (const bad of ["2026-02-30", "2026-13-01", "2026-1-9", "10/19/2026"]) {
    assert.throws(() => parseDate(bad), InvalidArgumentError, bad);
  }
});

test("validTimeZones lists Node's zones and UTC, sorted, and no designation", () => {
  const zones = validTimeZones();
  assert.deepEqual(zones, [...zones].sort());
  assert.ok(zones.includes("America/Chicago"));
  assert.ok(zones.includes("UTC"));
  assert.deepEqual(
    zones.filter((zone) => !zone.includes("/")),
    ["UTC"],
  );
  assert.equal(zones.length, Intl.supportedValuesOf("timeZone").length + 1);
});

test("parseTimeZone takes a listed name in any case, spelled as listed", () => {
  assert.equal(parseTimeZone("America/Chicago"), "America/Chicago");
  assert.equal(parseTimeZone("america/chicago"), "America/Chicago");
  assert.equal(parseTimeZone("utc"), "UTC");
  assert.equal(isValidTimeZone("AMERICA/CHICAGO"), true);
});

test("parseTimeZone refuses designations, and points to the list", () => {
  // Intl itself takes the legacy EST; the list does not.
  for (const bad of ["CDT", "CST", "EST", "IST", "Mars/Olympus", ""]) {
    assert.throws(
      () => parseTimeZone(bad),
      /not a valid time zone: .*Run with --list-valid-timezones/,
      bad,
    );
    assert.equal(isValidTimeZone(bad), false);
  }
});

test("localTimeZone names this computer's zone, as Intl reports it", () => {
  const local = localTimeZone();
  assert.equal(local, Intl.DateTimeFormat().resolvedOptions().timeZone);
  if (isValidTimeZone(local)) assert.equal(parseTimeZone(local), local);
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

test("previousDay crosses months and years", () => {
  assert.equal(previousDay("2026-10-19"), "2026-10-18");
  assert.equal(previousDay("2026-03-01"), "2026-02-28");
  assert.equal(previousDay("2027-01-01"), "2026-12-31");
});

test("wholeFrom is the first UTC midnight at or after a day's end", () => {
  assert.equal(wholeFrom("2026-10-19", "UTC"), Date.UTC(2026, 9, 20));
  // Ends at 05:00 UTC on the 20th (CDT), so whole when the 20th ends.
  assert.equal(
    wholeFrom("2026-10-19", "America/Chicago"),
    Date.UTC(2026, 9, 21),
  );
  // Ends at 15:00 UTC on the 19th, whole when that UTC day ends.
  assert.equal(wholeFrom("2026-10-19", "Asia/Tokyo"), Date.UTC(2026, 9, 20));
  // 2026-11-01 is 25 hours long in Chicago, ending at 06:00 UTC (CST).
  assert.equal(
    wholeFrom("2026-11-01", "America/Chicago"),
    Date.UTC(2026, 10, 3),
  );
});

test("lastWholeDay in UTC is yesterday", () => {
  assert.equal(lastWholeDay(Date.UTC(2026, 9, 21, 0), "UTC"), "2026-10-20");
  assert.equal(
    lastWholeDay(Date.UTC(2026, 9, 21, 23, 59, 59, 999), "UTC"),
    "2026-10-20",
  );
});

test("lastWholeDay west of Greenwich waits for the UTC day of a day's last hour", () => {
  const zone = "America/Chicago";
  // 18:59 CDT on the 21st: the 20th's last hours are on the UTC 21st.
  assert.equal(lastWholeDay(Date.UTC(2026, 9, 21, 23, 59), zone), "2026-10-19");
  // 19:00 CDT on the 21st, the UTC 21st has ended: the 20th is whole.
  assert.equal(lastWholeDay(Date.UTC(2026, 9, 22, 0), zone), "2026-10-20");
  // 01:00 CDT on the 21st: yesterday has ended, its UTC day has not.
  assert.equal(lastWholeDay(Date.UTC(2026, 9, 21, 6), zone), "2026-10-19");
});

test("lastWholeDay east of Greenwich waits for the UTC day a day ends in", () => {
  const zone = "Asia/Tokyo";
  // 09:00 on the 21st in Tokyo: the 20th ended at 15:00 UTC on the 20th.
  assert.equal(lastWholeDay(Date.UTC(2026, 9, 21, 0), zone), "2026-10-20");
  // 05:00 on the 22nd in Tokyo: the 21st ended, but its UTC day has not.
  assert.equal(lastWholeDay(Date.UTC(2026, 9, 21, 20), zone), "2026-10-20");
});

test("every day up to lastWholeDay is whole, and the day after is not", () => {
  const zones = ["UTC", "America/Chicago", "Asia/Tokyo", "Asia/Kolkata"];
  for (const zone of zones) {
    for (let hour = 0; hour < 48; hour += 1) {
      const now = Date.UTC(2026, 10, 1, hour);
      const last = lastWholeDay(now, zone);
      const label = `${zone} at ${new Date(now).toISOString()}`;
      assert.ok(wholeFrom(last, zone) <= now, label);
      assert.ok(wholeFrom(nextDay(last), zone) > now, label);
    }
  }
});
