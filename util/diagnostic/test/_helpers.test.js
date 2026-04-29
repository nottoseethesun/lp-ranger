/**
 * @file util/diagnostic/test/_helpers.test.js
 * @description
 * Tests for the shared pure helpers in util/diagnostic/_helpers.js.
 * These run via `npm run test:util` and stay out of CI / pre-commit.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const { sleep, addrTopic, addrFromTopic, fmtTs } = require("../_helpers");

test("addrTopic — pads a 20-byte address to a 32-byte topic", () => {
  const addr = "0x4e44847675763D5540B32Bee8a713CfDcb4bE61A";
  const topic = addrTopic(addr);
  assert.equal(topic.length, 66, "topic must be 0x + 64 hex chars");
  assert.ok(topic.startsWith("0x"));
  assert.equal(
    topic,
    "0x0000000000000000000000004e44847675763d5540b32bee8a713cfdcb4be61a",
  );
});

test("addrTopic — accepts both checksummed and lowercase input", () => {
  const upper = addrTopic("0x4e44847675763D5540B32Bee8a713CfDcb4bE61A");
  const lower = addrTopic("0x4e44847675763d5540b32bee8a713cfdcb4be61a");
  assert.equal(upper, lower);
});

test("addrTopic — handles input without 0x prefix", () => {
  const withoutPrefix = addrTopic("4e44847675763d5540b32bee8a713cfdcb4be61a");
  const withPrefix = addrTopic("0x4e44847675763d5540b32bee8a713cfdcb4be61a");
  assert.equal(withoutPrefix, withPrefix);
});

test("addrFromTopic — recovers a checksummed address from a topic", () => {
  const fakeEthers = {
    getAddress: (a) => a.toUpperCase().replace("0X", "0x"),
  };
  const topic =
    "0x0000000000000000000000004e44847675763d5540b32bee8a713cfdcb4be61a";
  const recovered = addrFromTopic(topic, fakeEthers);
  /*- We use a fake ethers stub so the test stays pure-JS — the only
      thing we care about is that the helper passes the trimmed
      0x-prefixed last-20-bytes hex string into ethers.getAddress. */
  assert.equal(
    recovered,
    "0x4E44847675763D5540B32BEE8A713CFDCB4BE61A",
    "should call ethers.getAddress with the last 20 bytes of the topic",
  );
});

test("fmtTs — formats unix seconds as YYYY-MM-DD HH:MM:SS UTC", () => {
  const sec = Math.floor(Date.UTC(2026, 0, 15, 12, 30, 45) / 1000);
  assert.equal(fmtTs(sec), "2026-01-15 12:30:45 UTC");
});

test("fmtTs — returns em-dash for falsy input", () => {
  assert.equal(fmtTs(null), "—");
  assert.equal(fmtTs(undefined), "—");
  assert.equal(fmtTs(0), "—");
});

test("sleep — resolves after at least the requested delay", async () => {
  const start = Date.now();
  await sleep(20);
  const elapsed = Date.now() - start;
  assert.ok(elapsed >= 18, `expected ≥18ms, got ${elapsed}ms`);
});
