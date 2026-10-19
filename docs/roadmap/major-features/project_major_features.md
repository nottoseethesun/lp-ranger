# Possible Major New Features

Platform-scale or strategic features. Distinct from the smaller
nice-to-haves list — these are not incremental polish.

## Multi-Chain Support

Add 9mm on Ethereum first, then the other blockchains 9mm supports.

Most of the groundwork exists. Each chain's facts live in its entry in
`app-config/app-defaults-for-user-configurable/chains.json`: rpc
endpoints, contract addresses, the aggregator, the price services, gas
multipliers, block time and cache tag. Disk caches and composite keys
lead with the chain. So adding a chain is mostly a new entry, checked
against that chain's 9mm deployment and tried on a testnet first.

What does not exist yet is any choice of chain from the dashboard. A
server runs the one chain chosen at startup (`CHAIN_NAME`, or the
shipped default) and cannot change it while running. A chain selector
on the dashboard is the remaining piece.

## LP Optimization Engine

Integrate with an external optimization service that recommends
optimal range width, rebalance timing, and fee tier based on
historical pool data and volatility analysis.

The bot today keeps a position's tick spread on rebalance, unless the
operator sets a range in Bot Configuration → Range. An optimization
engine would feed back recommendations
the user could accept (manually or auto-applied) to widen/narrow
ranges and adjust thresholds based on observed pool volatility.

## X1 (Solana-Fork) Port

Port LP Ranger to X1, a highly-modified Solana fork that keeps the
unmodified SVM. The layered transfer plan and its five blocker
questions are in
[project_x1_transfer_plan.md](project_x1_transfer_plan.md).
