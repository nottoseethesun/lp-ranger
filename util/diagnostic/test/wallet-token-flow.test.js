/**
 * @file util/diagnostic/test/wallet-token-flow.test.js
 * @description
 * Tests for the pure helpers in wallet-token-flow/index.js.  The CLI
 * `main()` is gated behind `require.main === module`.
 */

"use strict";

const { test } = require("node:test");
const assert = require("node:assert/strict");

const {
  parseDateArg,
  dateStartSec,
  dateEndSec,
  fmtAmount,
  buildProgram,
  dateWindowToBlocks,
} = require("../wallet-token-flow");

test("parseDateArg — recognises --from and --to with YYYY-MM-DD", () => {
  assert.deepEqual(parseDateArg("--from=2026-04-28"), {
    kind: "from",
    date: "2026-04-28",
  });
  assert.deepEqual(parseDateArg("--to=2026-04-28"), {
    kind: "to",
    date: "2026-04-28",
  });
});

test("parseDateArg — rejects malformed forms", () => {
  assert.equal(parseDateArg("--from=2026/04/28"), null);
  assert.equal(parseDateArg("--from=04-28-2026"), null);
  assert.equal(parseDateArg("--unrelated=2026-04-28"), null);
  assert.equal(parseDateArg("not-a-flag"), null);
});

test("dateStartSec — returns midnight UTC unix seconds", () => {
  const expected = Math.floor(Date.UTC(2026, 3, 28, 0, 0, 0) / 1000);
  assert.equal(dateStartSec("2026-04-28"), expected);
});

test("dateEndSec — returns 23:59:59 UTC unix seconds", () => {
  const expected = Math.floor(Date.UTC(2026, 3, 28, 23, 59, 59) / 1000);
  assert.equal(dateEndSec("2026-04-28"), expected);
});

test("dateEndSec — is exactly 86399 seconds after dateStartSec", () => {
  assert.equal(dateEndSec("2026-04-28") - dateStartSec("2026-04-28"), 86399);
});

test("fmtAmount — renders zero unconditionally", () => {
  assert.equal(fmtAmount(0n, 18), "0");
});

test("fmtAmount — formats whole-token quantities cleanly", () => {
  /*- 1 token with 18 decimals = 1e18 raw units. */
  assert.equal(fmtAmount(10n ** 18n, 18), "1");
});

test("fmtAmount — keeps fractional part trimmed of trailing zeros", () => {
  /*- 1.5 wPLS = 1.5 × 1e18 = 1500000000000000000. */
  assert.equal(fmtAmount(1500000000000000000n, 18), "1.5");
});

test("fmtAmount — caps fractional output at 8 decimal places", () => {
  /*- 1.123456789012 (12 fractional digits) is truncated to 8. */
  assert.equal(fmtAmount(1123456789012000000n, 18), "1.12345678");
});

test("fmtAmount — handles sub-1 amounts correctly", () => {
  /*- 0.5 token = 5 × 10^17 raw, 18 decimals. */
  assert.equal(fmtAmount(5n * 10n ** 17n, 18), "0.5");
});

test("buildProgram — collects positional args and date options", () => {
  const p = buildProgram().parse(
    ["0xWALLET", "0xTOKEN", "--from=2026-04-01", "--to=2026-04-28"],
    { from: "user" },
  );
  assert.deepEqual(p.args, ["0xWALLET", "0xTOKEN"]);
  assert.equal(p.opts().from, "2026-04-01");
  assert.equal(p.opts().to, "2026-04-28");
});

test("buildProgram — accepts the space form as well as the equals form", () => {
  /*- The old hand-rolled parser matched `--from=DATE` with a regex and
   *  silently ignored `--from DATE`; a parser handles both. */
  const p = buildProgram().parse(
    ["0xWALLET", "0xTOKEN", "--from", "2026-04-01"],
    { from: "user" },
  );
  assert.equal(p.opts().from, "2026-04-01");
});

test("buildProgram — leaves missing date options undefined", () => {
  const p = buildProgram().parse(["0xWALLET", "0xTOKEN"], { from: "user" });
  assert.equal(p.opts().from, undefined);
  assert.equal(p.opts().to, undefined);
});

test("buildProgram — refuses a date that is not YYYY-MM-DD", () => {
  /*- Refused while parsing, so a malformed date cannot become a
   *  nonsensical block window further down. */
  assert.throws(
    () =>
      buildProgram()
        .exitOverride()
        .configureOutput({ writeErr: () => {} })
        .parse(["0xW", "0xT", "--from", "April 1st"], { from: "user" }),
    /YYYY-MM-DD/,
  );
});

test("dateWindowToBlocks — defaults to last-24h when no dates given", () => {
  const head = 1_000_000;
  const headTs = Math.floor(Date.now() / 1000);
  const { fromBlock, toBlock } = dateWindowToBlocks(null, null, head, headTs);
  /*- 86400 seconds back at 10s/block ≈ 8640 blocks earlier. */
  assert.equal(toBlock, head, "to-block should be head when no --to");
  assert.ok(fromBlock < head);
  assert.ok(fromBlock >= head - 9000 && fromBlock <= head - 8000);
});

test("dateWindowToBlocks — clamps fromBlock at 1 when negative", () => {
  const head = 100;
  const headTs = Math.floor(Date.now() / 1000);
  const { fromBlock } = dateWindowToBlocks("2000-01-01", null, head, headTs);
  assert.equal(fromBlock, 1);
});
