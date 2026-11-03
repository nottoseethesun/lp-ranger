# Calculate the Activity Log's Loss/Gain When a Prior Rebalance Failed

> **Status:** Nice-to-have — not a bug. Funds are never at risk: the
> figure is shown in the Activity Log only, and nothing the bot decides
> reads it. Filed at the user's word (2026-11-03): "We'll need to add a
> nice-to-have, which is 'When prior rebalance failed, still calculate
> the % loss correctly for the stats on the Activity Log entry.'"

## What happened

On the user's $cro/$dwb position, a rebalance failed because the
slippage setting was too low. The old position was left emptied, its
coins in the wallet. The user raised the slippage and clicked Manage,
and that rebalance went through. Its Activity Log entry shows 0% for
Impermanent Loss/Gain, Current and Historical both.

## What the entry measures now

A Rebalance entry's Impermanent Loss/Gain is what the rebalance's own
swaps cost or gained. The rebalance reads the wallet's two coins three
times as it goes: before it empties the old position, after, and just
before the mint. The figure compares the coins after the emptying with
the coins before the mint, at one set of prices (docs/engineering.md §
"Activity Log Figures").

A rebalance that starts on a position already emptied has nothing to
empty, so its readings before and after the emptying are the same
coins: the wallet as it found it (`_walletBalances`,
`src/lib/rebalancer-execute.js`). Its figure covers only what it swapped
itself. Whatever the failed attempt swapped before it stopped falls
outside it. The entry names the old position, but nothing looks back at
the failed attempt.

A rebalance can fail on its slippage setting after its first swap has
landed: the corrective swap that follows is held to the same setting
(`src/lib/rebalancer-correct.js`), and a refusal there stops the
rebalance before the mint. The rebalance run again then has little left
to swap, so its figure can come out near 0%.

## The idea

Recognize the failed attempt. When a rebalance starts on a position a
failed rebalance emptied, take its readings before and after the
emptying from that failed attempt, so the figure counts every swap
between the old position and the new one.

The chain already holds what this needs. For a Rebalance entry with no
readings of its own, the scan finds the emptying among the old
position's events, its latest decrease of liquidity before the new
mint, and reads the wallet around it (`_chainReadings`,
`src/lib/rebalance-activity-figures.js`). For a rebalance run again,
that emptying is the failed attempt's. Today the rebalance's own
readings come first, so the chain is not asked.

## To settle first

- **Which step stopped the $cro/$dwb rebalance.** A swap whose price
  impact exceeds the slippage setting is refused before it is sent. If
  the first swap was refused, the rebalance run again made the whole
  swap, and its own readings hold it; a Rebalance figure shows in whole
  percents, so a loss under half a percent reads 0%. If the corrective
  swap was refused, the first swap had landed, as above. The log of the
  install where it ran tells which.
- **A longer span.** Hours or days can pass between the failed
  attempt's emptying and the mint of the rebalance run again, and the
  wallet's coins can change meanwhile for other reasons: a deposit,
  which the figure already sets aside, or a move of another managed
  position whose pool holds one of the same coins. The figure has to
  leave those out.
