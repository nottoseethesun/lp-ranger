---
name: feedback_never_test_against_production
description: "Never run a test, the app, or any script that can send a transaction against Production (PulseChain mainnet or the user's live install). Test on the testnet; mainnet stays read-only"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-16T18:25:27.926Z
---

Nothing I run may be able to send a transaction on PulseChain mainnet, or
touch the user's live install. That rules out:

- starting the app or the bot against mainnet;
- loading the user's wallet, `.env` or `app-config/user-configurable/` for
  a test run;
- forcing a Rebalance or Compound anywhere but the testnet.

Read-only mainnet calls are fine, such as a quote request or an
`eth_call`.

**Why:** user, 2026-10-16: *"Do not run any tests against Production
because e.g. a rebalance could cause me substantial financial loss."* A
rebalance drains the position, swaps and re-mints with real funds. A
mistake there is a real loss, not a failed test.

**How to apply:**

- Live tests run on PulseChain Testnet v4 (`CHAIN_NAME=pulsechain-testnet`,
  chain 943), in an isolated copy of the tree with its own
  `app-config/user-configurable/`. Use a fresh test-only wallet, never the
  user's key. Use a different `PORT`, since the user's server may be
  running on 5555.
- The unit suite (`npm run check`) is safe: it mocks the chain or uses
  ganache.
- Mainnet calls are fine only when they cannot move funds: quotes, reads,
  `eth_call`. Say which ones were made.
- When a test truly needs mainnet state, propose a local fork and ask
  first.

Related: [[feedback_user_launches_app]], [[project_9mm_api_sunset]].
