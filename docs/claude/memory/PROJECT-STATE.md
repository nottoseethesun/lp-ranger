# Project State Index

What is in flight, why the app is the way it is, and what is
deliberately deferred. Split out of [MEMORY.md](MEMORY.md), which holds
the rules for HOW to work and is loaded every session. Two `project_*`
entries stay there because they are workflow rules in practice — the tag
format and the help page's location.

This file is **not** auto-loaded, so open it when any of these apply:

- **Before any status report, audit, release or burn-in write-up.** The
  incidents and the current watch are here, and open bugs lead a report
  ([lead with open bugs](feedback_lead_with_open_bugs.md)).
- **Before proposing a change to an area below.** Several entries record
  a decision that looks like a defect until you read why.
- **Before explaining why the code does something.** Not only before
  changing it. An entry may already call it a known duplication or a
  deferred cleanup, and answering from the source alone turns into a
  defense of something already on the list
  ([check state before explaining design](feedback_check_state_before_explaining_design.md)).
- **When adding a `project_*` or `reference_*` memory.** Its one-line
  pointer goes in this file, not in `MEMORY.md`.

Nothing here is a bug report unless it says so. The Deferred section is
nice-to-haves ([nice-to-haves are not bugs](feedback_nice_to_haves_not_bugs.md)).


## Open, reproducible, deliberately unfixed

- [**false-zeroes-for-price-and-amounts**](project_false_zeroes_for_price_and_amounts.md) — **Start here.** The user's umbrella name for the three below: a failed endpoint or price-service answer recorded as zero, saved, and never asked again. One fix shape covers all three

Found 2026-10-03. A *value* bug — distinct from the control-flow class
the speed-up phase-boundary race belonged to.

- [HODL baseline zeroed by an rpc failure](project_hodl_baseline_zero_from_rpc_failure.md) — **FIXED 2026-10-03.** Was: a failed mint read recorded as "opened with zero of both tokens", looking complete so never retried, which silently disabled the Impermanent Loss Guard and let a later retry overwrite good amounts. Trigger was the token-decimals read, not the receipt. Kept as the record of why zero is never a substitute for "unknown" — and of a harm this file overclaimed before tracing it to the screen
- [per-NFT gas zeroed by an rpc failure](project_nft_gas_zero_from_rpc_failure.md) — **FIXED 2026-10-04.** Was: a refused receipt read becoming "cost no gas", persisted and then a cache hit forever, understating the mint — an NFT's largest charge. One unreadable receipt now makes the whole NFT total unknown and nothing is saved
- [initial residual priced at zero](project_initial_residual_zero_price_persisted.md) — A failed historical-price lookup is persisted as $0 and never re-fetched. The subtraction that excludes the initial-mint leftover from Lifetime Net P&L then removes nothing. Its sibling half of the same function aborts without persisting, which is the shape all three want

## Production incidents — all fixed, kept as the record

- [tx.wait() not failover-covered](project_tx_wait_not_failover_covered.md) — Hit Prod 0.9.7, fixed in 0.9.8: a receipt is a read, so it re-asks through the managed read provider instead of dying on the endpoint the failover already left
- [aggregator swap wait could cause a double swap](project_aggregator_swap_wait_double_swap.md) — Caught in development. Fixed 2026-10-03: the swap's confirmation wait was a bare `tx.wait()` raced against a timer, so an endpoint failure escaped unflagged and the router fallback swapped the same balance again. Now goes through `sendTx.waitForReceipt`, the single door to a receipt wait, with the cross-endpoint re-ask already attached
- [speed-up phase-boundary race](project_speedup_phase_boundary_race.md) — Caught in development, not Prod. Fixed 2026-10-03: a receipt re-ask carried a second deadline the length of the phase it ran inside, so the two could expire together and conclude opposite things. The fix removed the deadline rather than teaching the code to tell them apart
- [Telegram Markdown drops alerts](project_telegram_markdown_drops_alerts.md) — Hit Prod 0.9.7, fixed in 0.9.8: a parse refusal now resends unformatted, so the alert survives text Telegram won't parse
- [read retry counted one refusal 678 times](project_read_retry_spins_unpaced.md) — Hit Prod 0.9.7, fixed in 0.9.8: ethers cached the rejected promise, so retries never hit the wire yet each was reported as a failure
- [total RPC outage OOM](project_total_rpc_outage_oom.md) — Killed Prod 0.9.4: ethers' network detection skips the paced send(); fixed with staticNetwork in 0.9.5
- [failover exhausts on concurrent errors](project_failover_exhausts_on_concurrent_errors.md) — Prod 0.9.5 froze for an hour when ONE endpoint blipped; fixed in 0.9.6 by naming the failed endpoint
- [config stomp investigation](project_config_stomp_investigation.md) — bot-config.json once overwritten; root cause unknown, guards in place

## Release state & maturity

- [0.9.8 burn-in watch](project_0098_burn_in_watch.md) — 0.9.8 on Prod: ten hours of burn-in sent zero transactions, so the swap and nonce path the release exists to fix shipped unexercised
- [maturity staircase](project_maturity_staircase.md) — Stability outranks features
- [security audit two-tier](project_security_audit_two_tier.md) — The daily audit covers the release tag, not main
- [test wallet is atypical](project_test_wallet_is_atypical.md) — ~133-NFT chain is a test artifact; real positions make ≤24/year
- [renamed LP Ranger](project_renamed_lp_ranger.md) — Canonical name is LP Ranger (package `lp-ranger`); read this one first
- [major features](project_major_features.md) — Platform-scale features queued for post-soft-launch
- [X1 transfer plan](project_x1_transfer_plan.md) — Layered plan to port standards to an X1 chain
- [Pi 5 recommendation phrasing](project_pi5_recommendation_phrasing.md) — Whole recommendation inside the parens

