---
name: Slippage recommendation = lowest observed impact (floor, not ceiling)
description: _bestAttemptError picking the LOWEST impact across chunks/router is intentional; don't "fix" it to use the highest or the failing-attempt's value
type: feedback
originSessionId: ca6cd238-0010-4f82-88ce-354f7a7bc54e
modified: 2026-10-24T04:54:55.306Z
---
When a swap fails for slippage reasons after multi-step fallback (aggregator full → chunks → V3 router), `_bestAttemptError` in `src/lib/rebalancer-swap-impact.js` deliberately picks the **lowest** observed `impactPct` across all attempts and emits "Increase to at least X.X%". This is correct — do not change it to use the failing attempt's higher impact, even in edge cases where some chunks passed at low impact and a later step failed.

**Why:** "At least X" is a floor. The user can always set higher slippage if they want. But recommending a high number permanently inflates their slippage tolerance and makes them more vulnerable to MEV / bad fills on future rebalances. Late-step failures (e.g., chunk 3 slip-aborts after chunks 1+2 succeeded, or V3 router fallback fails on stale amountIn) are often red-herrings — transient or path-specific issues that resolve on retry without raising slippage. Sacrificing coins to red-herrings is the worse failure mode. Better to let the user retry at the lower (lowest-observed) slippage and only nudge higher if it persists.

**How to apply:** Don't propose adding an `aborted: true` filter to `_bestAttemptError` to exclude attempts that passed the gate. Don't propose using `Math.max` instead of `Math.min` to "be safer." Don't tighten the synthesis condition beyond the existing `isSwapImpactAbort && attempts.length > 1` guard. The current behavior — lowest impact + 0.5% safety margin, with "at least" wording — is the intentional design.
