# Possible Major New Features

Platform-scale or strategic features. Distinct from the smaller
nice-to-haves list — these are not incremental polish.

## Multi-Chain Support

Add 9mm on Ethereum first, then the other blockchains 9mm supports.

The current architecture already abstracts much of the chain-specific
configuration (per-chain tunables in `app-config/static-tunables/chains.json`,
chain-scoped disk caches, blockchain-prefixed composite keys).
Multi-chain rollout extends those abstractions: per-chain RPC
endpoints, per-chain contract addresses, per-chain price-source
preferences, and a chain selector on the dashboard.

## LP Optimization Engine

Integrate with an external optimization service that recommends
optimal range width, rebalance timing, and fee tier based on
historical pool data and volatility analysis.

The bot today preserves the user's original tick spread on
rebalance. An optimization engine would feed back recommendations
the user could accept (manually or auto-applied) to widen/narrow
ranges and adjust thresholds based on observed pool volatility.

## X1 (Solana-Fork) Port

Port LP Ranger to X1, a highly-modified Solana fork that keeps the
unmodified SVM. The detailed layered transfer plan + 5 blocker
questions is captured in
[project_x1_transfer_plan.md](project_x1_transfer_plan.md).
