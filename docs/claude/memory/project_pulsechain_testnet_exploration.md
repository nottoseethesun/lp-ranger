---
name: project_pulsechain_testnet_exploration
description: "PulseChain Testnet v4 (943) has NO 9mm V3 deployment. How to replay 9mm's own mainnet creation txs there, testnet WPLS/PLSX addresses, gas that mines at ~1 gwei, the faucet. Deferred by the user 2026-10-16"
metadata:
  node_type: memory
  type: project
  originSessionId: d369b37d-2a0a-4f23-a78a-ed163018a4c8
  modified: 2026-10-24T05:23:48.518Z
---

# PulseChain testnet exploration

Explored 2026-10-16 while planning live tests for the 9mm api migration
([[project_9mm_api_sunset]]). The user deferred building a testnet
deployment the same day, in favour of raising swap and aggregator test
coverage to 95%. This is the groundwork for picking it back up.

## Facts, all verified 2026-10-16

- **No 9mm V3 deployment on Testnet v4 (chain 943).** The user confirmed
  it. 9mm-exchange/deployments has no testnet folder, app.9mm.pro
  configures chain 369 only, data.9mm.pro answers `unknown_chain` for 943,
  and none of 9mm's mainnet contract addresses hold code on 943.
- **Network.** RPC `https://rpc.v4.testnet.pulsechain.com`, explorer
  `https://scan.v4.testnet.pulsechain.com`.
- **Tokens already on the testnet.** WPLS
  `0x70499adEBB11Efd915E3b69E700c331778628707` and PLSX
  `0x8a810ea8B121d08342E9e7696f4a9915cBE494B7`, both confirmed by their
  `symbol()`.
- **Gas.** `eth_gasPrice` suggests 25000 gwei and the base fee is 0, but
  recent blocks hold transactions priced between 0.035 and 25 gwei. At
  about 1 gwei, a whole deployment (around 25M gas) costs well under one
  testnet PLS.
- **Faucet.** `https://faucet.v4.testnet.pulsechain.com`: `POST /api/claim`
  with a form field `address`, no captcha, 10 testnet PLS per claim. The
  rate limit was not checked.
- **No aggregator.** Watergun answers chain 943 with "not served by this
  gateway", so every testnet swap goes through the V3 router.

## How 9mm deployed V3 on mainnet: replayable

One address, `0xDc815f76b1bAb12442D43E17E955c942E3799bc0`, deployed
everything with plain creation transactions:

| Contract | Address | Creation tx |
| --- | --- | --- |
| PancakeV3Factory (verified) | `0xe50DbDC88E87a2C92984d794bcF3D1d76f619C68` | `0x225353b3847c0f41a9b79dad355fd672e29090c02658f90f92d30698b973f023` |
| Pool deployer (unverified) | `0x00f37661fA1b2B8A530cfb7B6d5A5a6AEd74177b` | `0xd6f08e4dad51f3f961384b8bcfb4916a8cbaa5d1d62d530cccd9ef75a950eacf` |
| SwapRouter (verified) | `0x7bE8fbe502191bBBCb38b02f2d4fA0D628301bEA` | `0x342a762f917f7b6bda08526e42ad5984abcd264e66ae5343bc403232b880a7a5` |
| NonfungiblePositionManager (verified) | `0xCC05bf158202b4F461Ede8843d76dcd7Bbad07f2` | `0x3f78190ecb619889ed916b427e3ea8a1620ae177769efddbf4ebed95a970d6e0` |

**Replay plan.** Resend each creation input with only its constructor
arguments changed, in this order:

1. The pool deployer.
2. `factory(deployer)`.
3. `deployer.setFactoryAddress(factory)`.
4. `SwapRouter(deployer, factory, WPLS)`.
5. `NPM(deployer, factory, WPLS, descriptor)`.

Skip the NFT-image descriptor: LP Ranger never calls `tokenURI`. Pools
come out byte-for-byte 9mm's, because the pool code lives inside the
deployer. LP Ranger needs only:

- the factory: `getPool`, `feeAmountTickSpacing`;
- the position manager;
- the SwapRouter: `exactInputSingle`.

Then deploy a test token, create a pool against WPLS at a 9mm fee tier,
and mint a narrow position. Estimated at two to three hours, written as a
reusable script under `util/` so the testnet can be rebuilt if PulseChain
resets it.

## Known gaps in LP Ranger on the testnet

- **Gas.** It prices its own transactions at `eth_gasPrice` × the
  chain's `gasPriceMultiplier`. The testnet entry copies mainnet's 7,
  which comes to about 230 testnet PLS per rebalance; with 1, about 33.
  The proposal was a testnet-only fixed low gas price.
- **Chart links.** The testnet entry's `chartProviders` point at mainnet
  sites.
- **USD prices.** None exist for test tokens, so LP Ranger's price
  override would stand in. A check or two that depends on USD values may
  need a look.
- **Plumbing already built.** On branch `migrate-to-new-9mm-data-api`
  (2026-10-16): `parseCompositeKey` reads from the right, there is a
  `GET /api/chain` route plus `src/client/web/dashboard-chain.js`, and contract
  addresses no longer fall back to mainnet's.

**Why:** live tests must never touch Production
([[feedback_never_test_against_production]]), and the testnet had
nothing to test against. The exploration answered what building it would
take.

**How to apply:** when the user resumes testnet work, start from the
replay plan. Ask whether they have testnet PLS or want the faucet used.
Use a fresh test-only wallet, never theirs.
