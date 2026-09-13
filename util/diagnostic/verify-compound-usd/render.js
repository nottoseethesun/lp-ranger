/**
 * @file util/diagnostic/verify-compound-usd/render.js
 * @description
 * Every console-emitting function for `verify-compound-usd`.  Split out
 * of `index.js` to keep that file under the 500 non-comment-line cap
 * once the render layer was exported for testing.
 *
 * The split is along a real seam, not an arbitrary line count: this
 * module owns presentation only.  It computes nothing an operator
 * could act on — all the arithmetic and classification lives in
 * `./analysis.js` — and it performs no I/O beyond `console.log` and,
 * in `renderEvents`, block-timestamp lookups through an injected
 * provider.  That is what makes the whole layer testable by capturing
 * console output, which the
 * `util/diagnostic/test/verify-compound-usd-render.test.js` suite does.
 */

"use strict";

const { fmtTs } = require("../_helpers");
const {
  SHIFT_RANGE,
  usdOf,
  impliedPrices,
  decimalsShiftCandidates,
  recordedAmountsMatch,
  splitHistoryByNft,
  classifyIl,
  fmtUsd,
  fmtPrice,
  fmtRatio,
} = require("./analysis");

/** Ratio of an implied price to its live counterpart, or null. */
function _impliedRatio(implied, live) {
  return live > 0 && implied !== null ? implied / live : null;
}

/** Print the per-source price table for both tokens. */
function renderPrices(pos, px0, px1) {
  const row = (label, sym, p) => {
    const moralis = p.moralis === null ? "(no API key)" : fmtPrice(p.moralis);
    console.log(
      `  ${label} ${sym.padEnd(8)} cascade=${fmtPrice(p.cascade)}  ` +
        `Moralis=${moralis}  GeckoTerminal=${fmtPrice(p.gecko)}  ` +
        `DexScreener=${fmtPrice(p.dex)}`,
    );
  };
  console.log("\nLive USD prices (per source)");
  row("token0", pos.sym0, px0);
  row("token1", pos.sym1, px1);
  console.log(
    "  Sources should agree closely.  A single outlier is the price feed",
  );
  console.log(
    "  to distrust; the cascade is Moralis → GeckoTerminal → DexScreener,",
  );
  console.log("  first non-zero wins.");
}

/** Print one row of the on-chain event table. */
function renderEventRow(when, kind, ev, pos, p0, p1) {
  const a0 = (Number(ev.raw0) / 10 ** pos.d0).toFixed(4);
  const a1 = (Number(ev.raw1) / 10 ** pos.d1).toFixed(4);
  const usd = usdOf(ev.raw0, ev.raw1, pos.d0, pos.d1, p0, p1);
  console.log(
    `  ${when.padEnd(24)} ${kind.padEnd(10)} ${a0.padStart(16)} ` +
      `${a1.padStart(16)} ${fmtUsd(usd).padStart(14)}`,
  );
}

/** Print the hypothesis block explaining a reported figure. */
function renderHypotheses(reportedUsd, ev, tok) {
  const imp = impliedPrices(reportedUsd, ev, tok);
  const gap = reportedUsd - imp.liveUsd;
  console.log(`    reported            ${fmtUsd(reportedUsd)}`);
  console.log(
    `    recomputed @live    ${fmtUsd(imp.liveUsd)}   gap ${fmtUsd(gap)}`,
  );
  console.log(
    `    implied price0      ${fmtPrice(imp.impliedP0)}  ` +
      `vs live ${fmtPrice(tok.p0)}  ` +
      `ratio ${fmtRatio(_impliedRatio(imp.impliedP0, tok.p0))}`,
  );
  console.log(
    `    implied price1      ${fmtPrice(imp.impliedP1)}  ` +
      `vs live ${fmtPrice(tok.p1)}  ` +
      `ratio ${fmtRatio(_impliedRatio(imp.impliedP1, tok.p1))}`,
  );
  console.log(`    uniform price scale ${fmtRatio(imp.uniformScale)}`);
  const shifts = decimalsShiftCandidates(reportedUsd, ev, tok);
  if (shifts.length === 0) {
    console.log(
      `    decimals shift      no (decimals0, decimals1) within ` +
        `±${SHIFT_RANGE} reproduces this`,
    );
    return;
  }
  for (const s of shifts) {
    console.log(
      `    decimals shift      d0=${s.d0} d1=${s.d1} → ${fmtUsd(s.usd)}  ` +
        `(off by ${(s.rel * 100).toFixed(2)}%)`,
    );
  }
}

