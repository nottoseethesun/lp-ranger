---
name: project_false_zeroes_for_price_and_amounts
description: "OPEN, the user's umbrella name for three bugs: a failed endpoint or price-service answer is recorded as zero, saved to disk, and never asked again. Three instances — the opening deposit amounts, per-NFT gas, and the first-deposit leftover's value."
metadata:
  node_type: memory
  type: project
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-10-03T18:24:07.808Z
---

**"false-zeroes-for-price-and-amounts"** — the user's name for this
group, assigned 2026-10-03 so the three can be parked and picked up
together. All open, none fixed.

## The one mistake

The bot asks two kinds of outside questions: blockchain endpoints about
transactions, and a price service about what tokens were worth on a past
day. In three places a failed answer is recorded as a real one — zero —
and saved to disk. A saved value is never asked again, so the wrong
number is permanent, and nothing on screen marks it.

Zero is the wrong sentinel because it is a legitimate answer. "No gas
was spent" and "the endpoint would not tell me" must not be the same
value.

## The three

1. [[project_hodl_baseline_zero_from_rpc_failure]] — the two token
   amounts a position was opened with, read from the deposit
   transaction's receipt. Zeroed, IL/G then reports the whole position
   as gain, and the Impermanent Loss Guard stops checking that position.
2. [[project_nft_gas_zero_from_rpc_failure]] — the gas a transaction
   burned, read from its receipt. Zeroed and saved; the mint is an
   NFT's largest charge, so gas reads low and profit reads high.
3. [[project_initial_residual_zero_price_persisted]] — the two tokens'
   prices on the day of the first deposit, used to value the leftover
   that deposit did not consume. Zeroed, so the subtraction that keeps
   that leftover out of lifetime profit removes nothing.

## The fix all three want

Return nothing — `null` — for "could not read", and reserve zero for an
answer actually given. Then a caller has something to branch on and
declines to save. Instance 3 already contains the pattern: its balance
half returns `null` and aborts without saving, while its price half
returns zeros and saves them.

No repair pass over values already on disk
([[feedback_no_junk_repair_code]]): after the fact a false zero is
indistinguishable from a true one, and Reload Position re-derives from
chain.

## Not to be confused with

A **different class**, and the user drew the line: this group is about a
*value* — a failure written down as an answer.
[[project_speedup_phase_boundary_race]] is about *control flow* — two
parties bounding one interval, so one concern's failure ends another's
work. Searching error handlers for bad return values finds this group
and is blind to that one. See
[[feedback_signal_substitution]].