## Why the app is the way it is — check before changing these

- [consolidate RPC retry](project_consolidate_rpc_retry.md) — DONE 2026-10-02: one retry loop, no reader keeps its own endpoint list. Carries the three-grep sweep that tells you whether a new reader reintroduced one
- [rpc gateway bypass audit](project_rpc_gateway_bypass_audit.md) — CLOSED 2026-10-03: every provider in `src/` originates at the gateway, traced to ground. **Audit origins, not the forty functions taking a provider parameter** — two earlier sweeps missed the aggregator bypass because it constructed nothing and read no config. Carries the four-grep recipe and the two latent non-findings
- [disk layout philosophy](project_disk_layout_philosophy.md) — Three tiers (config/data/logs); two subdirs at the app-config top
- [single nonce manager](project_single_nonce_manager.md) — One NonceManager per wallet, never per-position
- [swap serialized](project_swap_serialized.md) — The swap path is deliberately serialized
- [scan-running guard intentional](project_scan_running_guard_intentional.md) — `_scanRunning` dropping concurrent scans is deliberate
- [event cache scoping rationale](project_event_cache_scoping_rationale.md) — Why caches key on chain+factory+wallet+tokens+fee
- [CSRF does not gate the bot](project_csrf_does_not_gate_bot.md) — CSRF guards browser POSTs; the bot is in-process
- [api/config lazy-creates](project_api_config_lazy_creates.md) — POST /api/config lazy-creates the position slot
- [config inputs populate once](project_config_inputs_populate_once.md) — Bot Config inputs populate once per position
- [unmanaged N/A principle](project_unmanaged_na_principle.md) — Unmanaged shows N/A for rebalance control, no Lifetime panel
- [util/diagnostic directory](project_util_diagnostic_directory.md) — util/diagnostic/ = dev tooling; scripts/ = operations

## P&L, pricing & deposits

- [P&L accounting model](project_pnl_accounting_model.md) — IL/G is divergence only; fees counted once in Profit
- [lifetime metrics distinction](project_lifetime_metrics_distinction.md) — Lifetime Net P&L vs Lifetime IL/G differ in formula and role
- [top panels price at today](project_top_panels_price_at_today.md) — Only Per-Day keeps period dollars
- [price source priority](project_price_source_priority.md) — Moralis → GeckoTerminal → DexScreener
- [Moralis setup flow](project_moralis_setup_flow.md) — The key can be entered during wallet setup
- [fresh deposit detection](project_fresh_deposit_detection.md) — Transfer scan with swap/drain/contract filters

## Deferred — nice-to-haves, NOT bugs

- [code cleanup nice-to-haves](project_code_cleanup_nice_to_haves.md) — Running list of polish items
- [dashboard cleanup NTH](project_dashboard_cleanup_nth.md) — Import cycles, cache sweep, 42 orphan HTML ids
- [deferred comment cleanup](project_deferred_comment_cleanup.md) — Storytelling JSDoc, 119 old-form openers, an engineering.md passage
- [ESM migration](project_esm_migration.md) — 100% CJS; ESM would be a big-bang change
- [bot-loop test scaffolding](project_bot_loop_test_scaffolding.md) — startBotLoop's lifecycle has no direct fixture
- [debug scripts print URL](project_debug_scripts_print_url.md) — Every `debug*` script prints its visit-this URL
- [gas-defer retry limit](project_gas_defer_retry_limit.md) — Optional cap on the gas-defer loop; not required
- [split rebalancePaused flag](project_split_rebalance_paused_flag.md) — Split the flag into aborted vs deferred

## Known rough edges — observed, low priority, not yet fixed

- [read retry never probes another endpoint](project_read_retry_never_probes_another_endpoint.md) — A bounded read spends all its attempts on the endpoint that is refusing, because selection only moves when the failure rate retires it. Costs one poll cycle; the endpoint usually comes back. The write path's probe-but-commit-on-success is the fix shape. Shares its trigger with issue 1 of [false-zeroes](project_false_zeroes_for_price_and_amounts.md)

- [receipt re-ask test flake](project_receipt_rewait_test_flake.md) — FIXED 2026-10-02: the flake was two real races in the speed-up pipeline, not a timing-seam problem
- [rebalance data lag](project_rebalance_data_lag.md) — Scanner sometimes misses a new pairing; ~30 min lag
- [route-via chain-scan gap](project_route_via_chain_scan_gap.md) — Chain-scanned events lack swapSources; Routed Via shows an em-dash
- [suppress OOR until synced](project_suppress_oor_until_synced.md) — Unmanaged view flashes "out of range" too early
- [throttle rehydrate loses timestamps](project_throttle_rehydrate_loses_timestamps.md) — rehydrate() restores dailyCount, not rebTimestamps

## External pointers

- [bug reports on dependencies](reference_bug_reports_on_dependencies.md) — `../bug-reports-on-dependencies/` holds upstream repros
- [release notes header](reference_release_notes_header.md) — docs/release-notes-header.md is the install blockquote
