# Derive Per-NFT Fees From One Scan Instead of Two

> **Status:** Mostly done. The two passes now share one read of the
> chain; what remains is two derivations kept in two stores. Not a bug:
> both figures are correct and agree. Funds are never at risk.

## Plain language

The app works out how much a position earned in trading fees twice, and
files the answers in two places. One feeds the Per-Day P&L table; the
other feeds the Lifetime panel's "Fees Compounded" row.

Nothing compares them. For a long time they used different formulas
and quietly disagreed — the Per-Day table showed $149 where the
Lifetime panel showed $1,084 on the same position. Both now use the
same formula and match, but they are still worked out twice, so they
could drift apart again.

## Detail

| | Per-Day P&L table | Lifetime "Fees Compounded" |
| --- | --- | --- |
| Figure | `snap.dailyPnl[].feePnl` | `snap.totalCompoundedUsd`, priced at every poll |
| Store | `app-data/scan-cache/pnl-epochs-cache.json`, in dollars at each period's close | `app-config/user-configurable/bot-config.json`, as coins (`compoundedAmount0` / `compoundedAmount1`) |
| Key | pool identity | composite key |
| Built by | `reconstructEpochs` → `getPositionHistory` | `_classifyAllCompounds` → `classifyCompounds` |
| Order | first | second |

## What has been done

- **One formula.** Since 2026-09-02 both call `lifetimeFeeAmounts` in
  `src/compounder.js`, the single definition of
  `Σ(Collect) − Σ(drained principal)`. Before that the Per-Day path used
  `Collect(last) − DecreaseLiquidity(last)`, and so missed every fee
  that auto-compound had already swept back into liquidity.
- **One read.** Both need the same `Collect` and `DecreaseLiquidity`
  logs. When a scan pass runs both, the lifetime scan's chain read is
  prepared first and epoch reconstruction takes its events from it
  (`_scanAndReconstruct` in `src/bot-recorder.js`,
  `src/bot-recorder-lifetime-read.js`). When the lifetime scan is not
  due, or its read cannot be prepared, reconstruction reads on its own,
  in one batched pass (`scanChainCollectAndDrain`).

## What remains

Two derivations of the same per-NFT fees, in two stores that nothing
compares. The fix is to have one feed the other: epoch reconstruction
taking the per-NFT fee amounts the compound classification computes,
or both taking them from one function over the shared read.

Deliberately deferred by the project owner: the data volume is small
and a rebuild is rare. With the read shared, what is left duplicates
arithmetic, not chain reads.