/**
 * Print the recorded-vs-chain comparison for one compoundHistory row.
 *
 * @returns {boolean} true when chain amounts × the row's own recorded
 *   prices reproduce its stored `usdValue`.  The caller uses this to
 *   suppress the live-price hypothesis block, which would otherwise
 *   "explain" a gap that is nothing but market drift since the row was
 *   written.
 */
function renderRecorded(row, ev, tok) {
  const rp0 = Number(row.price0);
  const rp1 = Number(row.price1);
  console.log(`\n  compoundHistory row  tx ${row.txHash || "—"}`);
  console.log(`    timestamp           ${row.timestamp || "—"}`);
  console.log(`    recorded usdValue   ${fmtUsd(row.usdValue)}`);
  const amountsOk = recordedAmountsMatch(row, ev);
  console.log(
    "    recorded amounts    " +
      (amountsOk
        ? "✓ match the chain's IncreaseLiquidity"
        : "✗ DIFFER from chain"),
  );
  if (!amountsOk) {
    console.log(
      `      stored ${row.amount0Deposited}/${row.amount1Deposited}, ` +
        `chain ${ev.raw0}/${ev.raw1}`,
    );
  }
  console.log(
    `    recorded price0     ${fmtPrice(rp0)}  ` +
      `vs live ${fmtPrice(tok.p0)}  ` +
      `ratio ${fmtRatio(_impliedRatio(rp0, tok.p0))}`,
  );
  console.log(
    `    recorded price1     ${fmtPrice(rp1)}  ` +
      `vs live ${fmtPrice(tok.p1)}  ` +
      `ratio ${fmtRatio(_impliedRatio(rp1, tok.p1))}`,
  );
  const atRecorded = usdOf(ev.raw0, ev.raw1, tok.d0, tok.d1, rp0, rp1);
  const stored = Number(row.usdValue);
  const reproduces =
    Number.isFinite(atRecorded) &&
    Math.abs(atRecorded - stored) <= Math.abs(stored) * 0.01;
  console.log(
    "    chain amounts × recorded prices, at chain decimals = " +
      fmtUsd(atRecorded),
  );
  if (reproduces) {
    /*- Deliberately does NOT conclude "the prices were wrong".  A row
     *  that reproduces is internally consistent; whether it is *right*
     *  depends on whether those prices were correct at the recorded
     *  timestamp, which this tool cannot know — live prices are
     *  today's, so any older row shows a ratio purely from market
     *  drift.  Asserting a price fault here would report a defect for
     *  every row the tool reconciles. */
    console.log(
      "    → ✓ reproduces the stored figure: the arithmetic was faithful,",
    );
    console.log(
      "      so the only possible fault is the recorded prices themselves.",
    );
    console.log(
      "      Judge them by the ratios above — live prices are TODAY's, so an",
    );
    console.log(
      "      older row drifts with the market.  A ratio near a plausible",
    );
    console.log("      price move is normal; an extreme one is a real fault.");
    return true;
  }
  console.log(
    "    → ✗ does not reproduce it: the DECIMALS the bot used differ from",
  );
  console.log("      the chain's.");
  /*- Re-run the shift search against the recorded prices rather than
   *  live ones.  With the exact prices the bot used there is no drift
   *  term, so a hit here names the decimals pair outright. */
  const exact = decimalsShiftCandidates(stored, ev, {
    d0: tok.d0,
    d1: tok.d1,
    p0: rp0,
    p1: rp1,
  });
  if (exact.length === 0) {
    console.log(
      `      no (decimals0, decimals1) within ±${SHIFT_RANGE} explains it ` +
        "either — the stored figure did not come from this event's amounts",
    );
    return false;
  }
  for (const s of exact)
    console.log(
      `      decimals used ≈ d0=${s.d0} d1=${s.d1} → ${fmtUsd(s.usd)} ` +
        `(off by ${(s.rel * 100).toFixed(2)}%)`,
    );
  return false;
}

