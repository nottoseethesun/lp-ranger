# RPC Auto-Failover

Mid-session RPC rotation on repeated saturation/terminal errors.

## Background

Today the bot uses a primary RPC with a startup-time fallback (via
`createProviderWithFallback`). If the primary RPC starts returning
terminal errors mid-session, the bot does not automatically rotate
to a different endpoint.

A 3-bucket error classifier
(`src/rpc-error-classifier.js` +
`app-config/static-tunables/evm-rpc-response-codes.json`) already
distinguishes transient / terminal-nonce-unused /
terminal-nonce-consumed errors. Public PulseChain RPCs have proven
reliable enough that mid-session rotation has not been needed.

## Design when prioritized

- Rotate when repeated terminal-nonce-unused aborts happen within a
  short window on the same RPC.
- Rotation point is the classifier's terminal-nonce-unused branch
  in `src/rebalancer-pools.js` `_retrySend`.
- Make rotation observable in logs + dashboard alert.
