---
name: project_rpc_gateway_bypass_audit
description: "CLOSED 2026-10-03: every provider in src/ originates at the centralized rpc gateway. Audit by tracing provider ORIGINS, not the forty functions that take one as a parameter — a threaded provider inherits its origin, and the bypass that mattered constructed nothing at all."
metadata:
  node_type: memory
  type: project
  originSessionId: 5204a00a-4efb-4764-869d-4cdadbf354e2
  modified: 2026-10-03T20:16:05.008Z
---

Asked by the user as "are we done with this class of bug — meaning, not
using the centralized rpc gateway." **Closed 2026-10-03.** No bypass
remains in `src/`.

## The method, which is the reusable part

Two earlier sweeps for this missed
[[project_aggregator_swap_wait_double_swap]], and the reason is worth
keeping. Both looked for code that *walked its own endpoint list* —
`buildProvider`, `walkOrderFrom`, a loop over `config.RPC_URLS`. The
real bypass constructed nothing and read no config: a bare `tx.wait()`,
which silently uses the provider ethers baked into the transaction
object when it was broadcast.

So do not grep for construction, and do not try to trace the forty
functions that accept a `provider` parameter — a threaded provider
inherits whatever its origin was, so depth is irrelevant. **Enumerate
the origins.** Every provider value in the app begins at one of a small
number of expressions, and if each of those is the gateway then every
parameter below them is too.

```bash
# the origins
grep -rnE "(const|let|var) +(provider|prov|_provider|readProvider) *=" src/*.js
# construction, which must appear only in the factory
grep -rn "JsonRpcProvider(" src/*.js
# providers baked into an object by ethers — the shape that hid
grep -rn "\.wait(\|signer\.provider\|runner\.provider" src/*.js
# and rule out rpc over raw HTTP
grep -rn "fetch(" src/*.js | grep -iE "rpc|RPC_URL"
```

## What the trace found

**Construction is centralized.** `JsonRpcProvider` is instantiated only
in `src/bot-provider.js`, the factory. Nothing else in the app builds
one.

**Twenty-eight provider assignments, two origins.** Twenty are
`sendTx.getManagedReadProvider()` directly. Eight are
`signer.provider ?? signer`, and `FailoverNonceManager`'s `provider`
getter returns that same managed proxy — so those are the gateway too.

**The signer is always a `FailoverNonceManager`.** Both construction
sites (`bot-loop.js`, `position-manager.js`) wrap the base wallet in
`createFailoverSigner`, and both branches of their dry-run ternary
connect that wallet to the managed proxy first. So even the unwrapped
base wallet — which the speed-up and cancel paths deliberately reach for
— carries the proxy.

**One deliberate exception.** `nonce-manager-wrapper.js` uses
`sendTx.getCurrentRPC()`, the raw current endpoint, for the inner
NonceManager's **write** side. That is correct: writes have their own
failover in `_estimateWithFailover`, and receipt polling must stay bound
to the endpoint that broadcast. Its own comment says so.

**No rpc over raw `fetch`.** The only `fetch` calls go to DexScreener,
GeckoTerminal and the 9mm quote API. None is an rpc endpoint.

**One `.wait()` left**, the aggregator's cancel. Its rejection is
neutralised to `null`, so it cannot become the move's failure, and the
`settleNonce` that follows asks through the gateway-derived provider —
so a cancel receipt one endpoint missed is still resolvable.

## Two latent items, neither a bug today

Recorded so they are not re-discovered as findings
([[feedback_no_finding_without_a_failure]]: no failure, so not a
finding).

1. **`position-details-quick.js` builds a plain `ethers.Wallet`**, not a
   `FailoverNonceManager`. It is connected to the proxy threaded down
   from `server-routes.js`, and it only does a `collect.staticCall`, so
   reads go through the gateway. But it bypasses nonce management by
   construction, so it must never be made to send a transaction.
2. **The `?? signer` / `|| signer` fallback** would be a bypass if a
   signer ever arrived without a `.provider`. Unreachable in production —
   the getter always exists on the wrapper and the base wallet is always
   constructed with a provider — and it exists for test stubs.

Related: [[project_consolidate_rpc_retry]] (the read-retry
consolidation that made one gateway possible),
[[feedback_signal_substitution]] (why the first two sweeps missed it).
