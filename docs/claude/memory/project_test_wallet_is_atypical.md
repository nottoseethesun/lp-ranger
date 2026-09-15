---
name: project_test_wallet_is_atypical
description: The dev wallet's HEX/eHEX position has ~133 NFTs from narrow-range test rebalances; typical is 24 or fewer per year per position
metadata:
  type: project
---

The development wallet's HEX/eHEX position carries a rebalance chain of
roughly 133 NFTs. That is a testing artifact, not a realistic shape: the
user ran it at a deliberately super-narrow range, which forced far more
rebalances than any operator would see. It was the test pair because 9mm
had no testnet at the time. A realistic position produces **24 NFTs per
year or fewer**, so only a three-year-old position would approach this
chain length.

9mm now does have a testnet. Supporting it is explicitly **not** wanted
for now.

**Why:** almost every cost in the app scales with NFTs per chain rather
than with pools — epoch reconstruction, per-NFT history walks, compound
classification. Timings measured against this wallet therefore
overstate normal cost by a large factor, and an estimate extrapolated
from them will be pessimistic.

**How to apply:** when quoting sync durations, scan counts, or
first-run expectations, say which they are. A figure from this wallet
describes a worst case. For a typical-operator estimate, scale by
rebalance count per pool rather than by pool count — three busy pools
cost far more than ten quiet ones. Measured on 2026-09-15: a cold sync
of three pools (132, 39 and 0 rebalance events) ran about 12 hours, of
which over 6 went to the 132-NFT chain alone. Related:
[[feedback_no_heuristic_thresholds]], [[project_maturity_staircase]].