/** Print the on-chain event table and return the enriched event list. */
async function renderEvents(provider, scan, pos, p0, p1) {
  const labelled = classifyIl(scan.il, scan.dl, scan.mintInWindow);
  const rows = [
    ...labelled.map((l) => ({ ...l.ev, kind: l.kind })),
    ...scan.collect.map((e) => ({ ...e, kind: "collect" })),
  ].sort((a, b) => a.blockNumber - b.blockNumber);
  console.log("\nOn-chain liquidity events");
  const head0 = pos.sym0.slice(0, 16).padStart(16);
  const head1 = pos.sym1.slice(0, 16).padStart(16);
  console.log(
    `  ${"when".padEnd(24)} ${"kind".padEnd(10)} ${head0} ${head1} ` +
      `${"USD @live".padStart(14)}`,
  );
  const out = [];
  for (const r of rows) {
    const blk = await provider.getBlock(r.blockNumber).catch(() => null);
    const when = fmtTs(blk?.timestamp);
    const ev = { raw0: r.amount0, raw1: r.amount1 };
    renderEventRow(when, r.kind, ev, pos, p0, p1);
    out.push({ ...r, when, ev });
  }
  if (!scan.mintInWindow)
    console.log(
      "  (mint predates the window — no event is labelled `mint`; widen" +
        " with --days)",
    );
  return out;
}

/** Compare recorded compoundHistory rows against the scanned events. */
function renderConfigComparison(posConfig, events, tok, tokenId) {
  const history = (posConfig?.compoundHistory || []).filter(
    (h) => h.usdValue !== undefined && h.usdValue !== null,
  );
  console.log("\nRecorded vs on-chain (compoundHistory in bot-config.json)");
  if (history.length === 0) {
    console.log("  No compoundHistory rows for this position.");
    return;
  }
  const { own, others } = splitHistoryByNft(history, tokenId);
  if (others.size > 0) {
    const total = [...others.values()].reduce((a, b) => a + b, 0);
    console.log(
      `  ${total} of ${history.length} rows belong to earlier NFTs in this` +
        ` rebalance chain, not #${tokenId}.  compoundHistory follows the`,
    );
    console.log(
      "  position across rebalances, so it accumulates every tokenId the" +
        " chain has had.  To verify those, rerun with:",
    );
    for (const [tid, n] of [...others].sort(
      (a, b) => Number(a[0]) - Number(b[0]),
    ))
      console.log(
        `    node util/diagnostic/verify-compound-usd --token-id ${tid}` +
          `   (${n} row${n === 1 ? "" : "s"})`,
      );
  }
  if (own.length === 0) {
    console.log(`\n  No rows recorded against #${tokenId} itself.`);
    return;
  }
  const byTx = new Map();
  for (const e of events) byTx.set((e.txHash || "").toLowerCase(), e);
  for (const row of own) {
    const match = byTx.get(String(row.txHash || "").toLowerCase());
    if (!match) {
      console.log(
        `\n  compoundHistory row  tx ${row.txHash || "—"} — no matching` +
          " event in the scan window",
      );
      console.log(`    recorded usdValue   ${fmtUsd(row.usdValue)}`);
      console.log(
        "    (recorded against this NFT but absent from the window —" +
          " widen with --days)",
      );
      continue;
    }
    /*- Only solve for bad inputs when the row does NOT reconcile with
     *  its own recorded prices.  For a row that reconciles there is no
     *  gap to explain — the live-price solver would just re-describe
     *  market drift as an "implied price", including nonsense negative
     *  values when the token has appreciated. */
    if (!renderRecorded(row, match.ev, tok))
      renderHypotheses(Number(row.usdValue), match.ev, tok);
  }
}

/** Entry point. */

module.exports = {
  renderPrices,
  renderEventRow,
  renderHypotheses,
  renderRecorded,
  renderEvents,
  renderConfigComparison,
};
