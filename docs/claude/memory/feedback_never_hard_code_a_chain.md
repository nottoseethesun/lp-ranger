---
name: feedback_never_hard_code_a_chain
description: "lp-ranger can never have anything hard-coded to a given blockchain (user, 2026-10-16, absolute). Chain facts come from chains.json; the dashboard shows nothing until the server names the chain"
metadata:
  node_type: memory
  type: feedback
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-24T04:55:09.016Z
---

# Never hard-code a blockchain

The user's words, 2026-10-16: "`lp-ranger` can never have anything
hard-coded to a given blockchain; fix." Said about the scan Reload starts,
then applied to the dashboard's "PulseChain" fallbacks: "fix to be blank
initially as with the other case and accept the wait for the server poll."

**What counts.** Any value in code that is true of one chain only:

- chain names, display names and ids (`"pulsechain"`, `"PulseChain"`,
  `369`, `0x171`), including as a default or fallback (`|| "pulsechain"`);
- a chain's token addresses and symbols (WPLS, `PLS`), its RPC endpoints,
  its explorer and homepage;
- a price service's id for a chain (DexScreener slug, GeckoTerminal
  network, Moralis hex id);
- anything that assumes its block time (a block count standing for a
  span of time);
- a chain's branding in HTML (the header logo and link).

**Where it lives instead.** The chain's entry in `chains.json`:
`displayName`, `homepage`, `logo`, `tokenList`, `blockTimeSec`,
`nativeCurrencySymbol`, `cacheTag`, `priceServices`, plus the existing
contracts, rpc, aggregator and chart providers. `src/lib/config.js` checks
each at startup and stops naming the setting; there are no fallbacks.
Time windows are configured in seconds and turned into blocks with
`blockTimeSec`. The dashboard holds no chain until `GET /api/chain`
answers and shows blanks until then.

**Why:** the app is built to add chains later, and a value true of one
chain is wrong, silently, on the next. On 2026-10-16 six dashboard
fallbacks named "PulseChain", the LP position cache's file names fell
back to it, a five-letter cache tag made PulseChain and its testnet share
cache files, and the price lookups and the Moralis key check named
PulseChain's ids directly.

**How to apply:**

- Before writing a chain value in code, put it in `chains.json` and read
  it from `config.CHAIN`; for another chain's data (the dust tokens on
  Ethereum), carry its ids with that data.
- Grep before declaring a chain sweep done: `pulsechain`, `PulseChain`,
  `369`, `0x171`, `PLS`, `WPLS`, `0xA1077a`, `g4mm4`, and block-time
  constants. A chain sweep on 2026-10-16 claimed completion and had
  missed the dashboard's hand-built keys, Reload's among them
  ([[project_9mm_api_sunset]]).
- **A literal turned lookup can be null.** `"pulsechain"` never was;
  `activeChainId()` is, until the server answers. A template literal
  turns that into `"null-…"`, `join` into `"-…"`, and localStorage keeps
  either for good. Check every consumer explicitly, or name the order
  that makes the check unneeded: polling starts after the chain loads,
  but input and click handlers are bound before it (audit, 2026-10-16:
  five consumers had no check).
- **A startup check makes the value's fallbacks dead, and dead code is
  removed** in the same change, pre-existing or not
  ([[feedback_dead_code_removed]]). Checking `displayName` at startup
  on 2026-10-16 left four `displayName ?? "?"` fallbacks dead; the user
  confirmed their removal the next day.
- **A request cannot name the chain either.** The server keys positions
  on `config.CHAIN_NAME`; `POST /api/position/manage` used to take
  `body.blockchain` and would mark a position running on a chain it
  does not run.
- Comments and help-text examples that describe PulseChain are not
  hard-coding. Prose in the help dialogs, the user manual and the
  disclosure that gives PulseChain-specific guidance is the user's call;
  ask before rewriting it.

Related: [[feedback_one_literal_per_shipped_default]],
[[feedback_generic_chain_cache_keys]].
